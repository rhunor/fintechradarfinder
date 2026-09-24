/**
 * cycle.ts — one complete poll cycle, start to finish.
 *
 * This is the heart of the agent. Called once a minute by an external
 * scheduler, it must do as much useful work as it can inside a strict time
 * budget and then stop cleanly, leaving anything unfinished safely on disk.
 *
 * ORDER MATTERS. Pending work is drained BEFORE new items are fetched, because
 * a candidate already waiting is by definition older than anything we are
 * about to find, and latency is measured from publication.
 *
 *   1. acquire the lease            (exit immediately if another cycle holds it)
 *   2. heartbeat + recover stuck    (notice scheduler gaps, rescue abandoned work)
 *   3. fetch due sources            (parallel, conditional GET, per-host limited)
 *   4. dedupe + bootstrap           (never alert on a new source's backlog)
 *   5. prefilter -> candidates      (write down before doing anything expensive)
 *   6. classify a batch             (one request, hard deadline)
 *   7. alert                        (atomic claim, then send)
 *   8. record cost                  (wall + CPU, for the Hobby projection)
 *
 * EVERY STEP IS DEADLINE-AWARE. `remaining()` is checked before anything
 * expensive, so running out of time degrades into "less done this minute"
 * rather than a half-written state or an overrun invocation.
 */

import type { Db } from "mongodb";
// Side-effect import: installs the keep-alive HTTP pool before any fetch runs.
import "@/lib/http";
import { ENABLED_SOURCES, type SourceConfig } from "@/config/sources";
import { eventConfig, isEventEnabled } from "@/config/events";
import { env, limits } from "@/lib/env";
import { log, errorInfo } from "@/lib/log";
import { fetchAllSources } from "@/lib/feeds/fetch-all";
import { prefilter } from "@/lib/prefilter";
import { recordSeen } from "@/lib/dedupe/seen";
import { acquireLock, releaseLock } from "@/lib/store/lock";
import {
  dueSources,
  loadAllSourceState,
  validatorsFrom,
  writeSourceStates,
  type SourceWrite,
} from "@/lib/store/source-state";
import {
  addCandidates,
  claimPending,
  countPending,
  markAlerted,
  markClassified,
  markRejected,
  recoverStuck,
  resetExhaustedAttempts,
  returnToPending,
} from "@/lib/store/candidates";
import { beatHeartbeat, getSettings, recordCycleDuration } from "@/lib/store/settings";
import { getUsage } from "@/lib/store/usage";
import { aiOfflineFor, classifyBatch } from "@/lib/classifier";
import { dispatchAlert } from "@/lib/alerter";
import { fetchArticleText, needsArticleFetch, toCandidateItem } from "@/lib/pipeline/candidate";
import { recordCycleCost, startMeter, type CycleMeasurement } from "@/lib/budget/meter";
import { warnBudget, warnStaleSources } from "@/lib/pipeline/health";
import type { RawItem } from "@/lib/feeds/types";
import type { CandidateItem } from "@/lib/classifier/types";
import type { CandidateDoc } from "@/lib/store/schema";

const POLL_LOCK_ID = "poll-cycle";

/** Nominal gap between cycles, used to decide when a backoff window is due. */
const CYCLE_INTERVAL_MS = 60_000;
/** First retry interval once the AI starts failing; doubles up to the max. */
const AI_BACKOFF_BASE_MS = 2 * 60_000;
/** Never wait longer than this before trying the AI again. */
const AI_BACKOFF_MAX_MS = 15 * 60_000;

export interface CycleReport {
  ran: boolean;
  skippedReason?: string;
  sourcesDue: number;
  sourcesOk: number;
  sourcesNotModified: number;
  sourcesFailed: number;
  /** Source ids we warned about this cycle. */
  warnedStale: string[];
  itemsSeen: number;
  itemsNew: number;
  bootstrapped: string[];
  candidatesAdded: number;
  classified: number;
  alertsSent: number;
  pendingAfter: number;
  gapMs: number | null;
  paused: boolean;
  measurement: CycleMeasurement;
  deadlineHit: boolean;
}

/** Deadline helper: how many milliseconds of budget are left. */
function makeDeadline(budgetMs: number): { remaining: () => number; signal: AbortSignal } {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  // Never keep the process alive just for this timer.
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return {
    remaining: () => Math.max(0, budgetMs - (Date.now() - start)),
    signal: controller.signal,
  };
}

export async function runCycle(db: Db, options: { budgetMs?: number } = {}): Promise<CycleReport> {
  const stopMeter = startMeter();
  const budgetMs = options.budgetMs ?? limits.cycleBudgetMs;
  const deadline = makeDeadline(budgetMs);
  const now = new Date();

  const report: CycleReport = {
    ran: false,
    sourcesDue: 0,
    sourcesOk: 0,
    sourcesNotModified: 0,
    sourcesFailed: 0,
    warnedStale: [],
    itemsSeen: 0,
    itemsNew: 0,
    bootstrapped: [],
    candidatesAdded: 0,
    classified: 0,
    alertsSent: 0,
    pendingAfter: 0,
    gapMs: null,
    paused: false,
    measurement: { wallMs: 0, cpuMs: 0 },
    deadlineHit: false,
  };

  // ---- 1. Lease -----------------------------------------------------------
  // The scheduler can double-fire or overlap. Exactly one cycle may run.
  const lease = await acquireLock(db, POLL_LOCK_ID, { ttlMs: limits.lockTtlMs, now });
  if (!lease) {
    report.skippedReason = "another cycle holds the lease";
    report.measurement = stopMeter();
    log.info("cycle.skipped", { reason: report.skippedReason });
    return report;
  }

  try {
    report.ran = true;

    // ---- 2. Heartbeat, recovery and state ---------------------------------
    // These four queries are independent, so they go out together. Run
    // sequentially they were four round trips of dead wall-clock time at the
    // start of every cycle, and wall time is what the memory meter bills.
    const [heartbeat, recovered, settings, state, usageToday] = await Promise.all([
      beatHeartbeat(db, now),
      recoverStuck(db, now),
      getSettings(db),
      loadAllSourceState(db),
      getUsage(db),
    ]);

    // Today's cycle count is the only monotonic counter a stateless function
    // has, and it is enough to spread classification across cycles.
    const cycleNumber = usageToday.cycles;

    report.gapMs = heartbeat.gapMs;
    if (heartbeat.gapDetected) {
      log.warn("cycle.scheduler_gap", {
        gap_ms: heartbeat.gapMs,
        previous_cycle_at: heartbeat.previousCycleAt?.toISOString(),
      });
    }
    if (recovered > 0) log.warn("cycle.recovered_stuck", { count: recovered });
    report.paused = settings.paused;

    // The AI is healthy again: give a fresh start to anything that burned
    // through its attempts while the provider was unavailable. Those attempts
    // measured our availability, not the item.
    if (!settings.aiFailingSince) {
      const rescued = await resetExhaustedAttempts(db, now);
      if (rescued > 0) log.warn("cycle.rescued_exhausted", { count: rescued });
    }

    // ---- 3. Fetch due sources --------------------------------------------
    const due = dueSources(ENABLED_SOURCES, state, now);
    report.sourcesDue = due.length;

    const validators = new Map(due.map((s) => [s.id, validatorsFrom(state.get(s.id))]));
    const fetched = due.length > 0
      ? await fetchAllSources(due, { validators, signal: deadline.signal })
      : [];

    // ---- 4. Dedupe and bootstrap -----------------------------------------
    // Source-state updates are collected and written in one bulkWrite at the
    // end. Writing them per source cost 6 seconds of wall time on the first
    // live cycle, which is billed memory time we get nothing for.
    const freshBySource = new Map<string, RawItem[]>();
    const stateWrites: SourceWrite[] = [];

    for (const { source, outcome } of fetched) {
      if (outcome.status === "not-modified") {
        report.sourcesNotModified++;
        stateWrites.push({ kind: "not-modified", sourceId: source.id });
        continue;
      }
      if (outcome.status === "error") {
        report.sourcesFailed++;
        log.warn("cycle.source_failed", { source: source.id, reason: outcome.reason });
        stateWrites.push({ kind: "error", sourceId: source.id, reason: outcome.reason });
        continue;
      }

      report.sourcesOk++;
      report.itemsSeen += outcome.items.length;

      const items = applyCategoryFilter(source, outcome.items);
      const isBootstrapped = state.get(source.id)?.bootstrapped ?? false;
      const dedupe = await recordSeen(db, source.id, items, isBootstrapped);

      if (dedupe.bootstrapped) {
        report.bootstrapped.push(source.id);
        log.info("cycle.source_bootstrapped", { source: source.id, items: items.length });
      }
      if (dedupe.fresh.length > 0) freshBySource.set(source.id, dedupe.fresh);
      report.itemsNew += dedupe.fresh.length;

      stateWrites.push({ kind: "success", sourceId: source.id, validators: outcome.validators });
    }

    await writeSourceStates(db, stateWrites, now);

    // ---- 5. Prefilter into the candidate queue ---------------------------
    const passed: RawItem[] = [];
    for (const items of freshBySource.values()) {
      for (const item of items) {
        const verdict = prefilter(item);
        if (verdict.pass) passed.push(item);
      }
    }
    report.candidatesAdded = await addCandidates(db, passed, now);
    if (report.candidatesAdded > 0) {
      log.info("cycle.candidates_added", { count: report.candidatesAdded });
    }

    // ---- 6 & 7. Classify and alert ---------------------------------------
    // Only if there is enough budget left to be worth starting.
    if (deadline.remaining() > 5_000) {
      const outcome = await classifyAndAlert(db, deadline, report.paused, cycleNumber);
      report.classified = outcome.classified;
      report.alertsSent = outcome.alertsSent;
    } else {
      report.deadlineHit = true;
      log.warn("cycle.skipped_classification", { remaining_ms: deadline.remaining() });
    }

    report.pendingAfter = await countPending(db);

    // ---- Health warnings --------------------------------------------------
    // Re-read source state: it has changed during this cycle, and warning on
    // the stale copy loaded at the start would report sources we just fixed.
    // Wrapped so a Telegram failure can never fail the cycle that found the
    // problem — that would be the worst possible time to lose a cycle.
    if (!report.paused) {
      try {
        const freshState = await loadAllSourceState(db);
        report.warnedStale = await warnStaleSources(db, freshState, new Date());
      } catch (err) {
        log.error("cycle.health_check_failed", errorInfo(err));
      }
    }
  } finally {
    await releaseLock(db, lease).catch(() => {
      // Survivable: the lease expires on its own.
    });
  }

  // ---- 8. Cost accounting -------------------------------------------------
  report.measurement = stopMeter();
  report.deadlineHit = report.deadlineHit || deadline.remaining() === 0;

  await Promise.all([
    recordCycleCost(db, report.measurement, {
      itemsSeen: report.itemsSeen,
      candidates: report.candidatesAdded,
    }).catch((err: unknown) => log.error("cycle.cost_record_failed", errorInfo(err))),
    recordCycleDuration(db, report.measurement.wallMs).catch(() => {}),
  ]);

  // Budget warning last, so it includes the cycle we just measured.
  await warnBudget(db).catch((err: unknown) => log.error("cycle.budget_warn_failed", errorInfo(err)));

  log.info("cycle.done", {
    wall_ms: report.measurement.wallMs,
    cpu_ms: report.measurement.cpuMs,
    sources_due: report.sourcesDue,
    sources_304: report.sourcesNotModified,
    sources_ok: report.sourcesOk,
    sources_failed: report.sourcesFailed,
    items_new: report.itemsNew,
    candidates_added: report.candidatesAdded,
    classified: report.classified,
    alerts: report.alertsSent,
    pending: report.pendingAfter,
    warned_stale: report.warnedStale.length,
    deadline_hit: report.deadlineHit,
  });

  return report;
}

/**
 * Some feeds have no usable topic feed, so we take the main feed and filter on
 * the categories each item declares. BetaKit is the case that forced this:
 * both of its fintech and funding category feeds were abandoned in 2024.
 */
function applyCategoryFilter(source: SourceConfig, items: RawItem[]): RawItem[] {
  if (!source.categoryFilter || source.categoryFilter.length === 0) return items;
  const wanted = new Set(source.categoryFilter);
  return items.filter((item) => {
    // Keep items with no categories at all: absence is not evidence of
    // irrelevance, and the prefilter will judge them on their text.
    if (item.categories.length === 0) return true;
    return item.categories.some((c) => wanted.has(c));
  });
}

interface ClassifyAlertOutcome {
  classified: number;
  alertsSent: number;
}

/**
 * Drain the pending queue: enrich, classify in one batch, then alert.
 *
 * Failures here always return items to pending rather than dropping them. The
 * cost of a delayed alert is a minute; the cost of a lost one is the deal.
 */
async function classifyAndAlert(
  db: Db,
  deadline: { remaining: () => number; signal: AbortSignal },
  paused: boolean,
  cycleNumber: number,
): Promise<ClassifyAlertOutcome> {
  const out: ClassifyAlertOutcome = { classified: 0, alertsSent: 0 };

  // Classification is the single most expensive thing a cycle does, and the
  // cost is almost entirely waiting. Running it on a fraction of cycles keeps
  // the memory meter down and batches more items per request. Fetching and
  // deduping still happen every cycle, so nothing is missed — only delayed.
  const everyN = limits.classifyEveryNCycles;
  if (everyN > 1 && cycleNumber % everyN !== 0) {
    const waiting = await countPending(db);
    if (waiting > 0) {
      log.info("cycle.classify_skipped", { cycle: cycleNumber, every_n: everyN, pending: waiting });
    }
    return out;
  }

  // BACK OFF WHEN THE PROVIDER IS DOWN.
  //
  // Without this, a slow or unavailable Gemini makes EVERY cycle spend its
  // whole classification budget failing. Observed in production: 90 cycles
  // averaging 25.9 seconds of wall time while completing just 5 requests —
  // which alone projected 172% of the Vercel memory allowance, because memory
  // is billed by wall time including time spent waiting.
  //
  // While the provider is failing we retry on a widening interval instead.
  // Nothing is lost: candidates stay pending and drain once it recovers.
  const offlineMs = await aiOfflineFor(db);
  if (offlineMs !== null) {
    const backoffMs = Math.min(
      AI_BACKOFF_BASE_MS * 2 ** Math.floor(offlineMs / AI_BACKOFF_BASE_MS),
      AI_BACKOFF_MAX_MS,
    );
    const sinceLastTry = offlineMs % backoffMs;
    if (sinceLastTry > CYCLE_INTERVAL_MS) {
      log.info("cycle.ai_backoff", {
        offline_ms: offlineMs,
        backoff_ms: backoffMs,
        pending: await countPending(db),
      });
      return out;
    }
  }

  const pending = await claimPending(db, limits.maxClassifierBatch);
  if (pending.length === 0) return out;

  // Enrich only the thin ones, and only within the per-cycle cap. A wire item
  // that is just a headline cannot be classified reliably, but fetching every
  // article page would blow the wall-clock budget.
  let fetches = 0;
  const items: CandidateItem[] = [];
  const byId = new Map<string, CandidateDoc>();

  for (const [index, doc] of pending.entries()) {
    const id = `i${index}`;
    byId.set(id, doc);

    let articleText: string | null = null;
    if (
      needsArticleFetch(doc) &&
      fetches < limits.maxArticleFetchesPerCycle &&
      deadline.remaining() > 8_000
    ) {
      fetches++;
      articleText = await fetchArticleText(doc.link, { signal: deadline.signal });
    }

    items.push(
      toCandidateItem(
        {
          sourceId: doc.sourceId,
          title: doc.title,
          link: doc.link,
          summary: doc.summary,
          publishedAt: doc.publishedAt,
          guid: null,
          categories: [],
          ...(doc.secFormType ? { secFormType: doc.secFormType } : {}),
        },
        id,
        doc.sourceId,
        articleText,
      ),
    );
  }

  const result = await classifyBatch(db, items, { signal: deadline.signal });

  if (result.deferred) {
    // Nothing was classified. Put everything back so the next cycle retries.
    log.warn("cycle.classification_deferred", { reason: result.reason, items: items.length });
    // Refund: the provider never judged these items, so the attempt measured
    // our availability, not their classifiability.
    for (const doc of pending) await returnToPending(db, doc._id, { refundAttempt: true });
    return out;
  }

  const verdictById = new Map(result.verdicts.map((v) => [v.id, v]));

  for (const [id, doc] of byId) {
    const verdict = verdictById.get(id);
    if (!verdict) {
      // The model saw this item and returned nothing for it. That is about the
      // item, so the attempt stands and it will eventually stop being retried.
      await returnToPending(db, doc._id);
      continue;
    }

    out.classified++;
    await markClassified(db, doc._id, verdict);

    // Each event type carries its own confidence floor: a partnership needs to
    // be more certain than a funding round, because a false positive on the
    // noisy categories is pure spam while a missed round is a real loss.
    // env.alertMinConfidence remains the global floor beneath all of them.
    const threshold = verdict.event
      ? Math.max(eventConfig(verdict.event).minConfidence, env.alertMinConfidence)
      : env.alertMinConfidence;

    const eventAllowed = verdict.event !== null && isEventEnabled(verdict.event);
    const shouldAlert = verdict.relevant && eventAllowed && verdict.confidence >= threshold;

    if (!shouldAlert) {
      const why = !verdict.is_fintech
        ? "not fintech"
        : verdict.region === "other"
          ? `region ${verdict.region}`
          : !verdict.event
            ? "not a tracked event"
            : !eventAllowed
              ? `event ${verdict.event} is disabled`
              : `confidence ${verdict.confidence.toFixed(2)} below ${threshold}`;
      await markRejected(db, doc._id, why);
      continue;
    }

    if (paused) {
      // Paused means we keep deduping and classifying but stay silent.
      await markRejected(db, doc._id, "paused");
      log.info("cycle.alert_suppressed_paused", { company: verdict.company });
      continue;
    }

    // shouldAlert already required a non-null event; this re-states it so the
    // compiler can narrow the type rather than taking it on trust.
    const event = verdict.event;
    if (!event) continue;

    const dispatch = await dispatchAlert(db, {
      company: verdict.company,
      event,
      region: verdict.region,
      fintechSubsector: verdict.fintech_subsector,
      amount: verdict.amount,
      currency: verdict.currency,
      round: verdict.round,
      leadInvestors: verdict.lead_investors,
      otherInvestors: verdict.other_investors,
      acquirer: verdict.acquirer,
      target: verdict.target,
      dealValue: verdict.deal_value,
      summary: verdict.one_line_summary,
      confidence: verdict.confidence,
      unverified: false,
      source: {
        sourceId: doc.sourceId,
        title: doc.title,
        link: doc.link,
        publishedAt: doc.publishedAt,
      },
      publishedAt: doc.publishedAt,
      fetchedAt: doc.fetchedAt,
      classifiedAt: new Date(),
    });

    if (dispatch.sent) {
      out.alertsSent++;
      await markAlerted(db, doc._id);
    } else if (dispatch.skipped === "duplicate" || dispatch.skipped === "in-flight") {
      await markRejected(db, doc._id, `duplicate deal (${dispatch.skipped})`);
    } else {
      // Sending failed: Telegram's problem, not the item's. Refund and retry.
      await returnToPending(db, doc._id, { refundAttempt: true });
    }
  }

  return out;
}

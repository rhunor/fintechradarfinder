/**
 * classifier/index.ts — picks a model, enforces the free tier, and tracks
 * whether the AI is healthy.
 *
 * The pipeline calls classifyBatch() and does not care which model answered.
 * Everything about model selection, quota protection, retries and the "AI has
 * been down for a while" state machine lives here.
 *
 * GEMINI ONLY, BY DESIGN: this project runs at zero cost, so every provider
 * here is on Google's free tier. Because those limits are applied PER MODEL, a
 * second Gemini model gives us a genuinely separate daily allowance rather than
 * the same bucket under another name. That is the fallback ladder:
 *
 *     primary model  ->  fallback model  ->  unverified alerts
 *
 * The Classifier interface is still provider-agnostic, so adding a paid
 * provider later is a new file, not a rewrite.
 *
 * THE RULE THAT MATTERS MOST: candidates are never silently dropped. If no
 * model can answer, items stay pending and are retried next cycle; and if the
 * AI has been failing for more than two minutes we fall back to clearly
 * labelled unverified alerts rather than going quiet.
 */

import type { Db } from "mongodb";
import { env, limits } from "@/lib/env";
import { log, errorInfo } from "@/lib/log";
import { ClassifierError } from "@/lib/classifier/errors";
import { consumedQuota, createGeminiClassifier } from "@/lib/classifier/gemini";
import type { CandidateItem, Classifier, Verdict } from "@/lib/classifier/types";
import { bumpUsage, getUsage, requestsForModel } from "@/lib/store/usage";
import { COLLECTIONS, type SettingsDoc } from "@/lib/store/schema";

/** How long the AI must be failing before we start sending unverified alerts. */
export const AI_OFFLINE_THRESHOLD_MS = 2 * 60 * 1000;

/** Above this share of a model's daily limit we start batching harder. */
const THROTTLE_AT = 0.8;

export interface ClassifyOptions {
  /** Cycle sequence number, used to classify every other cycle when throttled. */
  cycleParity?: number;
  /**
   * Cycle deadline. Classification is the longest single step a cycle takes,
   * and free-tier response times are highly variable, so it must be possible
   * to cut it off and leave the items pending.
   */
  signal?: AbortSignal | undefined;
}

export interface ClassifySelection {
  classifier: Classifier | null;
  model: string | null;
  reason: string;
  /** True when we are on the fallback model because the primary is spent. */
  usingFallback: boolean;
}

export interface ClassifyResult {
  verdicts: Verdict[];
  /** Model that answered, for logging and /status. */
  provider: string | null;
  /** True when the quota guard or a failure meant we classified nothing. */
  deferred: boolean;
  reason?: string;
}

/**
 * Decide which model to use given how much free quota is left today.
 * Returns a null classifier when we should not call anything this cycle.
 */
export async function selectProvider(
  db: Db,
  opts: ClassifyOptions = {},
): Promise<ClassifySelection> {
  const usage = await getUsage(db);

  const primary = env.geminiModel;
  const primaryLimit = env.geminiDailyLimit;
  const primaryUsed = requestsForModel(usage, primary);

  if (primaryUsed < primaryLimit) {
    // Near the cap: classify on every OTHER cycle so items accumulate and more
    // of them fit into each batched request, stretching the remaining quota.
    if (primaryUsed >= primaryLimit * THROTTLE_AT && (opts.cycleParity ?? 0) % 2 !== 0) {
      return {
        classifier: null,
        model: primary,
        reason: `throttling near daily limit (${primaryUsed}/${primaryLimit}), skipping this cycle`,
        usingFallback: false,
      };
    }
    return {
      classifier: createGeminiClassifier(primary),
      model: primary,
      reason: `${primary} (${primaryUsed}/${primaryLimit} today)`,
      usingFallback: false,
    };
  }

  // Primary exhausted. Try the second model's separate free allowance.
  const fallback = env.geminiFallbackModel;
  if (fallback) {
    const fallbackLimit = env.geminiFallbackDailyLimit;
    const fallbackUsed = requestsForModel(usage, fallback);
    if (fallbackUsed < fallbackLimit) {
      return {
        classifier: createGeminiClassifier(fallback),
        model: fallback,
        reason: `${primary} exhausted (${primaryUsed}/${primaryLimit}), using ${fallback} (${fallbackUsed}/${fallbackLimit})`,
        usingFallback: true,
      };
    }
    return {
      classifier: null,
      model: null,
      reason: `both models exhausted today (${primary} ${primaryUsed}/${primaryLimit}, ${fallback} ${fallbackUsed}/${fallbackLimit})`,
      usingFallback: true,
    };
  }

  return {
    classifier: null,
    model: null,
    reason: `${primary} daily limit reached (${primaryUsed}/${primaryLimit}) and no fallback model configured`,
    usingFallback: false,
  };
}

/** Records that the AI is currently failing, if it was not already marked. */
export async function markAiFailing(db: Db, error: string): Promise<Date> {
  const now = new Date();
  const settings = db.collection<SettingsDoc>(COLLECTIONS.settings);

  await settings.updateOne(
    { _id: "global" },
    {
      $set: { aiLastError: error.slice(0, 500), updatedAt: now },
      $setOnInsert: { paused: false },
    },
    { upsert: true },
  );

  // Only stamp the start of the streak on the FIRST failure, so the "down for
  // more than two minutes" check measures the streak rather than the last error.
  await settings.updateOne(
    { _id: "global", $or: [{ aiFailingSince: null }, { aiFailingSince: { $exists: false } }] },
    { $set: { aiFailingSince: now } },
  );

  const current = await settings.findOne({ _id: "global" });
  return current?.aiFailingSince ?? now;
}

/** Clears the failing state after a successful call. */
export async function markAiHealthy(db: Db): Promise<void> {
  await db
    .collection<SettingsDoc>(COLLECTIONS.settings)
    .updateOne(
      { _id: "global" },
      { $set: { aiFailingSince: null, updatedAt: new Date() }, $setOnInsert: { paused: false } },
      { upsert: true },
    );
}

/** How long the AI has been failing, in ms, or null when healthy. */
export async function aiOfflineFor(db: Db): Promise<number | null> {
  const settings = await db.collection<SettingsDoc>(COLLECTIONS.settings).findOne({ _id: "global" });
  if (!settings?.aiFailingSince) return null;
  return Date.now() - settings.aiFailingSince.getTime();
}

/**
 * Classify a batch, with one retry and full bookkeeping.
 *
 * Retry policy: exactly one retry, because a cycle has a 25 second budget and
 * the items are not lost either way — they stay pending and come back next
 * minute. Burning the budget on retries would delay every other source.
 */
export async function classifyBatch(
  db: Db,
  items: CandidateItem[],
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  if (items.length === 0) {
    return { verdicts: [], provider: null, deferred: false };
  }

  const { classifier, model, reason } = await selectProvider(db, opts);
  if (!classifier || !model) {
    log.warn("classifier.deferred", { reason, items: items.length });
    return { verdicts: [], provider: null, deferred: true, reason };
  }

  log.info("classifier.selected", { reason, items: items.length });

  // Bound the call to whichever comes first: our own classify budget or the
  // cycle deadline handed down by the caller.
  const budget = AbortSignal.timeout(limits.classifyBudgetMs);
  const signal = opts.signal ? AbortSignal.any([budget, opts.signal]) : budget;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const verdicts = await classifier.classify(items, { signal });
      await bumpUsage(db, { geminiRequests: 1 }, { model });
      await markAiHealthy(db);

      if (verdicts.length === 0 && attempt === 1) {
        // A valid call that produced zero usable verdicts is worth one retry.
        log.warn("classifier.empty_verdicts", { model, items: items.length });
        continue;
      }

      return { verdicts, provider: classifier.name, deferred: false };
    } catch (err) {
      // A 429 consumed quota and must be counted. A 503 ("model is currently
      // experiencing high load") did NOT — counting those would burn the whole
      // daily allowance without classifying anything.
      if (consumedQuota(err)) await bumpUsage(db, { geminiRequests: 1 }, { model });

      const classifierError = err instanceof ClassifierError ? err : null;
      log.error("classifier.failed", {
        model,
        attempt,
        retryable: classifierError?.retryable ?? true,
        ...errorInfo(err),
      });

      if (attempt === 2 || classifierError?.retryable === false) {
        const since = await markAiFailing(db, (err as Error).message);
        return {
          verdicts: [],
          provider: classifier.name,
          deferred: true,
          reason: `failed since ${since.toISOString()}`,
        };
      }

      // Out of time: do not spend the remaining budget on a second attempt.
      if (signal.aborted) {
        return {
          verdicts: [],
          provider: classifier.name,
          deferred: true,
          reason: "cycle deadline reached; items stay pending",
        };
      }

      // A 429 that named a delay: honour it only if it fits in the budget.
      const wait = classifierError?.retryAfterSeconds;
      if (wait && wait <= 5) await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }

  const since = await markAiFailing(db, "exhausted retries");
  return {
    verdicts: [],
    provider: classifier.name,
    deferred: true,
    reason: `failed since ${since.toISOString()}`,
  };
}

/**
 * dry-run.ts — run one full cycle locally and print what WOULD be alerted.
 *
 * Touches nothing: no Telegram message, no Mongo write. It fetches every
 * enabled source, dedupes within the run, applies the keyword prefilter,
 * classifies the survivors with the real model, and renders the alerts exactly
 * as they would appear on your phone.
 *
 * This is the honest end-to-end check before deploying, and the fastest way to
 * see whether the prompt is drawing the fintech and region lines where you want
 * them on today's real news.
 *
 * Usage: npm run dry-run
 */

import "./_bootstrap";
import { ENABLED_SOURCES, type SourceConfig } from "@/config/sources";
import { fetchAllSources } from "@/lib/feeds/fetch-all";
import { prefilter } from "@/lib/prefilter";
import { keysFor } from "@/lib/dedupe/seen";
import { createGeminiClassifier } from "@/lib/classifier/gemini";
import { toCandidateItem, needsArticleFetch, fetchArticleText } from "@/lib/pipeline/candidate";
import { formatAlert } from "@/lib/alerter/format";
import { env, limits } from "@/lib/env";
import type { RawItem } from "@/lib/feeds/types";
import type { CandidateItem } from "@/lib/classifier/types";
import type { DealDoc } from "@/lib/store/schema";

/** Strip the HTML we render for Telegram back to something readable in a terminal. */
function toPlainText(html: string): string {
  return html
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, "$2 $1")
    .replace(/<\/?[bi]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Free-tier Gemini answers 503 "experiencing high demand" often enough that a
 * single attempt regularly fails. The real pipeline just leaves items pending
 * and retries next cycle; a dry run has no next cycle, so it backs off here
 * instead of reporting a false negative.
 */
async function classifyWithRetries(candidates: CandidateItem[]) {
  const classifier = createGeminiClassifier();
  const fallback = env.geminiFallbackModel;
  const attempts: { model: string; waitMs: number }[] = [
    { model: env.geminiModel, waitMs: 0 },
    { model: env.geminiModel, waitMs: 4000 },
    { model: env.geminiModel, waitMs: 10000 },
    ...(fallback ? [{ model: fallback, waitMs: 2000 }] : []),
  ];

  let lastError: unknown;
  for (const [i, attempt] of attempts.entries()) {
    if (attempt.waitMs > 0) {
      console.log(`  attempt ${i + 1} with ${attempt.model} after ${attempt.waitMs}ms backoff...`);
      await new Promise((r) => setTimeout(r, attempt.waitMs));
    }
    try {
      const active = attempt.model === env.geminiModel ? classifier : createGeminiClassifier(attempt.model);
      return await active.classify(candidates);
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number }).status;
      console.log(`  attempt ${i + 1} failed (${status ?? "network"})`);
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const started = Date.now();
  console.log(`DRY RUN — nothing will be sent or stored.\n`);
  console.log(`Fetching ${ENABLED_SOURCES.length} sources...`);

  const results = await fetchAllSources(ENABLED_SOURCES);

  const bySource = new Map<string, SourceConfig>(ENABLED_SOURCES.map((s) => [s.id, s]));
  const allItems: RawItem[] = [];
  let failed = 0;
  for (const { source, outcome } of results) {
    if (outcome.status === "ok") allItems.push(...outcome.items);
    else if (outcome.status === "error") {
      failed++;
      console.log(`  ! ${source.id}: ${outcome.reason}`);
    }
  }
  console.log(
    `  ${allItems.length} items from ${results.length - failed} sources in ${Date.now() - started}ms\n`,
  );

  // Dedupe within this run only, since we are not reading the seen_items store.
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const unique: RawItem[] = [];
  for (const item of allItems) {
    const { urlKey, titleKey } = keysFor(item);
    if (seenUrls.has(urlKey)) continue;
    if (titleKey && seenTitles.has(titleKey)) continue;
    seenUrls.add(urlKey);
    if (titleKey) seenTitles.add(titleKey);
    unique.push(item);
  }
  console.log(`Dedupe: ${allItems.length} -> ${unique.length} unique\n`);

  const passed = unique.filter((item) => prefilter(item).pass);
  console.log(
    `Prefilter: ${passed.length} of ${unique.length} passed ` +
      `(${((passed.length / unique.length) * 100).toFixed(1)}%)\n`,
  );

  // In a real cycle the bootstrap flag and seen_items keep this small. Here
  // every item in every feed is new, so cap it the same way a cycle would.
  const batch = passed.slice(0, limits.maxClassifierBatch);
  if (batch.length < passed.length) {
    console.log(
      `Classifying the newest ${batch.length} (a real cycle batches ${limits.maxClassifierBatch} ` +
        `at a time and leaves the rest pending).\n`,
    );
  }

  // Enrich the thin ones, within the same per-cycle cap the pipeline uses.
  let fetched = 0;
  const candidates: CandidateItem[] = [];
  for (const [index, item] of batch.entries()) {
    let articleText: string | null = null;
    if (needsArticleFetch(item) && fetched < limits.maxArticleFetchesPerCycle) {
      fetched++;
      articleText = await fetchArticleText(item.link);
    }
    const sourceName = bySource.get(item.sourceId)?.name ?? item.sourceId;
    candidates.push(toCandidateItem(item, `i${index}`, sourceName, articleText));
  }
  if (fetched > 0) console.log(`Fetched ${fetched} article page(s) for thin summaries.\n`);

  if (candidates.length === 0) {
    console.log("Nothing passed the prefilter. No classification needed.");
    return;
  }

  console.log(`Classifying ${candidates.length} items with ${env.geminiModel}...`);
  const classifyStarted = Date.now();
  const verdicts = await classifyWithRetries(candidates);
  console.log(`  done in ${Date.now() - classifyStarted}ms\n`);

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const itemById = new Map(batch.map((item, index) => [`i${index}`, item]));

  const wouldAlert = verdicts.filter(
    (v) => v.relevant && v.confidence >= env.alertMinConfidence,
  );

  console.log("=".repeat(78));
  console.log(`WOULD ALERT: ${wouldAlert.length} of ${verdicts.length} classified`);
  console.log("=".repeat(78));

  for (const verdict of wouldAlert) {
    const item = itemById.get(verdict.id);
    const candidate = byId.get(verdict.id);
    if (!item || !candidate) continue;

    const deal: DealDoc = {
      _id: "dry-run",
      company: verdict.company,
      event: verdict.event ?? "funding",
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
      sources: [],
      alertState: "sent",
      claimedAt: new Date(),
      claimExpiresAt: new Date(),
      lastAlertedAt: new Date(),
      publishedAt: item.publishedAt,
      fetchedAt: new Date(),
      classifiedAt: new Date(),
      alertedAt: new Date(),
      createdAt: new Date(),
    };

    const html = formatAlert({
      deal,
      sourceName: candidate.sourceName,
      link: item.link,
      detectionLatencyMs: item.publishedAt ? Date.now() - item.publishedAt.getTime() : null,
      unverified: false,
    });

    console.log(`\n${toPlainText(html)}`);
    console.log(`  [confidence ${verdict.confidence.toFixed(2)}]`);
  }

  const rejected = verdicts.filter((v) => !wouldAlert.includes(v));
  if (rejected.length > 0) {
    console.log(`\n${"-".repeat(78)}`);
    console.log(`REJECTED (${rejected.length}) — why the classifier said no:`);
    for (const v of rejected.slice(0, 15)) {
      const item = itemById.get(v.id);
      const why = !v.is_fintech
        ? "not fintech"
        : v.region === "other"
          ? `region ${v.region}`
          : !v.event
            ? "not a funding or M&A event"
            : `confidence ${v.confidence.toFixed(2)} below ${env.alertMinConfidence}`;
      console.log(`  - ${(item?.title ?? v.company).slice(0, 62).padEnd(62)} ${why}`);
    }
  }

  console.log(`\nTotal dry run: ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

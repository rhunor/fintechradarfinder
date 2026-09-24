/**
 * drain-queue.ts — classify and publish the whole pending queue now.
 *
 * WHY THIS EXISTS: the poll cycle classifies a batch at a time, on a fraction
 * of cycles, to stay inside Vercel's memory budget. That is right for steady
 * state but wrong after an outage, when a backlog has built up and you want it
 * cleared immediately rather than trickled out over the next hour.
 *
 * This runs the SAME pipeline stages as a cycle — claim, classify, dispatch —
 * so dedupe and the idempotent alert claim still apply. It cannot double-post,
 * and an item already alerted stays alerted.
 *
 * Usage: npm run drain            process everything
 *        npm run drain -- --dry   classify and print, publish nothing
 */

import "./_bootstrap";
import { closeClient, getDb } from "@/lib/store/client";
import { COLLECTIONS } from "@/lib/store/schema";
import { countPending, markAlerted, markClassified, markRejected, returnToPending } from "@/lib/store/candidates";
import { classifyBatch } from "@/lib/classifier";
import { dispatchAlert } from "@/lib/alerter";
import { toCandidateItem } from "@/lib/pipeline/candidate";
import { eventConfig, isEventEnabled } from "@/config/events";
import { env, limits } from "@/lib/env";
import type { CandidateItem } from "@/lib/classifier/types";
import type { CandidateDoc } from "@/lib/store/schema";

const DRY = process.argv.includes("--dry");

async function main(): Promise<void> {
  const db = await getDb();
  const total = await countPending(db);
  console.log(`${total} pending candidate(s)${DRY ? " — DRY RUN, nothing will be published" : ""}\n`);
  if (total === 0) {
    await closeClient();
    return;
  }

  let processed = 0;
  let published = 0;
  let batch = 0;

  // Work through a SNAPSHOT of the queue rather than re-claiming each round.
  //
  // Re-claiming looked natural but was wrong: a dry run returns items to the
  // queue after inspecting them, so the next claim picked the same items up
  // again and the same story was classified seven times. Taking the ids once
  // means every item is considered exactly once per run.
  const snapshot = await db
    .collection<CandidateDoc>(COLLECTIONS.candidates)
    .find({ status: "pending" }, { projection: { _id: 1 } })
    .sort({ fetchedAt: 1 })
    .toArray();
  const queue = snapshot.map((d) => d._id);

  while (queue.length > 0) {
    const ids = queue.splice(0, limits.maxClassifierBatch);
    const pending = await db
      .collection<CandidateDoc>(COLLECTIONS.candidates)
      .find({ _id: { $in: ids }, status: "pending" })
      .toArray();
    if (pending.length === 0) continue;
    batch++;

    const byId = new Map<string, CandidateDoc>();
    const items: CandidateItem[] = pending.map((doc, index) => {
      const id = `i${index}`;
      byId.set(id, doc);
      return toCandidateItem(
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
        null,
      );
    });

    process.stdout.write(`batch ${batch}: classifying ${items.length}... `);
    const started = Date.now();
    const result = await classifyBatch(db, items);
    console.log(`${Date.now() - started}ms`);

    if (result.deferred) {
      console.log(`  deferred (${result.reason}) — returning this batch and stopping`);
      for (const doc of pending) await returnToPending(db, doc._id, { refundAttempt: true });
      break;
    }

    const verdicts = new Map(result.verdicts.map((v) => [v.id, v]));

    for (const [id, doc] of byId) {
      const verdict = verdicts.get(id);
      if (!verdict) {
        await returnToPending(db, doc._id);
        continue;
      }
      processed++;
      await markClassified(db, doc._id, verdict);

      const threshold = verdict.event
        ? Math.max(eventConfig(verdict.event).minConfidence, env.alertMinConfidence)
        : env.alertMinConfidence;
      const allowed = verdict.event !== null && isEventEnabled(verdict.event);
      const shouldAlert = verdict.relevant && allowed && verdict.confidence >= threshold;

      if (!shouldAlert) {
        const why = !verdict.is_fintech
          ? "not fintech"
          : verdict.region === "other"
            ? `region ${verdict.region}`
            : !verdict.event
              ? "not a tracked event"
              : `confidence ${verdict.confidence.toFixed(2)} < ${threshold}`;
        await markRejected(db, doc._id, why);
        continue;
      }

      const event = verdict.event;
      if (!event) continue;

      if (DRY) {
        console.log(`  WOULD PUBLISH  ${eventConfig(event).icon} ${verdict.company} — ${verdict.one_line_summary}`);
        await returnToPending(db, doc._id, { refundAttempt: true });
        continue;
      }

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
        source: { sourceId: doc.sourceId, title: doc.title, link: doc.link, publishedAt: doc.publishedAt },
        publishedAt: doc.publishedAt,
        fetchedAt: doc.fetchedAt,
        classifiedAt: new Date(),
      });

      if (dispatch.sent) {
        published++;
        await markAlerted(db, doc._id);
        console.log(`  PUBLISHED  ${eventConfig(event).icon} ${verdict.company} — ${verdict.one_line_summary}`);
      } else if (dispatch.skipped === "duplicate" || dispatch.skipped === "in-flight") {
        // Genuinely already covered: another source reported the same deal.
        await markRejected(db, doc._id, `duplicate deal (${dispatch.skipped})`);
        console.log(`  duplicate  ${verdict.company}`);
      } else {
        // A send failure is Telegram's problem or the network's, not the
        // item's. Rejecting it here would lose the alert permanently, which is
        // exactly what happened on the first run: two real deals were dropped
        // because a transient send error was treated as a verdict.
        await returnToPending(db, doc._id, { refundAttempt: true });
        console.log(`  RETRY      ${verdict.company} (send failed: ${dispatch.skipped})`);
      }

      // Telegram allows roughly 20 messages a minute to one chat. Pace the
      // backlog so a burst does not trip the rate limit mid-drain.
      if (!DRY) await new Promise((r) => setTimeout(r, 3500));
    }
  }

  console.log(`\nclassified ${processed}, published ${published}, still pending ${await countPending(db)}`);
  await closeClient();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

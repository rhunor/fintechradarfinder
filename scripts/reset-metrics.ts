/**
 * reset-metrics.ts — clear accumulated usage counters.
 *
 * WHY YOU NEED THIS: local development and the deployed app share one Atlas
 * database, so cycles you ran on your laptop land in the same daily_usage
 * documents as production. Laptop cycles are slow and failure-heavy, which
 * drags the Vercel projection into nonsense — during development this repo's
 * own numbers projected 142% of the CPU limit purely from local test runs.
 *
 * Run this once after deploying, so the projection in /status and the daily
 * summary describes the deployed app and nothing else.
 *
 * It only clears counters. Seen items, candidates and deals are untouched, so
 * nothing is re-alerted.
 *
 * Usage: npm run db:reset-metrics
 */

import "./_bootstrap";
import { closeClient, getDb } from "@/lib/store/client";
import { COLLECTIONS } from "@/lib/store/schema";

async function main(): Promise<void> {
  const db = await getDb();

  const usage = await db.collection(COLLECTIONS.dailyUsage).deleteMany({});
  console.log(`Cleared ${usage.deletedCount} daily usage document(s).`);

  // The cycle heartbeat would otherwise report a huge gap on the first real
  // cycle, and the stale-warning timers would suppress genuine warnings.
  await db.collection(COLLECTIONS.settings).updateOne(
    { _id: "global" as unknown as never },
    { $unset: { lastCycleAt: "", lastCycleDurationMs: "", lastBudgetWarningAt: "" } },
  );
  console.log("Reset cycle heartbeat and budget warning timer.");

  const state = await db
    .collection(COLLECTIONS.sourceState)
    .updateMany({}, { $unset: { lastStaleWarningAt: "" }, $set: { errorCount: 0 } });
  console.log(`Reset warning timers on ${state.modifiedCount} source(s).`);

  console.log("\nSeen items, candidates and deals were left alone — nothing will be re-alerted.");
  await closeClient();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

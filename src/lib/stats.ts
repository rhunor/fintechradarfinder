/**
 * stats.ts — latency percentiles and recent-activity counts.
 *
 * The number that matters is published -> alerted: how long after a story went
 * live did it reach your phone. p50 shows the typical case, p95 shows the tail
 * that a median would hide.
 */

import type { Db } from "mongodb";
import { COLLECTIONS, type DealDoc } from "@/lib/store/schema";

export interface LatencyStats {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
}

/**
 * Nearest-rank percentile on a sorted array.
 *
 * Deliberately not interpolating: with a handful of alerts a day, an
 * interpolated p95 invents a number that no actual alert ever had.
 */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? null;
}

/** Latency from publication to alert over the last `days` days. */
export async function latencyStats(db: Db, days: number): Promise<LatencyStats> {
  const since = new Date(Date.now() - days * 86_400_000);
  const deals = await db
    .collection<DealDoc>(COLLECTIONS.deals)
    .find(
      { alertState: "sent", alertedAt: { $gte: since }, publishedAt: { $ne: null } },
      { projection: { publishedAt: 1, alertedAt: 1 } },
    )
    .toArray();

  const latencies = deals
    .map((d) =>
      d.alertedAt && d.publishedAt ? d.alertedAt.getTime() - d.publishedAt.getTime() : null,
    )
    // A negative latency means the feed's timestamp was wrong, not that we
    // alerted before publication. Excluding those keeps the stats honest.
    .filter((ms): ms is number => ms !== null && ms >= 0)
    .sort((a, b) => a - b);

  return {
    count: latencies.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    minMs: latencies[0] ?? null,
    maxMs: latencies[latencies.length - 1] ?? null,
  };
}

export async function countAlertsSince(db: Db, since: Date): Promise<number> {
  return db
    .collection<DealDoc>(COLLECTIONS.deals)
    .countDocuments({ alertState: "sent", alertedAt: { $gte: since } });
}

/**
 * meter.ts — measures what each cycle costs, and projects it against the
 * Vercel Hobby limits.
 *
 * WHY THIS EXISTS: going over a Hobby limit pauses your functions for weeks.
 * That is a far worse outcome than being a bit slow, so the system measures its
 * own consumption every cycle and warns long before the cliff.
 *
 * THE TWO METERS ARE DIFFERENT, and confusing them is the classic mistake:
 *
 *   Active CPU    — actual processor time. Measured with process.cpuUsage().
 *                   Time spent waiting on a feed or the AI does NOT count.
 *                   Our work is almost all waiting, so this should stay tiny.
 *
 *   Provisioned Memory — memory size multiplied by WALL-CLOCK time, including
 *                   every millisecond spent waiting on the network. This is the
 *                   limit that actually binds us, because a cycle that waits
 *                   20 seconds on Gemini is billed for 20 seconds at 2GB.
 */

import type { Db } from "mongodb";
import { bumpUsage, getUsage } from "@/lib/store/usage";
import type { DailyUsageDoc } from "@/lib/store/schema";

/** Vercel Hobby monthly allowances. */
export const HOBBY_LIMITS = {
  activeCpuHours: 4,
  provisionedMemoryGbHours: 360,
  invocations: 1_000_000,
} as const;

/** Functions run at 2GB unless configured otherwise. */
export const FUNCTION_MEMORY_GB = 2;

/** Warn once projected usage passes this share of a limit. */
export const WARN_THRESHOLD = 0.7;

export interface CycleMeasurement {
  wallMs: number;
  cpuMs: number;
}

/**
 * Start measuring. Call the returned function when the cycle ends.
 *
 * process.cpuUsage() returns microseconds of user + system CPU consumed by
 * this process. Taking a delta gives us this cycle's share even on a warm
 * container that has already run many cycles.
 */
export function startMeter(): () => CycleMeasurement {
  const wallStart = Date.now();
  const cpuStart = process.cpuUsage();

  return () => {
    const cpu = process.cpuUsage(cpuStart);
    return {
      wallMs: Date.now() - wallStart,
      // user + system, converted from microseconds.
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    };
  };
}

export interface Projection {
  /** Cycles observed so far in the sampled period. */
  cycles: number;
  avgWallMs: number;
  avgCpuMs: number;
  /** Extrapolated to a full month at one cycle per minute. */
  projectedCpuHours: number;
  projectedGbHours: number;
  projectedInvocations: number;
  cpuPercent: number;
  memoryPercent: number;
  invocationPercent: number;
  /** True when either headline meter is projected past the warning threshold. */
  warn: boolean;
}

/** Cycles per month at one per minute, which is what the scheduler does. */
export const CYCLES_PER_MONTH = 60 * 24 * 30;

/**
 * Project a month's usage from observed averages.
 *
 * Uses the observed average cycle cost rather than the day's raw totals,
 * because a partial day would otherwise project a misleadingly small month.
 */
export function project(usage: DailyUsageDoc): Projection {
  const cycles = Math.max(usage.cycles, 1);
  const avgWallMs = usage.wallMs / cycles;
  const avgCpuMs = usage.cpuMs / cycles;

  const projectedCpuHours = (avgCpuMs * CYCLES_PER_MONTH) / 1000 / 3600;
  const projectedGbHours = ((avgWallMs * CYCLES_PER_MONTH) / 1000 / 3600) * FUNCTION_MEMORY_GB;
  const projectedInvocations = CYCLES_PER_MONTH;

  const cpuPercent = (projectedCpuHours / HOBBY_LIMITS.activeCpuHours) * 100;
  const memoryPercent = (projectedGbHours / HOBBY_LIMITS.provisionedMemoryGbHours) * 100;
  const invocationPercent = (projectedInvocations / HOBBY_LIMITS.invocations) * 100;

  return {
    cycles: usage.cycles,
    avgWallMs: Math.round(avgWallMs),
    avgCpuMs: Math.round(avgCpuMs),
    projectedCpuHours,
    projectedGbHours,
    projectedInvocations,
    cpuPercent,
    memoryPercent,
    invocationPercent,
    warn: cpuPercent > WARN_THRESHOLD * 100 || memoryPercent > WARN_THRESHOLD * 100,
  };
}

export async function recordCycleCost(
  db: Db,
  measurement: CycleMeasurement,
  extra: { itemsSeen?: number; candidates?: number } = {},
): Promise<void> {
  await bumpUsage(db, {
    cycles: 1,
    wallMs: measurement.wallMs,
    cpuMs: measurement.cpuMs,
    ...extra,
  });
}

export async function currentProjection(db: Db): Promise<Projection> {
  return project(await getUsage(db));
}

/** One-line summary for logs, /status and the daily digest. */
export function formatProjection(p: Projection): string {
  return (
    `avg ${p.avgWallMs}ms wall / ${p.avgCpuMs}ms cpu over ${p.cycles} cycles — ` +
    `projected CPU ${p.projectedCpuHours.toFixed(2)}h of ${HOBBY_LIMITS.activeCpuHours}h (${p.cpuPercent.toFixed(0)}%), ` +
    `memory ${p.projectedGbHours.toFixed(0)} of ${HOBBY_LIMITS.provisionedMemoryGbHours} GB-h (${p.memoryPercent.toFixed(0)}%)`
  );
}

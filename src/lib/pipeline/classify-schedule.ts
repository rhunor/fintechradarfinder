/**
 * classify-schedule.ts — decides WHEN the AI may be called. One rule, one clock.
 *
 * WHY THIS REPLACED THE OLD GATES: classification used to pass two independent
 * checks — "only on every Nth cycle" (to save Vercel memory) and "only in the
 * first minute of each backoff window" (to stop hammering a failing AI). Both
 * were modular arithmetic on different counters. With N=5 and a 15-minute
 * backoff cap, 15 is a multiple of 5, so depending on the minute the AI first
 * failed the two windows lined up every time or NEVER. In production that
 * stopped all classification for ~14 hours on Sep 30: 1440 cycles, 464 stories
 * queued, zero AI calls — then a burst of stale alerts when the counters drifted
 * into alignment.
 *
 * Now there is a single stored timestamp, `nextClassifyAt`. A cycle classifies
 * if and only if the clock has passed it. After a success it moves forward by
 * the normal interval; after a failure by a bounded, growing backoff. A plain
 * time comparison cannot fall out of alignment with anything.
 */

/** First retry after a failure. */
export const BACKOFF_BASE_MS = 60_000;
/** Never wait longer than this between attempts, however long the outage. */
export const BACKOFF_MAX_MS = 10 * 60_000;

/**
 * Delay before the next attempt after `consecutiveFailures` failures in a row:
 * 1, 2, 4, 8, then capped at 10 minutes.
 */
export function backoffDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_MAX_MS);
}

/** Should this cycle call the AI? */
export function isClassifyDue(nextClassifyAt: Date | null | undefined, now: Date): boolean {
  return !nextClassifyAt || now.getTime() >= nextClassifyAt.getTime();
}

export type ClassifyOutcome = "success" | "failure";

/** When the next attempt is allowed, given what just happened. */
export function nextClassifyTime(
  outcome: ClassifyOutcome,
  consecutiveFailures: number,
  intervalMs: number,
  now: Date,
): { nextClassifyAt: Date; consecutiveFailures: number } {
  if (outcome === "success") {
    return { nextClassifyAt: new Date(now.getTime() + intervalMs), consecutiveFailures: 0 };
  }
  const failures = consecutiveFailures + 1;
  return { nextClassifyAt: new Date(now.getTime() + backoffDelayMs(failures)), consecutiveFailures: failures };
}

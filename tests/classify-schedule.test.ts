/**
 * classify-schedule.test.ts — when the AI may be called.
 *
 * The lockout test at the bottom is a regression test for a real incident: two
 * independent "every Nth" gates could never line up, and classification
 * stopped for ~14 hours while 464 stories queued. It simulates a full day of
 * one-minute cycles with the AI failing at every possible minute and asserts
 * the AI is always asked again within the backoff cap.
 */

import { describe, expect, it } from "vitest";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  backoffDelayMs,
  isClassifyDue,
  nextClassifyTime,
} from "@/lib/pipeline/classify-schedule";

const MIN = 60_000;
const t0 = new Date("2026-10-01T12:00:00Z");

describe("backoffDelayMs", () => {
  it("is zero with no failures", () => {
    expect(backoffDelayMs(0)).toBe(0);
  });

  it("doubles from one minute", () => {
    expect(backoffDelayMs(1)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(2)).toBe(2 * MIN);
    expect(backoffDelayMs(3)).toBe(4 * MIN);
    expect(backoffDelayMs(4)).toBe(8 * MIN);
  });

  it("is capped, however long the outage", () => {
    expect(backoffDelayMs(5)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelayMs(500)).toBe(BACKOFF_MAX_MS);
  });
});

describe("isClassifyDue", () => {
  it("is due when nothing has been scheduled yet", () => {
    expect(isClassifyDue(undefined, t0)).toBe(true);
    expect(isClassifyDue(null, t0)).toBe(true);
  });

  it("waits until the scheduled time, then is due", () => {
    const at = new Date(t0.getTime() + 3 * MIN);
    expect(isClassifyDue(at, new Date(t0.getTime() + 2 * MIN))).toBe(false);
    expect(isClassifyDue(at, at)).toBe(true);
    expect(isClassifyDue(at, new Date(t0.getTime() + 4 * MIN))).toBe(true);
  });
});

describe("nextClassifyTime", () => {
  it("schedules the normal interval after a success and clears the streak", () => {
    const next = nextClassifyTime("success", 4, 5 * MIN, t0);
    expect(next.consecutiveFailures).toBe(0);
    expect(next.nextClassifyAt.getTime() - t0.getTime()).toBe(5 * MIN);
  });

  it("backs off further with each consecutive failure", () => {
    const first = nextClassifyTime("failure", 0, 5 * MIN, t0);
    const second = nextClassifyTime("failure", first.consecutiveFailures, 5 * MIN, t0);
    expect(first.consecutiveFailures).toBe(1);
    expect(second.consecutiveFailures).toBe(2);
    expect(second.nextClassifyAt.getTime()).toBeGreaterThan(first.nextClassifyAt.getTime());
  });
});

describe("regression: the AI can never be locked out", () => {
  /**
   * Run one-minute cycles for a day. The AI fails for `outageMinutes` starting
   * at `failAt`, then recovers. Return how long after recovery it was first
   * called successfully.
   */
  function minutesToFirstSuccessAfterRecovery(failAt: number, outageMinutes: number, intervalMin: number) {
    let nextClassifyAt: Date | null = null;
    let failures = 0;
    const recoverAt = failAt + outageMinutes;
    for (let minute = 0; minute < 24 * 60; minute++) {
      const now = new Date(t0.getTime() + minute * MIN);
      if (!isClassifyDue(nextClassifyAt, now)) continue;
      const failing = minute >= failAt && minute < recoverAt;
      const next = nextClassifyTime(failing ? "failure" : "success", failures, intervalMin * MIN, now);
      nextClassifyAt = next.nextClassifyAt;
      failures = next.consecutiveFailures;
      if (!failing && minute >= recoverAt) return minute - recoverAt;
    }
    return Infinity;
  }

  it.each([3, 5])("with a %i-minute interval, recovers promptly whatever minute the outage began", (interval) => {
    const capMinutes = BACKOFF_MAX_MS / MIN;
    for (let failAt = 0; failAt < 60; failAt++) {
      for (const outage of [1, 7, 30, 180]) {
        const wait = minutesToFirstSuccessAfterRecovery(failAt, outage, interval);
        // Under the old gates, some (failAt, interval) pairs returned Infinity.
        expect(wait, `failAt=${failAt} outage=${outage}`).toBeLessThanOrEqual(Math.max(capMinutes, interval));
      }
    }
  });
});

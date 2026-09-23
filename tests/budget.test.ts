/**
 * budget.test.ts — the Hobby usage projection.
 *
 * Getting this wrong is expensive in a specific way: understating usage means
 * no warning before Vercel pauses the functions for the rest of the month.
 * The two meters are easy to confuse, so they are pinned separately here.
 */

import { describe, expect, it } from "vitest";
import {
  CYCLES_PER_MONTH,
  FUNCTION_MEMORY_GB,
  HOBBY_LIMITS,
  project,
  startMeter,
} from "@/lib/budget/meter";
import type { DailyUsageDoc } from "@/lib/store/schema";

function usage(cycles: number, wallMs: number, cpuMs: number): DailyUsageDoc {
  return {
    _id: "2026-09-23",
    geminiRequests: 0,
    modelRequests: {},
    cycles,
    wallMs,
    cpuMs,
    itemsSeen: 0,
    candidates: 0,
    alerts: 0,
    updatedAt: new Date(),
  };
}

describe("startMeter", () => {
  it("reports wall time and CPU time separately", () => {
    const stop = startMeter();
    // Busy-wait so CPU time is genuinely consumed, not just elapsed.
    const until = Date.now() + 30;
    let n = 0;
    while (Date.now() < until) n += Math.sqrt(n + 1);
    const m = stop();
    expect(m.wallMs).toBeGreaterThanOrEqual(25);
    expect(m.cpuMs).toBeGreaterThan(0);
  });

  it("does not count time spent awaiting as CPU", async () => {
    // This is the property the whole budget model rests on: waiting on a feed
    // or the AI costs memory time but not Active CPU.
    const stop = startMeter();
    await new Promise((r) => setTimeout(r, 120));
    const m = stop();
    expect(m.wallMs).toBeGreaterThanOrEqual(100);
    expect(m.cpuMs).toBeLessThan(50);
  });
});

describe("project", () => {
  it("extrapolates average cycle cost to a full month", () => {
    // 100 cycles averaging 2s wall and 50ms CPU.
    const p = project(usage(100, 200_000, 5_000));
    expect(p.avgWallMs).toBe(2000);
    expect(p.avgCpuMs).toBe(50);

    // CPU: 50ms x 43,200 cycles = 2,160s = 0.6h
    expect(p.projectedCpuHours).toBeCloseTo(0.6, 2);
    // Memory: 2s x 43,200 = 86,400s = 24h, at 2GB = 48 GB-hours
    expect(p.projectedGbHours).toBeCloseTo(48, 1);
  });

  it("reports each meter as a percentage of its own limit", () => {
    const p = project(usage(100, 200_000, 5_000));
    expect(p.cpuPercent).toBeCloseTo((0.6 / HOBBY_LIMITS.activeCpuHours) * 100, 1);
    expect(p.memoryPercent).toBeCloseTo((48 / HOBBY_LIMITS.provisionedMemoryGbHours) * 100, 1);
  });

  it("does not warn while usage is comfortable", () => {
    expect(project(usage(100, 200_000, 5_000)).warn).toBe(false);
  });

  it("warns once projected CPU passes 70% of the limit", () => {
    // 4h limit x 70% = 2.8h. Need avg CPU above 2.8*3600*1000/43200 = 233ms.
    const p = project(usage(100, 200_000, 100 * 250));
    expect(p.projectedCpuHours).toBeGreaterThan(HOBBY_LIMITS.activeCpuHours * 0.7);
    expect(p.warn).toBe(true);
  });

  it("warns once projected memory passes 70% of the limit", () => {
    // 360 GB-h x 70% = 252. At 2GB that needs avg wall above 10.5s.
    const p = project(usage(100, 100 * 11_000, 1_000));
    expect(p.projectedGbHours).toBeGreaterThan(HOBBY_LIMITS.provisionedMemoryGbHours * 0.7);
    expect(p.warn).toBe(true);
  });

  it("stays inside every limit at the measured idle cost", () => {
    // The real floor measured locally: ~30ms CPU, and ~1.5s wall once the
    // database is in the same region as the function.
    const p = project(usage(100, 100 * 1_500, 100 * 30));
    expect(p.projectedCpuHours).toBeLessThan(HOBBY_LIMITS.activeCpuHours);
    expect(p.projectedGbHours).toBeLessThan(HOBBY_LIMITS.provisionedMemoryGbHours);
    expect(p.warn).toBe(false);
  });

  it("never divides by zero on a day with no cycles yet", () => {
    const p = project(usage(0, 0, 0));
    expect(p.avgWallMs).toBe(0);
    expect(p.projectedCpuHours).toBe(0);
  });

  it("uses one invocation per minute for the month", () => {
    expect(CYCLES_PER_MONTH).toBe(43_200);
    expect(project(usage(10, 1000, 100)).projectedInvocations).toBe(43_200);
    expect(FUNCTION_MEMORY_GB).toBe(2);
  });
});

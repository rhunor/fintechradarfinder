/**
 * usage.ts — the daily counters behind /status, the daily summary and the
 * free-tier guards.
 *
 * WHY MONGO AND NOT MEMORY: there is no memory between serverless invocations.
 * A counter in a module variable would reset every time Vercel spins up a new
 * container, so "how many Gemini requests today" has to live in the database.
 *
 * One document per UTC day, updated with $inc so concurrent cycles cannot lose
 * counts. The day key is UTC deliberately — Gemini's free-tier quota resets at
 * UTC midnight, so counting in local time would let us overshoot.
 */

import type { Db } from "mongodb";
import { COLLECTIONS, type DailyUsageDoc } from "@/lib/store/schema";

export function utcDayKey(when: Date = new Date()): string {
  return when.toISOString().slice(0, 10);
}

/**
 * MongoDB treats a dot in a field name as a path separator, and every Gemini
 * model id contains one ("gemini-3.5-flash-lite"). Without this, $inc would
 * silently create nested objects instead of a counter.
 */
export function modelKey(model: string): string {
  return model.replace(/\./g, "_");
}

export type UsageCounters = Partial<
  Pick<
    DailyUsageDoc,
    "geminiRequests" | "cycles" | "wallMs" | "cpuMs" | "itemsSeen" | "candidates" | "alerts"
  >
>;

const ALL_COUNTERS = [
  "geminiRequests",
  "cycles",
  "wallMs",
  "cpuMs",
  "itemsSeen",
  "candidates",
  "alerts",
] as const;

/** Atomically add to today's counters, creating the document if needed. */
export async function bumpUsage(
  db: Db,
  counters: UsageCounters,
  opts: { model?: string; when?: Date } = {},
): Promise<void> {
  const when = opts.when ?? new Date();
  const key = utcDayKey(when);

  const inc: Record<string, number> = {};
  for (const [field, value] of Object.entries(counters)) {
    if (typeof value === "number" && value !== 0) inc[field] = value;
  }
  // Per-model breakdown rides along with the request counter.
  if (opts.model && counters.geminiRequests) {
    inc[`modelRequests.${modelKey(opts.model)}`] = counters.geminiRequests;
  }
  if (Object.keys(inc).length === 0) return;

  await db.collection<DailyUsageDoc>(COLLECTIONS.dailyUsage).updateOne(
    { _id: key },
    {
      $inc: inc,
      $set: { updatedAt: when },
      // Ensure every field exists even on a day that only touched one counter,
      // so readers never have to defend against undefined.
      $setOnInsert: zeroedExcept(Object.keys(inc)),
    },
    { upsert: true },
  );
}

/**
 * $inc and $setOnInsert may not touch the same field, so the insert defaults
 * cover only the counters this call is NOT incrementing.
 */
function zeroedExcept(incremented: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ALL_COUNTERS) {
    if (!incremented.includes(field)) out[field] = 0;
  }
  // Only seed the map when this call is not already writing into it.
  if (!incremented.some((f) => f.startsWith("modelRequests."))) out["modelRequests"] = {};
  return out;
}

export function emptyUsage(key: string): DailyUsageDoc {
  return {
    _id: key,
    geminiRequests: 0,
    modelRequests: {},
    cycles: 0,
    wallMs: 0,
    cpuMs: 0,
    itemsSeen: 0,
    candidates: 0,
    alerts: 0,
    updatedAt: new Date(0),
  };
}

export async function getUsage(db: Db, when: Date = new Date()): Promise<DailyUsageDoc> {
  const key = utcDayKey(when);
  const doc = await db.collection<DailyUsageDoc>(COLLECTIONS.dailyUsage).findOne({ _id: key });
  if (!doc) return emptyUsage(key);
  // Documents written before modelRequests existed have no map.
  return { ...doc, modelRequests: doc.modelRequests ?? {} };
}

/** How many requests a specific model has used today. */
export function requestsForModel(usage: DailyUsageDoc, model: string): number {
  return usage.modelRequests[modelKey(model)] ?? 0;
}

/** The last `days` days of usage, newest first. Used by the daily summary. */
export async function getRecentUsage(db: Db, days: number): Promise<DailyUsageDoc[]> {
  const docs = await db
    .collection<DailyUsageDoc>(COLLECTIONS.dailyUsage)
    .find({})
    .sort({ _id: -1 })
    .limit(days)
    .toArray();
  return docs.map((d) => ({ ...d, modelRequests: d.modelRequests ?? {} }));
}

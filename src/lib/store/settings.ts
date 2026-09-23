/**
 * settings.ts — the singleton runtime flags, and the cycle heartbeat.
 *
 * Tiny on purpose: one document, id "global". It holds the paused flag (so
 * /pause works without a deploy) and the last-cycle timestamps used to notice
 * when the external scheduler has stopped calling us.
 */

import type { Db } from "mongodb";
import { COLLECTIONS, type SettingsDoc } from "@/lib/store/schema";

/** A gap longer than this between cycles means the scheduler missed calls. */
export const SCHEDULER_GAP_THRESHOLD_MS = 5 * 60 * 1000;

export async function getSettings(db: Db): Promise<SettingsDoc> {
  const doc = await db.collection<SettingsDoc>(COLLECTIONS.settings).findOne({ _id: "global" });
  return doc ?? { _id: "global", paused: false, updatedAt: new Date(0) };
}

export async function setPaused(db: Db, paused: boolean): Promise<void> {
  await db
    .collection<SettingsDoc>(COLLECTIONS.settings)
    .updateOne({ _id: "global" }, { $set: { paused, updatedAt: new Date() } }, { upsert: true });
}

export interface Heartbeat {
  previousCycleAt: Date | null;
  /** Milliseconds since the last cycle, or null on the very first one. */
  gapMs: number | null;
  /** True when the gap exceeds the threshold, i.e. the scheduler skipped us. */
  gapDetected: boolean;
}

/**
 * Record that a cycle is starting and report the gap since the last one.
 *
 * Reading the previous value before overwriting is the whole point: it is the
 * only way a stateless function can notice that it was not called for ten
 * minutes.
 */
export async function beatHeartbeat(db: Db, now: Date = new Date()): Promise<Heartbeat> {
  const previous = await db
    .collection<SettingsDoc>(COLLECTIONS.settings)
    .findOneAndUpdate(
      { _id: "global" },
      { $set: { lastCycleAt: now }, $setOnInsert: { paused: false, updatedAt: now } },
      { upsert: true, returnDocument: "before" },
    );

  const previousCycleAt = previous?.lastCycleAt ?? null;
  const gapMs = previousCycleAt ? now.getTime() - previousCycleAt.getTime() : null;

  return {
    previousCycleAt,
    gapMs,
    gapDetected: gapMs !== null && gapMs > SCHEDULER_GAP_THRESHOLD_MS,
  };
}

export async function recordCycleDuration(db: Db, durationMs: number): Promise<void> {
  await db
    .collection<SettingsDoc>(COLLECTIONS.settings)
    .updateOne({ _id: "global" }, { $set: { lastCycleDurationMs: durationMs } });
}

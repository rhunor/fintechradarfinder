/**
 * source-state.ts — what each feed remembers between invocations.
 *
 * WHY IT MATTERS FOR COST: the validators stored here (ETag, Last-Modified,
 * body hash) are what let a cycle answer "has anything changed?" in one cheap
 * round trip instead of downloading and parsing every feed. Losing this state
 * would turn every cycle into a full fetch of 19 feeds.
 *
 * It also carries health: last success, consecutive errors, and the bootstrap
 * flag that stops a newly added source flooding the chat with old news.
 */

import type { AnyBulkWriteOperation, Db } from "mongodb";
import { COLLECTIONS, type SourceStateDoc } from "@/lib/store/schema";
import type { SourceConfig } from "@/config/sources";
import type { SourceValidators } from "@/lib/feeds/types";

/**
 * Load every source's state in ONE query.
 *
 * Deliberately not one lookup per source: 19 round trips to Atlas would cost
 * more wall-clock time than the feed fetches themselves, and wall time is what
 * Vercel bills for.
 */
export async function loadAllSourceState(db: Db): Promise<Map<string, SourceStateDoc>> {
  const docs = await db.collection<SourceStateDoc>(COLLECTIONS.sourceState).find({}).toArray();
  return new Map(docs.map((doc) => [doc._id, doc]));
}

export function validatorsFrom(state: SourceStateDoc | undefined): SourceValidators {
  if (!state) return {};
  return {
    etag: state.etag,
    lastModified: state.lastModified,
    bodyHash: state.bodyHash,
  };
}

/**
 * Which sources are due, given their per-source minimum interval.
 *
 * A source with no state has never been fetched, so it is always due — that is
 * what triggers its bootstrap.
 */
export function dueSources(
  sources: readonly SourceConfig[],
  state: Map<string, SourceStateDoc>,
  now: Date = new Date(),
): SourceConfig[] {
  return sources.filter((source) => {
    const last = state.get(source.id)?.lastCheckedAt;
    if (!last) return true;
    return now.getTime() - last.getTime() >= source.minIntervalSeconds * 1000;
  });
}

export async function recordFetchSuccess(
  db: Db,
  sourceId: string,
  validators: SourceValidators,
  now: Date = new Date(),
): Promise<void> {
  const set: Record<string, unknown> = {
    lastCheckedAt: now,
    lastSuccessAt: now,
    errorCount: 0,
  };
  // Only overwrite a validator when the response actually carried one. A server
  // that stops sending ETag must not silently wipe the Last-Modified we still
  // have, or we would lose conditional GET for that source entirely.
  if (validators.etag !== undefined) set["etag"] = validators.etag;
  if (validators.lastModified !== undefined) set["lastModified"] = validators.lastModified;
  if (validators.bodyHash !== undefined) set["bodyHash"] = validators.bodyHash;

  await db
    .collection<SourceStateDoc>(COLLECTIONS.sourceState)
    .updateOne(
      { _id: sourceId },
      { $set: set, $unset: { lastError: "" }, $setOnInsert: { bootstrapped: false } },
      { upsert: true },
    );
}

/** A 304 or an unchanged body hash: healthy, but nothing to parse. */
export async function recordNotModified(
  db: Db,
  sourceId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .collection<SourceStateDoc>(COLLECTIONS.sourceState)
    .updateOne(
      { _id: sourceId },
      {
        $set: { lastCheckedAt: now, lastSuccessAt: now, errorCount: 0 },
        $setOnInsert: { bootstrapped: false },
      },
      { upsert: true },
    );
}

export async function recordFetchError(
  db: Db,
  sourceId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await db.collection<SourceStateDoc>(COLLECTIONS.sourceState).updateOne(
    { _id: sourceId },
    {
      // lastCheckedAt advances even on failure, so a persistently broken feed
      // is retried on its normal interval rather than on every single cycle.
      $set: { lastCheckedAt: now, lastError: reason.slice(0, 300) },
      $inc: { errorCount: 1 },
      $setOnInsert: { bootstrapped: false },
    },
    { upsert: true },
  );
}

/**
 * How many consecutive failures a source must have before it is called
 * unhealthy, on top of being silent for the whole window.
 *
 * WHY BOTH CONDITIONS: elapsed time alone is a noisy signal. Feeds sit behind
 * CDNs, and an occasional slow origin fetch can leave a perfectly healthy
 * source without a success for a quarter of an hour. errorCount resets to zero
 * on any success, so requiring it to be high means we only warn about a source
 * that is failing repeatedly rather than one that is merely unlucky.
 */
export const MIN_CONSECUTIVE_ERRORS_TO_WARN = 3;

/** Sources with no successful fetch inside the window, for health warnings. */
export function staleSources(
  sources: readonly SourceConfig[],
  state: Map<string, SourceStateDoc>,
  windowMs: number,
  now: Date = new Date(),
): { source: SourceConfig; lastSuccessAt: Date | null; lastError?: string }[] {
  const stale: { source: SourceConfig; lastSuccessAt: Date | null; lastError?: string }[] = [];
  for (const source of sources) {
    const doc = state.get(source.id);
    const lastSuccess = doc?.lastSuccessAt ?? null;
    if (lastSuccess && now.getTime() - lastSuccess.getTime() < windowMs) continue;
    // A source that has never run is not "stale" until it has had a chance.
    if (!doc) continue;
    // Silent AND repeatedly failing, not merely silent.
    if (doc.errorCount < MIN_CONSECUTIVE_ERRORS_TO_WARN) continue;
    const entry: { source: SourceConfig; lastSuccessAt: Date | null; lastError?: string } = {
      source,
      lastSuccessAt: lastSuccess,
    };
    if (doc.lastError) entry.lastError = doc.lastError;
    stale.push(entry);
  }
  return stale;
}

/** Rate-limit the stale warning to one per source per hour. */
export async function claimStaleWarning(
  db: Db,
  sourceId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const res = await db.collection<SourceStateDoc>(COLLECTIONS.sourceState).updateOne(
    {
      _id: sourceId,
      $or: [{ lastStaleWarningAt: { $lte: cutoff } }, { lastStaleWarningAt: { $exists: false } }],
    },
    { $set: { lastStaleWarningAt: now } },
  );
  return res.modifiedCount === 1;
}

/**
 * Per-source outcomes to persist at the end of a cycle.
 */
export type SourceWrite =
  | { kind: "success"; sourceId: string; validators: SourceValidators }
  | { kind: "not-modified"; sourceId: string }
  | { kind: "error"; sourceId: string; reason: string };

/**
 * Write every source's state in ONE round trip.
 *
 * WHY THIS REPLACED PER-SOURCE UPDATES: the first live cycle issued 19
 * sequential updateOne calls and spent 6 seconds on them alone, pushing the
 * cycle past its wall-clock budget. Wall time is exactly what Vercel bills for
 * on the Provisioned Memory meter, so nineteen round trips is not a style
 * problem, it is the second largest cost in the cycle after the AI call.
 */
export async function writeSourceStates(
  db: Db,
  writes: SourceWrite[],
  now: Date = new Date(),
): Promise<void> {
  if (writes.length === 0) return;

  const ops: AnyBulkWriteOperation<SourceStateDoc>[] = writes.map((write) => {
    if (write.kind === "error") {
      return {
        updateOne: {
          filter: { _id: write.sourceId },
          update: {
            // lastCheckedAt advances even on failure, so a persistently broken
            // feed retries on its normal interval, not on every cycle.
            $set: { lastCheckedAt: now, lastError: write.reason.slice(0, 300) },
            $inc: { errorCount: 1 },
            $setOnInsert: { bootstrapped: false },
          },
          upsert: true,
        },
      };
    }

    const set: Record<string, unknown> = {
      lastCheckedAt: now,
      lastSuccessAt: now,
      errorCount: 0,
    };
    if (write.kind === "success") {
      // Only overwrite a validator the response actually carried: a server
      // that stops sending ETag must not wipe the Last-Modified we still have.
      const v = write.validators;
      if (v.etag !== undefined) set["etag"] = v.etag;
      if (v.lastModified !== undefined) set["lastModified"] = v.lastModified;
      if (v.bodyHash !== undefined) set["bodyHash"] = v.bodyHash;
    }

    return {
      updateOne: {
        filter: { _id: write.sourceId },
        update: {
          $set: set,
          $unset: { lastError: "" },
          $setOnInsert: { bootstrapped: false },
        },
        upsert: true,
      },
    };
  });

  await db.collection<SourceStateDoc>(COLLECTIONS.sourceState).bulkWrite(ops, { ordered: false });
}

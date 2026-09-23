/**
 * candidates.ts — the work queue between "this looks interesting" and "alerted".
 *
 * WHY A PERSISTED QUEUE AND NOT JUST IN-MEMORY: a cycle can run out of time,
 * the AI can be rate limited, a container can die mid-invocation. Anything held
 * only in memory at that moment is gone. Every item that passes the prefilter
 * is written down first, so the worst case is a delay, never a loss.
 *
 * Lifecycle: pending -> classified -> alerted | rejected
 * Each cycle drains pending OLDEST FIRST, which keeps latency bounded rather
 * than letting a backlog starve while fresh items jump the queue.
 */

import type { Db } from "mongodb";
import { COLLECTIONS, type CandidateDoc, type CandidateStatus } from "@/lib/store/schema";
import { urlHash } from "@/lib/dedupe/normalize";
import type { RawItem } from "@/lib/feeds/types";
import type { Verdict } from "@/lib/classifier/types";

/** Rejected candidates are kept this long for debugging the prefilter. */
const REJECTED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** An item stuck mid-pipeline longer than this is considered abandoned. */
export const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

/** Give up on an item after this many classification attempts. */
const MAX_ATTEMPTS = 5;

export async function addCandidates(
  db: Db,
  items: RawItem[],
  now: Date = new Date(),
): Promise<number> {
  if (items.length === 0) return 0;

  const ops = items.map((item) => {
    const doc: Partial<CandidateDoc> = {
      sourceId: item.sourceId,
      title: item.title,
      link: item.link,
      summary: item.summary,
      publishedAt: item.publishedAt,
      fetchedAt: now,
      status: "pending" as CandidateStatus,
      statusAt: now,
      attempts: 0,
    };
    if (item.secFormType) doc.secFormType = item.secFormType;

    return {
      updateOne: {
        filter: { _id: urlHash(item.link) },
        // $setOnInsert only: if this candidate already exists we must not reset
        // its status or attempt count and send it round the loop again.
        update: { $setOnInsert: doc },
        upsert: true,
      },
    };
  });

  const res = await db.collection<CandidateDoc>(COLLECTIONS.candidates).bulkWrite(ops, {
    ordered: false,
  });
  return res.upsertedCount;
}

/**
 * Claim a batch of pending candidates, oldest first.
 *
 * Items are marked in-flight by bumping statusAt, so a concurrent cycle sees
 * them as recently touched and does not pick up the same work. Combined with
 * the cycle lease this is belt and braces, which is appropriate given the cost
 * of classifying the same item twice is real money.
 */
export async function claimPending(
  db: Db,
  limit: number,
  now: Date = new Date(),
): Promise<CandidateDoc[]> {
  const candidates = db.collection<CandidateDoc>(COLLECTIONS.candidates);
  const stuckCutoff = new Date(now.getTime() - STUCK_THRESHOLD_MS);

  const claimed: CandidateDoc[] = [];
  for (let i = 0; i < limit; i++) {
    const doc = await candidates.findOneAndUpdate(
      {
        $or: [
          { status: "pending", statusAt: { $lte: stuckCutoff } },
          { status: "pending", attempts: 0 },
        ],
        attempts: { $lt: MAX_ATTEMPTS },
      },
      { $set: { statusAt: now }, $inc: { attempts: 1 } },
      { sort: { fetchedAt: 1 }, returnDocument: "after" },
    );
    if (!doc) break;
    claimed.push(doc);
  }
  return claimed;
}

/** How many items are waiting, for /status and the daily summary. */
export async function countPending(db: Db): Promise<number> {
  return db.collection<CandidateDoc>(COLLECTIONS.candidates).countDocuments({ status: "pending" });
}

export async function markClassified(
  db: Db,
  id: string,
  verdict: Verdict,
  now: Date = new Date(),
): Promise<void> {
  await db
    .collection<CandidateDoc>(COLLECTIONS.candidates)
    .updateOne(
      { _id: id },
      { $set: { status: "classified", statusAt: now, verdict, classifiedAt: now } },
    );
}

export async function markAlerted(db: Db, id: string, now: Date = new Date()): Promise<void> {
  await db
    .collection<CandidateDoc>(COLLECTIONS.candidates)
    .updateOne({ _id: id }, { $set: { status: "alerted", statusAt: now } });
}

export async function markRejected(
  db: Db,
  id: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await db.collection<CandidateDoc>(COLLECTIONS.candidates).updateOne(
    { _id: id },
    {
      $set: {
        status: "rejected",
        statusAt: now,
        rejectedReason: reason.slice(0, 200),
        // Only rejected docs get an expiry, so the TTL index reaps them while
        // leaving live work alone.
        expiresAt: new Date(now.getTime() + REJECTED_TTL_MS),
      },
    },
  );
}

/**
 * Return an item to the queue after a failed or abandoned attempt.
 * Rewinding statusAt makes it immediately eligible again.
 */
export async function returnToPending(db: Db, id: string, now: Date = new Date()): Promise<void> {
  await db
    .collection<CandidateDoc>(COLLECTIONS.candidates)
    .updateOne(
      { _id: id },
      { $set: { status: "pending", statusAt: new Date(now.getTime() - STUCK_THRESHOLD_MS - 1000) } },
    );
}

/**
 * Rescue items abandoned in a non-terminal state.
 *
 * This is the safety net for a container that died between claiming an item
 * and finishing with it. Without it those candidates would sit in "classified"
 * forever and the deal would never be alerted.
 */
export async function recoverStuck(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_THRESHOLD_MS);
  const res = await db.collection<CandidateDoc>(COLLECTIONS.candidates).updateMany(
    { status: "classified", statusAt: { $lte: cutoff }, attempts: { $lt: MAX_ATTEMPTS } },
    { $set: { status: "pending", statusAt: cutoff } },
  );
  return res.modifiedCount;
}

/** Candidates that strongly matched the prefilter, for the AI-offline path. */
export async function pendingForUnverified(
  db: Db,
  limit: number,
  now: Date = new Date(),
): Promise<CandidateDoc[]> {
  const cutoff = new Date(now.getTime() - STUCK_THRESHOLD_MS);
  return db
    .collection<CandidateDoc>(COLLECTIONS.candidates)
    .find({ status: "pending", statusAt: { $lte: cutoff } })
    .sort({ fetchedAt: 1 })
    .limit(limit)
    .toArray();
}

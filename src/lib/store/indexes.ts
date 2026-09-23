/**
 * indexes.ts — every index the app relies on, declared in one place.
 *
 * WHY A SCRIPT AND NOT ON COLD START: createIndex is idempotent but it is still
 * a round trip. Running it on every cold start would add latency to cycles that
 * are supposed to finish in 1-2 seconds, and would waste Atlas M0's limited
 * operations budget. So indexes are created once by `npm run db:init`, and the
 * runtime assumes they exist.
 *
 * The uniqueness constraints here are load-bearing, not optimizations:
 *   seen_items.titleHash  — stops the same story alerting twice via two sources
 *   deals._id             — makes double-alerting structurally impossible
 *   telegram_updates._id  — makes retried Telegram updates safe to replay
 */

import type { Db, IndexDescription } from "mongodb";
import { COLLECTIONS } from "@/lib/store/schema";

const DAY = 86_400;

interface CollectionIndexes {
  collection: string;
  indexes: IndexDescription[];
}

export const INDEX_PLAN: CollectionIndexes[] = [
  {
    collection: COLLECTIONS.seenItems,
    indexes: [
      // Second dedupe axis. Sparse so items with no usable title never collide
      // with each other on an empty-string hash.
      { key: { titleHash: 1 }, name: "titleHash_unique", unique: true, sparse: true },
      // Reap after 30 days. Keeps us far inside Atlas M0's 512MB.
      { key: { firstSeenAt: 1 }, name: "firstSeenAt_ttl", expireAfterSeconds: 30 * DAY },
      { key: { sourceId: 1, firstSeenAt: -1 }, name: "source_recent" },
    ],
  },
  {
    collection: COLLECTIONS.candidates,
    indexes: [
      // The pending queue: oldest first, which is how each cycle drains it.
      { key: { status: 1, fetchedAt: 1 }, name: "status_oldest_first" },
      // Finds items stuck mid-pipeline for more than 5 minutes.
      { key: { status: 1, statusAt: 1 }, name: "status_stuck" },
      // expireAfterSeconds 0 means "delete when the date in this field passes".
      // Only rejected candidates get an expiresAt, so live work is never reaped.
      { key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 },
    ],
  },
  {
    collection: COLLECTIONS.deals,
    indexes: [
      { key: { alertedAt: -1 }, name: "alerted_recent" },
      { key: { company: 1, event: 1, lastAlertedAt: -1 }, name: "company_event_recent" },
      { key: { alertState: 1, claimExpiresAt: 1 }, name: "stuck_claims" },
      // Dashboard filters.
      { key: { event: 1, alertedAt: -1 }, name: "event_recent" },
      { key: { region: 1, alertedAt: -1 }, name: "region_recent" },
    ],
  },
  {
    collection: COLLECTIONS.sourceState,
    indexes: [{ key: { lastSuccessAt: 1 }, name: "last_success" }],
  },
  {
    collection: COLLECTIONS.locks,
    indexes: [
      // Safety net only. The lock logic never trusts the TTL reaper for
      // correctness — it compares expiresAt explicitly — because Mongo's TTL
      // sweep runs about once a minute and is far too coarse for a 90s lease.
      { key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 300 },
    ],
  },
  {
    collection: COLLECTIONS.telegramUpdates,
    indexes: [{ key: { receivedAt: 1 }, name: "receivedAt_ttl", expireAfterSeconds: DAY }],
  },
  {
    collection: COLLECTIONS.dailyUsage,
    indexes: [{ key: { updatedAt: -1 }, name: "updated_recent" }],
  },
];

export interface IndexResult {
  collection: string;
  index: string;
  status: "created" | "exists" | "failed";
  error?: string;
}

/** Creates every index. Safe to run repeatedly. */
export async function ensureIndexes(db: Db): Promise<IndexResult[]> {
  const results: IndexResult[] = [];

  for (const { collection, indexes } of INDEX_PLAN) {
    // createCollection is explicit so a fresh database gets every collection
    // even if nothing has written to it yet — otherwise /status would throw on
    // a brand new deployment.
    await db.createCollection(collection).catch((err: unknown) => {
      const code = (err as { codeName?: string }).codeName;
      if (code !== "NamespaceExists") throw err;
    });

    const existing = new Set(
      (await db.collection(collection).indexes()).map((i) => i.name),
    );

    for (const spec of indexes) {
      if (spec.name && existing.has(spec.name)) {
        results.push({ collection, index: spec.name, status: "exists" });
        continue;
      }
      try {
        await db.collection(collection).createIndexes([spec]);
        results.push({ collection, index: spec.name ?? "(unnamed)", status: "created" });
      } catch (err) {
        results.push({
          collection,
          index: spec.name ?? "(unnamed)",
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return results;
}

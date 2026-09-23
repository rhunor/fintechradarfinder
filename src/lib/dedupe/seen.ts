/**
 * seen.ts — remembers every story we have ingested, and handles bootstrapping.
 *
 * TWO JOBS:
 *
 * 1. Dedupe. A story reaches us from several feeds, and each feed redelivers
 *    its items every poll. We insert into `seen_items` with unique indexes on
 *    the URL hash (_id) and the title hash, and let MongoDB reject duplicates.
 *    Relying on the index rather than a read-then-write check is what makes
 *    this safe against two cycles racing.
 *
 * 2. Bootstrap. The first time a source is ever fetched it returns 10-150
 *    existing items, all of them old news. Alerting on those would mean a wall
 *    of irrelevant messages every time a feed is added. So the first successful
 *    fetch marks everything seen WITHOUT alerting, and flips a per-source
 *    `bootstrapped` flag. This applies per source, so adding a 20th feed in six
 *    months is just as quiet.
 */

import type { Db } from "mongodb";
import { COLLECTIONS, type SeenItemDoc, type SourceStateDoc } from "@/lib/store/schema";
import { titleHash, urlHash } from "@/lib/dedupe/normalize";
import type { RawItem } from "@/lib/feeds/types";

const DUPLICATE_KEY = 11000;

export interface DedupeOutcome {
  /** Items never seen before, in feed order. Empty during a bootstrap. */
  fresh: RawItem[];
  /** How many were already known. Useful for spotting a misbehaving feed. */
  duplicates: number;
  /** True when this call performed the initial bootstrap for the source. */
  bootstrapped: boolean;
}

/** Attach the two dedupe keys to an item. */
export function keysFor(item: RawItem): { urlKey: string; titleKey: string | null } {
  return { urlKey: urlHash(item.link), titleKey: titleHash(item.title) };
}

/**
 * Record items as seen and return only the genuinely new ones.
 *
 * `isBootstrapped` is passed in rather than read here, so the caller can fetch
 * all source states in one query per cycle instead of one per source.
 */
export async function recordSeen(
  db: Db,
  sourceId: string,
  items: RawItem[],
  isBootstrapped: boolean,
): Promise<DedupeOutcome> {
  if (items.length === 0) {
    return { fresh: [], duplicates: 0, bootstrapped: false };
  }

  const seen = db.collection<SeenItemDoc>(COLLECTIONS.seenItems);
  const now = new Date();

  const docs: SeenItemDoc[] = [];
  const byId = new Map<string, RawItem>();
  for (const item of items) {
    const { urlKey, titleKey } = keysFor(item);
    // A feed can list the same story twice in one payload; keep the first.
    if (byId.has(urlKey)) continue;
    byId.set(urlKey, item);
    const doc: SeenItemDoc = {
      _id: urlKey,
      titleHash: titleKey ?? urlKey, // sparse index: fall back to the URL key
      sourceId,
      link: item.link,
      title: item.title,
      firstSeenAt: now,
    };
    docs.push(doc);
  }

  // ordered:false means one duplicate does not abort the rest of the batch.
  // Duplicates are the expected case, not an error, so we inspect writeErrors
  // rather than letting the throw propagate.
  let inserted = new Set<string>();
  try {
    const res = await seen.insertMany(docs, { ordered: false });
    inserted = new Set(Object.values(res.insertedIds).map(String));
  } catch (err) {
    const bulk = err as {
      code?: number;
      writeErrors?: { err?: { index?: number; code?: number } }[];
      result?: { result?: { insertedIds?: { index: number; _id: unknown }[] } };
      insertedCount?: number;
    };
    const writeErrors = bulk.writeErrors ?? [];
    const allDuplicates = writeErrors.every((e) => e.err?.code === DUPLICATE_KEY);
    if (!allDuplicates && bulk.code !== DUPLICATE_KEY) throw err;

    // Everything we tried to insert, minus the ones that collided, was written.
    const failedIndexes = new Set(writeErrors.map((e) => e.err?.index));
    docs.forEach((doc, i) => {
      if (!failedIndexes.has(i)) inserted.add(doc._id);
    });
  }

  const duplicates = docs.length - inserted.size;

  // THE BOOTSTRAP GATE: everything above still ran, so these items are now
  // recorded as seen and will never be reprocessed — they just never become
  // candidates. That is the whole point.
  if (!isBootstrapped) {
    await db.collection<SourceStateDoc>(COLLECTIONS.sourceState).updateOne(
      { _id: sourceId },
      { $set: { bootstrapped: true }, $setOnInsert: { errorCount: 0 } },
      { upsert: true },
    );
    return { fresh: [], duplicates, bootstrapped: true };
  }

  const fresh: RawItem[] = [];
  for (const [id, item] of byId) {
    if (inserted.has(id)) fresh.push(item);
  }

  return { fresh, duplicates, bootstrapped: false };
}

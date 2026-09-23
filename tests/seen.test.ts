/**
 * seen.test.ts — dedupe and bootstrap against the real database.
 *
 * The guarantee under test is that MongoDB's unique indexes reject duplicates
 * atomically, so two cycles racing on the same story cannot both treat it as
 * new. Mocking that away would test nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordSeen } from "@/lib/dedupe/seen";
import { closeClient, getDb } from "@/lib/store/client";
import { COLLECTIONS } from "@/lib/store/schema";
import { requireDb } from "./db-helper";
import type { RawItem } from "@/lib/feeds/types";

const hasDb = Boolean(process.env.MONGODB_URI);
const describeDb = hasDb ? describe : describe.skip;

// Pay for the cold Atlas connect once, here, instead of inside whichever test
// runs first — where a slow connect reads as that test failing.
beforeAll(async () => {
  if (hasDb) await requireDb();
});

const SOURCE = "test-source-seen";

function item(title: string, link: string): RawItem {
  return {
    sourceId: SOURCE,
    title,
    link,
    summary: "",
    publishedAt: new Date(),
    guid: null,
    categories: [],
  };
}

async function reset(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTIONS.seenItems).deleteMany({ sourceId: SOURCE });
  await db.collection(COLLECTIONS.sourceState).deleteOne({ _id: SOURCE as never });
}

describeDb("recordSeen: bootstrap", () => {
  beforeEach(reset);

  it("returns nothing fresh on the first fetch of a source", async () => {
    const db = await getDb();
    const items = [
      item("Old story one about a raise", "https://example.com/seen-1"),
      item("Old story two about a merger", "https://example.com/seen-2"),
    ];
    const out = await recordSeen(db, SOURCE, items, false);

    expect(out.bootstrapped).toBe(true);
    expect(out.fresh).toHaveLength(0); // no flood of old news
  });

  it("still records the bootstrapped items, so they never resurface", async () => {
    const db = await getDb();
    const items = [item("Old story one about a raise", "https://example.com/seen-1")];
    await recordSeen(db, SOURCE, items, false);

    // Second pass, now bootstrapped: the same item must NOT look new.
    const out = await recordSeen(db, SOURCE, items, true);
    expect(out.fresh).toHaveLength(0);
    expect(out.duplicates).toBe(1);
  });

  it("sets the bootstrapped flag on the source", async () => {
    const db = await getDb();
    await recordSeen(db, SOURCE, [item("A story about funding", "https://example.com/seen-9")], false);
    const state = await db.collection(COLLECTIONS.sourceState).findOne({ _id: SOURCE as never });
    expect(state?.bootstrapped).toBe(true);
  });
});

describeDb("recordSeen: dedupe", () => {
  beforeEach(reset);

  it("returns genuinely new items as fresh", async () => {
    const db = await getDb();
    const out = await recordSeen(
      db,
      SOURCE,
      [
        item("Acme raises twenty five million", "https://example.com/seen-a"),
        item("Beta acquires Gamma Corporation", "https://example.com/seen-b"),
      ],
      true,
    );
    expect(out.fresh).toHaveLength(2);
    expect(out.duplicates).toBe(0);
  });

  it("treats the same URL with different tracking params as one story", async () => {
    const db = await getDb();
    await recordSeen(db, SOURCE, [item("Acme raises money today", "https://example.com/seen-c")], true);

    const out = await recordSeen(
      db,
      SOURCE,
      [item("Acme raises money today", "https://example.com/seen-c?utm_source=rss")],
      true,
    );
    expect(out.fresh).toHaveLength(0);
    expect(out.duplicates).toBe(1);
  });

  it("catches a syndicated reprint at a different URL via the title hash", async () => {
    const db = await getDb();
    await recordSeen(db, SOURCE, [item("Ramp raises 200 million Series E", "https://a.com/x")], true);

    const out = await recordSeen(
      db,
      SOURCE,
      [item("Exclusive: Ramp raises 200 million Series E", "https://b.com/y")],
      true,
    );
    expect(out.fresh).toHaveLength(0);
  });

  it("keeps only the first copy when a feed lists a story twice in one payload", async () => {
    const db = await getDb();
    const dup = item("Acme announces a funding round", "https://example.com/seen-d");
    const out = await recordSeen(db, SOURCE, [dup, { ...dup }], true);
    expect(out.fresh).toHaveLength(1);
  });

  it("returns the new items when a batch mixes new and already-seen", async () => {
    const db = await getDb();
    await recordSeen(db, SOURCE, [item("First story about a raise", "https://example.com/seen-e")], true);

    const out = await recordSeen(
      db,
      SOURCE,
      [
        item("First story about a raise", "https://example.com/seen-e"),
        item("Second story about a merger", "https://example.com/seen-f"),
      ],
      true,
    );
    expect(out.fresh).toHaveLength(1);
    expect(out.fresh[0]!.link).toBe("https://example.com/seen-f");
    expect(out.duplicates).toBe(1);
  });

  it("gives exactly one caller the fresh item when two cycles race", async () => {
    // The scheduler double-fire scenario, at the dedupe layer.
    const db = await getDb();
    const racing = item("Concurrent story about an acquisition", "https://example.com/seen-race");
    const [a, b] = await Promise.all([
      recordSeen(db, SOURCE, [racing], true),
      recordSeen(db, SOURCE, [{ ...racing }], true),
    ]);
    expect(a.fresh.length + b.fresh.length).toBe(1);
  });

  it("handles an empty batch without touching the database", async () => {
    const db = await getDb();
    const out = await recordSeen(db, SOURCE, [], true);
    expect(out).toEqual({ fresh: [], duplicates: 0, bootstrapped: false });
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await reset();
  await closeClient();
});

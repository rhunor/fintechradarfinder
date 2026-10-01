/**
 * queue.test.ts — the candidate queue drains freshest-first and retires stale
 * stories, against the real database.
 *
 * Both behaviours exist because of a production incident: after a stall, the
 * queue drained oldest-first, so hours-old stories went out in bursts while
 * fresh news waited behind them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimPending, expireStale } from "@/lib/store/candidates";
import { closeClient, getDb } from "@/lib/store/client";
import { COLLECTIONS } from "@/lib/store/schema";
import { requireDb } from "./db-helper";

const hasDb = Boolean(process.env.MONGODB_URI);
const describeDb = hasDb ? describe : describe.skip;
const SOURCE = "test-queue-source";
const HOUR = 3_600_000;

beforeAll(async () => {
  if (hasDb) await requireDb();
});

async function reset(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTIONS.candidates).deleteMany({ sourceId: SOURCE });
}

/** Insert a pending candidate first seen `ageHours` ago. */
async function add(id: string, ageHours: number, publishedAgeHours: number | null = ageHours) {
  const db = await getDb();
  const now = Date.now();
  await db.collection(COLLECTIONS.candidates).insertOne({
    _id: id as never,
    sourceId: SOURCE,
    title: `story ${id}`,
    link: `https://example.com/${id}`,
    summary: "",
    publishedAt: publishedAgeHours === null ? null : new Date(now - publishedAgeHours * HOUR),
    fetchedAt: new Date(now - ageHours * HOUR),
    status: "pending",
    statusAt: new Date(now - ageHours * HOUR),
    attempts: 0,
  });
}

describeDb("claimPending", () => {
  beforeEach(reset);

  it("hands out the freshest stories first", async () => {
    const db = await getDb();
    await add("q-old", 3);
    await add("q-new", 0.1);
    await add("q-mid", 1);
    // Claim more than ours so other pending docs in the shared DB cannot hide order.
    const claimed = (await claimPending(db, 50)).filter((d) => d.sourceId === SOURCE).map((d) => d._id);
    expect(claimed).toEqual(["q-new", "q-mid", "q-old"]);
  });
});

describeDb("expireStale", () => {
  beforeEach(reset);

  it("retires stories older than the limit and keeps fresh ones", async () => {
    const db = await getDb();
    await add("q-fresh", 1);
    await add("q-stale", 9);
    await expireStale(db, 6);

    const docs = await db.collection(COLLECTIONS.candidates).find({ sourceId: SOURCE }).toArray();
    const status = Object.fromEntries(docs.map((d) => [String(d._id), d.status]));
    expect(status["q-fresh"]).toBe("pending");
    expect(status["q-stale"]).toBe("rejected");
  });

  it("judges age by publication date when the feed gave one", async () => {
    // Seen a minute ago, but published 10 hours ago: still too old to post.
    const db = await getDb();
    await add("q-old-pub", 0.02, 10);
    await expireStale(db, 6);
    const doc = await db.collection(COLLECTIONS.candidates).findOne({ _id: "q-old-pub" as never });
    expect(doc?.status).toBe("rejected");
    expect(String(doc?.rejectedReason)).toContain("stale");
  });

  it("falls back to first-seen time when there is no publication date", async () => {
    const db = await getDb();
    await add("q-nodate-fresh", 1, null);
    await add("q-nodate-stale", 9, null);
    await expireStale(db, 6);
    const docs = await db.collection(COLLECTIONS.candidates).find({ sourceId: SOURCE }).toArray();
    const status = Object.fromEntries(docs.map((d) => [String(d._id), d.status]));
    expect(status["q-nodate-fresh"]).toBe("pending");
    expect(status["q-nodate-stale"]).toBe("rejected");
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await reset();
  await closeClient();
});

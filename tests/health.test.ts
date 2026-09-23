/**
 * health.test.ts — the stale-source warning's rate limiting.
 *
 * The rate limit is the whole point of this feature. A warning that fires every
 * cycle gets muted within the hour, and a muted warning is the same as no
 * warning at all — which is exactly the silence this system exists to break.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimStaleWarning } from "@/lib/store/source-state";
import { closeClient, getDb } from "@/lib/store/client";
import { COLLECTIONS } from "@/lib/store/schema";
import { requireDb } from "./db-helper";

const hasDb = Boolean(process.env.MONGODB_URI);
const describeDb = hasDb ? describe : describe.skip;
const SOURCE = "test-health-source";

beforeAll(async () => {
  if (hasDb) await requireDb();
});

async function reset(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTIONS.sourceState).deleteOne({ _id: SOURCE as never });
  await db
    .collection(COLLECTIONS.sourceState)
    .insertOne({ _id: SOURCE as never, errorCount: 3, bootstrapped: true });
}

describeDb("claimStaleWarning", () => {
  beforeEach(reset);

  it("allows the first warning for a source", async () => {
    const db = await getDb();
    expect(await claimStaleWarning(db, SOURCE)).toBe(true);
  });

  it("suppresses a second warning within the hour", async () => {
    const db = await getDb();
    await claimStaleWarning(db, SOURCE);
    expect(await claimStaleWarning(db, SOURCE)).toBe(false);
  });

  it("allows another warning once an hour has passed", async () => {
    const db = await getDb();
    await claimStaleWarning(db, SOURCE);
    const laterThanAnHour = new Date(Date.now() + 61 * 60 * 1000);
    expect(await claimStaleWarning(db, SOURCE, laterThanAnHour)).toBe(true);
  });

  it("lets exactly one concurrent cycle claim the warning", async () => {
    // Two overlapping cycles must not both notify about the same source.
    const db = await getDb();
    const results = await Promise.all([
      claimStaleWarning(db, SOURCE),
      claimStaleWarning(db, SOURCE),
      claimStaleWarning(db, SOURCE),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

afterAll(async () => {
  if (!hasDb) return;
  const db = await getDb();
  await db.collection(COLLECTIONS.sourceState).deleteOne({ _id: SOURCE as never });
  await closeClient();
});

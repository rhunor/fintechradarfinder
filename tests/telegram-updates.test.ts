/**
 * telegram-updates.test.ts — update deduplication, against the real database.
 *
 * Telegram redelivers an update when our webhook is slow. Without this guard a
 * single retried "/pause" could pause, resume and pause again.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimUpdate } from "@/lib/store/telegram-updates";
import { closeClient, getDb } from "@/lib/store/client";
import { COLLECTIONS } from "@/lib/store/schema";
import { requireDb } from "./db-helper";

const hasDb = Boolean(process.env.MONGODB_URI);
const describeDb = hasDb ? describe : describe.skip;

// A high id range so these can never collide with real Telegram updates.
const BASE = 999_000_000;

beforeAll(async () => {
  if (hasDb) await requireDb();
});

async function reset(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTIONS.telegramUpdates).deleteMany({ _id: { $gte: BASE } as never });
}

describeDb("claimUpdate", () => {
  beforeEach(reset);

  it("grants the first claim for an update", async () => {
    const db = await getDb();
    expect(await claimUpdate(db, BASE + 1)).toBe(true);
  });

  it("refuses a redelivery of the same update", async () => {
    const db = await getDb();
    await claimUpdate(db, BASE + 2);
    expect(await claimUpdate(db, BASE + 2)).toBe(false);
  });

  it("grants exactly one claim when a retry races the original", async () => {
    // Telegram retrying while the first handler is still in flight.
    const db = await getDb();
    const results = await Promise.all([
      claimUpdate(db, BASE + 3),
      claimUpdate(db, BASE + 3),
      claimUpdate(db, BASE + 3),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("treats different updates independently", async () => {
    const db = await getDb();
    expect(await claimUpdate(db, BASE + 4)).toBe(true);
    expect(await claimUpdate(db, BASE + 5)).toBe(true);
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await reset();
  await closeClient();
});

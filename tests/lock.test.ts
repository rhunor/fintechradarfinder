/**
 * lock.test.ts — the overlap lease under real contention.
 *
 * These run against the real MongoDB, because the whole point of the lock is
 * that MongoDB applies findOneAndUpdate+upsert atomically. A mock would test
 * our mock, not the guarantee we actually depend on. The suite skips itself
 * when MONGODB_URI is absent so CI without secrets still passes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, releaseLock, renewLock, withLock } from "@/lib/store/lock";
import { COLLECTIONS } from "@/lib/store/schema";
import { requireDb } from "./db-helper";
import { closeClient, getDb } from "@/lib/store/client";

const hasDb = Boolean(process.env.MONGODB_URI);
const describeDb = hasDb ? describe : describe.skip;

// Pay for the cold Atlas connect once, here, instead of inside whichever test
// runs first — where a slow connect reads as that test failing.
beforeAll(async () => {
  if (hasDb) await requireDb();
});

// A dedicated lock id so these tests can never disturb a real running cycle.
const TEST_LOCK = "test-poll-cycle";

describeDb("acquireLock", () => {
  beforeEach(async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.locks).deleteOne({ _id: TEST_LOCK as never });
  });

  it("grants the lease when it is free", async () => {
    const db = await getDb();
    const lease = await acquireLock(db, TEST_LOCK, { ttlMs: 90_000 });
    expect(lease).not.toBeNull();
    expect(lease!.holder).toBeTruthy();
  });

  it("refuses a second holder while the lease is live", async () => {
    const db = await getDb();
    const first = await acquireLock(db, TEST_LOCK, { ttlMs: 90_000 });
    const second = await acquireLock(db, TEST_LOCK, { ttlMs: 90_000 });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("grants exactly one lease to ten simultaneous callers", async () => {
    // The real scenario: a scheduler double-fires and several containers race.
    const db = await getDb();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => acquireLock(db, TEST_LOCK, { ttlMs: 90_000 })),
    );
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it("lets a new cycle take over once the lease has expired", async () => {
    const db = await getDb();
    const past = new Date(Date.now() - 10_000);
    // A lease that was granted with a 1ms TTL 10 seconds ago is long dead.
    const stale = await acquireLock(db, TEST_LOCK, { ttlMs: 1, now: past });
    expect(stale).not.toBeNull();

    const taken = await acquireLock(db, TEST_LOCK, { ttlMs: 90_000 });
    expect(taken).not.toBeNull();
    expect(taken!.holder).not.toBe(stale!.holder);
  });

  it("does not release a lease that has been taken over by someone else", async () => {
    const db = await getDb();
    const past = new Date(Date.now() - 10_000);
    const overrun = await acquireLock(db, TEST_LOCK, { ttlMs: 1, now: past });
    const successor = await acquireLock(db, TEST_LOCK, { ttlMs: 90_000 });

    // The overrun cycle finishing late must not delete the successor's lock.
    expect(await releaseLock(db, overrun!)).toBe(false);
    expect(await releaseLock(db, successor!)).toBe(true);
  });

  it("renews only for the current holder", async () => {
    const db = await getDb();
    const lease = await acquireLock(db, TEST_LOCK, { ttlMs: 5_000 });
    const renewed = await renewLock(db, lease!, 90_000);
    expect(renewed).not.toBeNull();
    expect(renewed!.expiresAt.getTime()).toBeGreaterThan(lease!.expiresAt.getTime());

    const impostor = { ...lease!, holder: "someone-else" };
    expect(await renewLock(db, impostor, 90_000)).toBeNull();
  });
});

describeDb("withLock", () => {
  beforeEach(async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.locks).deleteOne({ _id: TEST_LOCK as never });
  });

  it("runs the body and releases afterwards", async () => {
    const db = await getDb();
    const outcome = await withLock(db, TEST_LOCK, { ttlMs: 90_000 }, async () => "done");
    expect(outcome).toEqual({ ran: true, result: "done" });

    // Released, so the next caller can immediately take it.
    const after = await acquireLock(db, TEST_LOCK, { ttlMs: 1_000 });
    expect(after).not.toBeNull();
  });

  it("reports ran:false instead of running the body when contended", async () => {
    const db = await getDb();
    await acquireLock(db, TEST_LOCK, { ttlMs: 90_000 });
    let bodyRan = false;
    const outcome = await withLock(db, TEST_LOCK, { ttlMs: 90_000 }, async () => {
      bodyRan = true;
      return "should not happen";
    });
    expect(outcome.ran).toBe(false);
    expect(bodyRan).toBe(false);
  });

  it("releases the lease even when the body throws", async () => {
    const db = await getDb();
    await expect(
      withLock(db, TEST_LOCK, { ttlMs: 90_000 }, async () => {
        throw new Error("cycle blew up");
      }),
    ).rejects.toThrow("cycle blew up");

    const after = await acquireLock(db, TEST_LOCK, { ttlMs: 1_000 });
    expect(after).not.toBeNull();
  });
});

// One teardown for the whole file. Closing the shared client inside a single
// describe's afterAll would pull the connection out from under later suites.
afterAll(async () => {
  if (!hasDb) return;
  const db = await getDb();
  await db.collection(COLLECTIONS.locks).deleteOne({ _id: TEST_LOCK as never });
  await closeClient();
});

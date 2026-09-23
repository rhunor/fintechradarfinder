/**
 * lock.ts — the overlap lease that guarantees only one poll cycle runs at once.
 *
 * WHY THIS EXISTS: external schedulers are best-effort. cron-job.org can fire
 * twice for the same minute, retry a call it thinks failed, or overlap with a
 * previous cycle that ran long. Without a lock, two cycles would race on the
 * same pending candidates and could double-send alerts.
 *
 * HOW IT IS ATOMIC: a single findOneAndUpdate with upsert:true against a filter
 * that only matches an EXPIRED lease. MongoDB applies that as one atomic
 * operation, so of two concurrent callers exactly one can win.
 *
 * The subtle part is the losing caller. When the lease is held, the filter
 * matches nothing, so the upsert tries to INSERT — and hits the existing _id,
 * producing a duplicate-key error. That E11000 is not a failure: it is precisely
 * how we learn somebody else holds the lock. Treating it as an error would make
 * every contended cycle look broken in the logs.
 *
 * Note we compare expiresAt ourselves rather than relying on the TTL index.
 * Mongo's TTL sweeper runs roughly once a minute, which is far too coarse to
 * expire a 90-second lease correctly.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { COLLECTIONS, type LockDoc } from "@/lib/store/schema";

const DUPLICATE_KEY = 11000;

export interface Lease {
  id: string;
  holder: string;
  expiresAt: Date;
}

export interface AcquireOptions {
  /** How long the lease is valid. Must exceed the worst-case cycle time. */
  ttlMs: number;
  /** Injectable for tests. */
  now?: Date;
  holder?: string;
}

/**
 * Try to take the named lease. Returns the lease on success, or null when
 * another cycle holds it — in which case the caller should exit immediately.
 */
export async function acquireLock(
  db: Db,
  lockId: string,
  opts: AcquireOptions,
): Promise<Lease | null> {
  const now = opts.now ?? new Date();
  const holder = opts.holder ?? randomUUID();
  const expiresAt = new Date(now.getTime() + opts.ttlMs);

  try {
    await db.collection<LockDoc>(COLLECTIONS.locks).findOneAndUpdate(
      // Matches only when the current lease has already expired. A live lease
      // matches nothing, which forces the upsert down the insert path below.
      { _id: lockId, expiresAt: { $lte: now } },
      { $set: { holder, acquiredAt: now, expiresAt } },
      { upsert: true, returnDocument: "after" },
    );
    return { id: lockId, holder, expiresAt };
  } catch (err) {
    if ((err as { code?: number }).code === DUPLICATE_KEY) {
      // Someone else holds a live lease. Expected, not an error.
      return null;
    }
    throw err;
  }
}

/**
 * Release a lease we own. The holder check matters: if our cycle overran and
 * the lease already expired and was taken by someone else, we must not delete
 * THEIR lock on the way out.
 */
export async function releaseLock(db: Db, lease: Lease): Promise<boolean> {
  const res = await db
    .collection<LockDoc>(COLLECTIONS.locks)
    .deleteOne({ _id: lease.id, holder: lease.holder });
  return res.deletedCount === 1;
}

/**
 * Extend a lease we still hold. Used by long cycles so a slow-but-healthy run
 * is not declared dead and overtaken mid-flight.
 */
export async function renewLock(
  db: Db,
  lease: Lease,
  ttlMs: number,
  now: Date = new Date(),
): Promise<Lease | null> {
  const expiresAt = new Date(now.getTime() + ttlMs);
  const res = await db
    .collection<LockDoc>(COLLECTIONS.locks)
    .findOneAndUpdate(
      { _id: lease.id, holder: lease.holder },
      { $set: { expiresAt } },
      { returnDocument: "after" },
    );
  return res ? { ...lease, expiresAt } : null;
}

/** Convenience wrapper: run `fn` only if the lease is free, always releasing. */
export async function withLock<T>(
  db: Db,
  lockId: string,
  opts: AcquireOptions,
  fn: (lease: Lease) => Promise<T>,
): Promise<{ ran: false } | { ran: true; result: T }> {
  const lease = await acquireLock(db, lockId, opts);
  if (!lease) return { ran: false };
  try {
    return { ran: true, result: await fn(lease) };
  } finally {
    await releaseLock(db, lease).catch(() => {
      // A failed release is survivable: the lease expires on its own.
    });
  }
}

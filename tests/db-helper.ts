/**
 * db-helper.ts — shared setup for the database-backed suites.
 *
 * Tests that need Mongo call `requireDb()` in a beforeAll so the cold connect
 * happens once, explicitly, instead of inside whichever test happens to run
 * first — where a slow connect looks like that test failing.
 */

import { getDb } from "@/lib/store/client";
import type { Db } from "mongodb";

export const hasDb = Boolean(process.env.MONGODB_URI);

/** Establish the connection up front and return the handle. */
export async function requireDb(): Promise<Db> {
  const db = await getDb();
  // A trivial round trip forces the pool to be genuinely ready, not merely
  // constructed, so the first real assertion is not the one that waits.
  await db.command({ ping: 1 });
  return db;
}

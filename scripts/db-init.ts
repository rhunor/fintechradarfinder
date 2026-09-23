/**
 * db-init.ts — creates every collection and index, once.
 *
 * Run this after deploying, and again whenever indexes.ts changes. It is
 * idempotent: existing indexes are reported and left alone.
 *
 * Usage: npm run db:init
 */

import "./_bootstrap";
import { closeClient, getDb } from "@/lib/store/client";
import { ensureIndexes } from "@/lib/store/indexes";
import { COLLECTIONS } from "@/lib/store/schema";

async function main(): Promise<void> {
  const started = Date.now();
  const db = await getDb();
  console.log(`Connected to database "${db.databaseName}".\n`);

  const results = await ensureIndexes(db);

  let created = 0;
  let exists = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "created") created++;
    else if (r.status === "exists") exists++;
    else failed++;
    const mark = r.status === "created" ? "+" : r.status === "exists" ? "=" : "!";
    console.log(
      `${mark} ${r.collection.padEnd(18)} ${r.index}${r.error ? `  ERROR: ${r.error}` : ""}`,
    );
  }

  // Seed the settings singleton so /status and /pause never hit a missing doc.
  await db.collection(COLLECTIONS.settings).updateOne(
    { _id: "global" as unknown as never },
    { $setOnInsert: { paused: false, updatedAt: new Date() } },
    { upsert: true },
  );
  console.log(`\n= settings           global document ready`);

  const stats = await db.stats();
  console.log(
    `\n${created} created, ${exists} already existed, ${failed} failed ` +
      `in ${Date.now() - started}ms`,
  );
  console.log(
    `Storage used: ${(stats.dataSize / 1024 / 1024).toFixed(2)}MB of 512MB (Atlas M0 limit)`,
  );

  if (failed > 0) process.exitCode = 1;
  await closeClient();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

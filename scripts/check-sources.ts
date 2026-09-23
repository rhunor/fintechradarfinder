/**
 * check-sources.ts — fetches every enabled source and prints its health.
 *
 * WHY: feeds rot silently. A site moves its RSS path, or starts blocking our
 * User-Agent, and the radar just goes quiet instead of failing loudly. Run this
 * locally before deploying, and hit /api/admin/check-sources afterwards to
 * confirm the same feeds also work from Vercel's IP ranges.
 *
 * Usage: npm run check-sources
 */

import "./_bootstrap";
import { ENABLED_SOURCES, REJECTED_SOURCES } from "@/config/sources";
import { fetchAllSources } from "@/lib/feeds/fetch-all";

function ageOf(d: Date | null): string {
  if (!d) return "unknown";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h`;
  return `${(mins / 1440).toFixed(1)}d`;
}

async function main(): Promise<void> {
  console.log(`Checking ${ENABLED_SOURCES.length} enabled sources...\n`);
  const started = Date.now();

  // No stored validators are passed, so every source does a full fetch and we
  // can count items. Per-host pooling keeps us polite to PR Newswire and SEC.
  const results = await fetchAllSources(ENABLED_SOURCES);
  results.sort((a, b) => a.source.id.localeCompare(b.source.id));

  let ok = 0;
  let failed = 0;

  for (const { source, outcome } of results) {
    if (outcome.status === "ok") {
      const newest = outcome.items
        .map((i) => i.publishedAt)
        .filter((d): d is Date => d !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const stale = newest !== null && Date.now() - newest.getTime() > 7 * 86400_000;
      ok++;
      console.log(
        `${stale ? "!" : "OK"}  ${source.id.padEnd(20)} ${String(outcome.httpStatus).padEnd(4)} ` +
          `items:${String(outcome.items.length).padEnd(4)} newest:${ageOf(newest).padEnd(7)} ` +
          `${String(outcome.durationMs).padStart(5)}ms ${(outcome.bytes / 1024).toFixed(0)}KB` +
          (stale ? "   <-- STALE, newest item is over a week old" : ""),
      );
      if (outcome.items.length > 0) {
        console.log(`      e.g. ${outcome.items[0]!.title.slice(0, 92)}`);
      }
    } else if (outcome.status === "not-modified") {
      ok++;
      console.log(`OK  ${source.id.padEnd(20)} 304 not-modified (${outcome.via})`);
    } else {
      failed++;
      console.log(
        `FAIL ${source.id.padEnd(19)} ${outcome.reason}  [${source.url.slice(0, 70)}]`,
      );
    }
  }

  console.log(
    `\n${ok} ok, ${failed} failed, in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(all sources fetched in parallel)`,
  );
  console.log(`\n${REJECTED_SOURCES.length} sources were researched and rejected:`);
  for (const r of REJECTED_SOURCES) console.log(`  - ${r.name}: ${r.reason}`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

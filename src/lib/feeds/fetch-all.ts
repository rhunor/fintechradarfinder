/**
 * fetch-all.ts — fetches many sources at once without hammering any one host.
 *
 * WHY NOT A PLAIN Promise.all: we poll four PR Newswire feeds, three
 * GlobeNewswire feeds and two SEC endpoints. Firing all of a host's requests
 * simultaneously is both impolite and slower — it was exactly what made SEC's
 * Form D feed blow its 5s timeout during the first live run, while the same
 * request took 0.4s on its own. SEC also asks callers to stay well under 10
 * requests/second.
 *
 * So: unlimited parallelism ACROSS hosts, at most `perHostLimit` in flight
 * WITHIN a host. Total wall time stays close to the slowest single host, which
 * is what the Hobby memory budget is billed on.
 */

import type { SourceConfig } from "@/config/sources";
import { fetchSource } from "@/lib/feeds/fetch";
import type { FetchResult, SourceValidators } from "@/lib/feeds/types";

const DEFAULT_PER_HOST_LIMIT = 2;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export interface FetchAllOptions {
  /** Previously stored validators, keyed by source id. */
  validators?: Map<string, SourceValidators>;
  /** Max concurrent requests to any single hostname. */
  perHostLimit?: number;
  /** Cycle-wide deadline; in-flight fetches abort when it fires. */
  signal?: AbortSignal;
}

export async function fetchAllSources(
  sources: readonly SourceConfig[],
  opts: FetchAllOptions = {},
): Promise<FetchResult[]> {
  const perHostLimit = opts.perHostLimit ?? DEFAULT_PER_HOST_LIMIT;
  const validators = opts.validators ?? new Map<string, SourceValidators>();

  // Bucket by host, then drain each bucket with a small worker pool.
  const byHost = new Map<string, SourceConfig[]>();
  for (const source of sources) {
    const host = hostOf(source.url);
    const bucket = byHost.get(host);
    if (bucket) bucket.push(source);
    else byHost.set(host, [source]);
  }

  const results: FetchResult[] = [];

  await Promise.all(
    [...byHost.values()].map(async (bucket) => {
      let next = 0;
      const workers = Array.from({ length: Math.min(perHostLimit, bucket.length) }, async () => {
        for (;;) {
          const index = next++;
          const source = bucket[index];
          if (!source) return;
          const outcome = await fetchSource(source, validators.get(source.id) ?? {}, {
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
          results.push({ source, outcome });
        }
      });
      await Promise.all(workers);
    }),
  );

  return results;
}

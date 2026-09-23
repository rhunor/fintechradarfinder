/**
 * types.ts — the shapes that flow through the feed stage of the pipeline.
 *
 * A feed fetch produces one of three outcomes, and the rest of the system cares
 * a lot about which: "not-modified" means we did almost no work and must not
 * touch the item store, "ok" means we have fresh items to process, and "error"
 * means skip this source this cycle and try again next time.
 */

import type { SourceConfig } from "@/config/sources";

/** One story, normalized away from whatever XML dialect it arrived in. */
export interface RawItem {
  sourceId: string;
  title: string;
  link: string;
  /** Feed summary/description, HTML stripped. May be empty. */
  summary: string;
  /** Parsed publish time, or null when the feed gave nothing usable. */
  publishedAt: Date | null;
  /** Feed-provided identifier (guid / id), when present. */
  guid: string | null;
  /** Category/tag strings from the feed, lowercased. */
  categories: string[];
  /** SEC only: the form type, e.g. "8-K", "D". */
  secFormType?: string;
}

/** What we remember about a source between invocations, to avoid refetching. */
export interface SourceValidators {
  etag?: string | undefined;
  lastModified?: string | undefined;
  bodyHash?: string | undefined;
}

export type FetchOutcome =
  | {
      status: "ok";
      items: RawItem[];
      validators: SourceValidators;
      httpStatus: number;
      bytes: number;
      durationMs: number;
    }
  | {
      /** Either a 304, or a 200 whose body hashed to what we already had. */
      status: "not-modified";
      via: "http-304" | "body-hash";
      httpStatus: number;
      bytes: number;
      durationMs: number;
    }
  | {
      status: "error";
      reason: string;
      httpStatus?: number;
      durationMs: number;
    };

export interface FetchResult {
  source: SourceConfig;
  outcome: FetchOutcome;
}

/**
 * fetch.ts — fetches one feed as cheaply as the origin will allow.
 *
 * WHY THIS IS THE MOST IMPORTANT FILE FOR COST: the poll route runs ~43,000
 * times a month on Vercel Hobby, where memory is billed for wall-clock time
 * including time spent waiting on the network. Most cycles have no new news, so
 * the cheapest possible "nothing changed" path is what keeps us inside the
 * budget.
 *
 * Three tiers, cheapest first:
 *   1. Send If-None-Match / If-Modified-Since. A 304 costs one round trip and
 *      zero bytes of body, and we skip XML parsing entirely.
 *   2. Origin ignores validators (SEC's CGI endpoints, Financial Post): hash the
 *      body. We pay for the bytes but still skip parsing, which is the expensive
 *      part.
 *   3. Body genuinely changed: parse it.
 *
 * Every request carries a descriptive User-Agent. SEC requires one with contact
 * details or it returns 403 — verified.
 */

import { createHash } from "node:crypto";
import type { SourceConfig } from "@/config/sources";
import { env, limits } from "@/lib/env";
import { parseFeed } from "@/lib/feeds/parse";
import type { FetchOutcome, SourceValidators } from "@/lib/feeds/types";

function userAgentFor(source: SourceConfig): string {
  return source.type === "sec" ? env.secUserAgent : env.appUserAgent;
}

export function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

/**
 * Fetch a single source. Never throws: a failure is returned as an "error"
 * outcome so one bad feed can never abort the whole cycle.
 */
export async function fetchSource(
  source: SourceConfig,
  previous: SourceValidators,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<FetchOutcome> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? source.timeoutMs ?? limits.feedTimeoutMs;

  const headers: Record<string, string> = {
    "User-Agent": userAgentFor(source),
    Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    "Accept-Encoding": "gzip, deflate",
  };

  // Only send validators the origin actually honours. Sending If-None-Match to
  // a server that ignores it just wastes a header and can confuse caches.
  if (source.conditionalGet === "etag" && previous.etag) {
    headers["If-None-Match"] = previous.etag;
  }
  if (source.conditionalGet === "last-modified" && previous.lastModified) {
    headers["If-Modified-Since"] = previous.lastModified;
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  // Combine our per-feed timeout with the cycle-wide deadline, so a cycle that
  // is running out of time drops its in-flight fetches instead of overrunning.
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;

  let res: Response;
  try {
    res = await fetch(source.url, { headers, signal, redirect: "follow" });
  } catch (err) {
    const reason =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
        ? `timeout after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { status: "error", reason, durationMs: Date.now() - started };
  }

  if (res.status === 304) {
    return {
      status: "not-modified",
      via: "http-304",
      httpStatus: 304,
      bytes: 0,
      durationMs: Date.now() - started,
    };
  }

  if (!res.ok) {
    return {
      status: "error",
      reason: `HTTP ${res.status}`,
      httpStatus: res.status,
      durationMs: Date.now() - started,
    };
  }

  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
      httpStatus: res.status,
      durationMs: Date.now() - started,
    };
  }

  const bytes = Buffer.byteLength(body);
  const bodyHash = hashBody(body);

  // Tier 2: the origin returned 200 but nothing actually changed. Skip parsing.
  if (previous.bodyHash && previous.bodyHash === bodyHash) {
    return {
      status: "not-modified",
      via: "body-hash",
      httpStatus: res.status,
      bytes,
      durationMs: Date.now() - started,
    };
  }

  const validators: SourceValidators = {
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
    bodyHash,
  };

  let items;
  try {
    items = parseFeed(source, body);
  } catch (err) {
    return {
      status: "error",
      reason: `parse failed: ${err instanceof Error ? err.message : String(err)}`,
      httpStatus: res.status,
      durationMs: Date.now() - started,
    };
  }

  return {
    status: "ok",
    items,
    validators,
    httpStatus: res.status,
    bytes,
    durationMs: Date.now() - started,
  };
}

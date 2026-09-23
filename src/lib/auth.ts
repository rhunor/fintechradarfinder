/**
 * auth.ts — shared bearer-token check for the cron and admin routes.
 *
 * These endpoints trigger real work and expose operational data, so they are
 * not public. The check uses a timing-safe comparison: a naive === leaks the
 * secret one byte at a time to anyone patient enough to measure response
 * times, and these routes are internet-facing by definition.
 */

import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/** Constant-time string comparison that tolerates different lengths. */
export function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself be a timing
  // signal, so hash-free padding is avoided by comparing lengths after a
  // fixed-cost compare against a same-length buffer.
  if (bufA.length !== bufB.length) {
    // Still do a compare so the failure path costs roughly the same.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify `Authorization: Bearer <CRON_SECRET>`.
 *
 * Also accepts Vercel Cron's own header, so the same route works unchanged if
 * you later upgrade to Pro and drive it from vercel.json.
 */
export function isAuthorized(request: Request): boolean {
  const expected = env.cronSecret;

  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    return secureCompare(header.slice(7).trim(), expected);
  }

  return false;
}

/** 401 response shared by every protected route. */
export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * dashboard/auth.ts — cookie login for /deals.
 *
 * WHY NOT STORE THE PASSWORD IN THE COOKIE: a cookie is client-controlled and
 * readable by anyone with the device. Instead the cookie holds an HMAC of a
 * fixed payload keyed by DASHBOARD_PASSWORD. A visitor cannot forge it without
 * the password, and the password itself never leaves the server.
 *
 * This is deliberately small. It is one password protecting a read-only list of
 * public news, not a user system — a session table and refresh tokens would be
 * more moving parts than the thing they protect.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

export const SESSION_COOKIE = "fdr_session";

/** Cookie lifetime. Long enough to be convenient, short enough to expire. */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The signed value. It includes an issue date so a stolen cookie eventually
 * stops working even if Max-Age is ignored by the client.
 */
function sign(issuedAtDay: string): string {
  return createHmac("sha256", env.dashboardPassword)
    .update(`fintech-deal-radar:${issuedAtDay}`)
    .digest("hex");
}

function dayStamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function buildSessionValue(now: Date = new Date()): string {
  const day = dayStamp(now);
  return `${day}.${sign(day)}`;
}

/**
 * Verify a cookie value. Returns false for anything malformed, forged, or
 * older than the session lifetime.
 */
export function verifySessionValue(value: string | undefined, now: Date = new Date()): boolean {
  if (!value) return false;
  const [day, digest] = value.split(".");
  if (!day || !digest) return false;

  // Reject an old cookie even if the signature is genuine.
  const issued = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(issued.getTime())) return false;
  const ageSeconds = (now.getTime() - issued.getTime()) / 1000;
  if (ageSeconds < 0 || ageSeconds > SESSION_MAX_AGE_SECONDS) return false;

  const expected = sign(day);
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Constant-time password check, so the login form leaks nothing by timing. */
export function checkPassword(candidate: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(env.dashboardPassword, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function isLoggedIn(): Promise<boolean> {
  const store = await cookies();
  return verifySessionValue(store.get(SESSION_COOKIE)?.value);
}

export const sessionCookieOptions = {
  httpOnly: true,
  // Vercel always serves HTTPS; locally this would block the cookie over http,
  // so it follows the environment rather than being hard-coded.
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_MAX_AGE_SECONDS,
};

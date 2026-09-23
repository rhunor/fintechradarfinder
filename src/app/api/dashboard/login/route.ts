/**
 * /api/dashboard/login — sets and clears the dashboard session cookie.
 *
 * A form POST rather than JSON, so the login page needs no JavaScript at all.
 */

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { log } from "@/lib/log";
import {
  SESSION_COOKIE,
  buildSessionValue,
  checkPassword,
  sessionCookieOptions,
} from "@/lib/dashboard/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");

  if (!checkPassword(password)) {
    log.warn("dashboard.login_failed");
    // The error lives in the URL so the page stays a plain server render.
    redirect("/deals?error=1");
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, buildSessionValue(), sessionCookieOptions);
  redirect("/deals");
}

/** Logout: clearing the cookie is enough, there is no server-side session. */
export async function GET(): Promise<Response> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/deals");
}

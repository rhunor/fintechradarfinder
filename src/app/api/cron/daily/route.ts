/**
 * /api/cron/daily — the once-a-day digest.
 *
 * Registered in vercel.json, which Hobby allows because it runs only once a
 * day. Vercel fires it somewhere inside the scheduled hour rather than exactly
 * on the hour, which is fine for a summary.
 *
 * Unlike the poll route this does NOT use after(): the work is a handful of
 * queries and one message, so it finishes well inside any sensible timeout, and
 * returning the real result makes it far easier to test with curl.
 */

import { getDb } from "@/lib/store/client";
import { env } from "@/lib/env";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { log, errorInfo } from "@/lib/log";
import { sendMessage } from "@/lib/alerter/telegram";
import { buildDailySummary, dailySummaryFacts } from "@/lib/telegram/daily";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    log.warn("cron.daily.unauthorized");
    return unauthorized();
  }

  // ?dry=1 builds the summary and returns it without sending, so the format
  // can be checked without putting a message in the chat.
  const dry = new URL(request.url).searchParams.get("dry") === "1";

  try {
    const db = await getDb();
    const summary = await buildDailySummary(db);
    const facts = await dailySummaryFacts(db);

    if (dry) {
      return Response.json({ ok: true, sent: false, summary, facts });
    }

    await sendMessage(env.telegramChatId, summary);
    log.info("cron.daily.sent", facts);
    return Response.json({ ok: true, sent: true, facts });
  } catch (err) {
    log.error("cron.daily.failed", errorInfo(err));
    return Response.json({ ok: false, error: "daily summary failed" }, { status: 500 });
  }
}

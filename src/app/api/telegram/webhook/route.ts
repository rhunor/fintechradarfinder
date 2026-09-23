/**
 * /api/telegram/webhook — receives updates from Telegram.
 *
 * THREE RULES THIS ROUTE FOLLOWS, all of them learned from how Telegram
 * actually behaves:
 *
 * 1. VERIFY THE SECRET. The URL is guessable and the endpoint is public, so
 *    every update must carry the secret token we registered with setWebhook.
 *
 * 2. ALWAYS RETURN 200, QUICKLY. Telegram retries anything slow or non-200,
 *    and repeated failures get the webhook disabled entirely. So even a
 *    rejected or broken update gets a 200 — we just do not act on it. The only
 *    exception is a bad secret, which gets 401 because that is not Telegram.
 *
 * 3. DEDUPE BY update_id. A retry must not run the command twice.
 *
 * grammy IS used here (unlike the poll route) only in the sense that we parse
 * its Update type; the actual work is a plain fetch, so the poll path stays
 * free of the framework entirely.
 */

import { getDb } from "@/lib/store/client";
import { env } from "@/lib/env";
import { log, errorInfo } from "@/lib/log";
import { sendMessage } from "@/lib/alerter/telegram";
import { claimUpdate } from "@/lib/store/telegram-updates";
import { needsDatabase, parseCommand, runCommand, runOfflineCommand } from "@/lib/telegram/commands";
import { secureCompare } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** The subset of Telegram's Update we actually read. */
interface TelegramUpdate {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id?: number | string };
    from?: { id?: number | string; username?: string };
  };
}

/** 200 with no action. Telegram treats this as "delivered, stop retrying". */
function acknowledged(reason: string): Response {
  return Response.json({ ok: true, action: "ignored", reason });
}

export async function POST(request: Request): Promise<Response> {
  // --- 1. Authenticate ----------------------------------------------------
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || !secureCompare(secret, env.telegramWebhookSecret)) {
    log.warn("telegram.webhook.bad_secret");
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return acknowledged("unparseable body");
  }

  const updateId = update.update_id;
  const text = update.message?.text;
  const chatId = update.message?.chat?.id;

  if (typeof updateId !== "number") return acknowledged("no update_id");
  if (!text || chatId === undefined) return acknowledged("not a text message");

  // --- 2. Only answer the configured chat --------------------------------
  // Anyone can find the bot and message it. Without this, a stranger could
  // run /pause and silence your alerts.
  if (String(chatId) !== env.telegramChatId) {
    log.warn("telegram.webhook.foreign_chat", {
      chat_id: String(chatId),
      username: update.message?.from?.username,
    });
    return acknowledged("chat not allowed");
  }

  const command = parseCommand(text);
  if (!command) return acknowledged("not a command");

  try {
    // --- 3. Answer database-free commands without touching Mongo ----------
    // /help and /test are the commands you use when something is already
    // wrong, so they must not fail because the database is slow. We accept
    // that a retried /help may send twice: a duplicate help message is
    // harmless, whereas an unanswerable /help is not.
    if (!needsDatabase(command)) {
      log.info("telegram.command", { command, update_id: updateId, db: false });
      await sendMessage(env.telegramChatId, runOfflineCommand(command as "help" | "test"));
      return Response.json({ ok: true, command });
    }

    const db = await getDb();

    // Claimed BEFORE running, so a retry arriving mid-flight is rejected too.
    if (!(await claimUpdate(db, updateId))) {
      log.info("telegram.webhook.duplicate", { update_id: updateId, command });
      return acknowledged("duplicate update");
    }

    log.info("telegram.command", { command, update_id: updateId });
    const reply = await runCommand(db, command);
    await sendMessage(env.telegramChatId, reply);

    return Response.json({ ok: true, command });
  } catch (err) {
    log.error("telegram.webhook.failed", { command, ...errorInfo(err) });
    // Still 200: a retry would hit the same error, and repeated non-200
    // responses make Telegram disable the webhook.
    try {
      await sendMessage(env.telegramChatId, "⚠️ That command failed. Check the Vercel logs.");
    } catch {
      // Nothing more we can do.
    }
    return Response.json({ ok: true, error: "handler failed" });
  }
}

/** A GET here is almost always someone checking the URL in a browser. */
export function GET(): Response {
  return Response.json({ ok: true, info: "Telegram webhook endpoint. POST only." });
}

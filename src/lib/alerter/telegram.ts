/**
 * telegram.ts — the Telegram DM channel, and the low-level Bot API helper.
 *
 * WHY PLAIN FETCH AND NOT grammy: grammy is a full bot framework and it is what
 * handles the webhook side. Importing it here would pull the whole framework
 * into the poll route, which runs ~43,000 times a month. Sending a message is
 * one HTTP POST, so the poll path does exactly that and nothing more.
 *
 * Rate limits: Telegram answers 429 with a `retry_after` in seconds. We honour
 * it rather than hammering, because ignoring it gets the bot temporarily
 * blocked — which would take out alerting entirely.
 */

import { env } from "@/lib/env";
import { log, errorInfo } from "@/lib/log";
import { formatAlert } from "@/lib/alerter/format";
import type { AlertChannel, AlertPayload, SendResult } from "@/lib/alerter/types";

const API_BASE = "https://api.telegram.org";

export interface TelegramResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

/**
 * Call a Bot API method. Never logs the token, including in error paths — the
 * token is in the URL, so the URL itself must never reach a log line.
 */
export async function callTelegram<T = unknown>(
  method: string,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; token?: string } = {},
): Promise<T> {
  const token = opts.token ?? env.telegramBotToken;
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // 8s was too tight on a slow uplink and turned a working /last into a
    // "command failed". Telegram itself is fast; this budget is for the
    // network between us and it.
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });

  let payload: TelegramResponse<T>;
  try {
    payload = (await res.json()) as TelegramResponse<T>;
  } catch {
    throw new TelegramError(`${method} returned non-JSON (HTTP ${res.status})`, res.status);
  }

  if (!payload.ok) {
    throw new TelegramError(
      `${method} failed: ${payload.description ?? `HTTP ${res.status}`}`,
      payload.error_code ?? res.status,
      payload.parameters?.retry_after,
    );
  }

  return payload.result as T;
}

/** Send a message, retrying once if Telegram asks us to wait a short while. */
export async function sendMessage(
  chatId: string,
  html: string,
  opts: { disablePreview?: boolean; timeoutMs?: number } = {},
): Promise<{ message_id: number }> {
  const body = {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    // Link previews turn a compact alert into a wall of images.
    link_preview_options: { is_disabled: opts.disablePreview ?? true },
  };

  try {
    return await callTelegram<{ message_id: number }>("sendMessage", body, opts);
  } catch (err) {
    const wait = err instanceof TelegramError ? err.retryAfterSeconds : undefined;
    // Only wait it out if it is short. A long back-off is better handled by
    // leaving the deal unsent and retrying on the next cycle.
    if (wait !== undefined && wait <= 10) {
      log.warn("telegram.rate_limited", { retry_after: wait });
      await new Promise((r) => setTimeout(r, wait * 1000));
      return await callTelegram<{ message_id: number }>("sendMessage", body, opts);
    }
    throw err;
  }
}

/** The one alert channel implemented today. */
export function createTelegramDmChannel(): AlertChannel {
  return {
    name: "telegram-dm",

    isEnabled(): boolean {
      return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
    },

    async send(payload: AlertPayload): Promise<SendResult> {
      try {
        const html = formatAlert(payload);
        await sendMessage(env.telegramChatId, html);
        return { channel: "telegram-dm", ok: true };
      } catch (err) {
        log.error("alert.telegram.failed", errorInfo(err));
        const result: SendResult = {
          channel: "telegram-dm",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        if (err instanceof TelegramError && err.retryAfterSeconds !== undefined) {
          result.retryAfterSeconds = err.retryAfterSeconds;
        }
        return result;
      }
    },
  };
}

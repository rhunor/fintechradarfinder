/**
 * telegram-channel.ts — posts alerts to a public Telegram channel.
 *
 * WHY A CHANNEL RATHER THAN FANNING OUT DMs: a channel is ONE message no matter
 * how many people subscribe. Per-subscriber DMs would mean N sends per alert,
 * and Telegram caps bulk sending at roughly 30 messages a second — a thousand
 * subscribers would take forty seconds, which does not fit in a 45-second cycle
 * and would blow the Vercel memory budget. Telegram does the distribution.
 *
 * SPLIT OF RESPONSIBILITIES: this channel carries DEAL ALERTS only. Operational
 * messages — health warnings, the budget warning, the daily summary, and every
 * bot command — stay in the owner's private DM. Subscribers should not see that
 * a feed is down, and they certainly should not be able to run /pause.
 */

import { env } from "@/lib/env";
import { log, errorInfo } from "@/lib/log";
import { formatAlert } from "@/lib/alerter/format";
import { sendMessage } from "@/lib/alerter/telegram";
import type { AlertChannel, AlertPayload, SendResult } from "@/lib/alerter/types";
import { TelegramError } from "@/lib/alerter/telegram";

export function createTelegramChannelChannel(): AlertChannel {
  return {
    name: "telegram-channel",

    isEnabled(): boolean {
      return Boolean(env.telegramChannelId);
    },

    async send(payload: AlertPayload): Promise<SendResult> {
      const channelId = env.telegramChannelId;
      if (!channelId) {
        return { channel: "telegram-channel", ok: false, error: "TELEGRAM_CHANNEL_ID not set" };
      }

      try {
        // Unverified alerts are an internal signal that the AI was offline and
        // we guessed from keywords. Publishing a guess to an audience is worse
        // than publishing nothing, so they never reach the channel.
        if (payload.unverified) {
          log.info("alert.channel.skipped_unverified", { company: payload.deal.company });
          return { channel: "telegram-channel", ok: false, error: "unverified alerts are not published" };
        }

        await sendMessage(channelId, formatAlert(payload));
        return { channel: "telegram-channel", ok: true };
      } catch (err) {
        log.error("alert.channel.failed", errorInfo(err));
        const result: SendResult = {
          channel: "telegram-channel",
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

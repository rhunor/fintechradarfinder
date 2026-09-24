/**
 * alerter/index.ts — dispatches a deal to every enabled channel.
 *
 * The pipeline calls dispatchAlert() and never knows which channels exist.
 * Adding a public Telegram channel or an X/Twitter poster later means writing
 * one AlertChannel and registering it here.
 *
 * Claiming happens BEFORE sending and is released on failure, so a deal is
 * never lost to a transient Telegram outage and never sent twice.
 */

import type { Db } from "mongodb";
import { log } from "@/lib/log";
import { env } from "@/lib/env";
import { createTelegramDmChannel } from "@/lib/alerter/telegram";
import { createTelegramChannelChannel } from "@/lib/alerter/telegram-channel";
import type { AlertChannel, AlertPayload, SendResult } from "@/lib/alerter/types";
import { claimDealForAlert, markDealSent, releaseDealClaim, type NewDeal } from "@/lib/store/deals";
import { bumpUsage } from "@/lib/store/usage";

/**
 * The channel registry. Order is irrelevant: channels are independent and one
 * failing must not stop the others.
 */
export function getChannels(): AlertChannel[] {
  const channel = createTelegramChannelChannel();
  const dm = createTelegramDmChannel();

  // With a public channel configured, the owner's DM stops receiving every
  // alert by default. That DM is where health warnings and the daily summary
  // live, and duplicating a busy alert feed into it buries them. Set
  // ALSO_DM_ALERTS=true to get both.
  const channels: AlertChannel[] = [];
  if (channel.isEnabled()) channels.push(channel);
  if (!channel.isEnabled() || env.alsoDmAlerts) channels.push(dm);

  return channels.filter((c) => c.isEnabled());
}

export interface DispatchResult {
  sent: boolean;
  /** Why nothing was sent, when sent is false. */
  skipped?: "duplicate" | "in-flight" | "paused" | "no-channels" | "send-failed";
  results: SendResult[];
  dealId?: string;
}

/**
 * Claim, send, and record. The only entry point the pipeline should use.
 *
 * `paused` is checked by the caller rather than here, because a paused system
 * still needs to run dedupe and classification — it just does not speak.
 */
export async function dispatchAlert(
  db: Db,
  deal: NewDeal,
  now: Date = new Date(),
): Promise<DispatchResult> {
  const channels = getChannels();
  if (channels.length === 0) {
    log.warn("alert.no_channels_configured");
    return { sent: false, skipped: "no-channels", results: [] };
  }

  const claim = await claimDealForAlert(db, deal, now);
  if (!claim.claimed) {
    log.info("alert.suppressed", {
      company: deal.company,
      event: deal.event,
      reason: claim.reason,
      sources_on_deal: claim.existing?.sources.length ?? 0,
    });
    return {
      sent: false,
      skipped: claim.reason === "recently-alerted" ? "duplicate" : "in-flight",
      results: [],
    };
  }

  const dealId = claim.deal._id;
  const payload: AlertPayload = {
    deal: claim.deal,
    sourceName: deal.source.sourceId,
    link: deal.source.link,
    detectionLatencyMs: deal.publishedAt ? now.getTime() - deal.publishedAt.getTime() : null,
    unverified: deal.unverified,
  };

  const results = await Promise.all(channels.map((channel) => channel.send(payload)));
  const anySucceeded = results.some((r) => r.ok);

  if (anySucceeded) {
    await markDealSent(db, dealId, new Date());
    await bumpUsage(db, { alerts: 1 });
    log.info("alert.sent", {
      deal_id: dealId,
      company: deal.company,
      event: deal.event,
      channels: results.filter((r) => r.ok).map((r) => r.channel),
      unverified: deal.unverified,
    });
    return { sent: true, results, dealId };
  }

  // Everything failed. Release the claim so the next cycle retries rather than
  // waiting out the five-minute TTL with the deal stuck in "alerting".
  await releaseDealClaim(db, dealId);
  log.error("alert.all_channels_failed", {
    deal_id: dealId,
    errors: results.map((r) => r.error),
  });
  return { sent: false, skipped: "send-failed", results, dealId };
}

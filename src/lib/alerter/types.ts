/**
 * alerter/types.ts — the boundary between "we found a deal" and "we told someone".
 *
 * WHY A CHANNEL INTERFACE: today there is exactly one destination, a Telegram
 * DM. The brief anticipates a public Telegram channel and X/Twitter later,
 * possibly with an approve/skip step. Those must be addable without touching
 * the pipeline, so the pipeline only ever knows about `AlertChannel`.
 */

import type { DealDoc } from "@/lib/store/schema";

/** Everything a channel needs to render an alert. */
export interface AlertPayload {
  deal: DealDoc;
  /** Name of the source that reported it, for the attribution line. */
  sourceName: string;
  link: string;
  /** Milliseconds from publication to alert, for the "detected in" line. */
  detectionLatencyMs: number | null;
  /** True when the AI was offline and this is a keyword-only match. */
  unverified: boolean;
}

export interface SendResult {
  channel: string;
  ok: boolean;
  error?: string;
  /** Set when the channel asked us to back off. */
  retryAfterSeconds?: number;
}

export interface AlertChannel {
  readonly name: string;
  /** Whether this channel is configured and should be used. */
  isEnabled(): boolean;
  send(payload: AlertPayload): Promise<SendResult>;
}

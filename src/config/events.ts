/**
 * events.ts — the event types the radar reports, and how they are presented.
 *
 * WHY A SEPARATE FILE: event types now span from rare, high-value deals
 * (funding, acquisitions) to common announcements (launches, partnerships).
 * Those have very different volumes, so each one carries its own alert
 * threshold and an `enabled` flag, letting you turn a noisy category off
 * without touching the pipeline or the prompt.
 */

import type { DealEvent } from "@/lib/store/schema";

export interface EventConfig {
  id: DealEvent;
  /** Emoji shown at the head of the alert. */
  icon: string;
  /** Uppercase label in the alert headline. */
  label: string;
  /** One line describing it to the model. */
  description: string;
  enabled: boolean;
  /**
   * Per-event confidence floor. Common, low-stakes events are held to a
   * higher bar than a funding round, because a false positive on a
   * partnership is pure noise while a missed round is a real loss.
   */
  minConfidence: number;
  /**
   * Suppress a repeat for the same company and event for this many hours.
   * Launches and partnerships get a longer window: the same announcement gets
   * recycled through trade press for days.
   */
  dedupeWindowHours: number;
}

export const EVENTS: readonly EventConfig[] = [
  {
    id: "funding",
    icon: "💰",
    label: "FUNDING",
    description:
      "the company is RAISING money: pre-seed, seed, Series A-H, growth equity, venture debt, debt financing, credit facility, strategic investment",
    enabled: true,
    minConfidence: 0.7,
    dedupeWindowHours: 72,
  },
  {
    id: "acquisition",
    icon: "🤝",
    label: "ACQUISITION",
    description:
      "a company is being acquired, is acquiring, or is merging, including take-privates and definitive merger agreements",
    enabled: true,
    minConfidence: 0.7,
    dedupeWindowHours: 72,
  },
  {
    id: "launch",
    icon: "🚀",
    label: "LAUNCH",
    description:
      "a NEW product, platform, card, account type or major feature is being launched, or the company itself is coming out of stealth",
    enabled: true,
    // Held higher than a deal: every company ships features, and only a
    // genuine product launch is worth a notification.
    minConfidence: 0.75,
    dedupeWindowHours: 168,
  },
  {
    id: "expansion",
    icon: "🌐",
    label: "EXPANSION",
    description:
      "entering a new country, state or market, opening a major office, obtaining a licence or charter that unlocks a new market, or a significant headcount expansion",
    enabled: true,
    minConfidence: 0.75,
    dedupeWindowHours: 168,
  },
  {
    id: "rebrand",
    icon: "🏷️",
    label: "REBRAND",
    description:
      "a change of company name, brand, or a significant repositioning of the business",
    enabled: true,
    minConfidence: 0.75,
    dedupeWindowHours: 168,
  },
  {
    id: "partnership",
    icon: "🔗",
    label: "PARTNERSHIP",
    description:
      "a named partnership, integration or distribution deal between two companies, where at least one is a fintech",
    enabled: true,
    // The noisiest category by a distance: press releases announce
    // partnerships constantly, most of them trivial.
    minConfidence: 0.8,
    dedupeWindowHours: 168,
  },
];

export const ENABLED_EVENTS = EVENTS.filter((e) => e.enabled);

const BY_ID = new Map(EVENTS.map((e) => [e.id, e]));

export function eventConfig(event: DealEvent): EventConfig {
  const config = BY_ID.get(event);
  if (!config) throw new Error(`Unknown event type: ${event}`);
  return config;
}

export function isEventEnabled(event: DealEvent): boolean {
  return BY_ID.get(event)?.enabled ?? false;
}

/** The list the classifier is allowed to choose from. */
export function enabledEventIds(): DealEvent[] {
  return ENABLED_EVENTS.map((e) => e.id);
}

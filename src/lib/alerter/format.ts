/**
 * format.ts — renders a deal into the Telegram message.
 *
 * WHY ESCAPING IS NOT OPTIONAL: we send with parse_mode=HTML, and every string
 * here originates from a news headline or an AI response. A company called
 * "Smith & Wesson" or a summary containing "<" will make Telegram reject the
 * whole message with a 400 if it is not escaped. That failure would be silent
 * from the user's perspective — the alert simply never arrives.
 *
 * Times are rendered in US Eastern because that is where the markets and most
 * of these companies are, and because a timestamp in UTC is useless at a glance.
 */

import { eventConfig } from "@/config/events";
import type { DealDoc } from "@/lib/store/schema";
import type { AlertPayload } from "@/lib/alerter/types";

/**
 * Escape the five characters that matter to Telegram's HTML parser.
 * Order matters: ampersand must be first or it would double-escape the others.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ET_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const ET_DATETIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "14:32" in US Eastern. */
export function formatEtTime(date: Date): string {
  return ET_TIME.format(date);
}

/** "Sep 23, 14:32" in US Eastern, for the dashboard and daily summary. */
export function formatEtDateTime(date: Date): string {
  return ET_DATETIME.format(date);
}

/** "2m 14s" — how long between publication and the alert landing. */
export function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Region to flag. "US+CA" gets both, since either party qualifying is enough. */
export function regionFlag(region: string): string {
  switch (region) {
    case "US":
      return "🇺🇸";
    case "CA":
      return "🇨🇦";
    case "US+CA":
      return "🇺🇸🇨🇦";
    default:
      return "🌐";
  }
}

/**
 * Join the deal's money details into the headline's second line.
 * Every part is optional, so this drops missing pieces rather than printing
 * "undefined" or a trailing separator.
 */
function dealLine(deal: DealDoc): string {
  const parts: string[] = [];
  if (deal.round) parts.push(escapeHtml(deal.round));
  const money = deal.amount ?? deal.dealValue;
  if (money) parts.push(escapeHtml(money));
  return parts.join(" · ");
}

/**
 * The third line: who put the money in, or who is buying whom.
 */
function partiesLine(deal: DealDoc): string | null {
  if (deal.event === "acquisition") {
    const acquirer = deal.acquirer ? escapeHtml(deal.acquirer) : null;
    const target = deal.target ? escapeHtml(deal.target) : null;
    if (acquirer && target) {
      const value = deal.dealValue ? ` · ${escapeHtml(deal.dealValue)}` : "";
      return `${acquirer} → ${target}${value}`;
    }
    return null;
  }

  const leads = deal.leadInvestors.filter(Boolean);
  if (leads.length > 0) {
    const others = deal.otherInvestors.filter(Boolean);
    const suffix = others.length > 0 ? ` (+${others.length} more)` : "";
    return `Led by: ${escapeHtml(leads.join(", "))}${suffix}`;
  }
  const others = deal.otherInvestors.filter(Boolean);
  if (others.length > 0) return `Investors: ${escapeHtml(others.slice(0, 3).join(", "))}`;
  return null;
}

/**
 * Render the full alert. Returns Telegram-flavoured HTML.
 *
 * Shape (from the brief):
 *   💰 FUNDING · 🇺🇸
 *   <b>Company</b> — Series E · $200M
 *   Led by: Founders Fund
 *   One-line summary.
 *   TechCrunch · published 14:32 ET · detected in 2m 14s
 *   Read source →
 */
export function formatAlert(payload: AlertPayload): string {
  const { deal, sourceName, link, detectionLatencyMs, unverified } = payload;

  // Icon and label come from src/config/events.ts so adding an event type does
  // not mean hunting through the formatter.
  const { icon, label } = eventConfig(deal.event);
  const lines: string[] = [];

  if (unverified) {
    // Loud and first: the reader must know this bypassed the classifier.
    lines.push("⚠️ <b>UNVERIFIED</b> (AI offline — keyword match only)");
  }

  lines.push(`${icon} <b>${label}</b> · ${regionFlag(deal.region)}`);

  const details = dealLine(deal);
  lines.push(`<b>${escapeHtml(deal.company)}</b>${details ? ` — ${details}` : ""}`);

  const parties = partiesLine(deal);
  if (parties) lines.push(parties);

  if (deal.summary) lines.push(escapeHtml(deal.summary));

  const meta: string[] = [escapeHtml(sourceName)];
  if (deal.publishedAt) meta.push(`published ${formatEtTime(deal.publishedAt)} ET`);
  if (detectionLatencyMs !== null) meta.push(`detected in ${formatDuration(detectionLatencyMs)}`);
  lines.push(`<i>${meta.join(" · ")}</i>`);

  lines.push(`<a href="${escapeHtml(link)}">Read source →</a>`);

  // A deal reported by several wires lists the extras, so it is obvious the
  // system merged them rather than missed them.
  if (deal.sources.length > 1) {
    lines.push(`<i>also reported by ${deal.sources.length - 1} other source(s)</i>`);
  }

  return lines.join("\n");
}

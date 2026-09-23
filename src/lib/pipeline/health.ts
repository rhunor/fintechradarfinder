/**
 * health.ts — the warnings that tell you the agent is in trouble.
 *
 * WHY THIS IS NOT OPTIONAL: the failure mode of a monitoring agent is silence.
 * If a feed starts returning 403, or the scheduler stops calling us, nothing
 * visibly breaks — you simply stop getting alerts, and you have no way to tell
 * that apart from a quiet news day. These checks turn silence into a message.
 *
 * Every warning is rate limited, because a warning that arrives every minute
 * gets muted, and a muted warning is the same as no warning.
 */

import type { Db } from "mongodb";
import { ENABLED_SOURCES } from "@/config/sources";
import { log, errorInfo } from "@/lib/log";
import { escapeHtml, formatDuration } from "@/lib/alerter/format";
import { sendMessage } from "@/lib/alerter/telegram";
import { env } from "@/lib/env";
import { claimStaleWarning, staleSources } from "@/lib/store/source-state";
import { currentProjection, HOBBY_LIMITS, WARN_THRESHOLD } from "@/lib/budget/meter";
import { COLLECTIONS, type SettingsDoc, type SourceStateDoc } from "@/lib/store/schema";

/** A source with no successful fetch in this long is considered unhealthy. */
export const STALE_SOURCE_THRESHOLD_MS = 15 * 60 * 1000;

/** The budget warning repeats at most this often. */
const BUDGET_WARNING_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Warn about sources that have stopped working.
 *
 * One message covers every newly-stale source rather than one message each: a
 * network outage makes all nineteen go stale at once, and nineteen
 * notifications is how you learn to ignore notifications.
 */
export async function warnStaleSources(
  db: Db,
  state: Map<string, SourceStateDoc>,
  now: Date = new Date(),
): Promise<string[]> {
  const stale = staleSources(ENABLED_SOURCES, state, STALE_SOURCE_THRESHOLD_MS, now);
  if (stale.length === 0) return [];

  // claimStaleWarning is atomic per source and enforces one warning per hour,
  // so a persistent failure does not notify every single cycle.
  const toWarn: typeof stale = [];
  for (const entry of stale) {
    if (await claimStaleWarning(db, entry.source.id, now)) toWarn.push(entry);
  }
  if (toWarn.length === 0) return [];

  const lines = [
    `⚠️ <b>${toWarn.length} source(s) unhealthy</b>`,
    `<i>no successful fetch in ${formatDuration(STALE_SOURCE_THRESHOLD_MS)}</i>`,
    "",
  ];
  for (const entry of toWarn) {
    lines.push(`• <b>${escapeHtml(entry.source.name)}</b>`);
    const last = entry.lastSuccessAt
      ? `last ok ${formatDuration(now.getTime() - entry.lastSuccessAt.getTime())} ago`
      : "never succeeded";
    lines.push(`  <i>${escapeHtml(last)}${entry.lastError ? ` — ${escapeHtml(entry.lastError.slice(0, 80))}` : ""}</i>`);
  }

  try {
    await sendMessage(env.telegramChatId, lines.join("\n"));
  } catch (err) {
    // A failed warning must never take down the cycle that produced it.
    log.error("health.stale_warning_failed", errorInfo(err));
  }

  return toWarn.map((e) => e.source.id);
}

/**
 * Warn when projected monthly Vercel usage crosses the threshold.
 *
 * Going over a Hobby limit pauses functions for the rest of the billing period,
 * so this exists to give you days of notice rather than none.
 */
export async function warnBudget(db: Db, now: Date = new Date()): Promise<boolean> {
  const projection = await currentProjection(db);
  if (!projection.warn) return false;

  // Need a meaningful sample before extrapolating a month from it.
  if (projection.cycles < 30) return false;

  const settings = db.collection<SettingsDoc>(COLLECTIONS.settings);
  const cutoff = new Date(now.getTime() - BUDGET_WARNING_INTERVAL_MS);
  const claimed = await settings.updateOne(
    {
      _id: "global",
      $or: [{ lastBudgetWarningAt: { $lte: cutoff } }, { lastBudgetWarningAt: { $exists: false } }],
    },
    { $set: { lastBudgetWarningAt: now } },
  );
  if (claimed.modifiedCount !== 1) return false;

  const pct = (n: number) => `${n.toFixed(0)}%`;
  const lines = [
    `⚠️ <b>Vercel usage projection is high</b>`,
    `<i>over ${pct(WARN_THRESHOLD * 100)} of a Hobby limit</i>`,
    "",
    `Measured over ${projection.cycles} cycles today:`,
    `avg ${projection.avgWallMs}ms wall · ${projection.avgCpuMs}ms cpu`,
    "",
    `Active CPU: ${projection.projectedCpuHours.toFixed(2)}h of ${HOBBY_LIMITS.activeCpuHours}h (${pct(projection.cpuPercent)})`,
    `Memory: ${projection.projectedGbHours.toFixed(0)} of ${HOBBY_LIMITS.provisionedMemoryGbHours} GB-h (${pct(projection.memoryPercent)})`,
    "",
    "<i>Consider slowing the scheduler to every 90 seconds. See the README.</i>",
  ];

  try {
    await sendMessage(env.telegramChatId, lines.join("\n"));
    log.warn("health.budget_warning_sent", {
      cpu_percent: projection.cpuPercent,
      memory_percent: projection.memoryPercent,
    });
    return true;
  } catch (err) {
    log.error("health.budget_warning_failed", errorInfo(err));
    return false;
  }
}

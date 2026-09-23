/**
 * daily.ts — the once-a-day digest.
 *
 * WHY A DAILY MESSAGE AT ALL, when /status exists on demand: it is a heartbeat
 * you do not have to remember to check. If this stops arriving, something is
 * wrong — which is information you get for free, without watching anything.
 *
 * It answers four questions: what did it find, are the feeds healthy, how much
 * AI quota did it use, and are we on track to blow a Vercel limit.
 */

import type { Db } from "mongodb";
import { ENABLED_SOURCES } from "@/config/sources";
import { env } from "@/lib/env";
import { escapeHtml, formatDuration, formatEtDateTime } from "@/lib/alerter/format";
import { currentProjection, HOBBY_LIMITS } from "@/lib/budget/meter";
import { countPending } from "@/lib/store/candidates";
import { recentDeals } from "@/lib/store/deals";
import { getSettings } from "@/lib/store/settings";
import { loadAllSourceState } from "@/lib/store/source-state";
import { getUsage, requestsForModel } from "@/lib/store/usage";
import { latencyStats } from "@/lib/stats";
import { STALE_SOURCE_THRESHOLD_MS } from "@/lib/pipeline/health";
import type { DealDoc } from "@/lib/store/schema";
import { COLLECTIONS } from "@/lib/store/schema";

/** Deals alerted in the last 24 hours, newest first. */
async function dealsLast24h(db: Db): Promise<DealDoc[]> {
  const since = new Date(Date.now() - 86_400_000);
  return db
    .collection<DealDoc>(COLLECTIONS.deals)
    .find({ alertState: "sent", alertedAt: { $gte: since } })
    .sort({ alertedAt: -1 })
    .toArray();
}

export async function buildDailySummary(db: Db): Promise<string> {
  const now = new Date();
  const [settings, usage, projection, state, pending, deals, latency] = await Promise.all([
    getSettings(db),
    getUsage(db),
    currentProjection(db),
    loadAllSourceState(db),
    countPending(db),
    dealsLast24h(db),
    latencyStats(db, 7),
  ]);

  const lines: string[] = [
    `<b>📰 Daily summary</b>`,
    `<i>${formatEtDateTime(now)} ET</i>`,
    "",
  ];

  if (settings.paused) lines.push("⏸ <b>ALERTING IS PAUSED</b>", "");

  // --- what it found -------------------------------------------------------
  lines.push(`<b>Alerts (24h): ${deals.length}</b>`);
  if (deals.length === 0) {
    lines.push("<i>No qualifying deals. Quiet day, or worth checking /sources.</i>");
  } else {
    for (const deal of deals.slice(0, 10)) {
      const icon = deal.event === "funding" ? "💰" : "🤝";
      const detail = [deal.round, deal.amount ?? deal.dealValue].filter(Boolean).join(" · ");
      lines.push(
        `${icon} <b>${escapeHtml(deal.company)}</b>${detail ? ` — ${escapeHtml(detail)}` : ""}`,
      );
    }
    if (deals.length > 10) lines.push(`<i>…and ${deals.length - 10} more</i>`);
  }
  lines.push("");

  // --- pipeline throughput -------------------------------------------------
  lines.push("<b>Pipeline today</b>");
  lines.push(`Cycles: ${usage.cycles} · items seen: ${usage.itemsSeen}`);
  lines.push(`Candidates: ${usage.candidates} · pending now: ${pending}`);
  lines.push("");

  // --- latency -------------------------------------------------------------
  lines.push("<b>Latency, published → alerted (7d)</b>");
  if (latency.count === 0) {
    lines.push("<i>Not enough alerts with a known publish time yet.</i>");
  } else {
    lines.push(
      `p50 ${formatDuration(latency.p50Ms ?? 0)} · p95 ${formatDuration(latency.p95Ms ?? 0)} ` +
        `(${latency.count} alerts)`,
    );
  }
  lines.push("");

  // --- source health -------------------------------------------------------
  const unhealthy = ENABLED_SOURCES.filter((s) => {
    const last = state.get(s.id)?.lastSuccessAt;
    return !last || now.getTime() - last.getTime() > STALE_SOURCE_THRESHOLD_MS;
  });
  lines.push(
    `<b>Sources: ${ENABLED_SOURCES.length - unhealthy.length}/${ENABLED_SOURCES.length} healthy</b>`,
  );
  for (const source of unhealthy.slice(0, 8)) {
    const doc = state.get(source.id);
    const last = doc?.lastSuccessAt
      ? `${formatDuration(now.getTime() - doc.lastSuccessAt.getTime())} ago`
      : "never";
    lines.push(`⚠️ ${escapeHtml(source.name)} — last ok ${escapeHtml(last)}`);
  }
  lines.push("");

  // --- AI usage ------------------------------------------------------------
  lines.push("<b>AI usage today</b>");
  lines.push(
    `${escapeHtml(env.geminiModel)}: ${requestsForModel(usage, env.geminiModel)}/${env.geminiDailyLimit}`,
  );
  const fallback = env.geminiFallbackModel;
  if (fallback) {
    lines.push(
      `${escapeHtml(fallback)}: ${requestsForModel(usage, fallback)}/${env.geminiFallbackDailyLimit}`,
    );
  }
  if (settings.aiFailingSince) {
    lines.push(`⚠️ <i>AI failing since ${formatDuration(now.getTime() - settings.aiFailingSince.getTime())} ago</i>`);
  }
  lines.push("");

  // --- Vercel budget -------------------------------------------------------
  const pct = (n: number) => `${n.toFixed(0)}%`;
  lines.push("<b>Projected monthly Vercel usage</b>");
  lines.push(`avg cycle: ${projection.avgWallMs}ms wall · ${projection.avgCpuMs}ms cpu`);
  lines.push(
    `${projection.cpuPercent > 70 ? "⚠️" : "✅"} CPU ${projection.projectedCpuHours.toFixed(2)}h / ` +
      `${HOBBY_LIMITS.activeCpuHours}h (${pct(projection.cpuPercent)})`,
  );
  lines.push(
    `${projection.memoryPercent > 70 ? "⚠️" : "✅"} Memory ${projection.projectedGbHours.toFixed(0)} / ` +
      `${HOBBY_LIMITS.provisionedMemoryGbHours} GB-h (${pct(projection.memoryPercent)})`,
  );

  return lines.join("\n");
}

/** Most recent alerts, used by the daily route's JSON response for debugging. */
export async function dailySummaryFacts(db: Db): Promise<Record<string, unknown>> {
  const [usage, projection, deals] = await Promise.all([
    getUsage(db),
    currentProjection(db),
    recentDeals(db, 5),
  ]);
  return {
    cycles_today: usage.cycles,
    items_seen_today: usage.itemsSeen,
    alerts_recent: deals.length,
    projected_cpu_hours: Number(projection.projectedCpuHours.toFixed(3)),
    projected_gb_hours: Number(projection.projectedGbHours.toFixed(1)),
  };
}

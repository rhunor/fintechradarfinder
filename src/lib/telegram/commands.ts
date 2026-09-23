/**
 * commands.ts — what the bot says back.
 *
 * Every handler returns an HTML string; the route sends it. Keeping them pure
 * like this means they can be tested without a network, and it keeps the route
 * to the one thing routes should do, which is plumbing.
 *
 * All output goes through escapeHtml wherever it interpolates stored data —
 * company names and feed errors both routinely contain "&" and "<", and an
 * unescaped one makes Telegram reject the whole message with a 400.
 */

import type { Db } from "mongodb";
import { ENABLED_SOURCES } from "@/config/sources";
import { env } from "@/lib/env";
import { escapeHtml, formatDuration, formatEtDateTime, formatAlert } from "@/lib/alerter/format";
import { currentProjection, HOBBY_LIMITS } from "@/lib/budget/meter";
import { countPending } from "@/lib/store/candidates";
import { recentDeals } from "@/lib/store/deals";
import { getSettings, setPaused, SCHEDULER_GAP_THRESHOLD_MS } from "@/lib/store/settings";
import { loadAllSourceState } from "@/lib/store/source-state";
import { getUsage, requestsForModel } from "@/lib/store/usage";
import { countAlertsSince, latencyStats } from "@/lib/stats";
import type { DealDoc } from "@/lib/store/schema";

/** "3m ago", or "never". */
function ago(date: Date | null | undefined): string {
  if (!date) return "never";
  return `${formatDuration(Date.now() - date.getTime())} ago`;
}

export async function handleStatus(db: Db): Promise<string> {
  // Every one of these is independent, so they go out together. Leaving the
  // alert count as a sixth sequential query added a whole round trip to the
  // slowest command in the bot.
  const since = new Date(Date.now() - 86_400_000);
  const [settings, usage, projection, state, pending, alertsToday] = await Promise.all([
    getSettings(db),
    getUsage(db),
    currentProjection(db),
    loadAllSourceState(db),
    countPending(db),
    countAlertsSince(db, since),
  ]);

  const lines: string[] = ["<b>📊 Status</b>", ""];

  // --- cycles ---
  const lastCycle = settings.lastCycleAt ?? null;
  const gap = lastCycle ? Date.now() - lastCycle.getTime() : null;
  const stalled = gap !== null && gap > SCHEDULER_GAP_THRESHOLD_MS;
  lines.push(
    `${stalled ? "⚠️" : "✅"} Last cycle: ${ago(lastCycle)}` +
      (settings.lastCycleDurationMs ? ` (${settings.lastCycleDurationMs}ms)` : ""),
  );
  if (stalled) {
    lines.push(`   <i>No cycle for over ${formatDuration(SCHEDULER_GAP_THRESHOLD_MS)} — is the scheduler running?</i>`);
  }
  lines.push(`Cycles today: ${usage.cycles}`);
  if (settings.paused) lines.push("⏸ <b>PAUSED</b> — deduping but not alerting");
  lines.push("");

  // --- activity ---
  lines.push(`Items seen today: ${usage.itemsSeen}`);
  lines.push(`Candidates today: ${usage.candidates}`);
  lines.push(`Alerts (24h): ${alertsToday}`);
  lines.push(`Pending in queue: ${pending}`);
  lines.push("");

  // --- AI ---
  const primaryUsed = requestsForModel(usage, env.geminiModel);
  const aiHealthy = !settings.aiFailingSince;
  lines.push(`${aiHealthy ? "✅" : "⚠️"} AI: ${escapeHtml(env.geminiModel)}`);
  lines.push(`   requests today: ${primaryUsed}/${env.geminiDailyLimit}`);
  const fallback = env.geminiFallbackModel;
  if (fallback) {
    lines.push(
      `   fallback ${escapeHtml(fallback)}: ${requestsForModel(usage, fallback)}/${env.geminiFallbackDailyLimit}`,
    );
  }
  if (!aiHealthy && settings.aiFailingSince) {
    lines.push(`   <i>failing since ${ago(settings.aiFailingSince)}</i>`);
    if (settings.aiLastError) lines.push(`   <i>${escapeHtml(settings.aiLastError.slice(0, 120))}</i>`);
  }
  lines.push("");

  // --- sources ---
  const healthy = ENABLED_SOURCES.filter((s) => {
    const last = state.get(s.id)?.lastSuccessAt;
    return last && Date.now() - last.getTime() < 15 * 60 * 1000;
  }).length;
  lines.push(`Sources healthy: ${healthy}/${ENABLED_SOURCES.length}  (/sources for detail)`);
  lines.push("");

  // --- Vercel budget ---
  lines.push("<b>Projected monthly Vercel usage</b>");
  lines.push(`avg cycle: ${projection.avgWallMs}ms wall · ${projection.avgCpuMs}ms cpu`);
  lines.push(
    `${projection.cpuPercent > 70 ? "⚠️" : "✅"} Active CPU: ` +
      `${projection.projectedCpuHours.toFixed(2)}h of ${HOBBY_LIMITS.activeCpuHours}h ` +
      `(${projection.cpuPercent.toFixed(0)}%)`,
  );
  lines.push(
    `${projection.memoryPercent > 70 ? "⚠️" : "✅"} Memory: ` +
      `${projection.projectedGbHours.toFixed(0)} of ${HOBBY_LIMITS.provisionedMemoryGbHours} GB-h ` +
      `(${projection.memoryPercent.toFixed(0)}%)`,
  );
  lines.push(
    `✅ Invocations: ${projection.projectedInvocations.toLocaleString("en-US")} of ` +
      `${HOBBY_LIMITS.invocations.toLocaleString("en-US")} (${projection.invocationPercent.toFixed(0)}%)`,
  );

  return lines.join("\n");
}

export async function handleLast(db: Db): Promise<string> {
  const deals = await recentDeals(db, 5);
  if (deals.length === 0) return "No alerts sent yet.";

  const lines: string[] = ["<b>🕐 Last 5 alerts</b>", ""];
  for (const deal of deals) {
    const icon = deal.event === "funding" ? "💰" : "🤝";
    const detail = [deal.round, deal.amount ?? deal.dealValue].filter(Boolean).join(" · ");
    lines.push(
      `${icon} <b>${escapeHtml(deal.company)}</b>${detail ? ` — ${escapeHtml(detail)}` : ""}`,
    );
    lines.push(
      `   <i>${deal.alertedAt ? formatEtDateTime(deal.alertedAt) : "?"} ET · ${escapeHtml(deal.region)}</i>`,
    );
  }
  return lines.join("\n");
}

export async function handleStats(db: Db): Promise<string> {
  const stats = await latencyStats(db, 7);
  if (stats.count === 0) {
    return "<b>📈 Stats (7 days)</b>\n\nNo alerts with a known publish time yet.";
  }
  return [
    "<b>📈 Stats (7 days)</b>",
    "",
    `Alerts measured: ${stats.count}`,
    "",
    "<b>Published → alerted</b>",
    `p50: ${formatDuration(stats.p50Ms ?? 0)}`,
    `p95: ${formatDuration(stats.p95Ms ?? 0)}`,
    `best: ${formatDuration(stats.minMs ?? 0)}`,
    `worst: ${formatDuration(stats.maxMs ?? 0)}`,
  ].join("\n");
}

export async function handlePause(db: Db): Promise<string> {
  await setPaused(db, true);
  return "⏸ <b>Paused.</b>\n\nCycles keep running and deduping, but no alerts will be sent. Use /resume to turn alerting back on.";
}

export async function handleResume(db: Db): Promise<string> {
  await setPaused(db, false);
  return "▶️ <b>Resumed.</b> Alerting is back on.";
}

export async function handleSources(db: Db): Promise<string> {
  const state = await loadAllSourceState(db);
  const lines: string[] = [`<b>📡 Sources (${ENABLED_SOURCES.length})</b>`, ""];

  for (const source of ENABLED_SOURCES) {
    const doc = state.get(source.id);
    const last = doc?.lastSuccessAt ?? null;
    const fresh = last !== null && Date.now() - last.getTime() < 15 * 60 * 1000;
    const never = !doc;
    const icon = never ? "⚪" : fresh ? "✅" : "⚠️";

    let detail = never ? "not yet polled" : `ok ${ago(last)}`;
    if (doc && doc.errorCount > 0) {
      detail = `${doc.errorCount} error(s), last ok ${ago(last)}`;
    }
    lines.push(`${icon} <b>${escapeHtml(source.name)}</b>`);
    lines.push(`   <i>${escapeHtml(detail)}${!doc?.bootstrapped && doc ? " · bootstrapping" : ""}</i>`);
    if (doc?.lastError) lines.push(`   <i>${escapeHtml(doc.lastError.slice(0, 90))}</i>`);
  }
  return lines.join("\n");
}

/**
 * /test — send a sample alert so the formatting and delivery path can be
 * checked without waiting for real news.
 */
export function buildTestAlert(): string {
  const now = new Date();
  const sample: DealDoc = {
    _id: "sample",
    company: "Acme Pay & Co",
    event: "funding",
    region: "US+CA",
    fintechSubsector: "payments",
    amount: "$42M",
    currency: "USD",
    round: "Series B",
    leadInvestors: ["Example Ventures"],
    otherInvestors: ["Second Fund", "Third Fund"],
    acquirer: null,
    target: null,
    dealValue: null,
    summary: "Acme Pay raised $42M Series B to expand its cross-border payments network.",
    confidence: 0.94,
    unverified: false,
    sources: [],
    alertState: "sent",
    claimedAt: now,
    claimExpiresAt: now,
    lastAlertedAt: now,
    // Two minutes ago, so the latency line shows a realistic value.
    publishedAt: new Date(now.getTime() - 134_000),
    fetchedAt: now,
    classifiedAt: now,
    alertedAt: now,
    createdAt: now,
  };

  return (
    "<i>This is a test alert. The company is not real.</i>\n\n" +
    formatAlert({
      deal: sample,
      sourceName: "Example Wire",
      link: "https://example.com/acme-pay-series-b",
      detectionLatencyMs: 134_000,
      unverified: false,
    })
  );
}

export function handleHelp(): string {
  return [
    "<b>🛰 Fintech Deal Radar</b>",
    "",
    "Watching US and Canadian fintech funding rounds and acquisitions.",
    "",
    "<b>Commands</b>",
    "/status — cycles, sources, AI usage, Vercel budget",
    "/last — the last 5 alerts",
    "/stats — published→alerted latency, p50 and p95",
    "/sources — every feed and its health",
    "/pause — stop alerting (keeps deduping)",
    "/resume — start alerting again",
    "/test — send a sample alert",
    "/help — this message",
  ].join("\n");
}

/**
 * Commands that need no database at all.
 *
 * WHY THIS MATTERS: /help and /test are what you reach for when something is
 * already broken. Making them depend on Mongo means they fail exactly when you
 * need them — which is what happened in testing: /help returned "command
 * failed" purely because the database was slow, despite needing nothing from it.
 */
export const DB_FREE_COMMANDS = ["help", "test"] as const;

export function needsDatabase(command: CommandName): boolean {
  return !(DB_FREE_COMMANDS as readonly string[]).includes(command);
}

/** Handlers that need nothing but the process itself. */
export function runOfflineCommand(command: "help" | "test"): string {
  return command === "help" ? handleHelp() : buildTestAlert();
}

export type CommandName =
  | "status"
  | "last"
  | "stats"
  | "pause"
  | "resume"
  | "test"
  | "sources"
  | "help";

/**
 * Extract a command from message text.
 *
 * Handles the "/status@MyBot" form Telegram uses in groups, and ignores
 * anything that is not a command so ordinary chatter gets no reply.
 */
export function parseCommand(text: string): CommandName | null {
  const match = /^\/([a-z]+)(?:@\w+)?\b/i.exec(text.trim());
  const name = match?.[1]?.toLowerCase();
  if (!name) return null;
  const known: CommandName[] = [
    "status", "last", "stats", "pause", "resume", "test", "sources", "help",
  ];
  return (known as string[]).includes(name) ? (name as CommandName) : null;
}

/** Route a parsed command to its handler. */
export async function runCommand(db: Db, command: CommandName): Promise<string> {
  switch (command) {
    case "status":
      return handleStatus(db);
    case "last":
      return handleLast(db);
    case "stats":
      return handleStats(db);
    case "pause":
      return handlePause(db);
    case "resume":
      return handleResume(db);
    case "sources":
      return handleSources(db);
    case "test":
      return buildTestAlert();
    case "help":
      return handleHelp();
  }
}

/**
 * schema.ts — the document shapes stored in MongoDB, and the collection names.
 *
 * WHY TYPES AND NOT ZOD HERE: these documents are written only by this app, so
 * the compiler is enough. Zod is reserved for data crossing a trust boundary —
 * AI responses and Telegram webhooks — where the shape is genuinely unknown.
 *
 * A note on lifecycle fields: `expiresAt` appears on collections with a TTL
 * index configured as expireAfterSeconds: 0, which means "delete when the date
 * in this field passes". Documents WITHOUT the field are never expired, which
 * is how `candidates` keeps live work forever but discards rejected items.
 */

import type { Verdict } from "@/lib/classifier/types";

export const COLLECTIONS = {
  seenItems: "seen_items",
  candidates: "candidates",
  deals: "deals",
  sourceState: "source_state",
  locks: "locks",
  telegramUpdates: "telegram_updates",
  settings: "settings",
  dailyUsage: "daily_usage",
} as const;

/** Every story we have ever ingested, so we never process one twice. */
export interface SeenItemDoc {
  _id: string; //         urlHash — the canonical dedupe key
  titleHash: string; //   second dedupe axis, catches syndicated reprints
  sourceId: string;
  link: string;
  title: string;
  firstSeenAt: Date; //   TTL anchor: 30 days
}

export type CandidateStatus = "pending" | "classified" | "alerted" | "rejected";

/** A story that passed the keyword prefilter and is moving through the AI stage. */
export interface CandidateDoc {
  _id: string; //         urlHash, same key as SeenItemDoc
  sourceId: string;
  title: string;
  link: string;
  summary: string;
  /** Full article text, fetched only when the feed summary was too thin. */
  articleText?: string;
  publishedAt: Date | null;
  fetchedAt: Date;
  status: CandidateStatus;
  /** When status last changed. Used to find items stuck mid-pipeline. */
  statusAt: Date;
  /** How many times we have tried to classify this. Guards against hot loops. */
  attempts: number;
  verdict?: Verdict;
  classifiedAt?: Date;
  /** Why it was rejected, for debugging the prefilter and prompt. */
  rejectedReason?: string;
  /** Set when rejected, so the TTL index can reap it 30 days later. */
  expiresAt?: Date;
  /** True when alerted without AI confirmation because the AI was offline. */
  unverified?: boolean;
  secFormType?: string;
}

/**
 * The event types we alert on.
 *
 * funding and acquisition are the original deal events. The rest were added
 * later to widen coverage from "deals" to "notable company news". They are far
 * more common than deals, so they carry their own prefilter terms and are
 * easier to disable individually in src/config/events.ts.
 */
export type DealEvent =
  | "funding"
  | "acquisition"
  | "launch"
  | "expansion"
  | "rebrand"
  | "partnership";

/** One source that reported a deal. A deal can be reported by several. */
export interface DealSource {
  sourceId: string;
  title: string;
  link: string;
  publishedAt: Date | null;
}

/**
 * A deal we have alerted on. `_id` is the dedupe key (company + event), which
 * carries a unique index — that uniqueness is what makes double-alerting
 * impossible even if two cycles somehow run concurrently.
 */
export interface DealDoc {
  _id: string; //         dealKey: hash of normalized company + event
  company: string;
  event: DealEvent;
  region: string;
  fintechSubsector: string | null;
  amount: string | null;
  currency: string | null;
  round: string | null;
  leadInvestors: string[];
  otherInvestors: string[];
  acquirer: string | null;
  target: string | null;
  dealValue: string | null;
  summary: string;
  confidence: number;
  unverified: boolean;
  /** Every source that reported this deal, merged as duplicates arrive. */
  sources: DealSource[];
  /**
   * Claim state for idempotent sending. "alerting" means some execution path
   * is mid-send; "sent" means delivered. A doc stuck in "alerting" past
   * claimExpiresAt is considered abandoned and may be reclaimed.
   */
  alertState: "alerting" | "sent";
  claimedAt: Date;
  claimExpiresAt: Date;
  lastAlertedAt: Date | null;
  /** Latency chain, all four stamps, for the p50/p95 stats. */
  publishedAt: Date | null;
  fetchedAt: Date;
  classifiedAt: Date | null;
  alertedAt: Date | null;
  createdAt: Date;
}

/** Per-source memory between invocations: validators and health. */
export interface SourceStateDoc {
  _id: string; //         source id from config
  etag?: string;
  lastModified?: string;
  bodyHash?: string;
  lastCheckedAt?: Date;
  lastSuccessAt?: Date;
  /** Consecutive failures. Reset to 0 on any success. */
  errorCount: number;
  lastError?: string;
  /**
   * False until the first successful fetch has been absorbed. The bootstrap
   * fetch marks every existing item as seen WITHOUT alerting, so adding a new
   * source never floods the chat with old news.
   */
  bootstrapped: boolean;
  /** Rate-limits the "source is stale" Telegram warning to one per hour. */
  lastStaleWarningAt?: Date;
}

/** The overlap lease. Exactly one document, id "poll-cycle". */
export interface LockDoc {
  _id: string;
  holder: string;
  acquiredAt: Date;
  expiresAt: Date;
}

/** Telegram retries updates; this collection makes command handling idempotent. */
export interface TelegramUpdateDoc {
  _id: number; //         Telegram's update_id
  receivedAt: Date; //    TTL anchor: 1 day
}

/** Singleton runtime settings, id "global". */
export interface SettingsDoc {
  _id: string;
  paused: boolean;
  /** Set while the AI is failing, so we know when to send unverified alerts. */
  aiFailingSince?: Date | null;
  aiLastError?: string;
  /** Cycle heartbeat, used to detect scheduler gaps. */
  lastCycleAt?: Date;
  lastCycleDurationMs?: number;
  /** Rate-limits the Vercel budget warning to once per day. */
  lastBudgetWarningAt?: Date;
  updatedAt: Date;
}

/** One document per UTC day, holding the numbers /status and the daily summary read. */
export interface DailyUsageDoc {
  _id: string; //         "YYYY-MM-DD" in UTC
  /** Total AI requests across every model, for the headline number. */
  geminiRequests: number;
  /**
   * Requests broken down per model, because Gemini's free-tier limits are
   * per model and the fallback only helps if we count the two separately.
   * Keys have dots replaced with underscores — Mongo treats a dot in a field
   * name as a path separator, and every Gemini model id contains one.
   */
  modelRequests: Record<string, number>;
  cycles: number;
  /** Totals, in milliseconds, summed across every cycle that day. */
  wallMs: number;
  cpuMs: number;
  itemsSeen: number;
  candidates: number;
  alerts: number;
  updatedAt: Date;
}

/**
 * deals.ts — recording deals and claiming the right to alert on them.
 *
 * THE GUARANTEE: an alert for a given company + event is sent at most once per
 * 72 hours, no matter how many sources report it or how many cycles run
 * concurrently. That is enforced by a single atomic findOneAndUpdate against a
 * unique _id, NOT by a read-then-write check, which would have a race window
 * exactly wide enough for two cycles to both decide to send.
 *
 * The claim has three states:
 *   (absent)   nobody has seen this deal
 *   alerting   somebody is mid-send right now
 *   sent       delivered; lastAlertedAt says when
 *
 * A claim stuck in "alerting" past claimExpiresAt is treated as abandoned —
 * its cycle died between claiming and sending — and may be reclaimed. Without
 * that, a single crashed invocation would suppress a deal forever.
 */

import type { Db } from "mongodb";
import { COLLECTIONS, type DealDoc, type DealEvent, type DealSource } from "@/lib/store/schema";
import { dealKey } from "@/lib/dedupe/normalize";

const DUPLICATE_KEY = 11000;

/** How long the same company + event stays suppressed after a successful alert. */
export const DEAL_DEDUPE_WINDOW_MS = 72 * 60 * 60 * 1000;

/** How long a send may take before its claim is considered abandoned. */
export const CLAIM_TTL_MS = 5 * 60 * 1000;

export type ClaimOutcome =
  | { claimed: true; deal: DealDoc }
  /** Someone else is sending it right now, or it was sent recently. */
  | { claimed: false; reason: "in-flight" | "recently-alerted"; existing: DealDoc | null };

export interface NewDeal {
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
  source: DealSource;
  publishedAt: Date | null;
  fetchedAt: Date;
  classifiedAt: Date | null;
}

export function keyForDeal(company: string, event: DealEvent): string {
  return dealKey(company, event);
}

/**
 * Atomically claim the right to alert on this deal.
 *
 * Returns claimed:true to exactly one caller. Everyone else gets claimed:false
 * and should record their source on the existing deal instead of sending.
 */
export async function claimDealForAlert(
  db: Db,
  deal: NewDeal,
  now: Date = new Date(),
): Promise<ClaimOutcome> {
  const deals = db.collection<DealDoc>(COLLECTIONS.deals);
  const _id = keyForDeal(deal.company, deal.event);
  const claimExpiresAt = new Date(now.getTime() + CLAIM_TTL_MS);
  const dedupeCutoff = new Date(now.getTime() - DEAL_DEDUPE_WINDOW_MS);

  /**
   * Fields written ONLY when the document is first created.
   *
   * MongoDB refuses an update that touches the same path from two operators,
   * so anything in $set or $addToSet below MUST be absent here. That rules out
   * alertState, claimedAt, claimExpiresAt, summary, confidence, unverified and
   * sources — all of which are written on both insert and update anyway.
   */
  const insertOnly: Omit<
    DealDoc,
    | "_id"
    | "alertState"
    | "claimedAt"
    | "claimExpiresAt"
    | "summary"
    | "confidence"
    | "unverified"
    | "sources"
  > = {
    company: deal.company,
    event: deal.event,
    region: deal.region,
    fintechSubsector: deal.fintechSubsector,
    amount: deal.amount,
    currency: deal.currency,
    round: deal.round,
    leadInvestors: deal.leadInvestors,
    otherInvestors: deal.otherInvestors,
    acquirer: deal.acquirer,
    target: deal.target,
    dealValue: deal.dealValue,
    lastAlertedAt: null,
    publishedAt: deal.publishedAt,
    fetchedAt: deal.fetchedAt,
    classifiedAt: deal.classifiedAt,
    alertedAt: null,
    createdAt: now,
  };

  // The filter matches ONLY a deal that is free to claim:
  //   - an abandoned in-flight claim, or
  //   - one whose last successful alert is older than the dedupe window.
  // A live claim or a recent alert matches nothing, so the upsert falls through
  // to an insert and collides on _id — which is how we detect contention.
  try {
    const claimed = await deals.findOneAndUpdate(
      {
        _id,
        $or: [
          { alertState: "alerting", claimExpiresAt: { $lte: now } },
          { alertState: "sent", lastAlertedAt: { $lte: dedupeCutoff } },
        ],
      },
      {
        $set: {
          alertState: "alerting",
          claimedAt: now,
          claimExpiresAt,
          // Refresh the details from the newest report of the deal.
          summary: deal.summary,
          confidence: deal.confidence,
          unverified: deal.unverified,
        },
        $addToSet: { sources: deal.source },
        $setOnInsert: insertOnly,
      },
      { upsert: true, returnDocument: "after" },
    );
    if (claimed) return { claimed: true, deal: claimed };
  } catch (err) {
    if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
    // Fall through: a live claim or a recent alert already exists.
  }

  // We lost. Record this source on the existing deal so the alert can say how
  // many outlets reported it, then report why we are not sending.
  const existing = await deals.findOneAndUpdate(
    { _id },
    { $addToSet: { sources: deal.source } },
    { returnDocument: "after" },
  );

  const reason: "in-flight" | "recently-alerted" =
    existing?.alertState === "sent" ? "recently-alerted" : "in-flight";
  return { claimed: false, reason, existing };
}

/** Mark a claimed deal as delivered. */
export async function markDealSent(db: Db, dealId: string, now: Date = new Date()): Promise<void> {
  await db.collection<DealDoc>(COLLECTIONS.deals).updateOne(
    { _id: dealId },
    { $set: { alertState: "sent", lastAlertedAt: now, alertedAt: now } },
  );
}

/**
 * Release a claim we could not deliver, so the next cycle can retry
 * immediately rather than waiting out the five-minute claim TTL.
 */
export async function releaseDealClaim(db: Db, dealId: string): Promise<void> {
  await db
    .collection<DealDoc>(COLLECTIONS.deals)
    .updateOne(
      { _id: dealId, alertState: "alerting" },
      { $set: { claimExpiresAt: new Date(0) } },
    );
}

/** Most recent successfully-sent deals, for /last and the dashboard. */
export async function recentDeals(db: Db, limit: number): Promise<DealDoc[]> {
  return db
    .collection<DealDoc>(COLLECTIONS.deals)
    .find({ alertState: "sent" })
    .sort({ alertedAt: -1 })
    .limit(limit)
    .toArray();
}

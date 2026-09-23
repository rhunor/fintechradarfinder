/**
 * deals.test.ts — the idempotent alert claim, against the real database.
 *
 * This is the test that stops you getting the same alert twice. The guarantee
 * comes from MongoDB applying findOneAndUpdate+upsert atomically against a
 * unique _id, so it is verified here with genuine concurrency rather than a
 * mock that would only prove our mock works.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CLAIM_TTL_MS,
  DEAL_DEDUPE_WINDOW_MS,
  claimDealForAlert,
  keyForDeal,
  markDealSent,
  releaseDealClaim,
  type NewDeal,
} from "@/lib/store/deals";
import { closeClient, getDb } from "@/lib/store/client";
import { COLLECTIONS } from "@/lib/store/schema";
import { requireDb } from "./db-helper";

const hasDb = Boolean(process.env.MONGODB_URI);
const describeDb = hasDb ? describe : describe.skip;

// Pay for the cold Atlas connect once, here, instead of inside whichever test
// runs first — where a slow connect reads as that test failing.
beforeAll(async () => {
  if (hasDb) await requireDb();
});

const COMPANY = "ZZ Test Fintech";

function newDeal(overrides: Partial<NewDeal> = {}): NewDeal {
  return {
    company: COMPANY,
    event: "funding",
    region: "US",
    fintechSubsector: "payments",
    amount: "$10M",
    currency: "USD",
    round: "Series A",
    leadInvestors: ["Test Capital"],
    otherInvestors: [],
    acquirer: null,
    target: null,
    dealValue: null,
    summary: "A test deal.",
    confidence: 0.9,
    unverified: false,
    source: {
      sourceId: "test-source",
      title: "Test headline",
      link: "https://example.com/test",
      publishedAt: new Date(),
    },
    publishedAt: new Date(),
    fetchedAt: new Date(),
    classifiedAt: new Date(),
    ...overrides,
  };
}

async function reset(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTIONS.deals).deleteMany({ company: COMPANY });
}

describeDb("claimDealForAlert", () => {
  beforeEach(reset);

  it("grants the claim for a deal never seen before", async () => {
    const db = await getDb();
    const out = await claimDealForAlert(db, newDeal());
    expect(out.claimed).toBe(true);
  });

  it("refuses a second claim while the first is in flight", async () => {
    const db = await getDb();
    await claimDealForAlert(db, newDeal());
    const second = await claimDealForAlert(db, newDeal());
    expect(second.claimed).toBe(false);
    if (!second.claimed) expect(second.reason).toBe("in-flight");
  });

  it("grants the claim to exactly one of eight concurrent callers", async () => {
    // Eight wires reporting one funding round in the same cycle.
    const db = await getDb();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimDealForAlert(db, newDeal())),
    );
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });

  it("records the losing sources on the existing deal instead of dropping them", async () => {
    const db = await getDb();
    await claimDealForAlert(db, newDeal());
    await claimDealForAlert(
      db,
      newDeal({
        source: {
          sourceId: "second-wire",
          title: "Same deal, different wire",
          link: "https://example.com/other",
          publishedAt: new Date(),
        },
      }),
    );

    const stored = await db
      .collection(COLLECTIONS.deals)
      .findOne({ _id: keyForDeal(COMPANY, "funding") as never });
    expect(stored?.sources).toHaveLength(2);
  });

  it("suppresses a repeat within the 72 hour window", async () => {
    const db = await getDb();
    const claim = await claimDealForAlert(db, newDeal());
    expect(claim.claimed).toBe(true);
    if (claim.claimed) await markDealSent(db, claim.deal._id);

    const repeat = await claimDealForAlert(db, newDeal());
    expect(repeat.claimed).toBe(false);
    if (!repeat.claimed) expect(repeat.reason).toBe("recently-alerted");
  });

  it("allows a fresh alert once the 72 hour window has passed", async () => {
    const db = await getDb();
    const claim = await claimDealForAlert(db, newDeal());
    if (claim.claimed) await markDealSent(db, claim.deal._id);

    const later = new Date(Date.now() + DEAL_DEDUPE_WINDOW_MS + 60_000);
    const again = await claimDealForAlert(db, newDeal(), later);
    expect(again.claimed).toBe(true);
  });

  it("reclaims a deal abandoned mid-send by a crashed cycle", async () => {
    // Without this, one crashed invocation would suppress a deal forever.
    const db = await getDb();
    await claimDealForAlert(db, newDeal());

    const afterTtl = new Date(Date.now() + CLAIM_TTL_MS + 1_000);
    const retry = await claimDealForAlert(db, newDeal(), afterTtl);
    expect(retry.claimed).toBe(true);
  });

  it("separates the same company's funding from its acquisition", async () => {
    const db = await getDb();
    const funding = await claimDealForAlert(db, newDeal({ event: "funding" }));
    const acquisition = await claimDealForAlert(db, newDeal({ event: "acquisition" }));
    expect(funding.claimed).toBe(true);
    expect(acquisition.claimed).toBe(true);
  });

  it("lets the next cycle retry immediately after a released claim", async () => {
    const db = await getDb();
    const claim = await claimDealForAlert(db, newDeal());
    expect(claim.claimed).toBe(true);
    if (claim.claimed) await releaseDealClaim(db, claim.deal._id);

    const retry = await claimDealForAlert(db, newDeal());
    expect(retry.claimed).toBe(true);
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await reset();
  await closeClient();
});

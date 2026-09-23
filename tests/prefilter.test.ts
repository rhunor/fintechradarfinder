/**
 * prefilter.test.ts — the cheap gate in front of the AI.
 *
 * Two jobs are tested: that it lets real deals through (a miss here is
 * permanent), and that it rejects the specific noise that dominates real
 * feeds — market research reports, dividend notices and fund filings.
 */

import { describe, expect, it } from "vitest";
import { prefilter, secFilerName } from "@/lib/prefilter";
import type { RawItem } from "@/lib/feeds/types";
import { HEADLINE_FIXTURES } from "./fixtures/headlines";

function item(partial: Partial<RawItem> & { title: string }): RawItem {
  return {
    sourceId: "test",
    summary: "",
    link: "https://example.com/x",
    publishedAt: new Date(),
    guid: null,
    categories: [],
    ...partial,
  };
}

describe("prefilter: funding language", () => {
  it.each([
    "Ramp raises $200M Series E",
    "Mercury closes $300M in growth equity financing",
    "Wealthsimple secures $750-million CAD credit facility",
    "Bridge announces $58M seed round",
    "Acme lands Series B funding round",
    "Fintech startup raising $40M in venture debt",
  ])("passes: %s", (title) => {
    expect(prefilter(item({ title })).pass).toBe(true);
  });
});

describe("prefilter: M&A language", () => {
  it.each([
    "Visa to acquire Featurespace",
    "Nuvei acquired by Advent International",
    "Acme and Beta announce definitive agreement to merge",
    "PayCo buys rival processor",
    "Fintech completes takeover of lender",
  ])("passes: %s", (title) => {
    expect(prefilter(item({ title })).pass).toBe(true);
  });
});

describe("prefilter: substring false positives", () => {
  // The first version of this filter used substring matching and every one of
  // these slipped through.
  it.each([
    ["background check startup launches new product", "round inside background"],
    ["company seeded its database with test records", "seed inside seeded"],
    ["buysides are watching the market closely", "buys inside buysides"],
  ])("rejects %s (%s)", (title) => {
    expect(prefilter(item({ title })).pass).toBe(false);
  });
});

describe("prefilter: negative vetoes", () => {
  it("rejects a market research report that mentions mergers and funding", () => {
    const result = prefilter(
      item({
        title: "Global BNPL Market to Reach $167B by 2032, CAGR of 26.1%",
        summary: "The report covers merger and acquisition activity and funding trends.",
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("vetoed");
  });

  it("rejects a closed-end fund declaring distributions", () => {
    expect(
      prefilter(
        item({
          title: "Cohen & Steers Closed-End Funds Declare Distributions for October",
          summary: "The funds declared monthly distribution amounts.",
        }),
      ).pass,
    ).toBe(false);
  });

  it("rejects an executive appointment", () => {
    expect(
      prefilter(
        item({
          title: "Acme Payments appoints new CFO to lead funding strategy",
          summary: "",
        }),
      ).pass,
    ).toBe(false);
  });
});

describe("prefilter: items with no deal language at all", () => {
  it("rejects a product launch", () => {
    const r = prefilter(item({ title: "Stripe launches new billing dashboard" }));
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("no funding or M&A language");
  });
});

describe("prefilter: SEC 8-K", () => {
  it("passes an 8-K citing item 2.01 with acquisition language", () => {
    const r = prefilter(
      item({
        title: "8-K - ACME FINANCIAL CORP (0001234567) (Filer)",
        summary: "Item 2.01 Completion of Acquisition or Disposition of Assets",
        secFormType: "8-K",
      }),
    );
    expect(r.pass).toBe(true);
    expect(r.hit).toBe("sec-8k");
  });

  it("rejects an 8-K with a deal word but no relevant item code", () => {
    expect(
      prefilter(
        item({
          title: "8-K - ACME CORP (0001234567) (Filer)",
          summary: "Item 5.02 Departure of Directors. The company completed an acquisition last year.",
          secFormType: "8-K",
        }),
      ).pass,
    ).toBe(false);
  });

  it("passes an 8-K item 1.01 that names a real merger agreement", () => {
    const r = prefilter(
      item({
        title: "8-K - ACME FINANCIAL CORP (0001234567) (Filer)",
        summary:
          "Item 1.01 Entry into a Material Definitive Agreement. On September 22, the Company entered into an Agreement and Plan of Merger to acquire Beta Payments Inc.",
        secFormType: "8-K",
      }),
    );
    expect(r.pass).toBe(true);
  });

  it("rejects an 8-K citing item 1.01 with no deal language", () => {
    expect(
      prefilter(
        item({
          title: "8-K - ACME CORP (0001234567) (Filer)",
          summary: "Item 1.01 Entry into a Material Definitive Agreement regarding an office lease.",
          secFormType: "8-K",
        }),
      ).pass,
    ).toBe(false);
  });
});

describe("prefilter: SEC Form D", () => {
  it("passes a fintech-sounding operating company", () => {
    const r = prefilter(
      item({ title: "D - Acme Payments Inc. (0001609436) (Filer)", secFormType: "D" }),
    );
    expect(r.pass).toBe(true);
    expect(r.hit).toBe("sec-form-d");
  });

  it("rejects the investment vehicles that dominate this form", () => {
    // These are the real shapes seen in the live feed. All match fintech-ish
    // words like "Capital" while being funds, not fintech companies.
    for (const title of [
      "D - Arigon LoopX, a Series of A Master Series, LLC (0002154711) (Filer)",
      "D - Sequoia Capital Growth Fund IV, L.P. (0001111111) (Filer)",
      "D - Blackstone Real Estate Partners X (0002222222) (Filer)",
      "D - Acme Ventures II LP (0003333333) (Filer)",
    ]) {
      expect(prefilter(item({ title, secFormType: "D" })).pass).toBe(false);
    }
  });

  it("rejects a non-fintech operating company", () => {
    expect(
      prefilter(item({ title: "D - Platauro Metals Corp. (0001609436) (Filer)", secFormType: "D" }))
        .pass,
    ).toBe(false);
  });

  it("ignores SEC forms we do not track", () => {
    const r = prefilter(item({ title: "10-Q - ACME CORP (0001) (Filer)", secFormType: "10-Q" }));
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("not tracked");
  });
});

describe("secFilerName", () => {
  it("strips the form prefix, CIK and role suffix", () => {
    expect(secFilerName("D - Acme Payments Inc. (0001609436) (Filer)")).toBe("Acme Payments Inc.");
    expect(secFilerName("8-K - GROUP 1 AUTOMOTIVE INC (0001031203) (Filer)")).toBe(
      "GROUP 1 AUTOMOTIVE INC",
    );
  });
});

describe("prefilter: the ten ground-truth fixtures", () => {
  it.each(HEADLINE_FIXTURES.map((f) => [f.id, f] as const))(
    "%s behaves as documented",
    (_id, fixture) => {
      const result = prefilter(item({ title: fixture.title, summary: fixture.summary }));
      expect(result.pass, `${fixture.title}\n  -> ${fixture.rationale}`).toBe(
        fixture.shouldPrefilter,
      );
    },
  );
});

describe("prefilter: only the lede is read", () => {
  it("ignores deal language buried far below the opening paragraphs", () => {
    // BetaKit and other WordPress feeds ship the whole article, including
    // "related posts" trailers that name unrelated funding rounds.
    const buried = `${"Padding sentence about a product launch. ".repeat(60)}Separately, Acme raises $25M Series B.`;
    expect(prefilter(item({ title: "Company redesigns its mobile app", summary: buried })).pass).toBe(
      false,
    );
  });

  it("still reads deal language in the opening paragraph", () => {
    expect(
      prefilter(
        item({
          title: "Company announces news",
          summary: "Acme raises $25M Series B led by Sequoia. " + "Filler. ".repeat(400),
        }),
      ).pass,
    ).toBe(true);
  });
});

describe("prefilter: strong matches for the AI-offline path", () => {
  it("marks a headline naming both a deal and an amount as strong", () => {
    expect(prefilter(item({ title: "Ramp raises $200M Series E" })).strong).toBe(true);
  });

  it("does not mark a vague headline as strong", () => {
    expect(prefilter(item({ title: "Acme announces new funding round" })).strong).toBe(false);
  });
});

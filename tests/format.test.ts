/**
 * format.test.ts — alert rendering.
 *
 * The escaping tests are the important ones. We send with parse_mode=HTML, so
 * an unescaped "&" or "<" in a company name makes Telegram reject the entire
 * message with a 400 — and from the user's side the alert just never arrives.
 */

import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatAlert,
  formatDuration,
  formatEtTime,
  regionFlag,
} from "@/lib/alerter/format";
import type { DealDoc } from "@/lib/store/schema";
import type { AlertPayload } from "@/lib/alerter/types";

function deal(overrides: Partial<DealDoc> = {}): DealDoc {
  return {
    _id: "d1",
    company: "Ramp",
    event: "funding",
    region: "US",
    fintechSubsector: "spend management",
    amount: "$200M",
    currency: "USD",
    round: "Series E",
    leadInvestors: ["Founders Fund"],
    otherInvestors: [],
    acquirer: null,
    target: null,
    dealValue: null,
    summary: "Ramp raised $200M Series E led by Founders Fund.",
    confidence: 0.95,
    unverified: false,
    sources: [{ sourceId: "techcrunch", title: "t", link: "https://x.com/a", publishedAt: null }],
    alertState: "alerting",
    claimedAt: new Date(),
    claimExpiresAt: new Date(),
    lastAlertedAt: null,
    publishedAt: new Date("2026-09-23T18:32:00Z"),
    fetchedAt: new Date(),
    classifiedAt: null,
    alertedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function payload(overrides: Partial<AlertPayload> = {}): AlertPayload {
  return {
    deal: deal(),
    sourceName: "TechCrunch",
    link: "https://techcrunch.com/ramp",
    detectionLatencyMs: 134_000,
    unverified: false,
    ...overrides,
  };
}

describe("escapeHtml", () => {
  it("escapes the characters Telegram's HTML parser cares about", () => {
    expect(escapeHtml('Smith & Wesson <b>"x"</b>')).toBe(
      "Smith &amp; Wesson &lt;b&gt;&quot;x&quot;&lt;/b&gt;",
    );
  });

  it("escapes the ampersand first so nothing double-escapes", () => {
    expect(escapeHtml("a & <b")).toBe("a &amp; &lt;b");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("Ramp raises $200M")).toBe("Ramp raises $200M");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [45_000, "45s"],
    [134_000, "2m 14s"],
    [3_600_000, "1h 0m"],
    [-500, "0s"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("formatEtTime", () => {
  it("converts UTC to US Eastern", () => {
    // 18:32 UTC in September is 14:32 EDT.
    expect(formatEtTime(new Date("2026-09-23T18:32:00Z"))).toBe("14:32");
  });

  it("handles the winter offset too", () => {
    // 18:32 UTC in January is 13:32 EST.
    expect(formatEtTime(new Date("2026-01-15T18:32:00Z"))).toBe("13:32");
  });
});

describe("regionFlag", () => {
  it.each([
    ["US", "🇺🇸"],
    ["CA", "🇨🇦"],
    ["US+CA", "🇺🇸🇨🇦"],
    ["other", "🌐"],
    ["unknown", "🌐"],
  ])("%s -> %s", (region, flag) => {
    expect(regionFlag(region)).toBe(flag);
  });
});

describe("formatAlert: funding", () => {
  it("renders the documented shape", () => {
    const html = formatAlert(payload());
    expect(html).toContain("💰 <b>FUNDING</b> · 🇺🇸");
    expect(html).toContain("<b>Ramp</b> — Series E · $200M");
    expect(html).toContain("Led by: Founders Fund");
    expect(html).toContain("published 14:32 ET");
    expect(html).toContain("detected in 2m 14s");
    expect(html).toContain('<a href="https://techcrunch.com/ramp">Read source →</a>');
  });

  it("counts extra investors rather than listing them all", () => {
    const html = formatAlert(
      payload({ deal: deal({ otherInvestors: ["Thrive", "Sequoia", "Coatue"] }) }),
    );
    expect(html).toContain("Led by: Founders Fund (+3 more)");
  });

  it("falls back to plain investors when there is no named lead", () => {
    const html = formatAlert(
      payload({ deal: deal({ leadInvestors: [], otherInvestors: ["Thrive", "Sequoia"] }) }),
    );
    expect(html).toContain("Investors: Thrive, Sequoia");
  });
});

describe("formatAlert: acquisition", () => {
  it("renders acquirer, target and deal value", () => {
    const html = formatAlert(
      payload({
        deal: deal({
          event: "acquisition",
          company: "Nuvei",
          region: "CA",
          round: null,
          amount: null,
          acquirer: "Advent International",
          target: "Nuvei Corporation",
          dealValue: "$6.3B",
          leadInvestors: [],
        }),
      }),
    );
    expect(html).toContain("🤝 <b>ACQUISITION</b> · 🇨🇦");
    expect(html).toContain("Advent International → Nuvei Corporation · $6.3B");
  });
});

describe("formatAlert: edge cases", () => {
  it("escapes a company name containing an ampersand", () => {
    const html = formatAlert(payload({ deal: deal({ company: "Smith & Wesson Financial" }) }));
    expect(html).toContain("<b>Smith &amp; Wesson Financial</b>");
    expect(html).not.toContain("<b>Smith & Wesson");
  });

  it("escapes angle brackets injected via the AI summary", () => {
    const html = formatAlert(payload({ deal: deal({ summary: "Raised <script>alert(1)</script>" }) }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the dash when there is no round or amount", () => {
    const html = formatAlert(payload({ deal: deal({ round: null, amount: null, dealValue: null }) }));
    expect(html).toContain("<b>Ramp</b>\n");
    expect(html).not.toContain("Ramp</b> —");
  });

  it("omits the published time when the feed gave no date", () => {
    const html = formatAlert(payload({ deal: deal({ publishedAt: null }) }));
    expect(html).not.toContain("published");
  });

  it("omits the latency line when it cannot be computed", () => {
    const html = formatAlert(payload({ detectionLatencyMs: null }));
    expect(html).not.toContain("detected in");
  });

  it("puts a loud unverified banner first when the AI was offline", () => {
    const html = formatAlert(payload({ unverified: true }));
    expect(html.split("\n")[0]).toContain("⚠️ <b>UNVERIFIED</b>");
  });

  it("mentions how many other outlets reported the same deal", () => {
    const html = formatAlert(
      payload({
        deal: deal({
          sources: [
            { sourceId: "a", title: "t", link: "https://a", publishedAt: null },
            { sourceId: "b", title: "t", link: "https://b", publishedAt: null },
          ],
        }),
      }),
    );
    expect(html).toContain("also reported by 1 other source(s)");
  });
});

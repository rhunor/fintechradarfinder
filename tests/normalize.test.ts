/**
 * normalize.test.ts — URL and title canonicalization.
 *
 * These keys back unique indexes, so a bug here either drops real news (keys
 * collide) or double-alerts (keys diverge for one story). Both failure modes
 * are represented below.
 */

import { describe, expect, it } from "vitest";
import { dealKey, normalizeTitle, normalizeUrl, titleHash, urlHash } from "@/lib/dedupe/normalize";

describe("normalizeUrl", () => {
  it("strips utm and other campaign parameters", () => {
    expect(
      normalizeUrl("https://techcrunch.com/2026/09/22/ramp?utm_source=twitter&utm_campaign=x"),
    ).toBe("https://techcrunch.com/2026/09/22/ramp");
  });

  it("keeps meaningful query parameters and sorts them", () => {
    expect(normalizeUrl("https://example.com/news?b=2&a=1")).toBe("https://example.com/news?a=1&b=2");
  });

  it("treats http and https as the same article", () => {
    expect(normalizeUrl("http://example.com/x")).toBe(normalizeUrl("https://example.com/x"));
  });

  it("ignores www and host casing", () => {
    expect(normalizeUrl("https://WWW.Example.COM/x")).toBe("https://example.com/x");
  });

  it("drops the fragment", () => {
    expect(normalizeUrl("https://example.com/x#section-2")).toBe("https://example.com/x");
  });

  it("preserves path case, because slugs can be case sensitive", () => {
    expect(normalizeUrl("https://example.com/Press/Release-A")).toBe(
      "https://example.com/Press/Release-A",
    );
  });

  it("strips a trailing slash on a path but not on a bare origin", () => {
    expect(normalizeUrl("https://example.com/x/")).toBe("https://example.com/x");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("does not throw on a malformed URL", () => {
    expect(normalizeUrl("not a url at all")).toBe("not a url at all");
    expect(normalizeUrl("")).toBe("");
  });

  it("gives one hash to the same story arriving with different tracking", () => {
    const a = urlHash("https://www.pymnts.com/news/x/?utm_source=rss&utm_medium=feed");
    const b = urlHash("http://pymnts.com/news/x#comments");
    expect(a).toBe(b);
  });

  it("gives different hashes to genuinely different stories", () => {
    expect(urlHash("https://example.com/a")).not.toBe(urlHash("https://example.com/b"));
  });
});

describe("normalizeTitle", () => {
  it("removes editorial prefixes", () => {
    expect(normalizeTitle("Exclusive: Acme raises $25M")).toBe("acme raises $25m");
    expect(normalizeTitle("UPDATE: Acme raises $25M")).toBe("acme raises $25m");
  });

  it("removes two stacked prefixes", () => {
    expect(normalizeTitle("UPDATE: Exclusive: Acme raises $25M")).toBe("acme raises $25m");
  });

  it("strips accents and smart quotes", () => {
    expect(normalizeTitle("Société raises $5M")).toBe("societe raises $5m");
    expect(normalizeTitle("Acme’s round")).toBe("acmes round");
  });

  it("keeps $ and % because they carry deal meaning", () => {
    expect(normalizeTitle("Acme raises $25M at 20% premium")).toContain("$25m");
    expect(normalizeTitle("Acme raises $25M at 20% premium")).toContain("20%");
  });

  it("does NOT collapse two stories that reverse the parties", () => {
    // If this ever passes, we would report the wrong direction of a deal.
    expect(normalizeTitle("Acme acquires Beta")).not.toBe(normalizeTitle("Beta acquires Acme"));
  });
});

describe("titleHash", () => {
  it("matches syndicated copies of one headline", () => {
    expect(titleHash("Exclusive: Ramp raises $200M Series E")).toBe(
      titleHash("Ramp raises $200M Series E"),
    );
  });

  it("returns null for a title too short to identify a story", () => {
    // Sparse unique index: short titles dedupe by URL alone rather than
    // colliding with every other short-titled item.
    expect(titleHash("Update")).toBeNull();
    expect(titleHash("")).toBeNull();
  });
});

describe("dealKey", () => {
  it("ignores corporate suffix differences for one company", () => {
    expect(dealKey("Nuvei Corporation", "acquisition")).toBe(dealKey("Nuvei", "acquisition"));
    expect(dealKey("Ramp Inc.", "funding")).toBe(dealKey("Ramp", "funding"));
  });

  it("separates the same company's funding from its acquisition", () => {
    expect(dealKey("Ramp", "funding")).not.toBe(dealKey("Ramp", "acquisition"));
  });

  it("separates different companies", () => {
    expect(dealKey("Ramp", "funding")).not.toBe(dealKey("Brex", "funding"));
  });
});

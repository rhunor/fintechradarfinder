/**
 * dashboard.test.ts — session cookies and filter parsing.
 *
 * Two things are load-bearing here. The cookie must be unforgeable without the
 * password, and the company search must never reach a regex unescaped — a
 * visitor pasting "(a+)+$" into a search box should not be able to pin Atlas
 * M0's single shared CPU.
 */

import { describe, expect, it } from "vitest";
import { buildSessionValue, checkPassword, verifySessionValue } from "@/lib/dashboard/auth";
import { buildQuery, escapeRegex, filterHref, parseFilters } from "@/lib/dashboard/query";

describe("session cookie", () => {
  it("accepts a cookie it just issued", () => {
    expect(verifySessionValue(buildSessionValue())).toBe(true);
  });

  it("rejects a missing or malformed cookie", () => {
    expect(verifySessionValue(undefined)).toBe(false);
    expect(verifySessionValue("")).toBe(false);
    expect(verifySessionValue("garbage")).toBe(false);
    expect(verifySessionValue("2026-09-23")).toBe(false);
  });

  it("rejects a forged signature", () => {
    const value = buildSessionValue();
    const [day] = value.split(".");
    expect(verifySessionValue(`${day}.${"0".repeat(64)}`)).toBe(false);
  });

  it("rejects a valid signature that has expired", () => {
    // A genuine cookie issued 31 days ago: correctly signed, but too old.
    const old = new Date(Date.now() - 31 * 86_400_000);
    expect(verifySessionValue(buildSessionValue(old))).toBe(false);
  });

  it("rejects a cookie dated in the future", () => {
    const future = new Date(Date.now() + 5 * 86_400_000);
    expect(verifySessionValue(buildSessionValue(future))).toBe(false);
  });
});

describe("checkPassword", () => {
  it("accepts the configured password", () => {
    expect(checkPassword(process.env.DASHBOARD_PASSWORD ?? "")).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(checkPassword("definitely-not-it")).toBe(false);
  });

  it("rejects an empty password", () => {
    expect(checkPassword("")).toBe(false);
  });

  it("rejects a prefix of the real password", () => {
    const real = process.env.DASHBOARD_PASSWORD ?? "";
    expect(checkPassword(real.slice(0, -1))).toBe(false);
  });
});

describe("escapeRegex", () => {
  it("neutralises a catastrophic backtracking pattern", () => {
    const escaped = escapeRegex("(a+)+$");
    expect(escaped).toBe("\\(a\\+\\)\\+\\$");
    // It must match the literal text and nothing clever.
    expect(new RegExp(escaped).test("(a+)+$")).toBe(true);
    expect(new RegExp(escaped).test("aaaa")).toBe(false);
  });

  it("leaves ordinary company names alone", () => {
    expect(escapeRegex("Acme Pay")).toBe("Acme Pay");
  });
});

describe("parseFilters", () => {
  it("defaults to everything in the last 30 days", () => {
    const f = parseFilters(new URLSearchParams());
    expect(f).toEqual({ event: "all", region: "all", days: 30, search: "" });
  });

  it("reads valid values", () => {
    const f = parseFilters(new URLSearchParams("event=funding&region=CA&days=7&q=Ramp"));
    expect(f).toEqual({ event: "funding", region: "CA", days: 7, search: "Ramp" });
  });

  it("falls back to defaults for values not on the allowlist", () => {
    // Anything from a URL is untrusted; an unknown region must not reach Mongo.
    const f = parseFilters(new URLSearchParams("event=hacked&region=XX&days=9999"));
    expect(f).toEqual({ event: "all", region: "all", days: 30, search: "" });
  });

  it("caps an absurdly long search term", () => {
    const f = parseFilters(new URLSearchParams(`q=${"a".repeat(500)}`));
    expect(f.search).toHaveLength(80);
  });
});

describe("buildQuery", () => {
  const base = { event: "all" as const, region: "all", days: 30, search: "" };

  it("only ever returns deals that were actually sent", () => {
    expect(buildQuery(base).alertState).toBe("sent");
  });

  it("omits event and region filters when set to all", () => {
    const q = buildQuery(base);
    expect(q.event).toBeUndefined();
    expect(q.region).toBeUndefined();
  });

  it("applies event, region and a case-insensitive company search", () => {
    const q = buildQuery({ ...base, event: "acquisition", region: "CA", search: "Nuvei" });
    expect(q.event).toBe("acquisition");
    expect(q.region).toBe("CA");
    expect(q.company).toEqual({ $regex: "Nuvei", $options: "i" });
  });

  it("escapes regex metacharacters from the search box", () => {
    const q = buildQuery({ ...base, search: "a.*b" });
    expect(q.company).toEqual({ $regex: "a\\.\\*b", $options: "i" });
  });

  it("windows on the requested number of days", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    const q = buildQuery({ ...base, days: 7 }, now);
    const gte = (q.alertedAt as { $gte: Date }).$gte;
    expect(gte.toISOString()).toBe("2026-09-16T12:00:00.000Z");
  });
});

describe("filterHref", () => {
  const base = { event: "all" as const, region: "all", days: 30, search: "" };

  it("returns a bare path when nothing is filtered", () => {
    expect(filterHref(base, {})).toBe("/deals");
  });

  it("preserves other filters when one changes", () => {
    const href = filterHref({ ...base, region: "CA", search: "Ramp" }, { event: "funding" });
    expect(href).toContain("event=funding");
    expect(href).toContain("region=CA");
    expect(href).toContain("q=Ramp");
  });

  it("omits defaults to keep the URL short", () => {
    expect(filterHref(base, { days: 30 })).toBe("/deals");
    expect(filterHref(base, { days: 7 })).toBe("/deals?days=7");
  });
});

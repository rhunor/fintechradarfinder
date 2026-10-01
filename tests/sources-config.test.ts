/**
 * sources-config.test.ts — guards the source registry against easy mistakes
 * as it grows: duplicate ids (which would merge two feeds' state in Mongo),
 * non-HTTPS URLs, and a source that is both enabled and on the rejected list.
 */

import { describe, expect, it } from "vitest";
import { REJECTED_SOURCES, SOURCES } from "@/config/sources";

describe("source registry", () => {
  it("has unique ids", () => {
    const ids = SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique URLs", () => {
    const urls = SOURCES.map((s) => s.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("uses HTTPS everywhere", () => {
    for (const s of SOURCES) expect(s.url, s.id).toMatch(/^https:\/\//);
  });

  it("never polls faster than once a minute", () => {
    for (const s of SOURCES) expect(s.minIntervalSeconds, s.id).toBeGreaterThanOrEqual(60);
  });

  it("does not enable a feed that is also listed as rejected", () => {
    const rejected = new Set(REJECTED_SOURCES.map((r) => r.url));
    for (const s of SOURCES.filter((x) => x.enabled)) expect(rejected.has(s.url), s.id).toBe(false);
  });
});

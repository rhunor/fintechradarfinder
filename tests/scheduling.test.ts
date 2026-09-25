/**
 * scheduling.test.ts — which sources are due, and the category filter.
 *
 * `dueSources` is what keeps the cycle cheap: media sites are only fetched
 * every three minutes, so two cycles in three skip them entirely.
 */

import { describe, expect, it } from "vitest";
import { dueSources, staleSources, validatorsFrom } from "@/lib/store/source-state";
import type { SourceConfig } from "@/config/sources";
import type { SourceStateDoc } from "@/lib/store/schema";

const wire: SourceConfig = {
  id: "wire",
  name: "Wire",
  url: "https://example.com/wire",
  type: "rss",
  regionHint: "US",
  minIntervalSeconds: 60,
  conditionalGet: "etag",
  enabled: true,
};
const media: SourceConfig = { ...wire, id: "media", minIntervalSeconds: 180 };

function state(id: string, secondsAgo: number, extra: Partial<SourceStateDoc> = {}): SourceStateDoc {
  return {
    _id: id,
    errorCount: 0,
    bootstrapped: true,
    lastCheckedAt: new Date(Date.now() - secondsAgo * 1000),
    lastSuccessAt: new Date(Date.now() - secondsAgo * 1000),
    ...extra,
  };
}

describe("dueSources", () => {
  it("treats a never-fetched source as due, which triggers its bootstrap", () => {
    expect(dueSources([wire, media], new Map())).toHaveLength(2);
  });

  it("respects each source's own minimum interval", () => {
    const map = new Map([
      ["wire", state("wire", 90)],
      ["media", state("media", 90)],
    ]);
    const due = dueSources([wire, media], map);
    // 90s: the 60s wire is due, the 180s media site is not.
    expect(due.map((s) => s.id)).toEqual(["wire"]);
  });

  it("returns nothing when everything was just checked", () => {
    const map = new Map([
      ["wire", state("wire", 5)],
      ["media", state("media", 5)],
    ]);
    expect(dueSources([wire, media], map)).toHaveLength(0);
  });

  it("treats a source as due exactly at its interval", () => {
    const map = new Map([["wire", state("wire", 60)]]);
    expect(dueSources([wire], map)).toHaveLength(1);
  });
});

describe("validatorsFrom", () => {
  it("returns an empty set for an unknown source", () => {
    expect(validatorsFrom(undefined)).toEqual({});
  });

  it("carries through whichever validators were stored", () => {
    const v = validatorsFrom(state("wire", 10, { etag: '"abc"', bodyHash: "deadbeef" }));
    expect(v.etag).toBe('"abc"');
    expect(v.bodyHash).toBe("deadbeef");
    expect(v.lastModified).toBeUndefined();
  });
});

describe("staleSources", () => {
  const FIFTEEN_MIN = 15 * 60 * 1000;
  const FAILING = { errorCount: 5 };

  it("flags a source that is both silent and repeatedly failing", () => {
    const map = new Map([["wire", state("wire", 20 * 60, FAILING)]]);
    const stale = staleSources([wire], map, FIFTEEN_MIN);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.source.id).toBe("wire");
  });

  it("ignores a healthy source", () => {
    const map = new Map([["wire", state("wire", 60, FAILING)]]);
    expect(staleSources([wire], map, FIFTEEN_MIN)).toHaveLength(0);
  });

  it("does not flag a source that has never run", () => {
    // Nothing to complain about until it has had a chance to run once.
    expect(staleSources([wire], new Map(), FIFTEEN_MIN)).toHaveLength(0);
  });

  it("does not flag a silent source that is not actually failing", () => {
    // The noisy case this rule exists for: feeds sit behind CDNs, and an
    // occasional slow origin fetch can leave a healthy source without a
    // success for a quarter of an hour. errorCount resets on any success, so
    // a low count means it is unlucky rather than broken.
    const map = new Map([["wire", state("wire", 20 * 60, { errorCount: 1 })]]);
    expect(staleSources([wire], map, FIFTEEN_MIN)).toHaveLength(0);
  });

  it("includes the last error so the warning can say why", () => {
    const map = new Map([["wire", state("wire", 20 * 60, { ...FAILING, lastError: "HTTP 403" })]]);
    expect(staleSources([wire], map, FIFTEEN_MIN)[0]!.lastError).toBe("HTTP 403");
  });
});

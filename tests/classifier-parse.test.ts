/**
 * classifier-parse.test.ts — surviving whatever the model actually returns.
 *
 * Every case here is a real failure mode of JSON-mode LLM output. None of them
 * should cost us a deal: the parser salvages what it can, and anything it
 * cannot parse is reported so the caller leaves those items pending rather
 * than dropping them.
 */

import { describe, expect, it } from "vitest";
import { extractJson, parseResponseText, parseVerdicts } from "@/lib/classifier/parse";
import { LenientVerdictSchema } from "@/lib/classifier/types";

const validVerdict = {
  id: "a1",
  relevant: true,
  event: "funding",
  is_fintech: true,
  region: "US",
  company: "Ramp",
  fintech_subsector: "spend management",
  amount: "$200M",
  currency: "USD",
  round: "Series E",
  lead_investors: ["Founders Fund"],
  other_investors: [],
  acquirer: null,
  target: null,
  deal_value: null,
  one_line_summary: "Ramp raised $200M.",
  confidence: 0.95,
};

describe("extractJson", () => {
  it("parses clean JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("unwraps a ```json fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("unwraps a bare ``` fence", () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("ignores prose before and after the JSON", () => {
    expect(extractJson('Here is the result:\n{"a":1}\nLet me know if you need more.')).toEqual({
      a: 1,
    });
  });

  it("handles a brace inside a string without truncating early", () => {
    // A greedy or naive scanner cuts this off at the wrong brace.
    expect(extractJson('{"note":"a } brace","b":2}')).toEqual({ note: "a } brace", b: 2 });
  });

  it("handles an escaped quote inside a string", () => {
    expect(extractJson('{"note":"say \\"hi\\"","b":2}')).toEqual({ note: 'say "hi"', b: 2 });
  });

  it("parses a top-level array", () => {
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("throws on a truncated response rather than returning junk", () => {
    expect(() => extractJson('{"verdicts":[{"id":"a1","relev')).toThrow(/truncated|unbalanced/);
  });

  it("throws when there is no JSON at all", () => {
    expect(() => extractJson("I cannot help with that request.")).toThrow(/no JSON/);
  });
});

describe("parseVerdicts", () => {
  it("accepts the documented envelope", () => {
    const out = parseVerdicts({ verdicts: [validVerdict] });
    expect(out.verdicts).toHaveLength(1);
    expect(out.invalid).toHaveLength(0);
  });

  it("accepts a bare array, which models emit often enough to matter", () => {
    const out = parseVerdicts([validVerdict]);
    expect(out.verdicts).toHaveLength(1);
  });

  it("keeps the good entries when one item in the batch is malformed", () => {
    // Losing the whole batch because of one bad row would be the expensive bug.
    const out = parseVerdicts({ verdicts: [validVerdict, { id: "b2", relevant: "yes" }] });
    expect(out.verdicts).toHaveLength(1);
    expect(out.invalid).toHaveLength(1);
    expect(out.invalid[0]!.error).toContain("relevant");
  });

  it("throws when the shape is neither array nor envelope", () => {
    expect(() => parseVerdicts({ result: "ok" })).toThrow(/neither an array/);
  });
});

describe("LenientVerdictSchema normalization", () => {
  it('turns the string "null" into a real null', () => {
    const out = LenientVerdictSchema.parse({ ...validVerdict, amount: "null", round: "N/A" });
    expect(out.amount).toBeNull();
    expect(out.round).toBeNull();
  });

  it("turns an empty string into null", () => {
    expect(LenientVerdictSchema.parse({ ...validVerdict, acquirer: "" }).acquirer).toBeNull();
  });

  it("treats a missing nullable key as null", () => {
    const { deal_value: _omitted, ...withoutKey } = validVerdict;
    expect(LenientVerdictSchema.parse(withoutKey).deal_value).toBeNull();
  });

  it("rescales confidence given on a 0-100 scale", () => {
    expect(LenientVerdictSchema.parse({ ...validVerdict, confidence: 85 }).confidence).toBe(0.85);
  });

  it("coerces a stringified confidence", () => {
    expect(LenientVerdictSchema.parse({ ...validVerdict, confidence: "0.8" }).confidence).toBe(0.8);
  });

  it("splits a comma-joined investor string into an array", () => {
    const out = LenientVerdictSchema.parse({
      ...validVerdict,
      lead_investors: "Sequoia, Ribbit Capital",
    });
    expect(out.lead_investors).toEqual(["Sequoia", "Ribbit Capital"]);
  });

  it("treats missing investor arrays as empty", () => {
    const { lead_investors: _a, other_investors: _b, ...rest } = validVerdict;
    const out = LenientVerdictSchema.parse(rest);
    expect(out.lead_investors).toEqual([]);
  });

  it("rejects a confidence that is still out of range", () => {
    expect(() => LenientVerdictSchema.parse({ ...validVerdict, confidence: -1 })).toThrow();
  });

  it("rejects an unknown region rather than guessing", () => {
    expect(() => LenientVerdictSchema.parse({ ...validVerdict, region: "EU" })).toThrow();
  });
});

describe("parseResponseText end to end", () => {
  it("recovers verdicts from a fenced, prose-wrapped response", () => {
    const text = `Sure! Here are the classifications:\n\`\`\`json\n${JSON.stringify({
      verdicts: [validVerdict],
    })}\n\`\`\`\nHope that helps.`;
    expect(parseResponseText(text).verdicts).toHaveLength(1);
  });
});

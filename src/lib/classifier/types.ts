/**
 * types.ts — the contract between the pipeline and whichever AI classifies items.
 *
 * WHY ZOD HERE AND NOT ELSEWHERE: a model's JSON output is untrusted input. It
 * can be truncated, wrapped in markdown fences, or confidently wrong about its
 * own schema. Everything downstream (alert formatting, dedupe keys, the
 * dashboard) assumes these fields exist and have these types, so this is the
 * boundary where that assumption gets enforced rather than hoped for.
 */

import { z } from "zod";

/** What we send to the model for one story. */
export interface CandidateItem {
  /** Short stable id the model echoes back, so a batch can be re-associated. */
  id: string;
  title: string;
  sourceName: string;
  publishedAt: Date | null;
  /** Feed summary, or extracted article text when the summary was too thin. */
  body: string;
  secFormType?: string | undefined;
}

export const VerdictSchema = z.object({
  id: z.string(),
  relevant: z.boolean(),
  event: z.enum(["funding", "acquisition"]).nullable(),
  is_fintech: z.boolean(),
  region: z.enum(["US", "CA", "US+CA", "other", "unknown"]),
  company: z.string(),
  fintech_subsector: z.string().nullable(),
  amount: z.string().nullable(),
  currency: z.string().nullable(),
  round: z.string().nullable(),
  lead_investors: z.array(z.string()),
  other_investors: z.array(z.string()),
  acquirer: z.string().nullable(),
  target: z.string().nullable(),
  deal_value: z.string().nullable(),
  one_line_summary: z.string(),
  confidence: z.number().min(0).max(1),
});

export type Verdict = z.infer<typeof VerdictSchema>;

export const VerdictListSchema = z.object({
  verdicts: z.array(VerdictSchema),
});

/**
 * Models are inconsistent about nullable string fields: some emit the literal
 * string "null", some omit the key, some send an empty string. Normalizing here
 * means the rest of the app only ever deals with `string | null`.
 */
export const LenientVerdictSchema = VerdictSchema.extend({
  event: z.preprocess(emptyToNull, z.enum(["funding", "acquisition"]).nullable()),
  fintech_subsector: z.preprocess(emptyToNull, z.string().nullable()),
  amount: z.preprocess(emptyToNull, z.string().nullable()),
  currency: z.preprocess(emptyToNull, z.string().nullable()),
  round: z.preprocess(emptyToNull, z.string().nullable()),
  acquirer: z.preprocess(emptyToNull, z.string().nullable()),
  target: z.preprocess(emptyToNull, z.string().nullable()),
  deal_value: z.preprocess(emptyToNull, z.string().nullable()),
  lead_investors: z.preprocess(toStringArray, z.array(z.string())),
  other_investors: z.preprocess(toStringArray, z.array(z.string())),
  confidence: z.preprocess(toConfidence, z.number().min(0).max(1)),
});

function emptyToNull(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "" || t.toLowerCase() === "null" || t.toLowerCase() === "n/a") return null;
    return t;
  }
  return v;
}

function toStringArray(v: unknown): unknown {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim() !== "");
  // Some models return a comma-joined string instead of an array.
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function toConfidence(v: unknown): unknown {
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n > 1 ? n / 100 : n;
  }
  // A model asked for 0-1 occasionally answers on a 0-100 scale.
  if (typeof v === "number" && v > 1 && v <= 100) return v / 100;
  return v;
}

/** Options every provider honours. */
export interface ClassifyCallOptions {
  /**
   * Cycle deadline. A classify call is the single longest thing a cycle does,
   * so it must be interruptible — otherwise one slow model response blows the
   * whole wall-clock budget that Vercel bills us for.
   */
  signal?: AbortSignal | undefined;
}

/** The swappable interface every provider implements. */
export interface Classifier {
  readonly name: string;
  classify(items: CandidateItem[], opts?: ClassifyCallOptions): Promise<Verdict[]>;
}

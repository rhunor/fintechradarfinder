/**
 * parse.ts — turns whatever the model actually returned into trusted Verdicts.
 *
 * WHY THIS IS SEPARATE FROM THE PROVIDERS: both Gemini and Claude fail in the
 * same handful of ways, and all of them are cheap to survive if handled in one
 * place. Observed failure modes, all of which this module absorbs:
 *
 *   - the JSON wrapped in ```json fences despite JSON mode
 *   - a bare array returned instead of the { verdicts: [...] } envelope
 *   - trailing prose after the closing brace
 *   - a truncated response when the output token limit is hit
 *   - "null" as a string, or an omitted nullable key
 *   - confidence expressed as 85 instead of 0.85
 *
 * The last two are normalized by LenientVerdictSchema; the rest are handled by
 * extractJson below. Anything that still fails validation is reported so the
 * caller can retry once and then leave the items pending rather than dropping
 * them — silently losing candidates is the one outcome we never accept.
 */

import { LenientVerdictSchema, type Verdict } from "@/lib/classifier/types";

export interface ParseOutcome {
  verdicts: Verdict[];
  /** Ids that came back malformed, so the caller knows what to retry. */
  invalid: { raw: unknown; error: string }[];
}

/**
 * Pull a JSON value out of a model response that may be wrapped in markdown,
 * prefixed with prose, or followed by commentary.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Fast path: it is already clean JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to the salvage attempts
  }

  // Strip a markdown code fence, with or without a language tag.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }

  // Take the outermost balanced object or array. Scanning for balance rather
  // than using a greedy regex matters: a response with trailing prose that
  // contains a brace would otherwise produce an unparseable slice.
  const start = trimmed.search(/[[{]/);
  if (start === -1) throw new Error("no JSON value found in response");
  const open = trimmed[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return JSON.parse(trimmed.slice(start, i + 1));
      }
    }
  }

  throw new Error("JSON value in response was truncated or unbalanced");
}

/**
 * Validate a parsed response into Verdicts.
 *
 * Accepts either the documented { verdicts: [...] } envelope or a bare array,
 * because models drop the wrapper often enough that rejecting it would cost
 * real alerts for no benefit.
 */
export function parseVerdicts(raw: unknown): ParseOutcome {
  let list: unknown[];

  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object" && Array.isArray((raw as { verdicts?: unknown }).verdicts)) {
    list = (raw as { verdicts: unknown[] }).verdicts;
  } else {
    throw new Error("response was neither an array nor an object with a verdicts array");
  }

  const verdicts: Verdict[] = [];
  const invalid: { raw: unknown; error: string }[] = [];

  for (const entry of list) {
    const result = LenientVerdictSchema.safeParse(entry);
    if (result.success) verdicts.push(result.data);
    else invalid.push({ raw: entry, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  }

  return { verdicts, invalid };
}

/** Convenience: text in, validated verdicts out. */
export function parseResponseText(text: string): ParseOutcome {
  return parseVerdicts(extractJson(text));
}

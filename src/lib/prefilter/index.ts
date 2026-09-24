/**
 * prefilter/index.ts — decides whether an item is worth an AI call.
 *
 * This is the only stage between "every story on 19 feeds" and "things we pay
 * Gemini to read", so it controls both the free-tier budget and what we are
 * capable of detecting at all. Biased toward letting things through: a wasted
 * AI call costs a fraction of a cent, a missed deal costs the whole point.
 *
 * SEC filings take a different path from news items, because their feed entries
 * are structured differently and carry almost no prose.
 */

import {
  EXPANSION_TERMS,
  FINTECH_NAME_HINTS,
  FUNDING_TERMS,
  FUND_VEHICLE_PATTERNS,
  LAUNCH_TERMS,
  MA_TERMS,
  NEGATIVE_TERMS,
  PARTNERSHIP_TERMS,
  REBRAND_TERMS,
  SEC_8K_ITEM_CODES,
} from "@/config/keywords";
import { isEventEnabled } from "@/config/events";
import type { RawItem } from "@/lib/feeds/types";
import type { DealEvent } from "@/lib/store/schema";

export type PrefilterHit =
  | "funding"
  | "acquisition"
  | "launch"
  | "expansion"
  | "rebrand"
  | "partnership"
  | "sec-8k"
  | "sec-form-d";

export interface PrefilterResult {
  pass: boolean;
  /** Which rule family matched, for logging and for the unverified-alert path. */
  hit: PrefilterHit | null;
  /** Human-readable explanation, stored on rejected candidates for debugging. */
  reason: string;
  /**
   * True when the match is strong enough to alert on WITHOUT AI confirmation,
   * used only when the classifier has been down for more than two minutes.
   */
  strong: boolean;
}

function matches(patterns: readonly RegExp[], text: string): RegExp | null {
  for (const p of patterns) if (p.test(text)) return p;
  return null;
}

/**
 * SEC 8-K: only items 1.01 (entered a material agreement) and 2.01 (completed
 * an acquisition) are about deals, and even then only with deal language. The
 * EDGAR feed title carries just the form and filer, so the item codes normally
 * appear in the summary.
 */
function prefilterSec8k(haystack: string): PrefilterResult {
  const code = matches(SEC_8K_ITEM_CODES, haystack);
  if (!code) {
    return { pass: false, hit: null, reason: "8-K without item 1.01 or 2.01", strong: false };
  }

  // Item 2.01 IS "Completion of Acquisition or Disposition of Assets" by
  // definition, so the code alone is the signal. No language check needed.
  if (/\bitem\s*2\.01\b/i.test(haystack)) {
    return { pass: true, hit: "sec-8k", reason: "8-K item 2.01 (completed acquisition)", strong: false };
  }

  // Item 1.01 needs real deal language, but its own standard caption is "Entry
  // into a Material Definitive Agreement" — so the words "definitive agreement"
  // appear on EVERY 1.01 filing, including office leases and supply contracts.
  // Removing the boilerplate caption first is what stops this rule matching
  // every 1.01 ever filed.
  const withoutBoilerplate = haystack.replace(
    /entry into a material definitive agreement/gi,
    " ",
  );
  const deal = matches(MA_TERMS, withoutBoilerplate);
  if (!deal) {
    return {
      pass: false,
      hit: null,
      reason: "8-K item 1.01 with no acquisition or merger language beyond the standard caption",
      strong: false,
    };
  }
  return { pass: true, hit: "sec-8k", reason: `8-K item 1.01 + ${deal.source}`, strong: false };
}

/**
 * SEC Form D: a notice of an exempt securities offering, i.e. somebody raised
 * private money. The feed entry contains ONLY a company name and form type —
 * no amount, no industry, no location.
 *
 * Passing all of them to the model would burn the daily quota producing
 * "region: unknown" for hundreds of filings a day. Instead we require a
 * fintech-sounding name AND veto the investment vehicles (funds, SPVs, series
 * LLCs) that dominate this form and would otherwise match on words like
 * "Capital".
 */
function prefilterFormD(name: string): PrefilterResult {
  const vehicle = matches(FUND_VEHICLE_PATTERNS, name);
  if (vehicle) {
    return {
      pass: false,
      hit: null,
      reason: `Form D from an investment vehicle (${vehicle.source})`,
      strong: false,
    };
  }
  const hint = matches(FINTECH_NAME_HINTS, name);
  if (!hint) {
    return { pass: false, hit: null, reason: "Form D with no fintech signal in the name", strong: false };
  }
  return { pass: true, hit: "sec-form-d", reason: `Form D, name matches ${hint.source}`, strong: false };
}

/**
 * Strip the SEC boilerplate wrapper from a filing title so the name heuristic
 * sees "Acme Payments Inc" rather than "D - Acme Payments Inc (0001234567) (Filer)".
 */
/**
 * The news-item event families, in priority order, typed as DealEvent so the
 * enabled-check and the classifier agree on the same set of names.
 */
const EVENT_FAMILIES: readonly { hit: DealEvent; terms: readonly RegExp[] }[] = [
  { hit: "funding", terms: FUNDING_TERMS },
  { hit: "acquisition", terms: MA_TERMS },
  { hit: "launch", terms: LAUNCH_TERMS },
  { hit: "expansion", terms: EXPANSION_TERMS },
  { hit: "rebrand", terms: REBRAND_TERMS },
  { hit: "partnership", terms: PARTNERSHIP_TERMS },
];

export function secFilerName(title: string): string {
  return title
    .replace(/^[A-Z0-9/-]+\s+-\s+/, "")
    .replace(/\s*\(\d{7,10}\)\s*/g, " ")
    .replace(/\s*\((Filer|Subject|Reporting)\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How much of an item's body the keyword stage reads.
 *
 * WHY CLIP: feeds like BetaKit ship the full article in content:encoded, so any
 * post that merely MENTIONS a funding round deep in the text matched. Measured
 * against 513 live items, reading the whole body passed 31.8% while reading the
 * lede passed 26.5%, with all ten ground-truth fixtures still classified
 * correctly. A real announcement states the deal in its opening paragraphs.
 *
 * This is also exactly what we later send the model, so the two stages agree on
 * what "the item" is.
 */
export const PREFILTER_BODY_CHARS = 1500;

export function prefilter(item: RawItem): PrefilterResult {
  const haystack = `${item.title}\n${item.summary.slice(0, PREFILTER_BODY_CHARS)}`;

  if (item.secFormType) {
    const form = item.secFormType.toUpperCase();
    if (form === "8-K") return prefilterSec8k(haystack);
    if (form === "D" || form === "D/A") return prefilterFormD(secFilerName(item.title));
    return { pass: false, hit: null, reason: `SEC form ${form} is not tracked`, strong: false };
  }

  // Event families, in priority order. Deals come first: when a headline says
  // a company "launches a card and raises $20M", the funding is the story.
  // Disabling an event in src/config/events.ts removes it from this list, so
  // its items stop reaching the model at all rather than being classified and
  // then thrown away.
  const families = EVENT_FAMILIES.filter((family) => isEventEnabled(family.hit));

  // A match in the TITLE outranks one in the body, because a headline states
  // the story's actual subject while the body often mentions other companies'
  // news in passing.
  let titleHit: { hit: PrefilterHit; pattern: RegExp } | null = null;
  let bodyHit: { hit: PrefilterHit; pattern: RegExp } | null = null;

  for (const family of families) {
    if (!titleHit) {
      const inTitle = matches(family.terms, item.title);
      if (inTitle) titleHit = { hit: family.hit, pattern: inTitle };
    }
    if (!bodyHit) {
      const inBody = matches(family.terms, haystack);
      if (inBody) bodyHit = { hit: family.hit, pattern: inBody };
    }
  }

  const match = titleHit ?? bodyHit;
  if (!match) {
    return { pass: false, hit: null, reason: "no tracked event language", strong: false };
  }

  // A negative term vetoes the item even when event words are present. These
  // are the recurring false positives: dividend notices, market research
  // reports and "the M&A market is projected to grow" think-pieces.
  const negative = matches(NEGATIVE_TERMS, haystack);
  if (negative) {
    return { pass: false, hit: null, reason: `vetoed by ${negative.source}`, strong: false };
  }

  return {
    pass: true,
    hit: match.hit,
    reason: `matched ${match.pattern.source}`,
    // "Strong" means the headline itself names a DEAL and carries a money
    // figure — enough to alert unverified if the AI is offline. Deliberately
    // limited to funding and acquisitions: no launch or partnership is worth
    // an unverified alert.
    strong: Boolean(
      titleHit &&
        (titleHit.hit === "funding" || titleHit.hit === "acquisition") &&
        /\$\s?\d|\b\d+(\.\d+)?\s*(m|bn|b|million|billion)\b/i.test(item.title),
    ),
  };
}

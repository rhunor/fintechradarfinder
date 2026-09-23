/**
 * normalize.ts — turns messy real-world URLs and headlines into stable keys.
 *
 * WHY THIS IS SUBTLE: the same press release reaches us from several sources
 * with different tracking parameters, different casing, sometimes http vs
 * https, and often a syndicated copy under a different headline prefix. If the
 * keys are not stable, we alert twice for one deal. If they are TOO aggressive,
 * two genuinely different stories collapse into one and we miss a deal.
 *
 * Both hashes feed unique indexes in `seen_items`, so a collision here is not
 * a minor inefficiency — it silently drops news.
 */

import { createHash } from "node:crypto";

/**
 * Query parameters that identify a campaign or referrer rather than the
 * content. Stripping them is what makes the same article from a newsletter, a
 * feed and a share link collapse to one key.
 */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_name",
  "utm_reader",
  "utm_brand",
  "utm_social",
  "utm_social-type",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "twclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "referrer",
  "source",
  "src",
  "cmpid",
  "campaign_id",
  "sr_share",
  "guccounter",
  "guce_referrer",
  "guce_referrer_sig",
  "__twitter_impression",
  "_hsenc",
  "_hsmi",
  "hsCtaTracking",
  "yclid",
  "spm",
  "at_medium",
  "at_campaign",
]);

/**
 * Canonicalize a URL for deduplication.
 *
 * Deliberate choices:
 *  - scheme is forced to https, since http/https serve the same article
 *  - host is lowercased and a leading "www." removed
 *  - the path keeps its case: many CMSs serve case-sensitive slugs
 *  - remaining query params are sorted, so ?a=1&b=2 and ?b=2&a=1 agree
 *  - the fragment is dropped entirely; it never identifies a different story
 *
 * An unparseable URL is returned trimmed and lowercased rather than thrown on,
 * because a malformed link in one feed item must not abort a whole cycle.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return trimmed.toLowerCase();
  }
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";
  // Default ports carry no meaning once the scheme is normalized.
  if (url.port === "443" || url.port === "80") url.port = "";

  const kept: [string, string][] = [];
  for (const [key, value] of url.searchParams) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) continue;
    kept.push([key, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);

  let out = url.toString();
  // A trailing slash on a path is never meaningful for an article URL, but it
  // is for a bare origin, so only strip it when there is a real path.
  if (out.endsWith("/") && url.pathname !== "/") out = out.slice(0, -1);
  return out;
}

/**
 * Editorial prefixes that wire services and blogs bolt onto an otherwise
 * identical headline. Removing them lets syndicated copies dedupe together.
 */
const TITLE_PREFIXES =
  /^(exclusive|breaking|update|updated|correcting and replacing|press release|just in|report|scoop|editor's pick)\s*[:\-–—]\s*/i;

/**
 * Canonicalize a headline for deduplication.
 *
 * We strip accents, punctuation and editorial prefixes, then collapse
 * whitespace. We deliberately do NOT stem or drop stopwords: "Acme acquires
 * Beta" and "Beta acquires Acme" must stay distinct, and aggressive
 * normalization is how that distinction gets lost.
 */
export function normalizeTitle(raw: string): string {
  let t = raw.normalize("NFKD").replace(/[̀-ͯ]/g, ""); // strip accents
  t = t.toLowerCase().trim();

  // Wire items sometimes carry two prefixes, e.g. "UPDATE: EXCLUSIVE: ...".
  for (let i = 0; i < 2; i++) {
    const stripped = t.replace(TITLE_PREFIXES, "");
    if (stripped === t) break;
    t = stripped;
  }

  return t
    .replace(/[‘’“”]/g, "") // smart quotes
    .replace(/[^a-z0-9$%+]+/g, " ") // keep $ % + : they carry deal meaning
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable 32-char key for a URL. Truncated because collisions are negligible. */
export function urlHash(raw: string): string {
  return sha256(normalizeUrl(raw)).slice(0, 32);
}

/**
 * Stable key for a headline, or null when the title is too short to be a
 * trustworthy identity. Returning null matters: the unique index on titleHash
 * is sparse, so a story with a one-word title is deduped by URL alone rather
 * than colliding with every other short-titled story.
 */
export function titleHash(raw: string): string | null {
  const normalized = normalizeTitle(raw);
  if (normalized.length < 12) return null;
  return sha256(normalized).slice(0, 32);
}

/**
 * Key for deal-level dedupe: same company + same event type. Used to suppress
 * a second alert when three wires report one funding round.
 */
export function dealKey(company: string, event: string): string {
  const normalizedCompany = normalizeTitle(company)
    // Corporate suffixes differ between sources for the same company.
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|plc|sa|nv|ag|gmbh|ab|oy|pty|holdings|group|technologies|technology|labs|financial)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return sha256(`${normalizedCompany}::${event}`).slice(0, 32);
}

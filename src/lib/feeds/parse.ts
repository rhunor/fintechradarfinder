/**
 * parse.ts — turns RSS 2.0, Atom and SEC EDGAR Atom into one RawItem shape.
 *
 * WHY ONE NORMALIZER: every downstream stage (dedupe, prefilter, classifier)
 * should be blind to which XML dialect a story arrived in. All the per-dialect
 * awkwardness — CDATA, `<content:encoded>`, Atom's link-as-attribute, SEC
 * stuffing the form type into the title — is contained here.
 *
 * We use fast-xml-parser rather than a full feed library because this runs on
 * every changed feed in every cycle, and parse time is billed CPU.
 */

import { XMLParser } from "fast-xml-parser";
import type { SourceConfig } from "@/config/sources";
import type { RawItem } from "@/lib/feeds/types";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Feeds are inconsistent about whether a single item is an array. Forcing
  // these paths to always be arrays removes a whole class of branching below.
  isArray: (name) => ["item", "entry", "category", "link"].includes(name),
  trimValues: true,
  parseTagValue: false, // keep everything a string; we do our own coercion
  processEntities: true,
});

/**
 * Feeds embed HTML in summaries. The classifier wants prose, not markup.
 *
 * Numeric entities matter more than they look: a live feed item read
 * "Harry Adams raises &#163;7.5 million", and leaving that undecoded hides the
 * pound sign from the model — which is exactly the signal that tells it the
 * amount is not in dollars and the company may not be North American.
 */
export function stripHtml(input: string): string {
  return decodeEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  pound: "\u00a3",
  euro: "\u20ac",
  yen: "\u00a5",
  cent: "\u00a2",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

/**
 * Decode the entity forms feeds actually use: named, decimal (&#163;) and
 * hexadecimal (&#xA3;). Ampersand is decoded LAST so "&amp;#163;" — which some
 * feeds double-encode — resolves in one pass rather than becoming a literal.
 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => safeCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => {
      const value = NAMED_ENTITIES[name.toLowerCase()];
      return value ?? match;
    });
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** XML values arrive as string, object with #text, or array. Flatten to string. */
function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "object" && "#text" in value) {
    return text((value as Record<string, unknown>)["#text"]);
  }
  return "";
}

/**
 * Some feeds mix upcoming events into the news stream — Finextra carries webinar
 * listings dated months ahead. Treating those as "just published" would poison
 * latency stats and make stale items look like breaking news, so anything more
 * than an hour in the future is recorded as having no usable date.
 */
const MAX_CLOCK_SKEW_MS = 60 * 60 * 1000;

function parseDate(raw: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) return null;
  return d;
}

/**
 * Atom links are attributes, and there are several of them. We want the
 * alternate HTML link, falling back to the first link with an href.
 */
function atomLink(entry: Record<string, unknown>): string {
  const links = entry["link"];
  if (typeof links === "string") return links;
  if (!Array.isArray(links)) return "";
  const arr = links as Record<string, unknown>[];
  const alternate = arr.find(
    (l) => l["@_rel"] === "alternate" || l["@_rel"] === undefined,
  );
  return String((alternate ?? arr[0])?.["@_href"] ?? "");
}

function categoriesOf(node: Record<string, unknown>): string[] {
  const raw = node["category"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => {
      if (typeof c === "string") return c;
      const o = c as Record<string, unknown>;
      // RSS puts the name in the text node; Atom uses a `term` attribute.
      return text(o["#text"]) || String(o["@_term"] ?? "");
    })
    .map((c) => c.toLowerCase().trim())
    .filter(Boolean);
}

/**
 * SEC titles look like: "8-K - GROUP 1 AUTOMOTIVE INC (0001031203) (Filer)".
 * The form type before the first dash is what the prefilter routes on.
 */
function secFormType(entry: Record<string, unknown>, title: string): string | undefined {
  const cats = entry["category"];
  if (Array.isArray(cats)) {
    for (const c of cats as Record<string, unknown>[]) {
      if (c["@_label"] === "form type" && c["@_term"]) return String(c["@_term"]);
    }
  }
  const m = /^([A-Z0-9/-]+)\s+-\s+/.exec(title);
  return m?.[1];
}

export function parseFeed(source: SourceConfig, xml: string): RawItem[] {
  const doc = parser.parse(xml) as Record<string, unknown>;

  const rss = doc["rss"] as Record<string, unknown> | undefined;
  const channel = rss?.["channel"] as Record<string, unknown> | undefined;
  const rssItems = (channel?.["item"] as Record<string, unknown>[] | undefined) ?? [];

  const feed = doc["feed"] as Record<string, unknown> | undefined;
  const atomEntries = (feed?.["entry"] as Record<string, unknown>[] | undefined) ?? [];

  const items: RawItem[] = [];

  for (const it of rssItems) {
    const title = stripHtml(text(it["title"]));
    const link = text(it["link"]);
    if (!title || !link) continue;
    // content:encoded carries the full post on WordPress feeds; prefer it.
    const body = text(it["content:encoded"]) || text(it["description"]);
    items.push({
      sourceId: source.id,
      title,
      link,
      summary: stripHtml(body).slice(0, 4000),
      publishedAt: parseDate(text(it["pubDate"]) || text(it["dc:date"])),
      guid: text(it["guid"]) || null,
      categories: categoriesOf(it),
    });
  }

  for (const en of atomEntries) {
    const title = stripHtml(text(en["title"]));
    const link = atomLink(en);
    if (!title || !link) continue;
    const body = text(en["content"]) || text(en["summary"]);
    const item: RawItem = {
      sourceId: source.id,
      title,
      link,
      summary: stripHtml(body).slice(0, 4000),
      publishedAt: parseDate(text(en["updated"]) || text(en["published"])),
      guid: text(en["id"]) || null,
      categories: categoriesOf(en),
    };
    if (source.type === "sec") {
      const form = secFormType(en, title);
      if (form) item.secFormType = form;
    }
    items.push(item);
  }

  return items;
}

/**
 * candidate.ts — turning a feed item into something the classifier can read,
 * including fetching the article when the feed only gave a stub.
 *
 * WHY FETCHING IS CAPPED: pulling a press release page costs a full HTTP round
 * trip, and the cycle is billed on wall-clock time. Many wire feeds carry only
 * a headline and one sentence, which is not enough to tell a Series B from a
 * partnership — so we do fetch, but never more than a handful per cycle, and
 * anything we skip stays pending for next time rather than being classified
 * blind or dropped.
 */

import { env, limits } from "@/lib/env";
import { log, errorInfo } from "@/lib/log";
import { stripHtml } from "@/lib/feeds/parse";
import type { RawItem } from "@/lib/feeds/types";
import type { CandidateItem } from "@/lib/classifier/types";

/**
 * Below this many characters, a feed summary is too thin to classify well and
 * it is worth paying for the article page.
 */
export const THIN_SUMMARY_CHARS = 400;

export function needsArticleFetch(item: { summary: string }): boolean {
  return item.summary.trim().length < THIN_SUMMARY_CHARS;
}

/**
 * Fetch an article page and extract its main text.
 *
 * Deliberately crude: no readability library, no DOM parser. Those are heavy
 * dependencies for a job where "strip the tags and take the longest run of
 * prose" is good enough to feed a language model that is about to summarise it
 * anyway. Cheap beats perfect when CPU time is the budget.
 */
export async function fetchArticleText(
  url: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? limits.articleTimeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": env.appUserAgent,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Encoding": "gzip, deflate",
      },
      signal,
      redirect: "follow",
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) return null;

    const html = await res.text();

    // Prefer the <article> or main content block when the page marks one.
    const article = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1];
    const body = article ?? /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;

    const text = stripHtml(
      body
        .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
        .replace(/<header[\s\S]*?<\/header>/gi, " ")
        .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
        .replace(/<aside[\s\S]*?<\/aside>/gi, " "),
    );

    return text.length > 200 ? text.slice(0, 4000) : null;
  } catch (err) {
    log.debug("article.fetch_failed", { url, ...errorInfo(err) });
    return null;
  }
}

/**
 * Build the classifier payload from a feed item plus optional article text.
 *
 * `id` is a short token like "i3", not the URL. The model has to echo it back
 * for us to re-associate verdicts with items, and a long URL both costs tokens
 * on every item and gives the model something to subtly mistranscribe. Two
 * characters are impossible to get wrong.
 */
export function toCandidateItem(
  item: RawItem,
  id: string,
  sourceName: string,
  articleText?: string | null,
): CandidateItem {
  const body = articleText && articleText.length > item.summary.length ? articleText : item.summary;
  return {
    id,
    title: item.title,
    sourceName,
    publishedAt: item.publishedAt,
    body: body.slice(0, 1500),
    secFormType: item.secFormType,
  };
}

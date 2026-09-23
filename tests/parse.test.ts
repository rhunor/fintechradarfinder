/**
 * parse.test.ts — feed parsing across the three XML dialects we ingest.
 *
 * These use captured fixtures rather than live feeds so the suite is fast and
 * works offline. The awkward cases here are all real ones we hit during
 * development: CDATA titles, Atom's link-as-attribute, SEC's form type buried
 * in the title, and feeds that list future-dated events alongside news.
 */

import { describe, expect, it } from "vitest";
import { parseFeed, stripHtml } from "@/lib/feeds/parse";
import type { SourceConfig } from "@/config/sources";

const rssSource: SourceConfig = {
  id: "test-rss",
  name: "Test RSS",
  url: "https://example.com/feed",
  type: "rss",
  regionHint: "US",
  minIntervalSeconds: 60,
  conditionalGet: "etag",
  enabled: true,
};

const secSource: SourceConfig = { ...rssSource, id: "test-sec", type: "sec" };

describe("stripHtml", () => {
  it("removes tags and decodes entities", () => {
    expect(stripHtml("<p>Raised &amp; closed <b>$25M</b></p>")).toBe("Raised & closed $25M");
  });

  it("drops script and style content entirely", () => {
    expect(stripHtml("<style>.a{}</style>Hi<script>evil()</script>")).toBe("Hi");
  });

  it("decodes numeric entities, which carry currency signals", () => {
    // Seen live: "&#163;7.5 million". Leaving it encoded hides the pound sign
    // from the classifier, which is how it tells a UK deal from a US one.
    expect(stripHtml("raises &#163;7.5 million")).toBe("raises \u00a37.5 million");
    expect(stripHtml("raises &#x20AC;5M")).toBe("raises \u20ac5M");
  });

  it("decodes the named entities feeds actually use", () => {
    expect(stripHtml("a &pound;5 &mdash; b &hellip;")).toBe("a \u00a35 \u2014 b \u2026");
  });

  it("leaves an unknown entity alone rather than mangling it", () => {
    expect(stripHtml("&notarealentity; x")).toBe("&notarealentity; x");
  });
});

describe("parseFeed: RSS 2.0", () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Wire</title>
      <item>
        <title><![CDATA[Acme Pay raises $25M Series B]]></title>
        <link>https://example.com/acme</link>
        <description><![CDATA[<p>Acme Pay, a <b>payments</b> company, raised.</p>]]></description>
        <pubDate>Tue, 22 Sep 2026 11:00:00 GMT</pubDate>
        <guid>urn:acme-1</guid>
        <category>Fintech</category>
        <category>Funding</category>
      </item>
    </channel></rss>`;

  it("extracts a normalized item", () => {
    const [item] = parseFeed(rssSource, xml);
    expect(item).toBeDefined();
    expect(item!.title).toBe("Acme Pay raises $25M Series B");
    expect(item!.link).toBe("https://example.com/acme");
    expect(item!.summary).toBe("Acme Pay, a payments company, raised.");
    expect(item!.publishedAt?.toISOString()).toBe("2026-09-22T11:00:00.000Z");
    expect(item!.categories).toEqual(["fintech", "funding"]);
  });

  it("prefers content:encoded over description when present", () => {
    const withContent = xml.replace(
      "</description>",
      "</description><content:encoded><![CDATA[The full article body.]]></content:encoded>",
    );
    const [item] = parseFeed(rssSource, withContent);
    expect(item!.summary).toBe("The full article body.");
  });

  it("skips items missing a title or link", () => {
    const broken = `<rss version="2.0"><channel>
      <item><title>No link here</title></item>
      <item><link>https://example.com/x</link></item>
    </channel></rss>`;
    expect(parseFeed(rssSource, broken)).toHaveLength(0);
  });
});

describe("parseFeed: Atom and SEC", () => {
  it("reads Atom links from the href attribute", () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Fintech Co acquires Rival Inc</title>
          <link rel="alternate" type="text/html" href="https://example.com/deal"/>
          <summary>A deal happened.</summary>
          <updated>2026-09-22T10:00:00-04:00</updated>
          <id>urn:deal-1</id>
        </entry>
      </feed>`;
    const [item] = parseFeed(rssSource, xml);
    expect(item!.link).toBe("https://example.com/deal");
    expect(item!.title).toBe("Fintech Co acquires Rival Inc");
  });

  it("pulls the SEC form type from the category term", () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>8-K - QumulusAI, Inc. (0002084026) (Filer)</title>
          <link rel="alternate" href="https://sec.gov/x"/>
          <updated>2026-09-22T10:00:00-04:00</updated>
          <category scheme="https://sec.gov/" label="form type" term="8-K"/>
        </entry>
      </feed>`;
    const [item] = parseFeed(secSource, xml);
    expect(item!.secFormType).toBe("8-K");
  });

  it("falls back to parsing the form type out of the title", () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>D - Platauro Metals Corp. (0001609436) (Filer)</title>
          <link rel="alternate" href="https://sec.gov/y"/>
          <updated>2026-09-22T10:00:00-04:00</updated>
        </entry>
      </feed>`;
    const [item] = parseFeed(secSource, xml);
    expect(item!.secFormType).toBe("D");
  });
});

describe("parseFeed: future-dated items", () => {
  // Finextra mixes webinar listings months ahead into its news feed. Treating
  // those as freshly published would make latency stats meaningless.
  it("records a far-future date as no date at all", () => {
    const future = new Date(Date.now() + 60 * 86400_000).toUTCString();
    const xml = `<rss version="2.0"><channel><item>
      <title>Upcoming webinar on payments</title>
      <link>https://example.com/webinar</link>
      <pubDate>${future}</pubDate>
    </item></channel></rss>`;
    const [item] = parseFeed(rssSource, xml);
    expect(item!.publishedAt).toBeNull();
  });

  it("still accepts a date a few minutes ahead, which is just clock skew", () => {
    const soon = new Date(Date.now() + 5 * 60_000).toUTCString();
    const xml = `<rss version="2.0"><channel><item>
      <title>Just published</title>
      <link>https://example.com/now</link>
      <pubDate>${soon}</pubDate>
    </item></channel></rss>`;
    const [item] = parseFeed(rssSource, xml);
    expect(item!.publishedAt).not.toBeNull();
  });
});

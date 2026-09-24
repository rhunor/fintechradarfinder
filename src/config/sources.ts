/**
 * sources.ts — the single registry of every news feed the radar watches.
 *
 * WHY THIS FILE EXISTS: every other module treats sources as opaque config.
 * Adding or removing a feed should mean editing this list and nothing else.
 *
 * Every URL here was fetched and verified to return recent, valid items before
 * being added. `conditionalGet` records what the server actually supports, which
 * the fetcher uses to decide between If-None-Match/If-Modified-Since (cheap, the
 * server sends 0 bytes) and hashing the body (we pay for the bytes, but still
 * skip parsing). That distinction is what keeps us inside the Vercel Hobby CPU
 * budget, so it is measured, not assumed.
 */

export type SourceType = "rss" | "atom" | "sec";

/** Which validators the origin actually honoured when we tested it. */
export type ConditionalGetSupport =
  | "etag" //            responds 304 to If-None-Match
  | "last-modified" //   responds 304 to If-Modified-Since
  | "body-hash"; //      ignores validators; we hash the body instead

export interface SourceConfig {
  /** Stable key. Used as the Mongo _id in source_state — never change it. */
  id: string;
  /** Human label used in alerts and /sources output. */
  name: string;
  url: string;
  type: SourceType;
  /** Where this feed's stories usually originate. A hint for the classifier only. */
  regionHint: "US" | "CA" | "US+CA" | "global";
  /** Never fetch this source more often than this, in seconds. */
  minIntervalSeconds: number;
  conditionalGet: ConditionalGetSupport;
  enabled: boolean;
  /**
   * Optional: only keep items whose category/tag fields match one of these.
   * Used where a site's own category feeds are stale or missing.
   */
  categoryFilter?: readonly string[];
  /**
   * Optional per-source fetch timeout. SEC's CGI endpoints are generated on
   * demand and routinely take 2-3s, which the default 5s does not survive when
   * the network is busy.
   */
  timeoutMs?: number;
  /** Optional note explaining a non-obvious choice. */
  note?: string;
}

/** Newswires break deal news first — poll them hardest. */
const WIRE_INTERVAL = 60;

/**
 * SEC EDGAR gets its own, slower cadence.
 *
 * MEASURED FROM VERCEL: the browse-edgar CGI intermittently applies a ~10
 * second server-side delay — repeated samples came back at 10,070-10,128ms,
 * far too consistent to be network latency, interleaved with sub-second
 * responses. Roughly three calls in five are throttled.
 *
 * Because feeds are fetched in parallel, one 10s response makes the WHOLE
 * cycle 10s of wall time, and Vercel bills Provisioned Memory by wall time.
 * Polling SEC every 60s projects to ~147 GB-hours a month, 41% of the Hobby
 * allowance, for two sources. At 180s it is ~54 GB-hours, 15%.
 *
 * The tradeoff is up to two extra minutes of latency on SEC filings. That is
 * acceptable: an 8-K is the legal disclosure of a deal that a newswire has
 * usually already announced, and the wires are still polled every 60s.
 */
const SEC_INTERVAL = 180;
/** Media sites republish with a lag; 3 minutes is plenty and saves CPU. */
const MEDIA_INTERVAL = 180;

export const SOURCES: readonly SourceConfig[] = [
  // ---------------------------------------------------------------------
  // Tier 1 — newswires. Press releases land here first.
  // ---------------------------------------------------------------------
  {
    id: "prn-fintech",
    name: "PR Newswire · Financial Technology",
    url: "https://www.prnewswire.com/rss/financial-services-latest-news/financial-technology-list.rss",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: WIRE_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "prn-ma",
    name: "PR Newswire · Acquisitions & Mergers",
    url: "https://www.prnewswire.com/rss/financial-services-latest-news/acquisitions-mergers-and-takeovers-list.rss",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: WIRE_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "prn-vc",
    name: "PR Newswire · Venture Capital",
    url: "https://www.prnewswire.com/rss/financial-services-latest-news/venture-capital-list.rss",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: WIRE_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "prn-banking",
    name: "PR Newswire · Banking & Financial Services",
    url: "https://www.prnewswire.com/rss/financial-services-latest-news/banking-financial-services-list.rss",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: WIRE_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "gnw-ma",
    name: "GlobeNewswire · Mergers & Acquisitions",
    url: "https://www.globenewswire.com/RssFeed/subjectcode/22-Mergers%20And%20Acquisitions/feedTitle/GlobeNewswire%20-%20Mergers%20And%20Acquisitions",
    type: "rss",
    regionHint: "US+CA",
    minIntervalSeconds: WIRE_INTERVAL,
    conditionalGet: "last-modified",
    enabled: true,
  },
  {
    id: "gnw-fintech",
    name: "GlobeNewswire · Financial Technology",
    url: "https://www.globenewswire.com/RssFeed/industry/9576-Financial%20Technology/feedTitle/GlobeNewswire%20-%20Financial%20Technology",
    type: "rss",
    regionHint: "US+CA",
    minIntervalSeconds: WIRE_INTERVAL,
    conditionalGet: "last-modified",
    enabled: true,
  },
  {
    id: "gnw-financing",
    name: "GlobeNewswire · Financing Agreements",
    url: "https://www.globenewswire.com/RssFeed/subjectcode/19-Financing%20Agreements/feedTitle/GlobeNewswire%20-%20Financing%20Agreements",
    type: "rss",
    regionHint: "US+CA",
    minIntervalSeconds: WIRE_INTERVAL,
    conditionalGet: "last-modified",
    enabled: true,
  },

  // ---------------------------------------------------------------------
  // Tier 2 — SEC EDGAR. Slower to read than a press release, but it is the
  // ground truth for US deals and often lands before any media coverage.
  // These are CGI endpoints: they send no ETag/Last-Modified, so we hash.
  // ---------------------------------------------------------------------
  {
    id: "sec-8k",
    name: "SEC EDGAR · Form 8-K",
    url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=40&output=atom",
    type: "sec",
    regionHint: "US",
    minIntervalSeconds: SEC_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
    // Must clear EDGAR's ~10s throttle. 9s failed every throttled request.
    timeoutMs: 15_000,
    note: "Prefilter keeps only Item 1.01 / 2.01 with acquisition or merger language.",
  },
  {
    id: "sec-form-d",
    name: "SEC EDGAR · Form D",
    url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=D&company=&dateb=&owner=include&count=40&output=atom",
    type: "sec",
    regionHint: "US",
    minIntervalSeconds: SEC_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
    timeoutMs: 15_000,
    note: "High volume, and an entry carries only a company name. Name/SIC prefiltered before the AI.",
  },

  // ---------------------------------------------------------------------
  // Tier 3 — trade press and funding coverage. Slower cadence by design.
  // ---------------------------------------------------------------------
  {
    id: "techcrunch-fintech",
    name: "TechCrunch · Fintech",
    url: "https://techcrunch.com/category/fintech/feed/",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: MEDIA_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "crunchbase-news",
    name: "Crunchbase News",
    url: "https://news.crunchbase.com/feed/",
    type: "rss",
    regionHint: "US+CA",
    minIntervalSeconds: MEDIA_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "finextra",
    name: "Finextra",
    url: "https://www.finextra.com/rss/headlines.aspx",
    type: "rss",
    regionHint: "global",
    minIntervalSeconds: MEDIA_INTERVAL,
    conditionalGet: "last-modified",
    enabled: true,
  },
  {
    id: "pymnts",
    name: "PYMNTS",
    url: "https://www.pymnts.com/feed/",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: MEDIA_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "crowdfund-insider",
    name: "Crowdfund Insider",
    url: "https://www.crowdfundinsider.com/feed/",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: MEDIA_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "banking-dive",
    name: "Banking Dive",
    url: "https://www.bankingdive.com/feeds/news/",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: MEDIA_INTERVAL,
    conditionalGet: "last-modified",
    enabled: true,
  },
  {
    id: "payments-dive",
    name: "Payments Dive",
    url: "https://www.paymentsdive.com/feeds/news/",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: MEDIA_INTERVAL,
    conditionalGet: "last-modified",
    enabled: true,
  },
  {
    id: "tearsheet",
    name: "Tearsheet",
    url: "https://tearsheet.co/feed/",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: MEDIA_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },

  // ---------------------------------------------------------------------
  // Tier 4 — Canada.
  // ---------------------------------------------------------------------
  {
    id: "betakit",
    name: "BetaKit",
    url: "https://betakit.com/feed/",
    type: "rss",
    regionHint: "CA",
    minIntervalSeconds: MEDIA_INTERVAL,
    conditionalGet: "last-modified",
    enabled: true,
    timeoutMs: 10_000,
    categoryFilter: ["fintech", "funding", "acquisitions", "mergers-acquisitions", "ai"],
    note:
      "Main feed only, and it is a 1.4MB/150-item WordPress feed, hence the long timeout. " +
      "BetaKit's own /category/funding/feed/ and /category/fintech/feed/ are both abandoned " +
      "(newest items from 2024). Last-Modified works, so the full body only transfers on change.",
  },
  {
    id: "financial-post",
    name: "Financial Post",
    url: "https://financialpost.com/feed",
    type: "rss",
    regionHint: "CA",
    minIntervalSeconds: MEDIA_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
    note: "Sends an ETag but answers If-None-Match with 200 anyway, so validators are useless here.",
  },
];

/**
 * Sources that were researched and deliberately rejected. Kept here so nobody
 * re-adds a dead feed in six months, and so the README can explain the gaps.
 */
export const REJECTED_SOURCES: readonly { name: string; url: string; reason: string }[] = [
  {
    name: "Business Wire (all channels)",
    url: "https://feed.businesswire.com/rss/home/",
    reason: "Returns a 951-byte stub: 'The RSS channel you requested was deactivated by the administrator.'",
  },
  {
    name: "Newsfile Corp",
    url: "https://www.newsfilecorp.com/rss/all",
    reason: "HTTP 404 on every documented path; other paths answer 202 with a bot challenge and no feed body.",
  },
  {
    name: "Fintech Futures",
    url: "https://www.fintechfutures.com/feed/",
    reason: "HTTP 403 to any non-browser User-Agent. Reading it would mean spoofing a browser, which we do not do.",
  },
  {
    name: "FinSMEs",
    url: "https://www.finsmes.com/feed",
    reason: "HTTP 403 to a descriptive User-Agent.",
  },
  {
    name: "ACCESSWIRE",
    url: "https://www.accesswire.com/users/newsroom/rss",
    reason: "HTTP 403.",
  },
  {
    name: "PR Newswire Canada (CNW)",
    url: "https://www.newswire.ca/rss/",
    reason: "HTTP 404 on the RSS index and every list path. Canadian coverage comes from BetaKit and Financial Post instead.",
  },
];

export const ENABLED_SOURCES = SOURCES.filter((s) => s.enabled);

export function getSource(id: string): SourceConfig | undefined {
  return SOURCES.find((s) => s.id === id);
}

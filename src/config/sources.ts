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
  /**
   * Set false for paywalled publishers. When a feed summary is too thin the
   * pipeline normally fetches the article page for more text; for a paywalled
   * site that returns only the paywall, which wastes wall time and edges toward
   * the "never bypass a paywall" rule. The feed's own headline and summary are
   * what the publisher chose to make public, and that is all we use.
   */
  fetchArticle?: boolean;
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

/**
 * Sources added in the second expansion are polled less often than the
 * originals. Every source adds fetch work to every cycle, and Active CPU is
 * the Vercel meter with the least headroom. Fintech-focused and deal-focused
 * publications get 5 minutes; generalist or high-volume ones, where a relevant
 * story is rare, get 10.
 */
const FOCUSED_INTERVAL = 300;
const BROAD_INTERVAL = 600;

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
    timeoutMs: 14_000,
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
  // ---------------------------------------------------------------------
  // Second expansion (Oct 2026). Every entry verified: official RSS/Atom,
  // recent items, and conditional-GET support measured rather than assumed —
  // several advertise an ETag but never answer 304, and are marked body-hash.
  // ---------------------------------------------------------------------
  {
    id: "cnw",
    name: "CNW (PR Newswire Canada)",
    url: "https://www.newswire.ca/rss/news-releases/news-releases-list.rss",
    type: "rss",
    regionHint: "CA",
    minIntervalSeconds: 120,
    conditionalGet: "etag",
    // DISABLED: works from Europe but returns 404 from Vercel's US region
    // (iad1) on every request — Cloudflare serves newswire.ca differently by
    // region. The other list paths answer from the US but their newest items
    // are days old. Re-test with /api/admin/check-sources?only=cnw after
    // enabling if CNW ever changes its setup.
    enabled: false,
    note: "Region-dependent: 200 from Europe, 404 from Vercel iad1.",
  },
  {
    id: "pe-hub",
    name: "PE Hub",
    url: "https://www.pehub.com/feed/",
    type: "rss",
    regionHint: "US+CA",
    minIntervalSeconds: FOCUSED_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "fintech-futures",
    name: "Fintech Futures",
    url: "https://www.fintechfutures.com/rss.xml",
    type: "rss",
    regionHint: "global",
    minIntervalSeconds: FOCUSED_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
    note: "Previously rejected: /feed/ answered 403. /rss.xml works. Sends Last-Modified but never 304s.",
  },
  {
    id: "global-fintech-series",
    name: "Global Fintech Series",
    url: "https://globalfintechseries.com/feed/",
    type: "rss",
    regionHint: "global",
    minIntervalSeconds: FOCUSED_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
    note: "Sends an ETag but answers 200 to If-None-Match.",
  },
  {
    id: "fintech-ca",
    name: "Fintech.ca",
    url: "https://www.fintech.ca/feed/",
    type: "rss",
    regionHint: "CA",
    minIntervalSeconds: FOCUSED_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "american-banker",
    name: "American Banker",
    url: "https://www.americanbanker.com/feed?rss=true",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: FOCUSED_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
    fetchArticle: false,
    note: "Paywalled: only the feed's own headline and summary are used.",
  },
  {
    id: "the-logic",
    name: "The Logic",
    url: "https://thelogic.co/feed/",
    type: "rss",
    regionHint: "CA",
    minIntervalSeconds: FOCUSED_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
    fetchArticle: false,
    note: "Paywalled Canadian tech and business news.",
  },
  {
    id: "national-mortgage-news",
    name: "National Mortgage News",
    url: "https://www.nationalmortgagenews.com/feed?rss=true",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: FOCUSED_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
  },
  {
    id: "coverager",
    name: "Coverager",
    url: "https://coverager.com/feed/",
    type: "rss",
    regionHint: "global",
    minIntervalSeconds: FOCUSED_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "dig-in",
    name: "Digital Insurance",
    url: "https://www.dig-in.com/feed?rss=true",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
  },
  {
    id: "cfotech-ca",
    name: "CFOtech Canada",
    url: "https://cfotech.ca/feed",
    type: "rss",
    regionHint: "CA",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "fortune",
    name: "Fortune",
    url: "https://fortune.com/feed/fortune-feeds/?id=3230629",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
    fetchArticle: false,
  },
  {
    id: "bloomberg-tech",
    name: "Bloomberg Technology",
    url: "https://feeds.bloomberg.com/technology/news.rss",
    type: "rss",
    regionHint: "global",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
    fetchArticle: false,
    note: "Bloomberg's official public feed. The site is paywalled; feed text only.",
  },
  {
    id: "globe-and-mail",
    name: "The Globe and Mail · Business",
    url: "https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/business/",
    type: "rss",
    regionHint: "CA",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
    fetchArticle: false,
  },
  {
    id: "sifted",
    name: "Sifted",
    url: "https://sifted.eu/feed",
    type: "rss",
    regionHint: "global",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "last-modified",
    enabled: true,
    note: "European startup news. Most items fail the US/Canada rule; kept for European fintechs expanding to North America.",
  },
  {
    id: "insurance-journal",
    name: "Insurance Journal",
    url: "https://www.insurancejournal.com/feed/",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
  },
  {
    id: "ibamag-us",
    name: "Insurance Business (US)",
    url: "https://www.ibamag.com/us/rss/",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
    note: "High volume (~160 items), mostly brokerage news; the classifier does the filtering.",
  },
  {
    id: "ibamag-ca",
    name: "Insurance Business (Canada)",
    url: "https://www.ibamag.com/ca/rss/",
    type: "rss",
    regionHint: "CA",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
  },
  {
    id: "investmentnews",
    name: "InvestmentNews",
    url: "https://www.investmentnews.com/rss",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
  },
  {
    id: "wealthmanagement",
    name: "WealthManagement.com",
    url: "https://www.wealthmanagement.com/rss.xml",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
    note: "Sends Last-Modified but never answers 304.",
  },
  {
    id: "coindesk",
    name: "CoinDesk",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/",
    type: "rss",
    regionHint: "global",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "body-hash",
    enabled: true,
  },
  {
    id: "the-block",
    name: "The Block",
    url: "https://www.theblock.co/rss.xml",
    type: "rss",
    regionHint: "global",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "fintech-business-weekly",
    name: "Fintech Business Weekly",
    url: "https://fintechbusinessweekly.substack.com/feed",
    type: "rss",
    regionHint: "US",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
    note: "Weekly newsletter; a 640KB feed, but it answers 304 so the body rarely transfers.",
  },
  {
    id: "mars",
    name: "MaRS Discovery District",
    url: "https://www.marsdd.com/feed/",
    type: "rss",
    regionHint: "CA",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
  },
  {
    id: "product-hunt",
    name: "Product Hunt",
    url: "https://www.producthunt.com/feed/",
    type: "rss",
    regionHint: "global",
    minIntervalSeconds: BROAD_INTERVAL,
    conditionalGet: "etag",
    enabled: true,
    note: "Every product launch across tech; only fintech ones survive the classifier.",
  },
];

/**
 * Sources that were researched and deliberately rejected. Kept here so nobody
 * re-adds a dead feed in six months, and so the README can explain the gaps.
 */
export const REJECTED_SOURCES: readonly { name: string; url: string; reason: string }[] = [
  { name: "Business Wire", url: "https://www.businesswire.com", reason: "Public RSS channels were deactivated; the site now answers 403 to a descriptive User-Agent." },
  { name: "FinSMEs", url: "https://www.finsmes.com/feed", reason: "HTTP 403 on both the site and its feed." },
  { name: "ACCESSWIRE", url: "https://www.accesswire.com", reason: "HTTP 403." },
  { name: "Newsfile Corp", url: "https://www.newsfilecorp.com", reason: "No feed: documented paths return HTML or 404." },
  { name: "The Financial Brand", url: "https://thefinancialbrand.com/feed/", reason: "HTTP 403 to a descriptive User-Agent." },
  { name: "Auto Finance News", url: "https://www.autofinancenews.net/feed/", reason: "HTTP 403." },
  { name: "Bank Automation News", url: "https://bankautomationnews.com/feed/", reason: "HTTP 403." },
  { name: "ThinkAdvisor", url: "https://www.thinkadvisor.com/feed/", reason: "HTTP 403." },
  { name: "PitchBook News", url: "https://pitchbook.com/news/rss", reason: "HTTP 403." },
  { name: "Forbes", url: "https://www.forbes.com/fintech/feed/", reason: "No working public section feed: /fintech/feed/ and /money/feed/ return 404." },
  { name: "Reuters", url: "https://www.reuters.com", reason: "Public RSS discontinued; site returns 401." },
  { name: "Wall Street Journal", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", reason: "The official feed still answers but its newest item is about 20 months old." },
  { name: "Financial Times", url: "https://www.ft.com", reason: "Fully paywalled with no reachable public feed." },
  { name: "VentureBeat", url: "https://venturebeat.com/feed/", reason: "HTTP 429 (rate limited) at time of testing. Worth re-testing later." },
  { name: "The Paypers", url: "https://thepaypers.com", reason: "No feed: /rss and /rss.xml return HTML." },
  { name: "The Future Nexus", url: "https://thefuturenexus.com", reason: "No feed: /feed/ returns a JavaScript app page." },
  { name: "This Week in Fintech", url: "https://thisweekinfintech.com", reason: "No feed found at the standard paths." },
  { name: "Axios Pro Rata", url: "https://www.axios.com/newsletters/axios-pro-rata", reason: "Paid newsletter; HTTP 403." },
  { name: "Y Combinator Launches / Companies", url: "https://www.ycombinator.com/launches", reason: "Directory pages with no feed; reading them would mean scraping. YC's blog feed is ~3 months stale." },
  { name: "Wellfound", url: "https://wellfound.com", reason: "Startup directory with no feed; would require scraping." },
  { name: "Techstars portfolio", url: "https://www.techstars.com/portfolio", reason: "Directory with no feed; did not respond to a descriptive User-Agent." },
];

export const ENABLED_SOURCES = SOURCES.filter((s) => s.enabled);

export function getSource(id: string): SourceConfig | undefined {
  return SOURCES.find((s) => s.id === id);
}

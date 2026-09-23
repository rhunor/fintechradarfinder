/**
 * headlines.ts — the ground-truth set the whole pipeline is judged against.
 *
 * Ten realistic stories: six that must produce an alert, four that must not.
 * They are written to probe the specific ways this system can be wrong, not to
 * be easy:
 *
 *   - a Canadian fintech (region rule, non-US)
 *   - a debt facility, which is funding but not equity
 *   - an acquisition where the TARGET is the fintech, not the acquirer
 *   - a traditional bank buying a traditional bank (finance, but not fintech)
 *   - an AI company that merely sells to banks (not fintech by our definition)
 *   - a UK fintech (fintech and a real round, but wrong region)
 *   - a market research report (matches "acquisition" but is not news)
 *   - a product launch (fintech and US, but not a deal)
 *
 * `shouldAlert` is the end-to-end expectation. `shouldPrefilter` is narrower:
 * whether the cheap keyword stage should let it reach the model. They differ
 * on purpose — the UK and traditional-bank cases SHOULD reach the model, which
 * is what then rejects them on region and fintech grounds.
 */

export interface HeadlineFixture {
  id: string;
  title: string;
  summary: string;
  sourceName: string;
  /** Expected final outcome after classification. */
  shouldAlert: boolean;
  /** Expected outcome of the cheap keyword prefilter. */
  shouldPrefilter: boolean;
  /** Why, so a failing test explains itself. */
  rationale: string;
  expectedEvent?: "funding" | "acquisition";
  expectedRegion?: "US" | "CA" | "US+CA" | "other";
}

export const HEADLINE_FIXTURES: readonly HeadlineFixture[] = [
  // ---------------------- should alert (6) ----------------------
  {
    id: "fx-01",
    title: "Ramp raises $200M Series E at $16B valuation led by Founders Fund",
    summary:
      "Ramp, the New York-based corporate card and spend management platform, announced today it has raised a $200 million Series E round led by Founders Fund, with participation from Thrive Capital and Sequoia. The company will use the capital to expand its treasury products.",
    sourceName: "TechCrunch",
    shouldAlert: true,
    shouldPrefilter: true,
    rationale: "US fintech (spend management), clear equity round with a named lead.",
    expectedEvent: "funding",
    expectedRegion: "US",
  },
  {
    id: "fx-02",
    title: "Wealthsimple secures $750-million CAD credit facility from TD and BMO",
    summary:
      "Toronto-based Wealthsimple has secured a $750 million CAD credit facility led by TD Bank and Bank of Montreal to fund the growth of its lending book. The Canadian investing platform serves more than three million clients.",
    sourceName: "BetaKit",
    shouldAlert: true,
    shouldPrefilter: true,
    rationale: "Canadian fintech, debt financing counts as funding per the brief.",
    expectedEvent: "funding",
    expectedRegion: "CA",
  },
  {
    id: "fx-03",
    title: "Visa to acquire fraud prevention startup Featurespace in $935M deal",
    summary:
      "Visa Inc. announced a definitive agreement to acquire Featurespace, a fraud and financial crime prevention company, for approximately $935 million. The transaction is expected to close in the first quarter.",
    sourceName: "PR Newswire",
    shouldAlert: true,
    shouldPrefilter: true,
    rationale: "Acquisition where the acquirer is a US fintech; fraud prevention for financial services is in scope.",
    expectedEvent: "acquisition",
    expectedRegion: "US",
  },
  {
    id: "fx-04",
    title: "Nuvei acquired by Advent International in $6.3B take-private transaction",
    summary:
      "Montreal-based payments technology company Nuvei Corporation has entered into a definitive agreement to be acquired by private equity firm Advent International in an all-cash transaction valuing the company at $6.3 billion.",
    sourceName: "GlobeNewswire",
    shouldAlert: true,
    shouldPrefilter: true,
    rationale: "The fintech is the TARGET, not the acquirer. Either party qualifying is enough.",
    expectedEvent: "acquisition",
    expectedRegion: "CA",
  },
  {
    id: "fx-05",
    title: "Stablecoin infrastructure startup Bridge raises $58M seed round",
    summary:
      "San Francisco-based Bridge, which builds stablecoin payment infrastructure for businesses, has raised a $58 million seed and Series A round led by Sequoia Capital and Ribbit Capital. Bridge provides APIs for moving money across borders.",
    sourceName: "Crunchbase News",
    shouldAlert: true,
    shouldPrefilter: true,
    rationale: "Crypto/digital asset infrastructure is explicitly in the fintech definition.",
    expectedEvent: "funding",
    expectedRegion: "US",
  },
  {
    id: "fx-06",
    title: "Mercury closes $300M in growth equity financing to expand business banking",
    summary:
      "Mercury, the San Francisco startup banking platform, has closed a $300 million growth equity investment led by Coatue. The neobank serves over 200,000 startups and small businesses across the United States.",
    sourceName: "Finextra",
    shouldAlert: true,
    shouldPrefilter: true,
    rationale: "US neobank, growth equity is in scope.",
    expectedEvent: "funding",
    expectedRegion: "US",
  },

  // ---------------------- should NOT alert (4) ----------------------
  {
    id: "fx-07",
    title: "First Horizon Bank completes acquisition of Iberia Community Bancorp",
    summary:
      "First Horizon Corporation announced the completion of its acquisition of Iberia Community Bancorp, adding 34 branches across Louisiana. The combined institution will have approximately $89 billion in assets.",
    sourceName: "Business Wire",
    shouldAlert: false,
    // Must still reach the model: only a classifier can tell "bank buys bank,
    // no tech angle" from "bank buys a fintech", and the keyword stage cannot.
    shouldPrefilter: true,
    rationale: "Traditional bank buying a traditional bank with no technology angle — explicitly NOT fintech.",
  },
  {
    id: "fx-08",
    title: "Glean raises $150M Series F to bring AI search to enterprise customers",
    summary:
      "Glean, the enterprise AI search company, raised $150 million in a Series F round. The Palo Alto company counts several large banks among its customers and is expanding into regulated industries.",
    sourceName: "TechCrunch",
    shouldAlert: false,
    shouldPrefilter: true,
    rationale: "Generic enterprise AI that happens to sell to banks. Not a financial services product.",
  },
  {
    id: "fx-09",
    title: "Monzo raises £340M as UK challenger bank eyes profitability",
    summary:
      "London-based digital bank Monzo has raised £340 million in a funding round led by CapitalG. Monzo operates exclusively in the United Kingdom and has no stated plans for North American expansion.",
    sourceName: "Finextra",
    shouldAlert: false,
    shouldPrefilter: true,
    rationale: "Genuine fintech and a genuine round, but UK-only with no US or Canadian operations.",
    expectedRegion: "other",
  },
  {
    id: "fx-10",
    title: "Global Buy Now Pay Later Market to Reach $167B by 2032, CAGR of 26.1%",
    summary:
      "The global buy now pay later market size is projected to reach $167 billion by 2032, according to a new research report. The report covers merger and acquisition activity, funding trends and key player analysis.",
    sourceName: "GlobeNewswire",
    shouldAlert: false,
    // The keyword stage MUST catch this one: it is pure noise that mentions
    // both "merger" and "funding", and there is no reason to pay for it.
    shouldPrefilter: false,
    rationale: "Market research report. Mentions deal words but reports no actual deal.",
  },
];

export const SHOULD_ALERT = HEADLINE_FIXTURES.filter((f) => f.shouldAlert);
export const SHOULD_NOT_ALERT = HEADLINE_FIXTURES.filter((f) => !f.shouldAlert);

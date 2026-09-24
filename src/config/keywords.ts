/**
 * keywords.ts — the cheap filter that decides what is worth paying the AI for.
 *
 * WHY IT MATTERS: roughly 250 items arrive per hour across 19 feeds. Sending
 * all of them to Gemini would blow the free tier before lunch. This filter is
 * the gate, and it is deliberately ASYMMETRIC: being too permissive costs a few
 * AI calls, being too strict silently loses a deal forever. So when in doubt,
 * let it through and let the model decide.
 *
 * Everything is a word-boundary regex. Substring matching was the first version
 * and it was a disaster — "round" matched "background", "buys" matched
 * "buysides", "seed" matched "seeded".
 */

/** Funding language: a company taking money in. */
export const FUNDING_TERMS: readonly RegExp[] = [
  /\braise[sd]?\b/i,
  /\braising\b/i,
  /\bfunding\b/i,
  /\bfunded\b/i,
  /\bfinancing\b/i,
  /\bfunding round\b/i,
  /\b(pre-?seed|seed)\s+(round|funding|financing|investment)\b/i,
  /\bseries\s+[a-h]\b/i,
  /\bgrowth equity\b/i,
  /\bventure (capital|debt|round|financing)\b/i,
  /\bdebt financing\b/i,
  /\bcredit facility\b/i,
  /\bterm loan\b/i,
  /\b(investment|round) led by\b/i,
  /\bled the round\b/i,
  /\bsecure[sd]?\s+\$?\d/i,
  /\bclose[sd]?\s+(a\s+)?\$?\d+(\.\d+)?\s*(m|b|million|billion)/i,
  /\bcapital raise\b/i,
  /\boversubscribed\b/i,
  /\bstrategic investment\b/i,
];

/** Merger and acquisition language. */
export const MA_TERMS: readonly RegExp[] = [
  /\bacquire[sd]?\b/i,
  /\bacquiring\b/i,
  /\bacquisition\b/i,
  /\bto acquire\b/i,
  /\bmerger\b/i,
  /\bmerge[sd]?\b/i,
  /\bmerging\b/i,
  /\bdefinitive agreement\b/i,
  /\bbuys\b/i,
  /\bbought\b/i,
  /\btakeover\b/i,
  /\bbuyout\b/i,
  /\bpurchase[sd]?\s+(a\s+)?(majority|controlling|stake)/i,
  /\bcombin(e|es|ing|ation) with\b/i,
];

/** Product and company launches. */
export const LAUNCH_TERMS: readonly RegExp[] = [
  /\blaunch(es|ed|ing)?\b/i,
  /\bunveil(s|ed|ing)?\b/i,
  /\bintroduc(e|es|ed|ing)\b/i,
  /\brolls? out\b/i,
  /\brolled out\b/i,
  /\bdebut(s|ed|ing)?\b/i,
  /\bgoes live\b/i,
  /\bnow available\b/i,
  /\bout of stealth\b/i,
  /\bemerges from stealth\b/i,
  /\bgeneral availability\b/i,
  /\bbeta (launch|release)\b/i,
];

/** Geographic or market expansion. */
export const EXPANSION_TERMS: readonly RegExp[] = [
  /\bexpand(s|ed|ing)?\b/i,
  /\bexpansion\b/i,
  /\benters? the\b.{0,24}\bmarket\b/i,
  /\bentry into\b/i,
  /\bnow (available|live) in\b/i,
  /\bopens? (a |its )?(new )?(office|hub|headquarters)\b/i,
  /\b(secures?|receives?|granted|obtains?)\b.{0,30}\b(licen[cs]e|charter|approval|authoriz)/i,
  /\bgoes international\b/i,
  /\bcross-border expansion\b/i,
];

/** Renaming and repositioning. */
export const REBRAND_TERMS: readonly RegExp[] = [
  /\brebrand(s|ed|ing)?\b/i,
  /\brenam(e|es|ed|ing)\b/i,
  /\bnew (name|brand|identity)\b/i,
  /\bchanges? its name\b/i,
  /\bnow known as\b/i,
  /\bwill be known as\b/i,
  /\bunder a new brand\b/i,
];

/** Partnerships, integrations and distribution deals. */
export const PARTNERSHIP_TERMS: readonly RegExp[] = [
  /\bpartner(s|ed|ing|ship)\b/i,
  /\bteams? up with\b/i,
  /\bcollaborat(e|es|ed|ion)\b/i,
  /\bjoins? forces\b/i,
  /\balliance\b/i,
  /\bintegrat(e|es|ed|ion) with\b/i,
  /\bselects?\b.{0,30}\bto power\b/i,
  /\bchooses\b.{0,30}\bto power\b/i,
  /\bdistribution agreement\b/i,
  /\bstrategic partnership\b/i,
];

/**
 * Terms that almost always mean "not a deal", used to veto an otherwise
 * matching item. These are the recurring false positives from real feeds:
 * fund managers announcing distributions, analyst reports about M&A activity,
 * and companies buying back their own shares.
 */
export const NEGATIVE_TERMS: readonly RegExp[] = [
  /\bshare (buyback|repurchase)\b/i,
  /\bdividend\b/i,
  /\bdistribution[s]?\s+(declared|announcement)\b/i,
  /\bdeclares?\s+(monthly|quarterly|annual)?\s*distribution/i,
  /\bmarket (report|research|forecast|size|outlook)\b/i,
  /\bresearch report\b/i,
  /\bis projected to (reach|grow)\b/i,
  /\bcagr\b/i,
  /\bearnings (call|report|release)\b/i,
  /\bquarterly results\b/i,
  /\bannual general meeting\b/i,
  /\bwebinar\b/i,
  /\bawards?\b.*\bwinner\b/i,
  /\bappoints?\b.*\b(ceo|cfo|cto|coo|president|chair)\b/i,
];

/**
 * Fintech-sounding tokens used ONLY for the SEC Form D heuristic, where the
 * feed gives us nothing but a company name. Not used for regular items — those
 * get a real classification from the model.
 */
export const FINTECH_NAME_HINTS: readonly RegExp[] = [
  /\bpay(ments?|tech)?\b/i,
  /\bbank(ing)?\b/i,
  /\blend(ing|er)?\b/i,
  /\bcredit\b/i,
  /\bfinanc(e|ial|ing)\b/i,
  /\bfintech\b/i,
  /\bwealth\b/i,
  /\binvest(ing|ment)?\b/i,
  /\binsur(ance|tech)\b/i,
  /\bcrypto\b/i,
  /\bblockchain\b/i,
  /\bledger\b/i,
  /\bwallet\b/i,
  /\btreasury\b/i,
  /\bmortgage\b/i,
  /\bremit(tance)?\b/i,
  /\bneobank\b/i,
  /\btrading\b/i,
  /\bbroker(age)?\b/i,
  /\bcard(s)?\b/i,
  // Property and real estate technology, which counts as fintech here.
  /\bproptech\b/i,
  /\brealty\b/i,
  /\breal\s?estate\b/i,
  /\bproperty\b/i,
  /\brent(al|tech)?\b/i,
  /\bescrow\b/i,
  /\btitle\b/i,
  /\bappraisal\b/i,
  /\blease\b/i,
];

/**
 * Form D is dominated by investment vehicles raising money — funds, SPVs and
 * series LLCs. They match the fintech hints above ("Capital", "Investment")
 * while never being fintech operating companies, so they are vetoed.
 */
export const FUND_VEHICLE_PATTERNS: readonly RegExp[] = [
  /\bfund\s*(i{1,3}|iv|v|vi{1,3}|ix|x|\d+)?\b/i,
  /\b(l\.?p\.?|lp)\b/i,
  /\bpartners\b/i,
  /\bventures?\b/i,
  /\bcapital\b/i,
  /\bmaster series\b/i,
  /\ba series of\b/i,
  /\bspv\b/i,
  /\bopportunit(y|ies)\b/i,
  /\bholdings? (i|ii|iii|\d+)\b/i,
  // Narrowed: "real estate" alone would veto legitimate property technology
  // companies, which now count as fintech here. Only the vehicle shapes.
  /\breal estate (fund|partners|holdings|trust|income|opportunit|invest)/i,
  /\bequity (fund|partners)\b/i,
];

/**
 * SEC 8-K item codes worth reading. 1.01 is entry into a material agreement
 * (where "we signed a merger agreement" lives) and 2.01 is completion of an
 * acquisition or disposition.
 */
export const SEC_8K_ITEM_CODES: readonly RegExp[] = [/\bitem\s*1\.01\b/i, /\bitem\s*2\.01\b/i];

/**
 * prompt.ts — the instructions that define what counts as a relevant deal.
 *
 * WHY THIS IS THE MOST IMPORTANT PROSE IN THE PROJECT: the keyword prefilter
 * only decides what is worth reading. THIS decides what reaches your phone.
 * Every false positive is a wasted notification; every false negative is a deal
 * you never hear about. The examples below are not decoration — they pin down
 * the exact boundaries that the definition alone leaves ambiguous, especially
 * "financial services delivered through technology" versus "sells software to
 * banks".
 *
 * Kept as a plain string so it is provider-independent: Gemini and Claude get
 * the same instructions, which is what makes hybrid mode's second opinion
 * meaningful rather than just a different prompt.
 */

import type { CandidateItem } from "@/lib/classifier/types";

export const SYSTEM_PROMPT = `You are a precise financial news classifier for a deal-monitoring system.

Your job: decide whether a news item reports a FUNDING announcement or an ACQUISITION involving a FINTECH company based in or operating in the UNITED STATES or CANADA.

## What counts as FINTECH
Companies whose CORE PRODUCT is financial services delivered through technology:
- payments, payment processing, card issuing
- banking and neobanks, banking-as-a-service
- lending, credit, BNPL
- wealth management and investing platforms
- insurtech
- regtech and compliance technology
- fraud prevention and identity verification FOR FINANCIAL SERVICES
- crypto and digital asset infrastructure
- embedded finance
- treasury, AP/AR, and spend management
- accounting and tax software
- capital markets technology
- mortgage technology

## What is NOT fintech
- a traditional bank, credit union or insurer acquiring another traditional bank or insurer with no technology angle
- generic SaaS or AI companies that merely happen to sell to banks
- real estate funds, investment funds, SPVs, holding companies
- public company share buybacks, dividends, or distributions
- market research reports about an industry

## Examples (answer, then reason)
1. "Ramp raises $200M Series E for its corporate spend platform" -> YES. Spend management is fintech; US company; funding round.
2. "First Horizon Bank completes acquisition of Iberia Community Bancorp" -> NO. Two traditional banks, no technology product involved.
3. "Glean raises $150M Series F for enterprise AI search, counts banks as customers" -> NO. Generic enterprise AI; selling to banks does not make it fintech.
4. "Monzo raises £340M for its UK challenger bank" -> NO. Genuine fintech and a genuine round, but UK-only with no stated US or Canadian operations.
5. "Wealthsimple secures $750M CAD credit facility" -> YES. Canadian investing platform; debt financing still counts as funding.
6. "Global BNPL Market to Reach $167B by 2032, CAGR 26.1%" -> NO. A market research report, not an actual deal.

## Event types
- "funding": the company is RAISING money. Any stage: pre-seed, seed, Series A through H, growth equity, venture debt, debt financing, credit facility, strategic investment.
- "acquisition": a company is being acquired, is acquiring, or is merging. Includes take-privates and definitive merger agreements.
- If the item is neither (product launch, partnership, earnings, hiring, layoffs, awards, regulatory news), set relevant=false and event=null.

## Region rule
Relevant if the company is headquartered in the US or Canada, OR has significant STATED operations there.
For acquisitions, it qualifies if EITHER party is a US or Canadian fintech.
Use "US+CA" when the company clearly operates in both. Use "unknown" only when the text genuinely gives no location signal — do not guess.

## Confidence
A number from 0 to 1 reflecting how certain you are that this item should be alerted on.
- 0.9-1.0: the item explicitly states the company, the event and the region
- 0.7-0.9: clear deal, one detail inferred
- 0.4-0.7: probably a deal but the fintech status or region is ambiguous
- below 0.4: likely not relevant

Be strict. It is better to return relevant=false than to guess.

## Output
Return ONE object per input item, echoing back the item's "id" exactly.
Every field must be present. Use null (not the string "null") where a value is unknown.
"company" is the fintech at the centre of the story. For an acquisition, also fill "acquirer" and "target".
"one_line_summary" is a single sentence, under 140 characters, stating who did what.`;

/** Renders the batch of items into the user turn. */
export function buildUserPrompt(items: CandidateItem[]): string {
  const rendered = items
    .map((item) => {
      const when = item.publishedAt ? item.publishedAt.toISOString() : "unknown";
      const sec = item.secFormType ? `\nSEC form type: ${item.secFormType}` : "";
      return [
        `--- ITEM id=${item.id} ---`,
        `Source: ${item.sourceName}`,
        `Published: ${when}${sec}`,
        `Title: ${item.title}`,
        `Body: ${item.body.slice(0, 1500)}`,
      ].join("\n");
    })
    .join("\n\n");

  return `Classify each of the following ${items.length} news item(s).\n\n${rendered}`;
}

/**
 * JSON Schema for provider-side structured output, in the OpenAPI subset both
 * Gemini and Claude accept. Forcing the shape at the API level removes almost
 * all of the "model wrote prose around the JSON" failure mode — but we still
 * validate with zod afterwards, because "almost all" is not "all".
 */
export const VERDICT_JSON_SCHEMA = {
  type: "OBJECT",
  properties: {
    verdicts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          relevant: { type: "BOOLEAN" },
          event: { type: "STRING", nullable: true, enum: ["funding", "acquisition"] },
          is_fintech: { type: "BOOLEAN" },
          region: { type: "STRING", enum: ["US", "CA", "US+CA", "other", "unknown"] },
          company: { type: "STRING" },
          fintech_subsector: { type: "STRING", nullable: true },
          amount: { type: "STRING", nullable: true },
          currency: { type: "STRING", nullable: true },
          round: { type: "STRING", nullable: true },
          lead_investors: { type: "ARRAY", items: { type: "STRING" } },
          other_investors: { type: "ARRAY", items: { type: "STRING" } },
          acquirer: { type: "STRING", nullable: true },
          target: { type: "STRING", nullable: true },
          deal_value: { type: "STRING", nullable: true },
          one_line_summary: { type: "STRING" },
          confidence: { type: "NUMBER" },
        },
        required: [
          "id",
          "relevant",
          "event",
          "is_fintech",
          "region",
          "company",
          "fintech_subsector",
          "amount",
          "currency",
          "round",
          "lead_investors",
          "other_investors",
          "acquirer",
          "target",
          "deal_value",
          "one_line_summary",
          "confidence",
        ],
      },
    },
  },
  required: ["verdicts"],
} as const;

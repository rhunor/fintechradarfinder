/**
 * classifier-live.test.ts — the ten ground-truth headlines through the REAL model.
 *
 * This is the only test that spends quota, and it is the one that actually
 * answers "does this thing work". Unit tests prove we survive bad JSON; this
 * proves the prompt draws the fintech and region boundaries where the brief
 * says they are.
 *
 * Skipped automatically when GEMINI_API_KEY is absent.
 */

import { describe, expect, it } from "vitest";
import { createGeminiClassifier } from "@/lib/classifier/gemini";
import { HEADLINE_FIXTURES } from "./fixtures/headlines";
import type { CandidateItem } from "@/lib/classifier/types";

const hasKey = Boolean(process.env.GEMINI_API_KEY);
const describeAi = hasKey ? describe : describe.skip;

const ALERT_THRESHOLD = Number(process.env.ALERT_MIN_CONFIDENCE ?? "0.7");

describeAi("Gemini on the ground-truth fixtures", () => {
  it(
    "classifies all ten in one batched request",
    async () => {
      const items: CandidateItem[] = HEADLINE_FIXTURES.map((f) => ({
        id: f.id,
        title: f.title,
        sourceName: f.sourceName,
        publishedAt: new Date(),
        body: f.summary,
      }));

      const verdicts = await createGeminiClassifier().classify(items);

      // Every item must come back, echoing its id: a dropped item is a lost deal.
      expect(verdicts).toHaveLength(HEADLINE_FIXTURES.length);
      const byId = new Map(verdicts.map((v) => [v.id, v]));

      const failures: string[] = [];
      for (const fixture of HEADLINE_FIXTURES) {
        const verdict = byId.get(fixture.id);
        if (!verdict) {
          failures.push(`${fixture.id}: no verdict returned`);
          continue;
        }
        const wouldAlert = verdict.relevant && verdict.confidence >= ALERT_THRESHOLD;
        if (wouldAlert !== fixture.shouldAlert) {
          failures.push(
            `${fixture.id} "${fixture.title.slice(0, 55)}"\n` +
              `      expected alert=${fixture.shouldAlert} got=${wouldAlert} ` +
              `(relevant=${verdict.relevant} conf=${verdict.confidence} region=${verdict.region} fintech=${verdict.is_fintech})\n` +
              `      why it matters: ${fixture.rationale}`,
          );
        }
      }

      expect(failures.join("\n"), `\n${failures.join("\n")}\n`).toBe("");
    },
    60_000,
  );
});

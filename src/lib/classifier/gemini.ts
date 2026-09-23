/**
 * gemini.ts — the default classifier provider.
 *
 * WHY GEMINI FLASH-LITE: it has the most generous free tier of any current
 * model, which is the whole reason this project can run at zero cost. The exact
 * model comes from GEMINI_MODEL so it can be changed without a deploy.
 *
 * WHY THE SDK IS LAZY-IMPORTED: the poll route runs ~43,000 times a month, and
 * most cycles have nothing to classify. Importing the SDK at module scope would
 * add its parse and init cost to every one of those cycles. `await import()`
 * inside classify() means we only pay for it when there is actually work.
 */

import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { buildUserPrompt, SYSTEM_PROMPT, VERDICT_JSON_SCHEMA } from "@/lib/classifier/prompt";
import { parseResponseText } from "@/lib/classifier/parse";
import { ClassifierError } from "@/lib/classifier/errors";
import type {
  CandidateItem,
  Classifier,
  ClassifyCallOptions,
  Verdict,
} from "@/lib/classifier/types";

function statusOf(err: unknown): number | undefined {
  const direct = (err as { status?: number })?.status;
  if (typeof direct === "number") return direct;
  // The SDK stringifies the API error into the message, so dig it out.
  const m = /"code"\s*:\s*(\d{3})/.exec(String((err as Error)?.message ?? ""));
  return m?.[1] ? Number(m[1]) : undefined;
}

function isRateLimit(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? "");
  return statusOf(err) === 429 || /rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(msg);
}

/**
 * True when the request never reached the model, so it consumed no free-tier
 * quota. Counting these against the daily limit would exhaust our allowance
 * without a single classification — measured 503s on several Gemini models
 * during a burst, so this is a real path, not a theoretical one.
 */
export function consumedQuota(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 503 || status === 500 || status === 502 || status === 504) return false;
  if (status === undefined) return false; // network error or abort
  return true;
}

function retryAfterFrom(err: unknown): number | undefined {
  const msg = String((err as Error)?.message ?? "");
  // Google returns retry guidance inside the error text, e.g. "retryDelay":"27s"
  const m = /retryDelay"?\s*:\s*"?(\d+)s/i.exec(msg);
  return m?.[1] ? Number(m[1]) : undefined;
}

export function createGeminiClassifier(model = env.geminiModel): Classifier {
  return {
    name: `gemini:${model}`,

    async classify(items: CandidateItem[], opts: ClassifyCallOptions = {}): Promise<Verdict[]> {
      if (items.length === 0) return [];

      // Lazy import: nothing above this line costs anything on an idle cycle.
      const { GoogleGenAI, ThinkingLevel } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

      const started = Date.now();
      let text: string;
      try {
        const response = await ai.models.generateContent({
          model,
          contents: buildUserPrompt(items),
          config: {
            systemInstruction: SYSTEM_PROMPT,
            responseMimeType: "application/json",
            // Structured output: the API enforces the shape, so the parser
            // rarely has to salvage anything.
            responseSchema: VERDICT_JSON_SCHEMA as unknown as Record<string, unknown>,
            temperature: 0,
            // Classification needs judgement, not deliberation. Minimal
            // thinking keeps latency inside the cycle budget and tokens down.
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            ...(opts.signal ? { abortSignal: opts.signal } : {}),
          },
        });
        text = response.text ?? "";
      } catch (err) {
        if (opts.signal?.aborted) {
          // The cycle ran out of time. Not a provider failure: the items stay
          // pending and are retried next minute, so nothing is lost.
          throw new ClassifierError("cycle deadline reached during classification", true);
        }
        if (isRateLimit(err)) {
          throw new ClassifierError(
            `Gemini rate limited: ${(err as Error).message}`,
            true,
            429,
            retryAfterFrom(err),
          );
        }
        const status = statusOf(err);
        throw new ClassifierError(
          `Gemini request failed: ${(err as Error).message}`,
          // 4xx other than 429 will fail identically on a retry.
          status === undefined || status === 429 || status >= 500,
          status,
        );
      }

      if (!text.trim()) {
        throw new ClassifierError("Gemini returned an empty response", true);
      }

      const { verdicts, invalid } = parseResponseText(text);
      log.info("classifier.gemini.done", {
        model,
        items: items.length,
        verdicts: verdicts.length,
        invalid: invalid.length,
        ms: Date.now() - started,
      });
      if (invalid.length > 0) {
        log.warn("classifier.gemini.invalid_entries", {
          count: invalid.length,
          first_error: invalid[0]?.error,
        });
      }

      return verdicts;
    },
  };
}

/**
 * errors.ts — the one error type the classifier layer throws.
 *
 * `retryable` distinguishes "the provider had a bad moment" (network blip,
 * 429, 5xx — worth trying again) from "this request will never succeed"
 * (missing API key, malformed request). Retrying the second kind just burns
 * the cycle budget.
 */

export class ClassifierError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    /** Seconds the provider asked us to wait, parsed from a 429. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ClassifierError";
  }
}

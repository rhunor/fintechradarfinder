/**
 * telegram-api.test.ts — the Bot API helper, with fetch stubbed.
 *
 * The critical property here is that the bot TOKEN never reaches a log line or
 * an error message. It lives in the request URL, so any code that echoes the
 * URL on failure would leak it into Vercel's logs permanently.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTelegram, sendMessage, TelegramError } from "@/lib/alerter/telegram";

const TOKEN = "123456:SECRET_TOKEN_VALUE";
const originalFetch = globalThis.fetch;

function stubFetch(responses: unknown[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  const fn = vi.fn(async () => {
    const next = queue.shift();
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_CHAT_ID = "999";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("callTelegram", () => {
  it("returns the result on success", async () => {
    stubFetch([{ ok: true, result: { message_id: 7 } }]);
    const out = await callTelegram<{ message_id: number }>("sendMessage", { chat_id: "1" });
    expect(out.message_id).toBe(7);
  });

  it("throws a TelegramError carrying the API error code", async () => {
    // Two queued responses because the two assertions each make a call.
    const err = { ok: false, error_code: 400, description: "Bad Request: can't parse entities" };
    stubFetch([err, err]);
    await expect(callTelegram("sendMessage", {})).rejects.toThrow(TelegramError);
    await expect(callTelegram("sendMessage", {})).rejects.toMatchObject({ errorCode: 400 });
  });

  it("never puts the bot token in the error message", async () => {
    stubFetch([{ ok: false, error_code: 401, description: "Unauthorized" }]);
    await expect(callTelegram("sendMessage", {})).rejects.toSatisfy((err: Error) => {
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).not.toContain("SECRET_TOKEN_VALUE");
      return true;
    });
  });

  it("surfaces retry_after from a 429", async () => {
    stubFetch([
      { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } },
    ]);
    await expect(callTelegram("sendMessage", {})).rejects.toMatchObject({
      retryAfterSeconds: 30,
    });
  });
});

describe("sendMessage", () => {
  it("sends HTML with link previews disabled", async () => {
    const fetchMock = stubFetch([{ ok: true, result: { message_id: 1 } }]);
    await sendMessage("999", "<b>hi</b>");

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.parse_mode).toBe("HTML");
    expect(body.link_preview_options.is_disabled).toBe(true);
    expect(body.chat_id).toBe("999");
  });

  it("waits out a short retry_after and succeeds on the second try", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch([
      { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } },
      { ok: true, result: { message_id: 2 } },
    ]);

    const promise = sendMessage("999", "hi");
    await vi.advanceTimersByTimeAsync(1100);
    await expect(promise).resolves.toMatchObject({ message_id: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("gives up rather than blocking the cycle on a long retry_after", async () => {
    // A 5-minute back-off must not hold a 45s cycle hostage; the deal is
    // simply left unsent and retried next cycle.
    stubFetch([
      { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 300 } },
    ]);
    await expect(sendMessage("999", "hi")).rejects.toMatchObject({ retryAfterSeconds: 300 });
  });
});

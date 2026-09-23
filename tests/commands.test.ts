/**
 * commands.test.ts — command parsing, latency percentiles and the test alert.
 *
 * The parsing tests matter more than they look: Telegram sends "/status@BotName"
 * in groups, and a parser that misses that form makes the bot silently ignore
 * every command in any chat that is not a private DM.
 */

import { describe, expect, it } from "vitest";
import { buildTestAlert, handleHelp, parseCommand } from "@/lib/telegram/commands";
import { percentile } from "@/lib/stats";

describe("parseCommand", () => {
  it.each([
    ["/status", "status"],
    ["/last", "last"],
    ["/stats", "stats"],
    ["/pause", "pause"],
    ["/resume", "resume"],
    ["/test", "test"],
    ["/sources", "sources"],
    ["/help", "help"],
  ])("parses %s", (input, expected) => {
    expect(parseCommand(input)).toBe(expected);
  });

  it("handles the @botname suffix Telegram adds in groups", () => {
    expect(parseCommand("/status@fintechdr_bot")).toBe("status");
  });

  it("is case insensitive", () => {
    expect(parseCommand("/STATUS")).toBe("status");
  });

  it("ignores leading and trailing whitespace", () => {
    expect(parseCommand("  /help  ")).toBe("help");
  });

  it("ignores arguments after the command", () => {
    expect(parseCommand("/status now please")).toBe("status");
  });

  it("returns null for ordinary chatter, so the bot stays quiet", () => {
    expect(parseCommand("hello there")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("status")).toBeNull();
  });

  it("returns null for an unknown command", () => {
    expect(parseCommand("/deploy")).toBeNull();
    expect(parseCommand("/statuses")).toBeNull();
  });
});

describe("percentile", () => {
  it("returns null for an empty set", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("uses nearest rank rather than interpolating", () => {
    // With few samples, an interpolated value would be a number no alert had.
    const data = [10, 20, 30, 40];
    expect(percentile(data, 50)).toBe(20);
    expect(percentile(data, 95)).toBe(40);
  });

  it("handles a single sample", () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
  });

  it("never runs off the end of the array", () => {
    expect(percentile([1, 2, 3], 100)).toBe(3);
    expect(percentile([1, 2, 3], 0)).toBe(1);
  });
});

describe("buildTestAlert", () => {
  const html = buildTestAlert();

  it("says plainly that it is a test", () => {
    expect(html).toContain("test alert");
    expect(html).toContain("not real");
  });

  it("renders the full alert shape", () => {
    expect(html).toContain("💰 <b>FUNDING</b>");
    expect(html).toContain("Series B");
    expect(html).toContain("$42M");
    expect(html).toContain("Led by: Example Ventures");
    expect(html).toContain("detected in 2m 14s");
  });

  it("escapes the ampersand in the sample company name", () => {
    // "Acme Pay & Co" is deliberately chosen: an unescaped & makes Telegram
    // reject the message, so /test doubles as an escaping check.
    expect(html).toContain("Acme Pay &amp; Co");
    expect(html).not.toContain("Acme Pay & Co");
  });

  it("uses both flags for a US+CA deal", () => {
    expect(html).toContain("🇺🇸🇨🇦");
  });
});

describe("handleHelp", () => {
  it("lists every command the bot accepts", () => {
    const help = handleHelp();
    for (const cmd of ["/status", "/last", "/stats", "/sources", "/pause", "/resume", "/test", "/help"]) {
      expect(help).toContain(cmd);
    }
  });
});

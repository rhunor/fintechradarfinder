/**
 * event-icons.test.ts — every place that shows an event uses the right icon.
 *
 * Regression: the daily summary, /last and the dashboard used
 * `event === "funding" ? "💰" : "🤝"`, written when only two event types
 * existed, so every launch, partnership and expansion was shown as an
 * acquisition.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EVENTS, eventConfig } from "@/config/events";

describe("event icons", () => {
  it("gives every event type its own distinct icon", () => {
    const icons = EVENTS.map((e) => e.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("shows a launch as a launch, not an acquisition", () => {
    expect(eventConfig("launch").icon).toBe("🚀");
    expect(eventConfig("launch").icon).not.toBe(eventConfig("acquisition").icon);
  });

  it.each(["src/lib/telegram/daily.ts", "src/lib/telegram/commands.ts", "src/app/deals/page.tsx"])(
    "%s does not hardcode a two-way funding/acquisition icon",
    (file) => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/===\s*"funding"\s*\?\s*"💰"\s*:\s*"🤝"/);
    },
  );
});

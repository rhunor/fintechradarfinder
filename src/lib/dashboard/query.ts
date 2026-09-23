/**
 * dashboard/query.ts — turns URL search params into a Mongo query.
 *
 * Kept separate from the page so the filter logic is testable without
 * rendering React, and so the page component stays about layout.
 *
 * Every value here comes from a URL, so it is untrusted: the company search in
 * particular is escaped before it reaches a regex, or a visitor could paste a
 * pattern that pins the database at 100% CPU.
 */

import type { Filter } from "mongodb";
import type { DealDoc, DealEvent } from "@/lib/store/schema";

export interface DealFilters {
  event: DealEvent | "all";
  region: string;
  days: number;
  search: string;
}

const ALLOWED_DAYS = [1, 7, 30, 90, 365] as const;
const ALLOWED_REGIONS = ["all", "US", "CA", "US+CA"] as const;

export function parseFilters(params: URLSearchParams): DealFilters {
  const event = params.get("event");
  const region = params.get("region") ?? "all";
  const days = Number(params.get("days") ?? 30);

  return {
    event: event === "funding" || event === "acquisition" ? event : "all",
    region: (ALLOWED_REGIONS as readonly string[]).includes(region) ? region : "all",
    days: (ALLOWED_DAYS as readonly number[]).includes(days) ? days : 30,
    // Cap the length: a multi-kilobyte search term is never legitimate.
    search: (params.get("q") ?? "").trim().slice(0, 80),
  };
}

/**
 * Escape regex metacharacters.
 *
 * Without this, searching for "(((((a" would build a catastrophically
 * backtracking pattern, and Atlas M0 has no CPU to spare for that.
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildQuery(filters: DealFilters, now: Date = new Date()): Filter<DealDoc> {
  const query: Filter<DealDoc> = {
    alertState: "sent",
    alertedAt: { $gte: new Date(now.getTime() - filters.days * 86_400_000) },
  };

  if (filters.event !== "all") query.event = filters.event;
  if (filters.region !== "all") query.region = filters.region;
  if (filters.search) {
    query.company = { $regex: escapeRegex(filters.search), $options: "i" };
  }

  return query;
}

/** Rebuild the query string with one filter changed, preserving the rest. */
export function filterHref(filters: DealFilters, change: Partial<DealFilters>): string {
  const merged = { ...filters, ...change };
  const params = new URLSearchParams();
  if (merged.event !== "all") params.set("event", merged.event);
  if (merged.region !== "all") params.set("region", merged.region);
  if (merged.days !== 30) params.set("days", String(merged.days));
  if (merged.search) params.set("q", merged.search);
  const qs = params.toString();
  return qs ? `/deals?${qs}` : "/deals";
}

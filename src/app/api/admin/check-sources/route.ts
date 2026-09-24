/**
 * /api/admin/check-sources — fetch every source FROM VERCEL and report health.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE LOCAL SCRIPT: a feed that works from your
 * laptop can still block Vercel's IP ranges, or be served a different response
 * by a CDN. The only way to know the deployed app can actually read a source is
 * to ask the deployed app. Run this once after every deploy.
 */

import { ENABLED_SOURCES } from "@/config/sources";
import { fetchAllSources } from "@/lib/feeds/fetch-all";
import { isAuthorized, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) return unauthorized();

  const params = new URL(request.url).searchParams;

  // ?timeout=20000 overrides every source's timeout for this call only.
  // Diagnostic: it distinguishes "this origin is slow from Vercel" from "this
  // origin is refusing Vercel", which look identical in the normal output.
  const timeoutOverride = Number(params.get("timeout"));
  const candidates =
    Number.isFinite(timeoutOverride) && timeoutOverride > 0
      ? ENABLED_SOURCES.map((s) => ({ ...s, timeoutMs: Math.min(timeoutOverride, 45_000) }))
      : ENABLED_SOURCES;

  // ?only=sec-8k,sec-form-d narrows the check to specific sources.
  const only = params.get("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const selected = only?.length ? candidates.filter((s) => only.includes(s.id)) : candidates;

  const started = Date.now();
  // No stored validators: force a full fetch so item counts are real.
  const results = await fetchAllSources(selected);

  const sources = results
    .map(({ source, outcome }) => {
      const base = {
        id: source.id,
        name: source.name,
        type: source.type,
        region_hint: source.regionHint,
        min_interval_s: source.minIntervalSeconds,
        conditional_get: source.conditionalGet,
        duration_ms: outcome.durationMs,
      };

      if (outcome.status === "ok") {
        const dates = outcome.items
          .map((i) => i.publishedAt)
          .filter((d): d is Date => d !== null)
          .map((d) => d.getTime());
        const newest = dates.length > 0 ? Math.max(...dates) : null;
        return {
          ...base,
          status: "ok" as const,
          http_status: outcome.httpStatus,
          items: outcome.items.length,
          bytes: outcome.bytes,
          newest_item_at: newest ? new Date(newest).toISOString() : null,
          newest_item_age_minutes: newest ? Math.round((Date.now() - newest) / 60000) : null,
          sample_title: outcome.items[0]?.title.slice(0, 120) ?? null,
        };
      }

      if (outcome.status === "not-modified") {
        return { ...base, status: "not-modified" as const, via: outcome.via };
      }

      return {
        ...base,
        status: "error" as const,
        reason: outcome.reason,
        ...(outcome.httpStatus ? { http_status: outcome.httpStatus } : {}),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const failed = sources.filter((s) => s.status === "error");

  return Response.json(
    {
      checked_at: new Date().toISOString(),
      region: process.env.VERCEL_REGION ?? "local",
      total: selected.length,
      ok: sources.filter((s) => s.status !== "error").length,
      failed: failed.length,
      duration_ms: Date.now() - started,
      sources,
    },
    // 207 when some sources failed, so a monitor can alert on it.
    { status: failed.length > 0 ? 207 : 200 },
  );
}

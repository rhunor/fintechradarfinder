/**
 * /deals — the dashboard.
 *
 * Server-rendered on purpose. There is no client JavaScript at all: filters are
 * links, search is a plain form, and login is a form POST. That keeps the page
 * fast on a phone, keeps the bundle near zero, and means the whole thing works
 * with one database query per request.
 */

import { getDb } from "@/lib/store/client";
import { COLLECTIONS, type DealDoc } from "@/lib/store/schema";
import { isLoggedIn } from "@/lib/dashboard/auth";
import { buildQuery, filterHref, parseFilters, type DealFilters } from "@/lib/dashboard/query";
import { formatEtDateTime, formatDuration, regionFlag } from "@/lib/alerter/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DealsPage({ searchParams }: PageProps) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }

  if (!(await isLoggedIn())) {
    return <LoginForm failed={params.get("error") === "1"} />;
  }

  const filters = parseFilters(params);
  const db = await getDb();
  const deals = await db
    .collection<DealDoc>(COLLECTIONS.deals)
    .find(buildQuery(filters))
    .sort({ alertedAt: -1 })
    .limit(PAGE_SIZE)
    .toArray();

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Fintech Deal Radar</h1>
        <a className="text-sm text-slate-500 underline hover:text-slate-800" href="/api/dashboard/login">
          Sign out
        </a>
      </header>

      <Filters filters={filters} />

      <p className="mb-4 text-sm text-slate-500">
        {deals.length === PAGE_SIZE ? `${PAGE_SIZE}+` : deals.length} deal
        {deals.length === 1 ? "" : "s"} in the last {filters.days} day
        {filters.days === 1 ? "" : "s"}
      </p>

      {deals.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-6 text-slate-500">
          No deals match these filters.
        </p>
      ) : (
        <ul className="space-y-3">
          {deals.map((deal) => (
            <DealRow key={deal._id} deal={deal} />
          ))}
        </ul>
      )}
    </main>
  );
}

function Filters({ filters }: { filters: DealFilters }) {
  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-sm transition ${
      active ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-200"
    }`;

  return (
    <div className="mb-5 space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 text-xs uppercase tracking-wide text-slate-400">Type</span>
        <a className={chip(filters.event === "all")} href={filterHref(filters, { event: "all" })}>
          All
        </a>
        <a className={chip(filters.event === "funding")} href={filterHref(filters, { event: "funding" })}>
          💰 Funding
        </a>
        <a
          className={chip(filters.event === "acquisition")}
          href={filterHref(filters, { event: "acquisition" })}
        >
          🤝 Acquisition
        </a>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 text-xs uppercase tracking-wide text-slate-400">Region</span>
        {(["all", "US", "CA", "US+CA"] as const).map((region) => (
          <a key={region} className={chip(filters.region === region)} href={filterHref(filters, { region })}>
            {region === "all" ? "All" : `${regionFlag(region)} ${region}`}
          </a>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 text-xs uppercase tracking-wide text-slate-400">Since</span>
        {([1, 7, 30, 90, 365] as const).map((days) => (
          <a key={days} className={chip(filters.days === days)} href={filterHref(filters, { days })}>
            {days === 1 ? "24h" : days === 365 ? "1y" : `${days}d`}
          </a>
        ))}
      </div>

      {/* A plain GET form: no JavaScript, and the URL stays shareable. */}
      <form className="flex gap-2 pt-1" action="/deals" method="get">
        {filters.event !== "all" && <input type="hidden" name="event" value={filters.event} />}
        {filters.region !== "all" && <input type="hidden" name="region" value={filters.region} />}
        <input type="hidden" name="days" value={filters.days} />
        <input
          className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          type="search"
          name="q"
          placeholder="Search company name…"
          defaultValue={filters.search}
          maxLength={80}
        />
        <button className="rounded-md bg-slate-900 px-4 py-1.5 text-sm text-white" type="submit">
          Search
        </button>
      </form>
    </div>
  );
}

function DealRow({ deal }: { deal: DealDoc }) {
  const icon = deal.event === "funding" ? "💰" : "🤝";
  const money = deal.amount ?? deal.dealValue;
  const latency =
    deal.publishedAt && deal.alertedAt
      ? deal.alertedAt.getTime() - deal.publishedAt.getTime()
      : null;
  const primary = deal.sources[0];

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span>{icon}</span>
        <span className="font-semibold">{deal.company}</span>
        <span>{regionFlag(deal.region)}</span>
        {deal.round && <span className="text-sm text-slate-600">{deal.round}</span>}
        {money && <span className="text-sm font-medium text-slate-900">{money}</span>}
        {deal.unverified && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">unverified</span>
        )}
      </div>

      <p className="mt-1 text-sm text-slate-700">{deal.summary}</p>

      {deal.event === "acquisition" && deal.acquirer && deal.target && (
        <p className="mt-1 text-sm text-slate-500">
          {deal.acquirer} → {deal.target}
        </p>
      )}
      {deal.leadInvestors.length > 0 && (
        <p className="mt-1 text-sm text-slate-500">Led by {deal.leadInvestors.join(", ")}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
        <span>{deal.alertedAt ? `${formatEtDateTime(deal.alertedAt)} ET` : "—"}</span>
        {latency !== null && latency >= 0 && <span>detected in {formatDuration(latency)}</span>}
        {deal.fintechSubsector && <span>{deal.fintechSubsector}</span>}
        <span>confidence {deal.confidence.toFixed(2)}</span>
        {deal.sources.length > 1 && <span>{deal.sources.length} sources</span>}
        {primary && (
          <a className="text-blue-600 underline" href={primary.link} target="_blank" rel="noreferrer">
            source
          </a>
        )}
      </div>
    </li>
  );
}

function LoginForm({ failed }: { failed: boolean }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-xl font-semibold">Fintech Deal Radar</h1>
      <p className="mb-5 text-sm text-slate-500">Enter the dashboard password.</p>

      <form className="space-y-3" action="/api/dashboard/login" method="post">
        <input
          className="w-full rounded-md border border-slate-300 px-3 py-2"
          type="password"
          name="password"
          placeholder="Password"
          autoComplete="current-password"
          autoFocus
          required
        />
        <button className="w-full rounded-md bg-slate-900 px-4 py-2 text-white" type="submit">
          Sign in
        </button>
      </form>

      {failed && <p className="mt-3 text-sm text-red-600">Incorrect password.</p>}
    </main>
  );
}

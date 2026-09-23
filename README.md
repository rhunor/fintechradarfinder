# Fintech Deal Radar

A monitoring agent that watches news wires and fintech press, and sends you a
Telegram alert when a **US or Canadian fintech** announces **funding** or an
**acquisition**. Everything else — product launches, partnerships, earnings,
hires, market reports — is filtered out.

It runs on Vercel's free Hobby plan, MongoDB Atlas' free M0 tier, and Google
Gemini's free tier. Running cost is zero.

---

## How it works

An external scheduler calls one protected API route every minute. Each call runs
exactly one poll cycle and exits — there is no long-running process and no
`setInterval`, because serverless functions do not stay alive between requests.

```
scheduler (every 60s)
   │
   ▼
GET /api/cron/poll  ──► returns 202 in ~10ms
   │                     (work continues in Next.js after())
   ▼
 ┌─ acquire lease ──────────── another cycle running? exit immediately
 ├─ fetch due sources ──────── parallel, conditional GET, 2 per host
 ├─ dedupe + bootstrap ─────── unique indexes on URL hash and title hash
 ├─ keyword prefilter ──────── ~16% of items survive
 ├─ classify (Gemini) ──────── one batched request, hard deadline
 ├─ alert (Telegram) ───────── atomic claim, so never twice
 └─ record cost ────────────── wall + CPU, projected against Hobby limits
```

Each stage is deadline-aware. Running out of time means "less done this minute",
never a half-written state — anything unfinished stays `pending` and is picked up
next cycle, oldest first.

### Why conditional GET matters

The poll route runs about **43,000 times a month**. Most cycles have no new news.
Every source stores its `ETag` / `Last-Modified`, so a cycle usually asks "changed
since last time?" and gets a 304 with an empty body, skipping parsing entirely.
Sources that ignore validators (SEC's CGI endpoints, Financial Post) fall back to
hashing the response body — we pay for the bytes but still skip parsing.

Measured: parsing **every** feed on **every** cycle would use 1.55 of the 4
available CPU-hours. Realistically only a few feeds change per cycle, which puts
it nearer 6%.

---

## Deploy guide

Follow these in order. Roughly 30 minutes.

### 1. MongoDB Atlas (free M0)

1. Create an account at [mongodb.com/atlas](https://www.mongodb.com/atlas).
2. Create a cluster: **M0 free tier**, provider **AWS**, region **us-east-1
   (N. Virginia)**.

   > **Why us-east-1.** Vercel functions will run in `iad1`, which is the same
   > physical region. Every cycle makes a handful of database round trips; at
   > same-region latency those cost a few milliseconds, while cross-continent
   > they cost hundreds. Vercel bills memory by wall-clock time, so database
   > latency is a direct cost, not just a delay.

3. **Database Access** → Add a user with a strong generated password. Save it.
4. **Network Access** → Add IP `0.0.0.0/0` (allow from anywhere).

   > **Why open it to the world.** Vercel functions do not have stable outbound
   > IPs on Hobby, so there is no range to allowlist. The cluster is still
   > protected by the username and password in your connection string — which is
   > exactly why that password must be strong and must never be committed.

5. **Connect → Drivers** → copy the connection string.

### 2. Telegram bot

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the
   prompts. Save the token it gives you.
2. Get your chat ID: message [@userinfobot](https://t.me/userinfobot); it replies
   with your numeric ID.
3. Send your new bot any message (it cannot message you first).

### 3. Gemini API key

Create one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
The default model, `gemini-3.5-flash-lite`, has the most generous free tier.

### 4. Generate secrets

```bash
openssl rand -hex 32   # CRON_SECRET
openssl rand -hex 32   # TELEGRAM_WEBHOOK_SECRET
openssl rand -base64 18 # DASHBOARD_PASSWORD
```

### 5. Push to GitHub

```bash
git init
git add .
git commit -m "Fintech Deal Radar"
git branch -M main
git remote add origin git@github.com:YOU/fintech-deal-radar.git
git push -u origin main
```

`.env.local` is gitignored. Confirm with `git status` before pushing — if it
appears, stop and fix `.gitignore`.

### 6. Import into Vercel

1. [vercel.com/new](https://vercel.com/new) → import the repository.
2. Add every variable from `.env.example` under **Settings → Environment
   Variables**, for Production, Preview and Development.
3. Set `APP_URL` to your deployment URL (e.g.
   `https://fintech-deal-radar.vercel.app`), no trailing slash.
4. **Settings → Functions → Region**: `Washington, D.C. (iad1)`.

   `vercel.json` already pins `"regions": ["iad1"]`. Hobby allows exactly one
   region, which is all we need; multi-region is a Pro feature and irrelevant
   here.

5. Deploy.

### 7. Initialise the database

From your machine, with `.env.local` filled in and pointing at the same cluster:

```bash
npm run db:init
```

Creates all collections, indexes and TTLs. Safe to re-run; it reports what
already exists.

```bash
npm run db:reset-metrics
```

> **Do not skip this.** Local development writes cycle metrics into the same
> database production uses. Laptop cycles are slow and failure-prone, and they
> drag the Vercel projection into nonsense — during development this project's
> own numbers projected 142% of the CPU limit purely from local test runs. This
> clears the counters. Seen items, candidates and deals are untouched, so
> nothing is re-alerted.

### 8. Register the Telegram webhook

```bash
npm run telegram:set-webhook
```

Reads `APP_URL`, registers the webhook with its secret, and installs the command
menu. It refuses a non-HTTPS URL, because Telegram will not deliver to one.

Then message your bot `/help`. If it replies, the webhook works.

### 9. Verify the deployment can read the feeds

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://YOUR-APP.vercel.app/api/admin/check-sources | jq
```

> **Why check from the deployment and not just locally.** A feed that works from
> your laptop can still block Vercel's IP ranges or be served differently by a
> CDN. The only way to know the deployed app can read a source is to ask the
> deployed app. Run this after every deploy.

Expect `"failed": 0`. The route returns **207** if any source failed, so a
monitor can alert on it.

### 10. Schedule the poll

Vercel Hobby crons run **once per day only** — sub-daily expressions fail at
deploy time. So the one-minute poll comes from outside.

1. Sign up at [cron-job.org](https://cron-job.org) (free).
2. Create a job:
   - **URL**: `https://YOUR-APP.vercel.app/api/cron/poll`
   - **Schedule**: every minute
   - **Header**: `Authorization: Bearer YOUR_CRON_SECRET`
   - **Notifications**: enable failure emails
   - **Timeout**: 30s is fine — the route answers in ~10ms

> **Turn the failure emails on.** If cycles stop entirely, the bot cannot tell
> you, because the bot is what stopped. cron-job.org emailing you is the backstop.

The daily summary is already registered in `vercel.json` and needs no setup.

### 11. Confirm it is running

Message the bot `/status`. After 30 minutes you should see regular cycles and a
usage projection well inside every limit.

---

## Bot commands

| Command | What it shows |
|---|---|
| `/status` | Last cycle, source health, AI usage, projected Vercel usage |
| `/last` | The last 5 alerts |
| `/stats` | Published→alerted latency, p50 and p95 over 7 days |
| `/sources` | Every feed and when it last succeeded |
| `/pause` | Stop alerting (cycles keep deduping) |
| `/resume` | Start alerting again |
| `/test` | Send a sample alert |
| `/help` | All commands |

`/help` and `/test` work even when the database is down, because those are the
commands you reach for when something is already broken.

---

## Local development

```bash
cp .env.example .env.local   # then fill it in
npm install
npm run db:init

npm run dev                  # http://localhost:3000
npm run check-sources        # fetch every feed, print status and item age
npm run dry-run              # full cycle, prints what WOULD alert, sends nothing
npm run test                 # everything, including one live Gemini call
npm run test:fast            # skips the live AI test (saves quota)
npm run lint
npm run build
```

`npm run dry-run` is the honest end-to-end check. It fetches real feeds,
classifies with the real model, and renders alerts exactly as they would appear —
without sending anything or writing to the database.

If you are running these from a slow or distant connection, raise
`MONGODB_SERVER_SELECTION_TIMEOUT_MS` in `.env.local`. The 8s production default
assumes the function sits next to the cluster.

---

## Staying inside the free tiers

### Vercel Hobby

Three limits matter, and they are billed differently:

| Meter | Limit | What counts |
|---|---|---|
| Active CPU | 4 hours/month | Real processor time. Waiting on the network does **not** count. |
| Provisioned Memory | 360 GB-hours/month | Memory × **wall-clock** time, including every millisecond spent waiting. |
| Invocations | 1,000,000/month | 43,200 used by the poll route. |

Provisioned Memory is the binding constraint, because a cycle that waits 20
seconds on Gemini is billed for 20 seconds at 2GB.

`/status` and the daily summary both show the projection. A Telegram warning
fires automatically once either meter is projected past 70%, at most once a day.

**Reading your actual usage**: Vercel dashboard → your project → **Usage** tab.

**Reading the logs**: Vercel dashboard → **Logs**. Every line is JSON with an
`evt` field, so you can filter to one event type. Useful ones: `cycle.done`,
`cycle.source_failed`, `alert.sent`, `classifier.failed`.

**If usage runs high**, slow the schedule to every 90 seconds in cron-job.org.
That cuts all three meters by a third. Alert latency rises by about 30 seconds.

**If you upgrade to Pro**, you can drop cron-job.org and let Vercel run the poll.
Add this to `vercel.json` and remove the external job:

```json
{
  "crons": [
    { "path": "/api/cron/daily", "schedule": "0 13 * * *" },
    { "path": "/api/cron/poll",  "schedule": "* * * * *" }
  ]
}
```

Vercel Cron sends its own `Authorization: Bearer ${CRON_SECRET}` header, so the
route needs no changes.

> Vercel Hobby is for **personal, non-commercial use**. Running this for a
> business requires a Pro plan.

### Gemini free tier

Requests are counted per model per UTC day in Mongo. Above 80% of
`GEMINI_DAILY_LIMIT` the agent classifies every other cycle so more items batch
into each request. At the limit it switches to `GEMINI_FALLBACK_MODEL`, which has
its own separate free allowance. If both are exhausted, strongly-matching items
are sent as clearly labelled **⚠️ Unverified** alerts rather than being dropped.

### Atlas M0

512MB. TTL indexes reap seen items after 30 days, rejected candidates after 30
days, and Telegram update records after 1 day. Real usage is a few MB.

---

## Sources

19 feeds, all official RSS/Atom. No HTML scraping, no paywall circumvention.

**Newswires (60s)** — PR Newswire ×4 (fintech, M&A, venture capital, banking),
GlobeNewswire ×3 (M&A, fintech, financing agreements)

**Regulatory (60s)** — SEC EDGAR 8-K, SEC EDGAR Form D

**Trade press (180s)** — TechCrunch Fintech, Crunchbase News, Finextra, PYMNTS,
Crowdfund Insider, Banking Dive, Payments Dive, Tearsheet

**Canada (180s)** — BetaKit, Financial Post

### Sources that were researched and rejected

These are recorded in `REJECTED_SOURCES` in `src/config/sources.ts` so nobody
re-adds a dead feed in six months:

| Source | Why |
|---|---|
| Business Wire | All public RSS channels return a stub: *"The RSS channel you requested was deactivated by the administrator."* |
| Newsfile Corp | 404 on every documented path; others return a bot challenge with no feed body |
| Fintech Futures | 403 to any non-browser User-Agent. Reading it would mean spoofing a browser |
| FinSMEs | 403 to a descriptive User-Agent |
| ACCESSWIRE | 403 |
| PR Newswire Canada (CNW) | 404 on the RSS index and every list path |

Losing Business Wire is a genuine coverage gap for US fintech press releases.
GlobeNewswire and PR Newswire cover much of the same ground, but not all of it.

**A note on BetaKit**: its own `/category/fintech/feed/` and
`/category/funding/feed/` are both abandoned — newest items date from 2024. The
main feed is live, so we poll that and filter on each item's categories.

### SEC Form D

Form D entries carry only a company name — no amount, industry or location.
Sending all of them to the model would burn the daily quota producing
`region: unknown` for hundreds of filings. They are instead filtered by name:
fintech-sounding names pass, and the investment vehicles that dominate the form
(funds, SPVs, series LLCs) are vetoed. On a live sample, 0 of 40 Form D entries
warranted an AI call.

---

## Environment variables

Every variable is documented inline in [`.env.example`](.env.example).

Secrets never appear in logs. The Telegram token lives in the request URL, so the
API helper is written never to echo a failing URL — there is a test asserting
this.

---

## Project layout

```
src/
  config/
    sources.ts        every feed, with verified conditional-GET support
    keywords.ts       prefilter terms and SEC rules
  lib/
    feeds/            fetch (conditional GET), parse (RSS/Atom/SEC)
    dedupe/           URL and title normalization, seen-items store
    prefilter/        the cheap filter in front of the AI
    classifier/       Gemini provider, prompt, resilient JSON parsing
    alerter/          channel interface, Telegram DM, message formatting
    store/            Mongo client, schema, indexes, lock, candidates, deals
    budget/           CPU and wall metering, Hobby projection
    pipeline/         the cycle itself, health warnings
    telegram/         bot commands, daily summary
  app/
    api/cron/poll     one cycle per call
    api/cron/daily    daily digest
    api/telegram/     webhook
    api/admin/        source health from the deployment
    deals/            the dashboard
scripts/              db:init, check-sources, dry-run, set-webhook, reset-metrics
tests/                209 tests, fixtures with 10 ground-truth headlines
```

The core is plain TypeScript under `src/lib/` with no Next.js imports, so it runs
identically from a route or a local script.

---

## Troubleshooting

**No alerts at all.** Check `/status`. If "Last cycle" is minutes old, the
scheduler has stopped — check cron-job.org. If cycles are running but sources are
unhealthy, run the admin check-sources endpoint.

**"That command failed."** The database was unreachable. Check Atlas is running
and that Network Access still allows `0.0.0.0/0`.

**Alerts stopped but cycles are running.** You may have `/pause`d. `/status` says
so explicitly. Otherwise check AI usage — you may have hit the daily limit.

**A source shows as unhealthy.** Often temporary. If it persists, run
`npm run check-sources` locally: if it works there but not from Vercel, the site
is blocking Vercel's IPs, and the source should be disabled in
`src/config/sources.ts`.

**Duplicate alerts.** Should be impossible — a unique index makes double-sending
structurally unavailable. If it happens, the same deal was reported under two
different company spellings. Check `dealKey` normalization in
`src/lib/dedupe/normalize.ts`.

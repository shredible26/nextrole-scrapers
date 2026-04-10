# NextRole — Project Spec & State (as of April 10, 2026)

## SECTION 1: Overview

- **Product name:** NextRole
- **Live URL:** https://nextrole-phi.vercel.app
- **Purpose:** Job aggregator for new grad and entry-level tech roles
- **Target users:** CS/DS students graduating 2025-2026 and recent grads with 0-2 YOE
- **Stack (exact package versions from `package.json`):** `next@16.2.2`, `react@19.2.4`, `react-dom@19.2.4`, `typescript@^5`, `@supabase/supabase-js@^2.101.1`, `@supabase/ssr@^0.10.0`, `stripe@^22.0.0`, `@stripe/stripe-js@^9.0.1`, `tailwindcss@^4`, `@tailwindcss/postcss@^4`, `@tailwindcss/typography@^0.5.19`, `tsx@^4.21.0`, `dotenv-cli@^11.0.0`, `sanitize-html@^2.17.2`, `date-fns@^4.1.0`, `sonner@^2.0.7`, `playwright@^1.59.1`, `crawlee@^3.16.0`
- **Repo structure:**
  - `nextrole` (public) — frontend/app repo. In practice, this checkout also still contains `scrapers/` and scrape scripts, so the split is not fully reflected in the public codebase yet.
  - `nextrole-scrapers` (private) — scrapers + cron. Operational details are documented below for reference, but there are currently no `.github/workflows/` files in this repo.

---

## SECTION 2: Architecture

### Frontend
- Next.js `16.2.2` App Router app rooted under `app/`
- Global shell in `app/layout.tsx`; Tailwind v4 styles live in `app/globals.css`
- Request interception is handled by root-level `proxy.ts` (not `middleware.ts`)
- Key user-facing routes:
  - `/` — landing page
  - `/jobs` — main authenticated feed shell
  - `/jobs/[id]` — public job detail page
  - `/pricing` — plan selection and billing portal
  - `/profile` — profile, resume, plan info
  - `/tracker` — application tracker
  - `/settings` — placeholder page
  - `/auth/callback` — OAuth code-exchange route
- SEO/metadata routes also exist: `app/sitemap.ts`, `app/jobs/sitemap.ts`, `app/robots.ts`

### Backend
- Supabase for PostgreSQL, Auth, RLS, and Storage
- Browser/server Supabase clients live in `lib/supabase/client.ts` and `lib/supabase/server.ts`
- Service-role Supabase clients are used in:
  - `app/auth/callback/route.ts`
  - `app/api/auth/webhook/route.ts`
  - Stripe routes
  - public job detail page (`app/jobs/[id]/page.tsx`)
  - sitemap generation (`lib/sitemap/jobs.ts`)
  - scraper upload/cleanup utilities under `scrapers/`
- Resume files are stored in a private `resumes` Storage bucket with per-user policies

### Auth
- Google OAuth only
- Client login starts from `components/Navbar.tsx` via `supabase.auth.signInWithOAuth({ provider: 'google' })`
- Server-side callback route exists at `app/auth/callback/route.ts` and calls `exchangeCodeForSession(code)`
- Profile creation/upsert is handled in the auth callback with a service-role client, and the callback only seeds `display_name` when the profile does not already have one
- `proxy.ts` protects `/tracker` and `/settings`; `/profile` redirects on the server when unauthenticated
- `/jobs` itself is not proxy-protected, but `/api/jobs` requires an authenticated user, so the feed is effectively auth-gated

### Payments
- Stripe subscription billing with two plans:
  - Monthly: `$4.99`
  - Yearly: `$50`
- The code is environment-driven; whether production is using live or test mode depends on the deployed `STRIPE_*` keys rather than hardcoded app logic
- Checkout is created in `app/api/stripe/checkout/route.ts`
- Subscription state is synchronized in `app/api/stripe/webhook/route.ts`
- Existing subscribers can open the Stripe billing portal from `app/api/stripe/portal/route.ts`

### Scraping
- Product docs assume a separate private scraper repo, but this public repo still contains a working `scrapers/` tree and `pnpm scrape` / `pnpm cleanup` scripts
- Current orchestrator behavior in `scrapers/index.ts`:
  - imports all scraper modules directly
  - runs them with `Promise.allSettled(...)`
  - dedupes GitHub curated sources by normalized URL
  - uploads into Supabase
  - deactivates stale jobs per source after upload

### Deployment
- Vercel deployment; the repo is set up for auto-deploy on push to `main`
- `@vercel/analytics` is mounted in `app/layout.tsx`
- `next.config.ts` sets `turbopack.root = __dirname` and allows remote images from `logo.clearbit.com` and `lh3.googleusercontent.com`

---

## SECTION 3: Database Schema

No additional relational app tables beyond `profiles`, `jobs`, and `applications` exist in `supabase/migrations/`. There is no `job_scores` table in this repo. Migration `005_resume_storage.sql` adds a private `resumes` Storage bucket and storage policies rather than a new SQL table.

### `profiles`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | Primary key; references `auth.users(id)` with `ON DELETE CASCADE` |
| `email` | `text` | Nullable |
| `full_name` | `text` | Legacy profile field; still inserted by legacy auth webhook |
| `avatar_url` | `text` | Legacy profile field |
| `tier` | `text` | `NOT NULL`, default `'free'`, check constraint to `'free'` or `'pro'` |
| `stripe_customer_id` | `text` | Nullable; unique index when non-null |
| `stripe_subscription_id` | `text` | Nullable |
| `resume_url` | `text` | Legacy field; current resume UX uses Supabase Storage directly |
| `jobs_viewed_today` | `int` | `NOT NULL`, default `0`; currently unused by app logic |
| `last_reset_date` | `date` | `NOT NULL`, default `CURRENT_DATE`; currently unused by app logic |
| `created_at` | `timestamptz` | Default `now()` |
| `subscription_status` | `text` | Added in `002_stripe_fields.sql`; default `'inactive'`; no DB-level enum/check |
| `cancel_at_period_end` | `boolean` | Added in `002_stripe_fields.sql`; default `false` |
| `display_name` | `text` | Added in `004_profile_display_name.sql`; used by `/profile` and the callback upsert logic |

### `jobs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | Primary key; default `gen_random_uuid()` |
| `source` | `text` | `NOT NULL` |
| `source_id` | `text` | Nullable source-native identifier |
| `title` | `text` | `NOT NULL` |
| `company` | `text` | `NOT NULL` |
| `location` | `text` | Nullable |
| `remote` | `boolean` | Default `false` |
| `url` | `text` | `NOT NULL` |
| `description` | `text` | Nullable |
| `salary_min` | `int` | Nullable |
| `salary_max` | `int` | Nullable |
| `experience_level` | `text` | Check constraint to `'new_grad'`, `'entry_level'`, or `'internship'` |
| `roles` | `text[]` | Role tags |
| `posted_at` | `timestamptz` | Nullable |
| `scraped_at` | `timestamptz` | Default `now()` |
| `is_active` | `boolean` | Default `true` |
| `dedup_hash` | `text` | `NOT NULL`, unique |
| `fts` | `tsvector` | Added in `002_add_fts.sql`; generated stored column over `title`, `company`, and `description` |

**Important notes:**
- There is **no** `created_at` column on `jobs`
- There is **no** `updated_at` column on `jobs`
- Full-text search is backed by `fts` plus the `search_jobs_ranked(search_query text, is_active_filter boolean default true)` SQL function in `003_search_rank_fn.sql`
- The current FTS implementation is **unweighted**; it uses a single generated `to_tsvector(...)`, not `setweight(...)`

### `applications`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | Primary key; default `gen_random_uuid()` |
| `user_id` | `uuid` | `NOT NULL`; references `profiles(id)` with `ON DELETE CASCADE` |
| `job_id` | `uuid` | `NOT NULL`; references `jobs(id)` with `ON DELETE CASCADE` |
| `status` | `text` | `NOT NULL`, default `'applied'`; check constraint to `applied`, `phone_screen`, `oa`, `interview`, `offer`, `rejected`, `withdrawn` |
| `applied_at` | `timestamptz` | Default `now()` |
| `notes` | `text` | Nullable |
| `auto_tracked` | `boolean` | Default `true` |
| `updated_at` | `timestamptz` | Default `now()` |

**Constraint:** `UNIQUE(user_id, job_id)`

### RLS and storage policies

- `jobs`: RLS enabled, but a public `SELECT` policy allows reads by anyone
- `profiles`: users can `SELECT` and `UPDATE` only their own row
- `applications`: users can `SELECT`/`INSERT`/`UPDATE`/`DELETE` only their own rows
- `storage.objects` for bucket `resumes`: authenticated users can upload, read, update, and delete only files under `<auth.uid()>/...`

### Auth-related DB objects

- `001_initial_schema.sql` still creates a `handle_new_user()` trigger on `auth.users`
- Current app code **also** upserts profiles in `app/auth/callback/route.ts`
- There is therefore more than one profile-creation path present in the repo

---

## SECTION 4: API Routes

| Method | Path | Auth requirement | What it does | Key implementation notes |
|--------|------|------------------|--------------|--------------------------|
| `POST` | `/api/apply` | Supabase user session | Auto-tracks a job by upserting into `applications` | Sets `status='applied'`, `auto_tracked=true`, `applied_at=now`; uses `onConflict: 'user_id,job_id'` and ignores duplicates |
| `PATCH` | `/api/applications/[id]` | Supabase user session | Updates one tracked application | Partial update of `status` and/or `notes`; always sets `updated_at`; scoped by both `id` and `user_id` |
| `DELETE` | `/api/applications/[id]` | Supabase user session | Deletes one tracked application | Returns `404` when no row matched the current user |
| `POST` | `/api/auth/webhook` | Bearer secret via `SUPABASE_WEBHOOK_SECRET` | Legacy auth webhook that inserts a `profiles` row when an auth user is created | Expects payload `{ type: 'INSERT', table: 'users', record: ... }`; inserts `id`, `email`, `full_name`, `avatar_url`; appears to be legacy/redundant with the auth callback |
| `GET` | `/api/jobs` | Supabase user session | Returns filtered jobs for the feed | Reads `profiles.tier`; creates a profile row if missing; supports `roles`, `search`, `level`, `remote`, `source`, `postedWithin`, `location`, `page`; free users get `402` with `{ upgrade: true }` when requesting `page > 1` |
| `PATCH` | `/api/profile/display-name` | Supabase user session | Updates `profiles.display_name` | Validates JSON, trims input, enforces 1-50 chars, rejects HTML tags; special-cases missing migration errors |
| `POST` | `/api/stripe/checkout` | Supabase user session | Creates a Stripe Checkout Session for `monthly` or `yearly` | Uses service-role profile lookup for existing `stripe_customer_id`; success URL is `/jobs?upgraded=true`; adds `user_id` to checkout and subscription metadata |
| `POST` | `/api/stripe/portal` | Supabase user session | Opens the Stripe billing portal | Requires an existing `stripe_customer_id`; return URL is `/pricing` |
| `POST` | `/api/stripe/webhook` | Stripe-signed request, not end-user auth | Syncs Stripe subscription events back into `profiles` | Must read the raw body with `req.text()` and verify `stripe-signature`; handles `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted` |
| `POST` | `/api/upload-resume` | None in current stub | Placeholder resume-upload route | Currently always returns `501`; the real resume flow uploads directly from `ProfileClient` to Supabase Storage |

### `/api/jobs` filter behavior

- Search path:
  - uses the `search_jobs_ranked` RPC when `search` is non-empty
  - applies role/remote/level/source/postedWithin/location filters in JS after the RPC result
  - sorts by `rank DESC`, then `posted_at DESC`
- Non-search path:
  - uses PostgREST filters directly on `jobs`
  - supports grouped GitHub repo filtering by expanding `github_repos` from `lib/source-groups.ts`
- USA filtering:
  - treats `remote=true`, null/empty locations, US state names, US state abbreviations, common US city names, `US, ...`, and Workday-style `"N Locations"` strings as US
  - explicitly excludes `Perth, WA` false positives
- Important monetization note:
  - the server enforces free-tier pagination limits
  - the server does **not** currently reject free-tier search requests directly; the Pro search gate lives in the UI

---

## SECTION 5: Frontend Pages & Components

### Pages

- `/` — marketing landing page with beta copy, product stats, source badges, and CTAs into `/jobs` and `/pricing`
- `/jobs` — main feed entry point; renders `UpgradedBanner` and `JobFeed`
- `/jobs/[id]` — public job detail page with sanitized rich description, Open Graph/canonical metadata, and JobPosting JSON-LD
- `/pricing` — free vs Pro pricing cards, Stripe checkout buttons, and billing-portal entry for current Pro users
- `/profile` — authenticated profile page with display-name editing, resume upload/delete, plan badge, subscription status, and application count
- `/tracker` — authenticated application tracker with table and kanban views
- `/settings` — placeholder page for future settings/preferences
- `/auth/callback` — route handler that exchanges an OAuth code for a session and upserts `profiles`

### Key components

- `Navbar` — sticky top navigation with `Jobs`, `Tracker`, `Pricing`, Google sign-in, Google avatar dropdown, and a Pro badge
- `JobFeed` — client-side feed container; fetches `/api/jobs`, debounces search by `300ms`, manages pagination, owns the upgrade modal, and syncs tracked IDs between Supabase and `localStorage`
- `FilterSidebar` — single-select source filter plus role chips, experience level, remote, location, and posted-within filters
- `JobCard` — per-job card with Clearbit logo lookup, role chips, salary snippet, source label, `Apply ↗`, and `Track`
- `ApplicationTracker` — application CRUD UI with default table view, kanban toggle, inline notes, slide-over detail editor, filters, and delete/remove actions
- `ProfileClient` — profile-side client logic for display name, plan display, resume Storage operations, and stats
- `PricingClient` — pricing UI, checkout initiation, billing portal launch, and upgraded toast handling
- `UpgradeModal` — monetization modal shown when free users hit the pagination/search gate
- `UpgradedBanner` — toast-once handler for `/jobs?upgraded=true`

### Pro-only UI in the current code

- Search input in `JobFeed` is locked for free users and opens `UpgradeModal`
- Pagination beyond page 1 is Pro-only because `/api/jobs` returns `402` with `upgrade: true` for free users requesting deeper pages
- A green `Pro` badge appears in the navbar/profile/pricing views when `profiles.tier = 'pro'`

---

## SECTION 6: Free vs Pro

### Free tier (actual implementation)

- `20` jobs per page from `/api/jobs`
- page 1 only; requesting page 2+ triggers the upgrade flow
- all current sidebar filters are visible, including:
  - role
  - experience level
  - remote-only
  - location (`USA` / `Other`)
  - posted within
  - source
- application tracking is included
- profile page and resume upload/delete are included
- public job detail pages are included
- search is locked in the UI, but the backend route does not currently hard-block free-tier search requests

### Pro tier (actual implementation)

- `50` jobs per page from `/api/jobs`
- pagination beyond page 1
- unlocked search UI in `JobFeed`
- Pro badge in the navbar/profile/pricing UI
- billing portal access from `/pricing`

### Price

- Monthly: `$4.99`
- Yearly: `$50`

### How tier is checked

- Server-side: `/api/jobs` reads `profiles.tier`
- Client-side display logic also checks `profiles.tier` in:
  - `components/JobFeed.tsx`
  - `components/Navbar.tsx`
  - `components/PricingClient.tsx`
  - `components/ProfileClient.tsx`

### Upgrade flow

1. `UpgradeModal` or `PricingClient` calls `POST /api/stripe/checkout` with `{ plan: 'monthly' | 'yearly' }`
2. Stripe Checkout redirects back to `/jobs?upgraded=true`
3. `POST /api/stripe/webhook` receives the Stripe event and updates `profiles`:
   - `tier`
   - `stripe_customer_id`
   - `stripe_subscription_id`
   - `subscription_status`
   - `cancel_at_period_end`
4. Subscription update/delete events can downgrade the user back to `free`

### Important monetization discrepancies in the current code

- DB columns `jobs_viewed_today` and `last_reset_date` still exist, but the current app no longer reads or writes them
- Upgrade modal and pricing copy still say "20 jobs per day", but the implemented gate is actually "page 1 only / 20 jobs per page"
- Pricing copy claims Pro gets "All filters + source filter", but the source filter is currently visible to all users
- Pricing/upgrade UI advertises AI match scoring, email alerts, CSV export, and priority support as coming soon; none of those features are implemented in code today

---

## SECTION 7: Active Job Sources

Counts below are the most recent known scrape totals provided for April 2026. The repo itself does not store per-run scrape metrics, so these numbers are operational reference rather than values computed from this checkout.

| Source | File | Method | ~Jobs |
|--------|------|--------|-------|
| `pittcsc` | `pittcsc.ts` | Raw GitHub JSON (`SimplifyJobs/New-Grad-Positions`) | 14,918 |
| `simplify_internships` | `simplify-internships.ts` | Raw GitHub JSON (`SimplifyJobs/Summer2026-Internships`) | 18,908 |
| `vanshb03_newgrad` | `vanshb03-newgrad.ts` | Raw GitHub JSON (`vanshb03/New-Grad-2026`) | 527 |
| `vanshb03_internships` | `vanshb03-internships.ts` | Raw GitHub JSON (`vanshb03/Summer2026-Internships`) | 871 |
| `ambicuity` | `ambicuity.ts` | GitHub curated list parsing (markdown/JSON) | 1,019 |
| `speedyapply_ai_newgrad` | `speedyapply-ai-newgrad.ts` | GitHub curated markdown (`speedyapply/2026-AI-College-Jobs`) | 33 |
| `speedyapply_swe_newgrad` | `speedyapply-swe-newgrad.ts` | GitHub curated markdown (`speedyapply/2026-SWE-College-Jobs`) | 243 |
| `jobright_swe` | `jobright-swe.ts` | GitHub curated markdown (`jobright-ai/2026-Software-Engineer-New-Grad`) | 748 |
| `jobright_data` | `jobright-data.ts` | GitHub curated markdown (`jobright-ai/2026-Data-Analysis-New-Grad`) | 287 |
| `zapplyjobs` | `zapplyjobs.ts` | GitHub curated markdown | 1,093 |
| `hackernews` | `hackernews.ts` | Hacker News Firebase API + thread/comment parsing | 370 |
| `adzuna` | `adzuna.ts` | Adzuna official jobs API | 1,129 |
| `remoteok` | `remoteok.ts` | RemoteOK public API | 43 |
| `arbeitnow` | `arbeitnow.ts` | Arbeitnow public job board API | 285 |
| `themuse` | `themuse.ts` | The Muse public jobs API | 10 |
| `jobspy` | `jobspy.ts` | `ts-jobspy` (currently Indeed-only; stored source values become `jobspy_indeed`) | 496 |
| `greenhouse` | `greenhouse.ts` | Greenhouse Boards API | 4,730 |
| `lever` | `lever.ts` | Lever public postings API | 1,372 |
| `workday` | `workday.ts` | Workday public `wday/cxs/.../jobs` POST endpoints | 3,341 |
| `workable` | `workable.ts` | Workable global search API `jobs.workable.com/api/v1/jobs` | 10 |
| `smartrecruiters` | `smartrecruiters.ts` | SmartRecruiters public postings APIs | 157 |
| `workatastartup` | `workatastartup.ts` | Work at a Startup site + Algolia-backed search | 37 |
| `builtin` | `builtin.ts` | Built In jobs API with HTML fallback logic | 503 |
| `dice` | `dice.ts` | Dice API / web endpoint scraping | 2,394 |
| `simplyhired` | `simplyhired.ts` | HTML/JSON-LD parsing with Playwright fallback | 99 |
| `ashby` | `ashby.ts` | Ashby posting API | 3,954 |
| `usajobs` | `usajobs.ts` | USAJobs official API | 210 |

Other scrapers are also wired into `scrapers/index.ts` (`speedyapply_swe`, `speedyapply_ai`, `ziprecruiter`, `glassdoor`, `careerjet`, `wellfound`, `handshake`, `bamboohr`, `rippling`, `dice_rss`), but the current spec does not have reliable April 2026 counts for them and several are called out as fragile or effectively stubbed in the TODO/discrepancy notes.

---

## SECTION 8: Scraper Architecture (for `nextrole-scrapers`)

This section is included as operational reference. In this checkout, scraper code still lives under `scrapers/`, but the intended architecture is a separate private repo.

- **Runtime:** `tsx` + `dotenv-cli`
  - `package.json` scripts:
    - `pnpm scrape` -> `dotenv -e .env.local -- tsx scrapers/index.ts`
    - `pnpm cleanup` -> `dotenv -e .env.local -- tsx scrapers/cleanup-senior-roles.ts`
- **Deduplication:** `dedup_hash` is `md5(lowercase(company) + '|' + lowercase(title) + '|' + lowercase(location))` from `scrapers/utils/dedup.ts`
- **Pipeline:** current `scrapers/index.ts` runs all imported scrapers with `Promise.allSettled(...)`
- **Priority scrapers first:** **not implemented in this checkout**
  - the TODO explicitly proposes running heavy sources like `lever`, `workday`, and `workable` sequentially before the concurrent batch
  - current orchestrator still launches every scraper together
- **Stale job deactivation:** `deactivateStaleJobs(sourceName, activeDedupHashes)` runs after upload for every source except orchestrator-level `jobspy`
- **Caching:**
  - `scrapers/cache/ashby-valid-slugs.json`
  - `scrapers/cache/workday-dead.json`
- **GitHub Actions cron:** not present in this repo (`.github/workflows/` is empty), but the intended/private scraper ops are documented as a daily `7:00 AM UTC` cron with a `120 minute` timeout
- **Local cron:** also not present in this repo; the TODO recommends `caffeinate -i pnpm scrape` for Cloudflare-blocked sources
- **Upload behavior:** `scrapers/utils/upload.ts` upserts in chunks of `100` and deactivates stale IDs in chunks of `500`
- **Curated GitHub repo dedupe:** after fetching, GitHub repo sources are additionally deduped against earlier curated sources by normalized URL

---

## SECTION 9: Key Engineering Gotchas

- `proxy.ts` is the correct Next.js 16 file convention; `middleware.ts` is deprecated. This is also confirmed by the shipped Next.js docs under `node_modules/next/dist/docs/.../proxy.md`.
- Tailwind is v4-style in this repo: configuration is driven from `app/globals.css` with `@plugin "@tailwindcss/typography"`. There is no `tailwind.config.ts`.
- `/jobs` is not proxy-protected, but `/api/jobs` requires a user session. The page shell can render for anonymous users while the data API still returns `401`.
- Profile creation is not cleanly single-path in this repo:
  - DB trigger `handle_new_user()` still exists in migrations
  - `app/auth/callback/route.ts` also upserts profiles
  - `/api/jobs` has a fallback insert when no profile row exists
  - `app/api/auth/webhook/route.ts` is another legacy insert path
- Google OAuth is the only auth provider; external Google test-user / consent-screen setup is not represented in code but is still an operational requirement.
- `components/Navbar.tsx` currently starts OAuth with `redirectTo: ${window.location.origin}/jobs`, while the repo also has a dedicated `/auth/callback` route. The exact callback behavior therefore depends on external Supabase/OAuth configuration and is not fully obvious from code alone.
- Stripe webhook verification must use `req.text()` with the raw body. Using `req.json()` would break signature verification.
- Current monetization enforcement is page-based, not daily-counter-based:
  - free users get `20` jobs per page
  - Pro users get `50`
  - free users are blocked only on `page > 1`
  - stale UI copy still says "20 jobs per day"
- Search is Pro-only in the UI but not fully enforced server-side. Free users cannot use the search input in `JobFeed`, but `/api/jobs?search=...` does not currently reject them based on tier.
- Source filtering is currently available to all users even though pricing copy presents it as a Pro feature.
- `/jobs/[id]` uses `sanitize-html` before rendering descriptions and relies on Tailwind Typography prose classes. Descriptions are truncated to `5,000` characters on the detail page.
- Current full-text search uses the generated `jobs.fts` column plus the `search_jobs_ranked()` RPC, but it is not a weighted `setweight(...)` index. The older weighted-FTS description from previous specs is stale.
- USA filtering in `/api/jobs` is heuristic-heavy:
  - remote jobs and null/empty locations are treated as US-safe
  - state names, state abbreviations, and many city names are regex-matched
  - Workday-specific forms like `"3 Locations"` and `US, City` are treated as US
  - `Perth, WA` is explicitly excluded to avoid false positives for Washington
- Workday-specific scraper behavior:
  - tries multiple subdomain versions (`wd1`-`wd8`, `wd10`, `wd12`, `wd100`)
  - tries multiple slug variations per company/career site
  - prefers `externalUrl` / `jobPostingUrl`, otherwise builds from `externalPath`
  - strips `/en-US/` from `externalPath` if present before constructing the public URL
- Workday dead-cache handling in this checkout is still coarse:
  - companies are cached in `workday-dead.json`
  - a company can be marked "dead" after a successful raw response that later filters down to zero kept jobs
  - the safer "only mark dead on zero raw postings" behavior is **not** fully implemented here
- Workable uses the global endpoint `https://jobs.workable.com/api/v1/jobs`, not the per-company account API.
- SimplyHired detects `403` / Cloudflare challenge pages and falls back to Playwright. The repo TODO references a local `caffeinate` cron for this, but no such automation exists in this checkout.
- `jobspy` is special-cased in the orchestrator because it emits per-site source names like `jobspy_indeed`; stale cleanup is skipped for the top-level `jobspy` orchestrator name.
- `app/api/upload-resume` is still a `501` stub, but the real resume UX is already implemented client-side in `ProfileClient` via direct Supabase Storage operations.
- `.github/workflows/` is empty in this repo. Any cron automation described in historical docs or TODO items refers to external/private scraper ops, not the files currently checked into `nextrole`.

---

## SECTION 10: Environment Variables

### App repo env vars actually read by this codebase

| Env var | Required | Used in | Notes |
|--------|----------|---------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | `lib/supabase/client.ts`, `lib/supabase/server.ts`, `proxy.ts`, auth callback, Stripe routes | Browser/SSR Supabase URL; also used by some admin-client helpers |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | `lib/supabase/client.ts`, `lib/supabase/server.ts`, `proxy.ts`, auth callback | Browser/SSR anon key |
| `SUPABASE_URL` | Yes | auth callback, auth webhook, scraper upload/cleanup | Service-role base URL for admin operations |
| `SUPABASE_SERVICE_KEY` | Yes | auth callback, auth webhook, Stripe routes, public job detail page, sitemap routes, scraper upload/cleanup | Full admin access; bypasses RLS |
| `STRIPE_SECRET_KEY` | Yes for billing | `lib/stripe.ts` | Server-side Stripe client |
| `STRIPE_PRICE_MONTHLY` | Yes for billing | `lib/stripe.ts`, checkout route | Stripe Price ID for monthly plan |
| `STRIPE_PRICE_YEARLY` | Yes for billing | `lib/stripe.ts`, checkout route | Stripe Price ID for yearly plan |
| `STRIPE_WEBHOOK_SECRET` | Yes for billing | Stripe webhook route | Required for signature verification |
| `NEXT_PUBLIC_URL` | Yes for billing | checkout route, portal route | Success/cancel/return URLs |
| `SUPABASE_WEBHOOK_SECRET` | Only if using legacy auth webhook | `app/api/auth/webhook/route.ts` | Protects the legacy profile-creation webhook endpoint |

### Scraper env vars actually read by the scraper code present in this checkout

| Env var | Required | Used in | Notes |
|--------|----------|---------|-------|
| `SUPABASE_URL` | Yes | `scrapers/utils/upload.ts`, `scrapers/cleanup-senior-roles.ts` | Uploads jobs and runs cleanup |
| `SUPABASE_SERVICE_KEY` | Yes | `scrapers/utils/upload.ts`, `scrapers/cleanup-senior-roles.ts` | Service-role access for scraper writes |
| `ADZUNA_APP_ID` | Required for Adzuna | `scrapers/sources/adzuna.ts` | Skips Adzuna scraper if missing |
| `ADZUNA_APP_KEY` | Required for Adzuna | `scrapers/sources/adzuna.ts` | Skips Adzuna scraper if missing |
| `MUSE_API_KEY` | Optional | `scrapers/sources/themuse.ts` | Raises rate limits; scraper still runs without it |
| `USAJOBS_API_KEY` | Optional/recommended | `scrapers/sources/usajobs.ts` | Used when available; scraper has a fallback header set |
| `USAJOBS_EMAIL` | Optional/recommended | `scrapers/sources/usajobs.ts` | Used as `User-Agent` when key mode is enabled |
| `CAREERJET_API_KEY` | Required for Careerjet | `scrapers/sources/careerjet.ts` | Careerjet scraper exits early if missing |
| `CAREERJET_USER_IP` | Optional | `scrapers/sources/careerjet.ts` | Defaults to `127.0.0.1` |
| `CAREERJET_USER_AGENT` | Optional | `scrapers/sources/careerjet.ts` | Default provided in code |
| `PROXY_SERVER` | Optional | `scrapers/base.ts`, `scrapers/sources/wellfound.ts` | Proxy support for browser-based scraping |
| `PROXY_USER` | Optional | `scrapers/base.ts` | Proxy username |
| `PROXY_PASS` | Optional | `scrapers/base.ts` | Proxy password |

### Older env vars mentioned in previous docs but not currently read by code

- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is **not referenced anywhere** in the current repo

---

## SECTION 11: UI Features (current state)

- **`/jobs`**
  - split-screen layout on desktop with independent sidebar/feed scroll
  - filters for role, experience, remote, location, posted-within, and source
  - search box with `300ms` debounce
  - `Load more` pagination button
  - upgrade modal when a free user hits the search gate or requests page 2+
- **`/tracker`**
  - default table view plus kanban toggle
  - status editing, inline notes, slide-over detail editor
  - client-side filters for role, status, and applied date
  - remove/delete action per tracked application
- **`/pricing`**
  - monthly/yearly Stripe checkout buttons
  - billing portal button for current Pro users
  - "coming soon" marketing copy for AI match scoring, email alerts, CSV export, and priority support
- **`/profile`**
  - display-name edit
  - resume upload/replace/delete to Supabase Storage
  - application count card
  - current plan and subscription-status display
- **Navbar**
  - Pro badge when `tier = 'pro'`
  - Google avatar and dropdown
  - links to `Jobs`, `Tracker`, `Pricing`, `Profile`, `Settings`
- **Search**
  - Pro-only in the current UI
  - debounced `300ms`
  - backed by `/api/jobs?search=...` -> `search_jobs_ranked(...)`
  - current DB search is unweighted generated FTS, not weighted `A/B/D` ranking
- **Location filter**
  - two options: `USA` (default) and `Other`
  - server-side classification uses regex/state/city heuristics plus Workday-specific cases
- **Role chips**
  - `All`, `SWE`, `DS`, `ML`, `AI`, `Analyst`, `PM`
- **Experience filter**
  - `All`, `New Grad`, `Entry Level`, `Internship`
- **Source filter**
  - single-select radio filter
  - `GitHub Repos` grouped option expands through `lib/source-groups.ts`
  - individual sources are also listed explicitly
  - currently visible to free users too
- **Job detail pages**
  - public pages with sanitized HTML descriptions, metadata, and JSON-LD

---

## NextRole — Master TODO (April 2026)

---

### PRIORITY 1: SCRAPER STABILITY

1. Fix lever/workday/workable concurrent timeout — run heavy
   scrapers in a prioritized early sequential batch before the
   other 34 scrapers start competing for resources. Lever needs
   200s+, Workday needs 300s+, currently getting starved.
2. Remove dead scrapers: speedyapply-swe.ts, speedyapply-ai.ts
   (always 0 jobs, confirmed stubs)
3. Fix careerjet (0 jobs every run — check if API key expired
   or endpoint changed)
4. Remove rippling (2 jobs, fragile Next.js build ID approach,
   not worth maintaining)
5. Set up local caffeinate cron for CF-blocked scrapers
   (simplyhired, workable) that fail in GitHub Actions:
   `caffeinate -i pnpm scrape` at 7AM daily via crontab

---

### PRIORITY 2: NEW SOURCES & SOURCE EXPANSION

6. Fix Workable — currently 10 jobs. 429 rate limiting on
   entry-level search terms. Add exponential backoff + retry,
   run failed terms again after delay.
7. Expand Ashby slug list (currently 255 valid slugs, target
   400+ via Common Crawl + additional GitHub repos)
8. Expand Lever company list (currently ~115 slugs)
9. Expand Workday company list — currently 26/365 companies
   returning jobs. Verify wdVersions for remaining 339.
10. Add Recruitee source:
    GET https://{company}.recruitee.com/api/offers/
    No auth required. Large list of companies available.
11. Add TeamTailor source:
    GET https://api.teamtailor.com/v1/jobs
    No auth, large ATS used by European + US startups.
12. Add Personio source (XML feed, European ATS with US roles)
13. Add iCIMS source (large enterprise ATS, no public API —
    research correct endpoint via Codex)
14. Add rabiuk/job-scraper GitHub repo as source
15. Add bttf/internio GitHub repo as source
16. Add SpeedyApply 2026-SWE-College-Jobs and
    2026-AI-College-Jobs repos (distinct from current ones)
17. Expand HackerNews — add more monthly "Who is Hiring"
    thread IDs (currently only 2-3 threads)
18. Expand SmartRecruiters company list (currently 157 jobs,
    target 500+ — most new entries return totalFound: 0,
    need better slug discovery)
19. Research additional sources via Perplexity:
    - Cavuno's 2026 ATS roundup (Greenhouse, Lever, Ashby,
      Workable, Recruitee, Personio endpoints)
    - Fantastic Jobs ATS article (endpoint validation)
    - No-auth API directory (adjacent endpoints)
    - Any new GitHub curated new grad lists (target 5-6 more)
20. Try Monster with Playwright + stealth plugins to bypass
    Cloudflare (research feasibility first)
21. LinkedIn Jobs (low priority — API approval required,
    significant engineering lift, may not be worth it.
    Re-evaluate after other sources are maxed out.)

---

### PRIORITY 3: FILTERING LOGIC

22. Per-source keyword tuning — audit each source's role
    classification accuracy. Ensure SWE/DS/ML/AI chips
    return correct results per source.
23. Role classification improvements — expand inferRoles()
    keyword lists, add more title patterns for each role.
24. Add more role filters beyond current 7 chips:
    - DevOps / Infrastructure
    - Security
    - Mobile (iOS/Android)
    - QA / Testing
    - Embedded / Hardware
25. Add more experience level filter options:
    - Co-op (separate from internship)
    - Recent Grad (0-2 YOE, distinct from new_grad)
26. International/non-tech filter tightening — reduce false
    positives slipping through (non-tech roles, non-Latin
    character titles, etc.)
27. Location filter expansion — add more granular options
    beyond USA/Other (e.g., by state, by city cluster like
    SF Bay Area, NYC, Seattle, Austin)

---

### PRIORITY 4: UI & DESIGN

28. Home page full rewrite:
    - New headline + subheadline (largest new grad/entry-level
      tech job aggregator, all company types including startups)
    - Advertise job count (55k+), source count (25+), daily
      updates
    - Feature highlights: search, filters, tracker, pro scoring
    - Add social proof when available (users, applications
      tracked, etc.)
29. Pricing page text rewrite — clarify free vs pro tiers,
    update feature list, mark coming-soon features clearly
30. Full site color scheme overhaul — dark mode improvements,
    more vibrant and modern palette, consistent across all pages
31. Filter sidebar UI redesign — better visual hierarchy,
    cleaner styling, mobile-friendly
32. Job tracker UI redesign — better colors, table/kanban
    toggle, status column styling
33. Job card design improvements — salary display, company
    logo quality, role chip styling
34. Mobile responsiveness full audit — test /jobs, /tracker,
    /pricing, /profile on iPhone and Android screen sizes.
    Fix all broken layouts.
35. Navbar: add Profile link (done), verify all links work
    on mobile (hamburger menu if needed)

---

### PRIORITY 5: FEATURE COMPLETENESS

36. Job view limit for free users — free users see page 1
    only (20 jobs per page, already implemented). Confirm
    this works correctly end-to-end including upgrade modal.
37. Job tracker limit — cap at 100 tracked jobs for free
    users, unlimited for pro. Show "Upgrade to track more"
    when limit hit.
38. Similar jobs on job detail page — show 5 similar jobs
    by title/role using existing FTS + pgvector when ready.
    For now use textSearch similarity.
39. Job alerts via email (Resend):
    - User sets filter preferences (role, experience level,
      remote, location) — store in profiles table
    - Daily or weekly digest email: "X new jobs matching
      your preferences"
    - Unsubscribe link in every email
    - Resend free tier: 3,000 emails/month
40. Contact / feedback page — simple /contact form, submits
    via Resend to your email. Helps with user trust.
41. Rate limiting on API routes:
    - /api/stripe/webhook (already uses raw body verification)
    - /api/jobs (add per-user rate limit: 100 req/min)
    - /api/profile/display-name (add per-user rate limit)
    Use Upstash Redis + @upstash/ratelimit (free tier).

---

### PRIORITY 6: RAG PIPELINE (Build in order)

42. Embeddings setup:
    - Enable pgvector extension in Supabase
    - Add embedding column to jobs table: vector(1536)
    - Generate embeddings via OpenAI text-embedding-3-small
      for job title + description concatenated
    - Batch embedding generation after each scrape run
    - Add embedding generation to scrape pipeline
43. Resume text extraction:
    - Parse uploaded PDF from Supabase Storage on upload
    - Use pdf-parse (Node.js) to extract clean text
    - Store extracted text in profiles.resume_text column
    - Re-extract automatically when resume is replaced
    - Generate and store resume embedding in
      profiles.resume_embedding column
44. Match scoring:
    - Compute cosine similarity: resume_embedding vs job
      embedding via pgvector <=> operator
    - Convert to A-F grade:
      A: similarity > 0.85
      B: similarity > 0.75
      C: similarity > 0.65
      D: similarity > 0.55
      F: similarity <= 0.55
      (tune thresholds after testing with real resumes)
    - Cache scores: job_scores(user_id, job_id, score,
      grade, computed_at)
    - Invalidate cache when user uploads new resume
45. Match scoring UI:
    - Grade badge on job card (A/B/C/D/F, color coded:
      A=green, B=teal, C=yellow, D=orange, F=red)
    - Pro users only — show lock icon for free users
    - "Upload resume to see match" prompt for Pro users
      without resume uploaded
    - "Best Match" sort option in job feed (sort by grade)
    - Grade shown on job detail page with brief explanation
46. Agent/Chat (Claude-powered, build last):
    - /chat page or sidebar on /jobs
    - System prompt: user's resume text + job preferences
    - RAG retrieval: pgvector similarity search for top 10
      matching jobs given user query
    - Claude answers: "find ML jobs in NYC", "why am I
      not getting interviews", "tailor my resume for this"
    - Pro only, uses Claude claude-sonnet-4-20250514 via API

---

### PRIORITY 7: TESTING

47. End-to-end Stripe purchase test — buy a Pro subscription
    with a real card, verify webhook fires, tier updates,
    Pro features unlock correctly
48. Full UI flow test — every page, every button, every
    filter combination, all edge cases
49. Mobile device testing — iPhone Safari, Android Chrome,
    tablet landscape/portrait
50. Search accuracy testing — test 20+ queries, verify
    ranked results are correct and relevant
51. Role filter accuracy testing — click each chip, verify
    job counts and results are correct per source

---

### PRIORITY 8: ANALYTICS & MONITORING

52. Verify Vercel Analytics is capturing data (already added)
    — check dashboard for drop-off points
53. Add Posthog for deeper funnel analysis — track: job
    card clicks, apply button clicks, upgrade modal views,
    search usage, filter usage
54. Add Sentry for error monitoring — add once real users
    are on the site. Capture frontend + API route errors.

---

### PRIORITY 9: MARKETING

55. SEO — verify Google Search Console is indexing job pages,
    check coverage report, fix any crawl errors. Already have
    sitemap submitted.
56. Reddit — r/cscareerquestions, r/csMajors,
    r/learnprogramming. Share as a resource post, not an ad.
    Time for peak engagement (weekday mornings US time).
57. CS Discord servers — target new grad focused servers
    (CS Career Hub, Blind, Levels.fyi Discord etc)
58. ProductHunt launch — after UI polish + RAG scoring live.
    Prepare assets: logo, tagline, screenshots, demo GIF.
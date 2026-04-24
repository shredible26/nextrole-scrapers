# NextRole — Project Spec & State (as of April 23, 2026)

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
- Current scraper/orchestrator behavior:
  - imports scraper modules directly
  - active scrapers currently include `pittcsc`, `simplify_internships`, `vanshb03_newgrad`, `vanshb03_internships`, `ambicuity`, `speedyapply_ai_newgrad`, `speedyapply_swe_newgrad`, `jobright_swe`, `jobright_data`, `zapplyjobs`, `hackernews`, `adzuna`, `remoteok`, `arbeitnow`, `themuse`, `jobspy`, `greenhouse`, `ashby`, `lever`, `workday`, `workable`, `smartrecruiters`, `recruitee`, `personio`, `breezy`, `icims`, `jazzhr`, `jobvite`, `oraclecloud`, `careerjet`, `workatastartup`, `builtin`, `dice`, `simplyhired`, and `usajobs`
  - new scraper modules added this cycle are `breezy.ts`, `icims.ts`, `jazzhr.ts`, `jobvite.ts`, `oracle-cloud.ts` (stored source `oraclecloud`), and `personio.ts`
  - runs them with `Promise.allSettled(...)`
  - `dice.ts` was fixed to use the Dice GET API instead of POST and no longer applies the old 3-day filter
  - `workable.ts` was rewritten to use HTML pagination instead of the rate-limited `jobs.workable.com/api/v1/jobs` endpoint
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
| `job_alerts_enabled` | `boolean` | `NOT NULL`, default `false`; controls whether daily alert emails are sent |

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
| `fts` | `tsvector` | Reworked in `008_weighted_fts.sql`; non-generated weighted search vector maintained by `jobs_fts_update()` / `jobs_fts_trigger` |

**Important notes:**
- There is **no** `created_at` column on `jobs`
- There is **no** `updated_at` column on `jobs`
- Full-text search is backed by `fts` plus the `search_jobs_ranked(search_query text, is_active_filter boolean default true)` SQL function; migration `008_weighted_fts.sql` replaced the earlier generated-column implementation
- `fts` is populated with `setweight(...)`: `title=A`, `company=B`, `description=C`, and kept in sync by `jobs_fts_update()` via a `BEFORE INSERT OR UPDATE OF title, company, description` trigger

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
| `interview_count` | `int` | Added in `007_application_interview_counts.sql`; `NOT NULL`, default `0`, check constraint `interview_count >= 0` |

**Constraint:** `UNIQUE(user_id, job_id)`

**Migration notes:**
- Migration `007_application_interview_counts.sql` adds `applications.interview_count`
- Migration `008_weighted_fts.sql` replaces the generated `jobs.fts` column with a weighted trigger-backed column

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
| `PATCH` | `/api/profile/alerts` | Supabase user session | Toggles `profiles.job_alerts_enabled` | Validates JSON body `{ enabled: boolean }` and updates the authenticated user's row |
| `GET` | `/api/unsubscribe` | None; stateless token in query string | Disables `job_alerts_enabled` without a session | Verifies an HMAC-SHA256 token, updates the user row with `job_alerts_enabled=false`, and redirects to `/?unsubscribed=true` |
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

Counts below are the most recent known scrape totals from the latest scrape run as of April 23, 2026. The repo itself does not store per-run scrape metrics, so these numbers are operational reference rather than values computed from this checkout.

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
| `greenhouse` | `greenhouse.ts` | Greenhouse Boards API | 6,984 |
| `lever` | `lever.ts` | Lever public postings API | 1,992 |
| `workday` | `workday.ts` | Workday public `wday/cxs/.../jobs` POST endpoints | 2,364 |
| `workable` | `workable.ts` | Workable per-company HTML pagination | 1,454 |
| `smartrecruiters` | `smartrecruiters.ts` | SmartRecruiters public postings APIs | 1,355 |
| `recruitee` | `recruitee.ts` | Recruitee per-company public API | 968 |
| `personio` | `personio.ts` | Personio XML feed | 182 |
| `breezy` | `breezy.ts` | Breezy HR public JSON feed | 58 |
| `icims` | `icims.ts` | iCIMS per-company HTML + JSON-LD | 263 |
| `jazzhr` | `jazzhr.ts` | JazzHR per-company HTML + JSON-LD | 80 |
| `jobvite` | `jobvite.ts` | Jobvite per-company HTML + JSON-LD | 54 |
| `oraclecloud` | `oracle-cloud.ts` | Oracle Cloud Recruiting REST API | 94 |
| `workatastartup` | `workatastartup.ts` | Work at a Startup site + Algolia-backed search | 37 |
| `builtin` | `builtin.ts` | Built In jobs API with HTML fallback logic | 503 |
| `careerjet` | `careerjet.ts` | Careerjet partner API | 110 |
| `dice` | `dice.ts` | Dice GET API / web endpoint scraping | 4,942 |
| `simplyhired` | `simplyhired.ts` | HTML/JSON-LD parsing with Playwright fallback | 205 |
| `ashby` | `ashby.ts` | Ashby posting API | 7,095 |
| `usajobs` | `usajobs.ts` | USAJobs official API | 210 |

Other scrapers are also referenced in scraper orchestration (`speedyapply_swe`, `speedyapply_ai`, `ziprecruiter`, `glassdoor`, `wellfound`, `handshake`, `bamboohr`, `rippling`, `dice_rss`), but the current spec does not have reliable April 2026 counts for them and several are called out as fragile or effectively stubbed in the TODO/discrepancy notes.

---

## SECTION 8: Scraper Architecture (for `nextrole-scrapers`)

This section is included as operational reference. In this checkout, scraper code still lives under `scrapers/`, but the intended architecture is a separate private repo.

- **Runtime:** `tsx` + `dotenv-cli`
  - `package.json` scripts:
    - `pnpm scrape` -> `dotenv -e .env.local -- tsx scrapers/index.ts`
    - `pnpm cleanup` -> `dotenv -e .env.local -- tsx scrapers/cleanup-senior-roles.ts`
- **Deduplication:** `dedup_hash` is `md5(lowercase(company) + '|' + lowercase(title) + '|' + lowercase(location))` from `scrapers/utils/dedup.ts`
- **Pipeline:** current scraper orchestration runs all imported scrapers with `Promise.allSettled(...)`
- **Global scrape timeout:** a hard `25 minute` timeout wraps the entire `Promise.allSettled(...)` scrape run; if it fires, unresolved scrapers are logged and the process exits via `process.exit(0)`
- **Priority scrapers first:** **not implemented in this checkout**
  - the TODO explicitly proposes running heavy sources like `lever`, `workday`, and `workable` sequentially before the concurrent batch
  - current orchestrator still launches every scraper together
- **Stale job deactivation:** `deactivateStaleJobs(sourceName, activeDedupHashes)` runs after upload for every source except orchestrator-level `jobspy`; each call has a `60 second` per-source timeout
- **Caching:**
  - `scrapers/cache/ashby-valid-slugs.json`
  - `scrapers/cache/workday-dead.json`
- **GitHub Actions cron:** the private `nextrole-scrapers` repo runs the scrape workflow in GitHub Actions; after the embed step it now runs a `Send job alerts` step via `npx dotenv-cli`
- **Job alerts:** `scrapers/scripts/send-job-alerts.ts` sends daily job alert emails via Resend to users with `job_alerts_enabled = true`
- **Local cron:** also not present in this repo; the TODO recommends `caffeinate -i pnpm scrape` for Cloudflare-blocked sources
- **Upload behavior:** `scrapers/utils/upload.ts` upserts in chunks of `50` and deactivates stale IDs in chunks of `500`
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
- Never run embeddings and the FTS batch `UPDATE` at the same time on nano compute; it will OOM the instance and take the project unhealthy.
- `jobs.fts` is no longer a generated column. The `jobs_fts_trigger` / `jobs_fts_update()` pair must exist or new rows will have `NULL` `fts` values and disappear from search results.
- Weighted FTS intentionally uses `ts_rank_cd(...)` (cover density) instead of `ts_rank(...)` inside `search_jobs_ranked()` because it behaves better for multi-word queries.
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
- `workable.ts` no longer uses the global `jobs.workable.com/api/v1/jobs` endpoint; it now paginates per-company HTML results because the API path was rate-limited.
- SimplyHired detects `403` / Cloudflare challenge pages and falls back to Playwright. The repo TODO references a local `caffeinate` cron for this, but no such automation exists in this checkout.
- `jobspy` is special-cased in the orchestrator because it emits per-site source names like `jobspy_indeed`; stale cleanup is skipped for the top-level `jobspy` orchestrator name.
- Scraper upserts now use chunks of `50`. Do not increase this unless compute is upgraded beyond nano.
- `app/api/upload-resume` is still a `501` stub, but the real resume UX is already implemented client-side in `ProfileClient` via direct Supabase Storage operations.
- The `send-job-alerts.ts` GitHub Actions step requires `NEXT_PUBLIC_URL`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_KEY` in repo secrets.

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

## NextRole — Master TODO (Not fully updated)

---

### 1: SCRAPER STABILITY
1a. LOCATION FILTERING DOESN'T WORK (USA, OTHER)
1b. Fix mobile screens (chat, pricing, etc)
1c.[COMPLETED ✅]: Fix lever/workday/workable concurrent timeout — run
   heavy scrapers in a prioritized early sequential batch before the
   other 34 scrapers start competing for resources. Lever needs
   200s+, Workday needs 300s+, currently getting starved.
1d.Contact workable support (support@workable.com) or fix scraper to
   bypass rate limit / ip detection.    
2. [COMPLETED ✅]: Remove dead scrapers: speedyapply-swe.ts, 
   speedyapply-ai.ts (always 0 jobs, confirmed stubs), make sure to remove correct scrapers
3. [COMPLETED ✅] Fix careerjet (0 jobs every run — check if API key expired
   or endpoint changed). Right now, it gracefully fails, but returns 0 jobs (not fixed, but no longer crashes)
4a. [COMPLETED ✅]: Fix rippling if possible (do research) (2 jobs,
   fragile next.js build ID). If absolutely not possible, then deactivate/remove
4b.[COMPLETED ✅] Create careerjet.ts file in nextrole-scrapers! File is non-existent. 
   Currently 115 jobs from careerjet from an old nextrole scraper - recreate and get as many jobs as possible for all existing roles and experience levels. Make sure to take IP address into account. 
5a.[COMPLETED ✅]: Potentially remove source filtering, or redesign it so 
   that users cannot easily just go to the sources and search there instead. 
   to design this / figure it out
5b.Set up local caffeinate cron for CF-blocked scrapers
   (simplyhired, workable) that fail in GitHub Actions:
   `caffeinate -i pnpm scrape` at 7AM daily via crontab
5c.[COMPLETED ✅] Viewers should not be able to view jobs without an account - remove 
   from the pricing page. 'View jobs' button while not signed in should redirect to google login. 
5d.[COMPLETED ✅] When a user signs in and it automatically goes to the job page, it
   always shows 0 jobs until the user refreshes the page. Then the jobs load. Fix this- the jobs should load immediately after signing in/signing up.
5e.In the search bar (in jobs page), the 'x' button doesn't work. It 
   should clear all the text and unselect the search bar.
5f.Manually curate a seed list of ~50-100 tech companies that use
   Recruitee
5g.TeamTailor - Figure out if I should add via manual seed slug
   (check website) or if there is a better way  
5h.For each role filter, add up job count. Then figure out what the difference is between that and 'All'. What are the remaining jobs? How
   can they be sorted/categorized? 
5i.Fix back button (on About this role page and browser back button 
   on jobs page)
5j.Add the claude re-read step for the RAG grade matching. 
   (Partially done, uses deterministic approach right now)   
5k.'About this role' section should be displayed perfectly (not at one 
    big paragraph). The description should not show on the the jobs card
    (which it currently does), it should only show if you click on the job title and it should appear in the 'About this role' section. Maybe add a 'view description' button for jobs with them?
5l.Add 'best match' filter (pro only) - ranks all jobs from best to worst.
5m.Limit pro users to 5 chat total (same / other chat) questions 
   per day.
5n. On job cards, make the source bold. 
5o. Auto-embedding for any new job that gets scraped (I should not have 
   to do this manually)
5p. Handle long chat memory - when users send many messages to the same 
   chat conversation (without clicking new chat) - should not cost much
5q. In the user profile page, remove the 'current plan' section (where it just says Pro for pro users).
5r. Right now, when on any page, the profile circle shows the users first
   name initial but it should show full name initials (fit properly into circle).
5s. For pro users, add a grade toggle allowing them to turn off grades.
5t. Give grades to free users as well (they still have limited job 
    access)
5u. Fix location filtering for personio, make sure it works for all 
    sources and is as good a possible (catches all possible keywords). Research until all keywords are gathered. 
5v. Fix pricing page (include best match, chat, etc)
5w. Update logic for finding jobs (active vs inactive) - this should
    be flawless and should include ALL keywords/etc since this is what determines whether or not a job shows up on the sits. This filtering should be the most thorough out of every filter. I want to include as many relevant jobs as possible (anything that fits into my available filters). Do deep research. How should I approach this?
5x. Change home page text to something like 'Every tech job from all
    the common sites and repositories' and the numbers should be updated to 70,000+ jobs and 35+ sources (or whatever I am at now).
5t. Any way to speed up the deactivation process after jobs all jobs are
    scraped? Maybe just remove jobs from postings 6+ months ago or something?
5u. Right now, the 'Best match' filter only sorts the current jobs 
    showing (I have to click 'Load more' to increase the number of jobs). This is perfect for free users. For pro users, can the best match grade be based on ALL jobs with the current users filter configuration? They can click the '24 hour' filter if they just want all of the jobs from the past 24 hours graded, etc. 
5v. On the profile page, redesign the top box (with the name and email
    and profile circle with initials). Instead of a box, the circle should be in the center, the name should be right under it, the email right under that, and then the 'Pro' badge or the 'Upgrade' button should be under that. Everthing else should remain - this is just for the very top element/box. 
5w. When switching tabs (between jobs, tracker, profile, etc), the 
    filters on the jobs page should not change, until the a full browser reload. 
5x. Whenever I reload the page (on my pro account), in the jobs page,
    the search bar at the end of the text shows (Pro) for half a second before erasing it. Remove this- the text should remain the same. For free users, it should show (Pro) at the end, and that should remain there between reloads (not change at all), but for Pro users it should dissappear. 
5y. Make the company name on the job card more bold / stand out more. 


---

### 2: NEW SOURCES & SOURCE EXPANSION

6a.[COMPLETED ✅] Hide job source from the job card for free users (hide completely or 
   categorize into the available free source filters: github, job board, or other, and use that)
6b.Fix Workable — currently 10 jobs. 429 rate limiting on
   entry-level search terms. Add exponential backoff + retry,
   run failed terms again after delay. (workable scraper kept - email sent to support)
7a.Expand Ashby slug list (currently 255 valid slugs, target
   400+ via Common Crawl + additional GitHub repos)
7b.Takes too long to load 'all' jobs. Prioritize loading first 30-50, 
   figure out how to speed up.    
8. [COMPLETED ✅]: Expand Lever company list (currently ~115 slugs)
9. [COMPLETED ✅]: Expand Workday company list — currently 26/365
   companies returning jobs. Verify wdVersions for remaining 339.
10.[COMPLETED ✅]: Add Recruitee source:
    GET https://{company}.recruitee.com/api/offers/
    No auth required. Large list of companies available.
11. Add TeamTailor source:
    GET https://api.teamtailor.com/v1/jobs
    No auth, large ATS used by European + US startups.
12. [COMPLETED ✅]:Add Personio source (XML feed, European ATS with US 
    roles)
13. [COMPLETED ✅] Add iCIMS source (large enterprise ATS, no public API —
    research correct endpoint via Codex)
14. [COMPLETED ✅] Add rabiuk/job-scraper GitHub repo as source
15. [COMPLETED ✅] Add bttf/internio GitHub repo as source
16. [COMPLETED ✅] Add SpeedyApply 2026-SWE-College-Jobs and
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

### 3: FILTERING LOGIC

22a.[COMPLETED ✅]: Update inferExperienceLevel(), inferRoles(), and
    inferRemote() functions in scrapers/normalize.ts. Expanded
    heuristics / keyword coverage for experience level, role tagging,
    and remote inference.
22b.Train a small text classifier (e.g. fine-tuned distilbert
    or even a simple sklearn TF-IDF + logistic regression) on labeled job title/description → experience level + role tags.
22c.Add ML to roles with no keywords.
22d.Per-source keyword tuning — audit each source's role
    classification accuracy. Ensure SWE/DS/ML/AI chips
    return correct results per source.
22e.[COMPLETED ✅] Make the 'remote' filter toggle in the jobs page dark themed / dark.
23. [COMPLETED ✅]: Role classification improvements — expand
    inferRoles() keyword lists, add more title patterns for each role.
23a.[COMPLETED ✅]: Weighted FTS (migration 008) — implemented with
    `ts_rank_cd(...)` plus `setweight(...)` on `title=A`,
    `company=B`, `description=C`.
24. Add more role filters beyond current 7 chips:
    - Consulting / Tech Consulting
    - Full-Stack
    - Security
    - Mobile (iOS/Android)
25. Add more experience level filter options:
    - Co-op (separate from internship)
    - Recent Grad (0-2 YOE, distinct from new_grad)
26. [COMPLETED ✅] International/non-tech filter tightening — reduce false
    positives slipping through (non-tech roles, non-Latin
    character titles, etc.)
27. Location filter expansion — add more granular options
    beyond USA/Other (e.g., by state, by city cluster like
    SF Bay Area, NYC, Seattle, Austin)
27a.[COMPLETED ✅]: USA/Other location filter improvements —
    expanded USA-vs-non-USA matching heuristics in `app/api/jobs/route.ts`.

---

### 4: UI & DESIGN

28a.[COMPLETED ✅]: Home page full rewrite:
    - New headline + subheadline (largest new grad/entry-level
      tech job aggregator, all company types including startups)
    - Advertise job count (55k+), source count (25+), daily
      updates
    - Feature highlights: search, filters, tracker, pro scoring
    - Add social proof when available (users, applications
      tracked, etc.)
28b.[COMPLETED ✅] For the search bar feature, make sure you are able to search by job
    source along with everyhting else. (Ex. search 'ZapplyJobs')
28c.[COMPLETED ✅] Fix the back button (UI and logic) to become more prominent and make sure
    it actually works. Right now it resets all filters when clicked. Back button for jobs page, wheen you click on a job and it shows the description etc. 
29a.[COMPLETED ✅]: Pricing page text rewrite — clarify free vs pro tiers,
    update feature list, mark coming-soon features clearly
29b.[COMPLETED ✅]: Add button to Tracker page that allows users to add
    custom job (with optional url/details/etc, whatever fields are there
    normally) to their tracker
29c.[COMPLETED ✅]:In the mini pricing window (and main pricing page if
    applicable, for the two rows that say 'Unlimited' for Pro users, remove the check mark next to Unlimited. 
29d.[COMPLETED ✅]:Remove "No account required to browse" from pricing. 
30. [COMPLETED ✅]:Full site color scheme overhaul — dark mode,
    more vibrant and modern palette, consistent across all pages
31. [COMPLETED ✅]:Filter sidebar UI redesign — better visual hierarchy,
    cleaner styling, mobile-friendly
32. [COMPLETED ✅]:Job tracker UI redesign — better colors, table/kanban
    toggle, status column styling
33. [COMPLETED ✅]:Job card design improvements — salary display, company
    logo quality, role chip styling
34. [COMPLETED ✅]: Mobile responsiveness full audit — test /jobs,
    /tracker, /pricing, /profile on iPhone and Android screen sizes.
    Fix all broken layouts.
35a.[COMPLETED ✅]:Navbar: add Profile link (done), verify all links work
35b.[COMPLETED ✅]: Make sure everything works on mobile (all pages,
    all links, hamburger menu, etc)

---

### 5: FEATURE COMPLETENESS

36. [COMPLETED ✅]: Job view limit for free users — free users see page 1
    only (30 jobs per filter configuration, already implemented). Confirm
    this works correctly end-to-end including upgrade modal.
37. [COMPLETED ✅] Job tracker limit — cap at 100 tracked jobs for free
    users, unlimited for pro. Show "Upgrade to track more"
    when limit hit.
38a.Similar jobs on 'about this role' page — show 5 similar jobs
    by title/role using existing FTS + pgvector when ready.
    For now use textSearch similarity. 
38b.[COMPLETED ✅]:Upgrade modal copy still says "20 jobs", needs update 
    to '30 jobs'
38c.[COMPLETED ✅]: Application rate tracker on profile —
    `Applications` + `Interviews` stat cards now use real tracker data.
39. [COMPLETED ✅]: Job alerts via email (Resend):
    - User sets filter preferences (role, experience level,
      remote, location) — store in profiles table
    - Daily or weekly digest email: "X new jobs matching
      your preferences"
    - Unsubscribe link in every email
    - Resend free tier: 3,000 emails/month
    - Implemented with profile opt-in toggle, daily cron script,
      Claude Haiku summaries for Pro users, and `/api/unsubscribe`
40. [COMPLETED ✅] Contact / feedback page — simple /contact form, submits
    via Resend to your email. Helps with user trust.
41a. [COMPLETED ✅]: Server-enforce Pro-only search — confirmed in
     `app/api/jobs/route.ts`; currently search is
     blocked in the UI for free users but /api/jobs?search=
     can be called directly to bypass it. Add a server-side
     check in app/api/jobs/route.ts: if search param is
     present and user tier is 'free', return 402 with
     upgrade: true (same pattern as page > 1 check).
41b. Consolidate profile creation paths — currently profiles
     can be created via: DB trigger, auth callback, legacy
     auth webhook, and /api/jobs fallback insert. This risks
     duplicate rows and race conditions. Audit and remove all
     paths except the auth callback route (which uses the
     service role client and is the most reliable). Disable
     or drop the DB trigger.
42. Rate limiting on API routes:
    - /api/stripe/webhook (already uses raw body verification)
    - /api/jobs (add per-user rate limit: 100 req/min)
    - /api/profile/display-name (add per-user rate limit)
    Use Upstash Redis + @upstash/ratelimit (free tier).

---

[COMPLETED ✅] ### 6: RAG PIPELINE (Build in order)

[COMPLETED ✅]: 43. Embeddings setup:
    - Enable pgvector extension in Supabase
    - Add embedding column to jobs table: vector(1536)
    - Generate embeddings via OpenAI text-embedding-3-small
      for job title + description concatenated
    - Batch embedding generation after each scrape run
    - Add embedding generation to scrape pipeline
[COMPLETED ✅]: 44. Resume text extraction:
    - Parse uploaded PDF from Supabase Storage on upload
    - Use pdf-parse (Node.js) to extract clean text
    - Store extracted text in profiles.resume_text column
    - Re-extract automatically when resume is replaced
    - Generate and store resume embedding in
      profiles.resume_embedding column
[COMPLETED ✅]: 45. Match scoring:
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
[COMPLETED ✅]: 46. Match scoring UI:
    - Grade badge on job card (A/B/C/D/F, color coded:
      A=green, B=teal, C=yellow, D=orange, F=red)
    - Pro users only — show lock icon for free users
    - "Upload resume to see match" prompt for Pro users
      without resume uploaded
    - "Best Match" sort option in job feed (sort by grade)
    - Grade shown on job detail page with brief explanation
[COMPLETED ✅]: 47. Agent/Chat (Claude-powered, build last):
    - /chat page or sidebar on /jobs
    - System prompt: user's resume text + job preferences
    - RAG retrieval: pgvector similarity search for top 10
      matching jobs given user query
    - Claude answers: "find ML jobs in NYC", "why am I
      not getting interviews", "tailor my resume for this"
    - Pro only, uses Claude claude-sonnet-4-20250514 via API

---

### 7: TESTING

48. End-to-end Stripe purchase test — buy a Pro subscription
    with a real card, verify webhook fires, tier updates,
    Pro features unlock correctly
49. Full UI flow test — every page, every button, every
    filter combination, all edge cases
50. Mobile device testing — iPhone Safari, Android Chrome,
    tablet landscape/portrait
51. Search accuracy testing — test 20+ queries, verify
    ranked results are correct and relevant
52. Role filter accuracy testing — click each chip, verify
    job counts and results are correct per source

---

### 8: ANALYTICS & MONITORING

53. Verify Vercel Analytics is capturing data (already added)
    — check dashboard for drop-off points
54. Add Posthog for deeper funnel analysis — track: job
    card clicks, apply button clicks, upgrade modal views,
    search usage, filter usage
55. Add Sentry for error monitoring — add once real users
    are on the site. Capture frontend + API route errors.

---

### 9: MARKETING

56. SEO — verify Google Search Console is indexing job pages,
    check coverage report, fix any crawl errors. Already have
    sitemap submitted.
57. Reddit — r/cscareerquestions, r/csMajors,
    r/learnprogramming. Share as a resource post, not an ad.
    Time for peak engagement (weekday mornings US time).
58. CS Discord servers — target new grad focused servers
    (CS Career Hub, Blind, Levels.fyi Discord etc)
59. ProductHunt launch — after UI polish + RAG scoring live.
    Prepare assets: logo, tagline, screenshots, demo GIF.

### More details:
22a: 
- Add Regex patterns not just exact matches (/\bjr\.?\b/i, /\b0[\s-]?[–-][\s-]?[12]\s*(?:yr|year)/i)
- Negative signals ("5+ years", "senior", "staff", "principal", "lead" → exclude)
- Title-specific overrides by source (Greenhouse titles follow different conventions than LinkedIn)
- Weighted scoring instead of binary (if 2+ signals match → high confidence)

22b:
- Accuracy: Better than keywords, slightly worse than GPT-4, but fast and free at inference
- Cost: One-time training cost, then essentially free
- Catch: You need labeled training data. You could bootstrap this by using LLM to label a few thousand jobs once, then train on those labels.
- Complexity: This is a real ML project — 1-2 weeks to do properly

22c:
jobs that return [] from inferRoles. Right now those jobs have no role chips and essentially disappear from filtered views. A cheap middle ground that's better than full ML: after inferRoles runs, if it returns [], run a second pass using hasTechTitleSignal patterns and map those to a default swe tag. That way nothing falls through the cracks.
# NextRole — Project Spec & State (April 2026)

## Overview
- **Name:** NextRole
- **Live URL:** nextrole-phi.vercel.app
- **Purpose:** Job aggregator for new grad and entry-level tech roles
- **Target users:** CS/DS students graduating 2025–2026
- **Stack:** Next.js 14 App Router, TypeScript, Supabase, Stripe, Tailwind CSS
- **Repo:** github.com/shredible26/nextrole
- **Deployment:** Vercel (auto-deploy on push to main)

---

## Architecture

### Frontend
- Next.js 14 App Router (NOT pages router)
- **IMPORTANT:** middleware is named `proxy.ts` and exports `proxy` (Next.js 16 convention)
- Tailwind CSS for styling
- Key pages: `/jobs`, `/tracker`, `/pricing`, `/settings`, `/auth/callback`

### Backend
- Supabase (PostgreSQL + Auth + RLS)
- Service role client used in: auth callback, webhook handler, scraper
- Anon client used in: frontend queries
- Auth: Google OAuth only
- Profile creation: handled in `app/auth/callback/route.ts` via service role client
  (NOT via database trigger — trigger had permission issues)

### Payments
- Stripe (currently TEST MODE — live mode pending account review)
- Monthly: $4.99/mo | Yearly: $50/yr
- Checkout: `/api/stripe/checkout`
- Webhook: `/api/stripe/webhook` (handles subscription lifecycle)
- Portal: `/api/stripe/portal` (manage/cancel subscription)
- Free tier: page 1 only (20 jobs). Pro: unlimited.
- Upgrade modal triggers on Load More for free users

### Scraping Pipeline
- Runtime: `tsx` + `dotenv-cli` (NOT ts-node)
- Script: `"scrape": "dotenv -e .env.local -- tsx scrapers/index.ts"`
- Scheduler: GitHub Actions cron daily at 7AM UTC
- All scrapers run concurrently via `Promise.allSettled`
- Deduplication: `dedup_hash = hash(company + title + location)`
- Stale job deactivation: `deactivateStaleJobs()` runs per source after scrape

---

## Database Schema

### profiles table
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | references auth.users |
| email | text | |
| tier | text | `'free'` \| `'pro'`, default `'free'` |
| stripe_customer_id | text unique | |
| stripe_subscription_id | text | |
| subscription_status | text | `'inactive'` \| `'active'` \| `'past_due'` \| `'canceled'` |
| cancel_at_period_end | boolean | default false |
| jobs_viewed_today | int | default 0 |
| last_reset_date | date | |
| created_at | timestamptz | |

### jobs table
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | |
| source | text | source identifier e.g. `'pittcsc'`, `'greenhouse'` |
| source_id | text | |
| title | text | |
| company | text | |
| location | text | |
| remote | boolean | |
| url | text | |
| description | text | |
| salary_min | int | |
| salary_max | int | |
| experience_level | text | `'new_grad'` \| `'entry_level'` \| `'internship'` |
| roles | text[] | e.g. `['swe', 'ml']` |
| posted_at | timestamptz | |
| is_active | boolean | default true |
| dedup_hash | text unique | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### applications table
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | |
| user_id | uuid | references profiles |
| job_id | uuid | references jobs |
| status | text | `'applied'` \| `'interviewing'` \| `'offered'` \| `'rejected'` |
| notes | text | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

## Active Job Sources

| Source | File | Method | ~Jobs |
|--------|------|--------|-------|
| pittcsc | pittcsc.ts | GitHub JSON (SimplifyJobs new grad) | 14,688 |
| simplify_internships | simplify-internships.ts | GitHub JSON | 18,806 |
| vanshb03_newgrad | vanshb03-newgrad.ts | GitHub JSON | 636 |
| vanshb03_internships | vanshb03-internships.ts | GitHub JSON | 1,229 |
| greenhouse | greenhouse.ts | Free REST API, 300+ companies | 2,715 |
| ashby | ashby.ts | Free REST API, 150+ companies | 1,917 |
| lever | lever.ts | Free REST API, 115 companies | 77 |
| workday | workday.ts | POST API, 16+ companies working | 559 |
| adzuna | adzuna.ts | Free API (redirect_url only) | 1,112 |
| jobspy_indeed | jobspy.ts | ts-jobspy library | 252 |
| arbeitnow | arbeitnow.ts | Free API | 363 |
| usajobs | usajobs.ts | Official govt API + key | 183 |
| remoteok | remoteok.ts | Free API | 41 |
| themuse | themuse.ts | Free API | 10 |

## Stub Scrapers (0 jobs — wired but not producing)
- `dice_rss.ts` — Dice RSS (gated)
- `dice.ts` — Dice API (paid key required)
- `wellfound.ts` — Wellfound (auth required)
- `handshake.ts` — Handshake (auth required)
- `linkedin.ts` — LinkedIn (proxy required)
- `bamboohr.ts` — BambooHR (wrong endpoints)
- `rippling.ts` — Rippling (wrong endpoints)
- `speedyapply-swe.ts` — SpeedyApply (JSON not public)
- `speedyapply-ai.ts` — SpeedyApply (JSON not public)

---

## Experience Level Classification

Order of checks in `inferExperienceLevel(title, description)`:
1. EXCLUSION check → return `null` (senior/staff/principal/director/VP etc)
2. INTERNSHIP check → return `'internship'`
3. NEW_GRAD check (title) → return `'new_grad'`
4. ENTRY_LEVEL check (title) → return `'entry_level'`
5. NEW_GRAD check (description) → return `'new_grad'`
6. ENTRY_LEVEL check (description) → return `'entry_level'`
7. Default → return `'entry_level'`

---

## Key Engineering Gotchas
- `proxy.ts` NOT `middleware.ts` (Next.js 16)
- Profile creation in auth callback, NOT database trigger
- Google OAuth: test users must be added in consent screen
- `dotenv-cli` required: `pnpm add dotenv-cli`, use `"dotenv -e .env.local --"`
- Supabase 414 error: chunk large dedup hash sets (500 at a time)
- Workday: tries all `wd1–wd12/wd100` × 9 slug variations per company
- **Workday URL bug:** API returns relative `externalPath` values. If path starts with `/en-US/`, use directly. Otherwise prepend `/en-US/{careerSite}/`. Also check `externalUrl` and `jobPostingUrl` fields first.
- **Workday filter pipeline order:** `inferExperienceLevel` → `isWorkdaySeniorTitle` → `isNonUsLocation` → `hasNonLatinCharacters` → `isNonTechRole`
- Greenhouse/Lever/Ashby: all free public APIs, no auth
- **Adzuna:** only provides `redirect_url` (their landing page), no direct apply URL. UTM param `&utm_source=nextrole` is appended. Apply button is uniform "Apply ↗" for all sources.
- Stripe webhook: must use `req.text()` not `req.json()` for raw body

---

## Environment Variables

### Required for local dev (`.env.local`)
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_KEY
SUPABASE_URL
ADZUNA_APP_ID
ADZUNA_APP_KEY
MUSE_API_KEY
USAJOBS_API_KEY
USAJOBS_EMAIL
STRIPE_SECRET_KEY
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
STRIPE_PRICE_MONTHLY
STRIPE_PRICE_YEARLY
STRIPE_WEBHOOK_SECRET
NEXT_PUBLIC_URL=https://nextrole-phi.vercel.app
```

### Required for GitHub Actions scraper
```
SUPABASE_URL, SUPABASE_SERVICE_KEY, ADZUNA_APP_ID, ADZUNA_APP_KEY,
MUSE_API_KEY, USAJOBS_API_KEY, USAJOBS_EMAIL
```

---

## UI Features
- `/jobs`: 2-column job grid, left filter sidebar (role, experience, remote, posted within, source), pagination, upgrade modal for free users on page 2+
- `/tracker`: table view (default) + kanban toggle, status/notes columns, client-side filtering, auto-save on blur
- `/pricing`: monthly/yearly Stripe checkout, manage subscription portal
- Navbar: Pro badge for pro users, Google avatar
- Role chips: All / SWE / DS / ML / AI / Analyst / PM (wraps to 2 rows — no `whitespace-nowrap`, sidebar is `overflow-x-hidden`)
- Source filter: GitHub Repos (grouped) + individual sources
- Apply button is uniform "Apply ↗" for all sources (no source-specific labels)

---

## GOALS:
- [FEATURE]: Fix description text when you click on any job.
- [FEATURE]: Add more startups
- [FEATURE]: Fix sources where job count = 0 (ziprecruiter, glassdoor, dice, etc), use codex to figure out correct methods/logic
- [FEATURE]: Fix Ashby (commoncrawl, slugs) and workatastartup (try to get more jobs)
- [FEATURE]: Improve sources, especially ones that are showing low numbers
- [FEATURE]: Other sources & github repos (super extensive search, figure out how to do so)
- [FEATURE]: Job tracker: limit to like 100 for free users, unlimited for pro
- [FEATURE]: Change job view logic to 50-100 total jobs can view for free user
- [FEATURE]: Add more role and experience level filters for better filterins + higher job count
- [FEATURE]: Job Search fix: Make just one big horizontal bar (remove duplicate role filters, replace that space with the search bar). Search should only be available to pro users. 
- [FEATURE]: Profile page with necessary info and option to upload resume
- [FEATURE]: Agentic RAG (Claude chat)
  - [FEATURE]: Embeddings Setup
  - [FEATURE]: Resume Upload
  - [FEATURE]: Match Scoring UI
  - [FEATURE]: Agent/Chat
- [FEATURE]: Add some form of contact for questions, help, etc
- [FEATURE]: SEO: Submit sitemap to Google Search Console, add meta descriptions per job page — you have 40k+ indexed pages, this is free organic traffic
- [FEATURE]: Email notifications: "New jobs matching your profile" weekly digest — drives retention
- [FEATURE]: Rate limiting on API routes: Protect /api/stripe/webhook and job fetch endpoints ???
- Filtering Feature: Make sure all filters on the site work properly, especially role filtering
- Filtering Logic: For each source, make sure the keyword search and job filtering (jobs to include, exclude, etc) are as best as possible. Do very extensive research for best results. Make sure as many tech jobs as possible (within available roles on the site) show up.
- UI: Update all pricing page text
- UI: Update all home page text (advertise as a huge job aggregate - including all types of companies (startups too), all tech, specific roles)
- UI: Improve design & color for filter navigation
- UI: Improve design & color for Application Tracker
- UI: Improve design & color for Home Page
- UI: Improve rest of the site color scheme (dark mode, better color scheme more vibrant, etc), make it look modern and nice
- TEST: Make sure pricing works via an actual purchase
- TEST: UI flow for everything, edge cases, all functionality, features, and links
- TEST: UI on different devices (mobile, etc)
- ANALYTICS: Add Posthog or Vercel Analytics to see where users drop off
- ANALYTICS: Add Sentry for Error Monitoring (once real users hit the site)
- MARKETING: r/cscareerquestions, r/csMajors, CS Discord servers
- [FEATURE (MAYBE)]: LinkedIn Jobs
- Try to implement Monster and bypass ClowdFlare Protection (Playwright + stealth plugins)


## Current sources to add:
High Priority:
- SmartRecruiters (GET https://api.smartrecruiters.com/v1/companies/{company}/postings)
- Recruitee (GET https://{company}.recruitee.com/api/offers/)
- TeamTailor (GET https://api.teamtailor.com/v1/jobs)
- Presonio (XML)
- SpeedApply (https://github.com/speedyapply)
- rabiuk/job-scraper (GitHub)

Medium Priority:
- HackerNews (GET https://hacker-news.firebaseio.com/v0/item/{thread_id}.json)
- Workable (GET https://jobs.workable.com/api/v1/jobs?q=software+engineer&location=United+States)
- Cavuno’s 2026 roundup — confirms six no-auth public ATS sources and adds implementation details for Greenhouse, Lever, Ashby, Workable, Recruitee, and Personio.
- Fantastic Jobs ATS article — separately documents public APIs for Ashby, Greenhouse, Lever, and Recruitee, useful as a second source for endpoint validation.
- No-auth API directory — a broader free/open API list that may help with adjacent job-related endpoints, though it is not job-specific.
- bttf/internio — a scraper that aggregates new-grad and internship listings by scraping GitHub repos, including SimplifyJobs sources.
- SpeedyApply pinned repos — 2026-SWE-College-Jobs and 2026-AI-College-Jobs are surfaced on the SpeedyApply org page and are distinct from the org homepage you already listed. 

## TODO:
## Phase 1: Max out job count (goal: 50k+)

PROMPT A: Workable
- Add Workable as new source (1,700+ companies, auto-discoverable)
- Use Codex to find the Workable company discovery endpoint

PROMPT B: Fix broken scrapers 
- Wellfound aggressive debug
- Rippling aggressive debug

PROMPT B (Part 2):
- iCIMS as new source
- SmartRecruiters as new source

PROMPT C: Expand Ashby similarly
- Find verified Ashby company list from GitHub repos

PROMPT D: Add SimplyHired scraper
- Free, large volume, consistent HTML structure

PROMPT E: Fix Handshake scraper (currently 0)
- New grad focused — perfect audience match

PROMPT F: Add more GitHub repo sources
- Find 5-6 more curated new grad lists
- Parse their JSON/markdown and ingest

## Phase 2: Filtering logic optimization
- Per-source keyword tuning
- Role classification improvements
- International/non-tech filter tightening

## Phase 3: Features
- Job search
- Profile + resume upload
- Job tracker limits
- RAG pipeline

## Phase 4: UI overhaul
- Dark mode
- Modern color scheme
- Mobile responsiveness

## Phase 5: Marketing
- Reddit, Discord
- ProductHunt
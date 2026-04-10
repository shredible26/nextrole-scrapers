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
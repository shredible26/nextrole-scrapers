---
name: nextrole-scraper-audit
description: >
  Full audit of all active NextRole scrapers in nextrole-scrapers. Use this skill
  whenever the user says "run scraper audit", "audit scrapers", "check scrapers",
  "scraper health check", "verify scrapers", or anything about checking scraper output
  counts or debugging a broken or underperforming scraper. Runs every active scraper
  individually in two phases: a fast count-only check, then a full upload scrape to
  verify counts match baselines in the DB. Auto-debugs all failures using web search
  and code fixes. Always use this skill for any scraper audit — do not attempt a
  scraper audit without reading this first.
---

# NextRole Scraper Audit Skill

## Overview

Two-phase audit of every active scraper in `nextrole-scrapers`:
- **Phase 1 — Count check:** Run each scraper, count returned jobs, flag failures fast
- **Phase 2 — Upload scrape:** Re-run every scraper and upload to Supabase, verify DB counts match baselines

**Repo:** `~/Desktop/nextrole-scrapers`
**Runtime:** `tsx` + `dotenv-cli`
**CRITICAL:** Do NOT run `pnpm scrape` during audit — runs everything concurrently
and OOMs nano compute. Always run scrapers one at a time sequentially.
**CRITICAL:** Do not run while the nightly GitHub Actions cron is running (7AM UTC).

---

## Step 0 — Environment Setup

Always run first:
```bash
cd ~/Desktop/nextrole-scrapers
export $(cat .env.local | grep -v '#' | grep -v '^$' | xargs)
```

---

## Phase 1 — Count Check (fast, no DB writes)

Run each scraper individually and record the count. No upload, no DB interaction.

**Command template:**
```bash
pnpm exec tsx -e "
import { FUNCTION_NAME } from './scrapers/sources/FILE.ts';
FUNCTION_NAME()
  .then(jobs => console.log('jobs:', jobs.length))
  .catch(e => console.error('FAIL:', e.message));
"
```

Run all active scrapers sequentially. Record count for each. Classify immediately:
```
PASS  = count >= threshold
WARN  = count > 0 but below threshold
FAIL  = count == 0 OR threw an error
SKIP  = known broken or confirmed stub (see lists below)
```

Fix all FAILs and WARNs before proceeding to Phase 2 (see Step 3 — Debugging).

---

## Phase 2 — Upload Scrape (real scrape, writes to Supabase)

After Phase 1 passes (all non-skip sources are PASS or WARN), run each scraper again
with a real upload to Supabase. This is the verification step.

**Command template:**
```bash
pnpm exec tsx -e "
import { FUNCTION_NAME } from './scrapers/sources/FILE.ts';
import { uploadJobs } from './scrapers/utils/upload.ts';
import { deactivateStaleJobs } from './scrapers/utils/upload.ts';

const jobs = await FUNCTION_NAME();
console.log('[SOURCE_NAME] scraped:', jobs.length);

const stats = await uploadJobs('SOURCE_NAME', jobs);
console.log('[SOURCE_NAME] upload stats:', JSON.stringify(stats));

const dedupHashes = jobs.map(j => j.dedup_hash);
await deactivateStaleJobs('SOURCE_NAME', dedupHashes);
console.log('[SOURCE_NAME] stale jobs deactivated');
"
```

Replace `FUNCTION_NAME`, `FILE.ts`, and `SOURCE_NAME` for each scraper.
`SOURCE_NAME` must exactly match the `source` field stored in the DB
(e.g. `'pittcsc'`, `'simplify_internships'`, `'jobright_swe'`).

Run all active scrapers sequentially. After each upload, verify the scraped count
matches the Phase 1 count and the baseline. If counts diverge significantly,
investigate dedup collisions or upload errors.

**Note on jobspy:** `deactivateStaleJobs` must use `'jobspy_indeed'` not `'jobspy'`
because that is the actual source value stored in the DB for jobspy jobs.

---

## Active Scrapers — Complete Accurate List

### GitHub Repo Sources
All jobs MUST pass through. Pre-curated by repo maintainers as new_grad/internship/entry_level.
Only `inferRoles()` is applied. Jobs with no role match upload with `roles: []` (appear under "All").
Never filter GitHub repo jobs by experience_level or role.

| File | Function | Source Name (DB) | Baseline | Threshold |
|------|----------|-----------------|----------|-----------|
| pittcsc.ts | `scrapePittCSC` | `pittcsc` | 15,909 | >12,000 |
| simplify-internships.ts | `scrapeSimplifyInternships` | `simplify_internships` | 18,966 | >15,000 |
| vanshb03-newgrad.ts | `scrapeVanshb03Newgrad` | `vanshb03_newgrad` | 565 | >400 |
| vanshb03-internships.ts | `scrapeVanshb03Internships` | `vanshb03_internships` | 949 | >700 |
| ambicuity.ts | `scrapeAmbicuity` | `ambicuity` | 1,019 | >700 |
| speedyapply-ai-newgrad.ts | `scrapeSpeedyapplyAiNewgrad` | `speedyapply_ai_newgrad` | 37 | >20 |
| speedyapply-swe-newgrad.ts | `scrapeSpeedyApplySWENewGrad` | `speedyapply_swe_newgrad` | 251 | >150 |
| jobright-swe.ts | `scrapeJobrightSwe` | `jobright_swe` | 624 | >400 |
| jobright-data.ts | `scrapeJobrightData` | `jobright_data` | 340 | >200 |
| jobright-business.ts | `scrapeJobrightBusiness` | `jobright_business` | 52 | >20 |
| jobright-design.ts | `scrapeJobrightDesign` | `jobright_design` | 228 | >100 |
| jobright-marketing.ts | `scrapeJobrightMarketing` | `jobright_marketing` | 1,025 | >600 |
| jobright-accounting.ts | `scrapeJobrightAccounting` | `jobright_accounting` | 2,364 | >1,500 |
| jobright-pm.ts | `scrapeJobrightPm` | `jobright_pm` | 131 | >80 |
| zapplyjobs.ts | `scrapeZapplyjobs` | `zapplyjobs` | 2,683 | >1,800 |
| hackernews.ts | `scrapeHackerNews` | `hackernews` | 381 | >200 |

### Job Board Sources

| File | Function | Source Name (DB) | Baseline | Threshold | Notes |
|------|----------|-----------------|----------|-----------|-------|
| greenhouse.ts | `scrapeGreenhouse` | `greenhouse` | 7,239 | >4,000 | |
| ashby.ts | `scrapeAshby` | `ashby` | 11,843 | >7,000 | Uses `scrapers/cache/ashby-valid-slugs.json` |
| lever.ts | `scrapeLever` | `lever` | 1,997 | >1,200 | |
| workday.ts | `scrapeWorkday` | `workday` | 2,746 | >1,500 | Uses `scrapers/cache/workday-dead.json` |
| workable.ts | `scrapeWorkable` | `workable` | 1,468 | >800 | HTML pagination, rate-limit sensitive |
| recruitee.ts | `scrapeRecruitee` | `recruitee` | 1,100 | >600 | |
| adzuna.ts | `scrapeAdzuna` | `adzuna` | 1,108 | >600 | Requires ADZUNA_APP_ID + ADZUNA_APP_KEY |
| dice.ts | `scrapeDice` | `dice` | 5,069 | >3,000 | GET API |
| builtin.ts | `scrapeBuiltIn` | `builtin` | 529 | >300 | |
| workatastartup.ts | `scrapeWorkAtAStartup` | `workatastartup` | 34 | >15 | |
| remoteok.ts | `scrapeRemoteOK` | `remoteok` | 35 | >15 | |
| arbeitnow.ts | `scrapeArbeitnow` | `arbeitnow` | 404 | >200 | |
| themuse.ts | `scrapeTheMuse` | `themuse` | 10 | >5 | |
| jobspy.ts | `scrapeJobSpy` | `jobspy_indeed` | 576 | >300 | Deactivate uses `jobspy_indeed` not `jobspy` |
| breezy.ts | `scrapeBreezy` | `breezy` | 48 | >20 | |
| jazzhr.ts | `scrapeJazzHr` | `jazzhr` | 83 | >40 | |
| jobvite.ts | `scrapeJobvite` | `jobvite` | 48 | >20 | |
| oracle-cloud.ts | `scrapeOracleCloud` | `oraclecloud` | 88 | >40 | |
| personio.ts | `scrapePersonio` | `personio` | 177 | >80 | XML feed |
| usajobs.ts | `scrapeUSAJobs` | `usajobs` | 213 | >100 | Requires USAJOBS_API_KEY |

### Known Broken — Always Skip (do not run, do not attempt to fix)

| File | Function | Reason |
|------|----------|--------|
| smartrecruiters.ts | `scrapeSmartRecruiters` | Always 0 — broken |
| icims.ts | `scrapeIcims` | Always 0 — broken |
| careerjet.ts | `scrapeCareerjet` | Always 0 — IP blocked |
| simplyhired.ts | `scrapeSimplyHired` | Always 0 in CI — Cloudflare block |

### Confirmed Stubs — Skip (throw or return [])

Do not run these:
`jobright.ts`, `bamboohr.ts`, `dice-rss.ts`, `handshake.ts`, `indeed.ts`,
`levels.ts`, `linkedin.ts`, `otta.ts`, `rippling.ts`, `wellfound.ts`, `ziprecruiter.ts`

### Inactive — Skip Unless Explicitly Requested
`glassdoor.ts` (`scrapeGlassdoor`) — not a stub, not in active orchestrator.

---

## Step 3 — Debugging FAILs and WARNs

Run this for every FAIL or WARN before proceeding to Phase 2.

### 3a. Read the source file
```bash
cat scrapers/sources/FILENAME.ts
```

### 3b. Run with full error output
```bash
pnpm exec tsx -e "
import { FUNCTION } from './scrapers/sources/FILE.ts';
FUNCTION()
  .then(j => {
    console.log('count:', j.length);
    if (j.length > 0) console.log('sample:', JSON.stringify(j[0], null, 2));
  })
  .catch(e => console.error('FULL ERROR:', e));
"
```

### 3c. Test the endpoint directly
```bash
curl -s -o /dev/null -w "%{http_code}" "ENDPOINT_URL"
curl -s "ENDPOINT_URL" | head -c 500
```

### 3d. Web search if needed
- `"[platform] jobs API" changelog 2025 2026`
- `[platform] API documentation [endpoint path]`
- Exact error message verbatim

### 3e. Fix and verify
Make targeted minimal changes. Re-run Phase 1 command to confirm count recovers.
Run `pnpm exec tsc --noEmit` after any code change.

### 3f. GitHub repo — verify no jobs dropped
```bash
# pittcsc
curl -s "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json" | \
  pnpm exec tsx -e "
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const data = JSON.parse(Buffer.concat(chunks).toString());
  console.log('raw total:', data.length);
  console.log('visible:', data.filter(j => j.is_visible !== false).length);
});
"

# simplify internships
curl -s "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json" | \
  pnpm exec tsx -e "
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const data = JSON.parse(Buffer.concat(chunks).toString());
  console.log('raw total:', data.length);
  console.log('visible:', data.filter(j => j.is_visible !== false).length);
});
"
```
If raw count >> scraper count, a filter is dropping jobs. Check for `.filter()`,
`inferExperienceLevel`, or role filtering in the scraper. Remove or loosen it.

### 3g. If unfixable after exhausting all methods
Document: exact error, endpoint tested, raw response, every fix tried, web searches run,
and what a human needs to do next.

---

## Step 4 — Generate Final Report

```
═══ NEXTROLE SCRAPER AUDIT REPORT ══════════════════════════════
Timestamp: [ISO datetime]

SOURCE                   P1 COUNT  P2 UPLOADED  BASELINE   STATUS
────────────────────────────────────────────────────────────────
pittcsc                  15,909    15,909        15,909     PASS
simplify_internships     18,966    18,966        18,966     PASS
vanshb03_newgrad         565       565           565        PASS
vanshb03_internships     949       949           949        PASS
ambicuity                1,019     1,019         1,019      PASS
speedyapply_ai_newgrad   37        37            37         PASS
speedyapply_swe_newgrad  251       251           251        PASS
jobright_swe             624       624           624        PASS
jobright_data            340       340           340        PASS
jobright_business        52        52            52         PASS
jobright_design          228       228           228        PASS
jobright_marketing       1,025     1,025         1,025      PASS
jobright_accounting      2,364     2,364         2,364      PASS
jobright_pm              131       131           131        PASS
zapplyjobs               2,683     2,683         2,683      PASS
hackernews               381       381           381        PASS
greenhouse               7,239     7,239         7,239      PASS
ashby                    11,843    11,843        11,843     PASS
lever                    1,997     1,997         1,997      PASS
workday                  2,746     2,746         2,746      PASS
workable                 1,468     1,468         1,468      PASS
recruitee                1,100     1,100         1,100      PASS
adzuna                   1,108     1,108         1,108      PASS
dice                     5,069     5,069         5,069      PASS
builtin                  529       529           529        PASS
workatastartup           34        34            34         PASS
remoteok                 35        35            35         PASS
arbeitnow                404       404           404        PASS
themuse                  10        10            10         PASS
jobspy                   576       576           576        PASS
breezy                   48        48            48         PASS
jazzhr                   83        83            83         PASS
jobvite                  48        48            48         PASS
oraclecloud              88        88            88         PASS
personio                 177       177           177        PASS
usajobs                  213       213           213        PASS

SKIPPED — known broken:    smartrecruiters, icims, careerjet, simplyhired
SKIPPED — confirmed stubs: jobright, bamboohr, dice-rss, handshake, indeed,
                            levels, linkedin, otta, rippling, wellfound, ziprecruiter

────────────────────────────────────────────────────────────────
FIXED DURING AUDIT:
  - [source]: [error]. Fixed by [change]. Now returns [N].

UNFIXABLE:
  - [source]: [error] — tried [X, Y, Z] — next step: [action for human]

WARNINGS:
  - [source]: scraped [N] vs threshold [T] — [reason if known]

────────────────────────────────────────────────────────────────
Active sources audited: 36
PASS: X  WARN: X  FAIL: X  FIXED: X  SKIPPED: 15
Total jobs uploaded this audit: X

FINAL SUMMARY
─────────────
Total jobs across all active sources: X
Underperforming sources (below threshold): [list or "None ✓"]
Broken sources fixed this run: [list or "None"]
Action required: [list any unfixable sources or "None — all systems healthy ✓"]
═════════════════════════════════════════════════════════════════
```

---

## Key Architecture Reference

- **Dedup hash:** `md5(lowercase(company) + '|' + lowercase(title) + '|' + lowercase(location))` — `scrapers/utils/dedup.ts`
- **Role inference:** `inferRoles(title)` in `scrapers/utils/normalize.ts` — `[]` if no match (fine, appears under "All")
- **Experience level:** GitHub scrapers hardcode (e.g. `'new_grad' as const`) — job boards use `inferExperienceLevel()`
- **USA detection:** `isUsaLocation(location)` in `scrapers/utils/normalize.ts` — sets `is_usa` boolean
- **Upload chunks:** 50 rows max — never increase on nano compute
- **Cross-source dedup:** same `dedup_hash` from different source → keep newer `posted_at`, always set `is_active = true`
- **Stale deactivation:** `deactivateStaleJobs(sourceName, activeDedupHashes)` — run after every upload
- **Caches:** `scrapers/cache/ashby-valid-slugs.json`, `scrapers/cache/workday-dead.json`

## Common Failure Patterns

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `fetch failed` / timeout | Transient | Re-run once; if persists check endpoint |
| HTTP 403 / 429 | Rate limited or IP blocked | Add delay, check API key expiry |
| HTTP 404 | Endpoint URL changed | Check platform docs, update URL |
| 0 jobs, no error | Filter too aggressive | Log intermediate counts, loosen filter |
| JSON parse error | API response format changed | Log raw response, update parser |
| GitHub raw 404 | Branch renamed (dev→main) | Check repo on github.com, update RAW_URL |
| Cloudflare block | Bot detection | Use Playwright fallback if available |
| P1 count ≠ P2 uploaded | Dedup collisions or upload chunk error | Check upload stats object for errors |
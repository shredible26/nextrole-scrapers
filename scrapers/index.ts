import { scrapePittCSC }             from './sources/pittcsc';
import { scrapeSimplifyInternships } from './sources/simplify-internships';
import { scrapeVanshb03Newgrad }     from './sources/vanshb03-newgrad';
import { scrapeVanshb03Internships } from './sources/vanshb03-internships';
import { scrapeAmbicuity }           from './sources/ambicuity';
import { scrapeSpeedyapplySwe }      from './sources/speedyapply-swe';
import { scrapeSpeedyapplyAi }       from './sources/speedyapply-ai';
import { scrapeSpeedyapplyAiNewgrad } from './sources/speedyapply-ai-newgrad';
import { scrapeSpeedyApplySWENewGrad } from './sources/speedyapply-swe-newgrad';
import { scrapeJobrightSwe }         from './sources/jobright-swe';
import { scrapeJobrightData }        from './sources/jobright-data';
import { scrapeZapplyjobs }          from './sources/zapplyjobs';
import { scrapeHackerNews }          from './sources/hackernews';
import { scrapeAdzuna }              from './sources/adzuna';
import { scrapeRemoteOK }            from './sources/remoteok';
import { scrapeArbeitnow }           from './sources/arbeitnow';
import { scrapeTheMuse }             from './sources/themuse';
import { scrapeJobSpy }              from './sources/jobspy';
import { scrapeGreenhouse }          from './sources/greenhouse';
import { scrapeLever }               from './sources/lever';
import { scrapeWorkday }             from './sources/workday';
import { scrapeWorkable }            from './sources/workable';
import { scrapeSmartRecruiters }     from './sources/smartrecruiters';
import { scrapeZipRecruiter }        from './sources/ziprecruiter';
import { scrapeGlassdoor }           from './sources/glassdoor';
import { scrapeCareerjet }           from './sources/careerjet';
import { scrapeWorkAtAStartup }      from './sources/workatastartup';
import { scrapeBuiltIn }             from './sources/builtin';
import { scrapeWellfound }           from './sources/wellfound';
import { scrapeDice }                from './sources/dice';
import { scrapeSimplyHired }         from './sources/simplyhired';
import { scrapeHandshake }           from './sources/handshake';
import { scrapeAshby }              from './sources/ashby';
import { scrapeBambooHR }           from './sources/bamboohr';
import { scrapeRippling }           from './sources/rippling';
import { scrapeDiceRss }            from './sources/dice-rss';
import { scrapeUSAJobs }            from './sources/usajobs';
import { uploadJobs, deactivateStaleJobs } from './utils/upload';
import { NormalizedJob } from './utils/normalize';
import { GITHUB_REPO_SOURCE_SET } from '../lib/source-groups';

const SCRAPERS: { name: string; fn: () => Promise<NormalizedJob[]> }[] = [
  // Week 1 — active
  { name: 'pittcsc',               fn: scrapePittCSC },
  { name: 'simplify_internships',  fn: scrapeSimplifyInternships },
  { name: 'vanshb03_newgrad',      fn: scrapeVanshb03Newgrad },
  { name: 'vanshb03_internships',  fn: scrapeVanshb03Internships },
  { name: 'ambicuity',             fn: scrapeAmbicuity },
  { name: 'speedyapply_swe',       fn: scrapeSpeedyapplySwe },
  { name: 'speedyapply_ai',        fn: scrapeSpeedyapplyAi },
  { name: 'speedyapply_ai_newgrad', fn: scrapeSpeedyapplyAiNewgrad },
  { name: 'speedyapply_swe_newgrad', fn: scrapeSpeedyApplySWENewGrad },
  { name: 'jobright_swe',          fn: scrapeJobrightSwe },
  { name: 'jobright_data',         fn: scrapeJobrightData },
  { name: 'zapplyjobs',            fn: scrapeZapplyjobs },
  { name: 'hackernews',            fn: scrapeHackerNews },
  { name: 'adzuna',                fn: scrapeAdzuna },
  { name: 'remoteok',             fn: scrapeRemoteOK },
  { name: 'arbeitnow',            fn: scrapeArbeitnow },
  { name: 'themuse',              fn: scrapeTheMuse },
  { name: 'jobspy',               fn: scrapeJobSpy },
  { name: 'greenhouse',           fn: scrapeGreenhouse },
  { name: 'lever',                fn: scrapeLever },
  { name: 'workday',              fn: scrapeWorkday },
  { name: 'workable',             fn: scrapeWorkable },
  { name: 'smartrecruiters',      fn: scrapeSmartRecruiters },
  { name: 'ziprecruiter',         fn: scrapeZipRecruiter },
  { name: 'glassdoor',            fn: scrapeGlassdoor },
  { name: 'careerjet',            fn: scrapeCareerjet },
  { name: 'workatastartup',       fn: scrapeWorkAtAStartup },
  { name: 'builtin',              fn: scrapeBuiltIn },
  { name: 'wellfound',            fn: scrapeWellfound },
  { name: 'dice',                 fn: scrapeDice },
  { name: 'simplyhired',          fn: scrapeSimplyHired },
  { name: 'handshake',            fn: scrapeHandshake },
  { name: 'ashby',               fn: scrapeAshby },
  { name: 'bamboohr',            fn: scrapeBambooHR },
  { name: 'rippling',            fn: scrapeRippling },
  { name: 'dice_rss',            fn: scrapeDiceRss },
  { name: 'usajobs',             fn: scrapeUSAJobs },
  // Week 2 (uncomment when ready):
  // { name: 'jobright',          fn: scrapeJobright },
  // { name: 'otta',              fn: scrapeOtta },
  // { name: 'levels',            fn: scrapeLevels },
  // Week 3 (requires proxy):
  // { name: 'linkedin',          fn: scrapeLinkedIn },
  // { name: 'indeed',            fn: scrapeIndeed },
  // { name: 'handshake',         fn: scrapeHandshake },
  // (wellfound + dice are now active above)
];

const SKIPPABLE_SLOW_SOURCE_SET = new Set([
  'ziprecruiter',
  'glassdoor',
  'wellfound',
  'handshake',
  'bamboohr',
  'dice_rss',
  'rippling',
]);

type FetchResult =
  | {
      name: string;
      jobs: NormalizedJob[];
      success: true;
      startedAt: number;
    }
  | {
      name: string;
      jobs: [];
      success: false;
      startedAt: number;
    };

const DEFAULT_SCRAPER_TIMEOUT_MS = 120_000;

function getScraperTimeoutMs(name: string): number {
  switch (name) {
    case 'simplyhired':
      return 90_000;
    case 'workday':
      return 300_000;
    case 'workable':
      return 120_000;
    default:
      return DEFAULT_SCRAPER_TIMEOUT_MS;
  }
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  name: string,
): Promise<T | []> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      fn(),
      new Promise<[]>(resolve => {
        timeoutId = setTimeout(() => {
          console.warn(`  [${name}] timed out after ${timeoutMs / 1000}s`);
          resolve([]);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function dedupeGitHubRepoJobs(results: FetchResult[]): FetchResult[] {
  const seenUrls = new Set<string>();

  return results.map(result => {
    if (!result.success || !GITHUB_REPO_SOURCE_SET.has(result.name)) {
      return result;
    }

    const dedupedJobs: NormalizedJob[] = [];
    let removed = 0;

    for (const job of result.jobs) {
      const key = normalizeUrl(job.url);
      if (!key) {
        dedupedJobs.push(job);
        continue;
      }

      if (seenUrls.has(key)) {
        removed += 1;
        continue;
      }

      seenUrls.add(key);
      dedupedJobs.push(job);
    }

    if (removed > 0) {
      console.log(
        `  [${result.name}] Deduped ${removed} URL duplicates against earlier GitHub repo sources`,
      );
    }

    return { ...result, jobs: dedupedJobs };
  });
}

function getActiveScrapers() {
  const skipSlowSources = (process.env.SKIP_SLOW_SOURCES ?? '').toLowerCase() === 'true';
  if (!skipSlowSources) {
    return { scrapers: SCRAPERS, skipped: [] as string[] };
  }

  const skipped: string[] = [];
  const scrapers = SCRAPERS.filter(({ name }) => {
    const shouldSkip = SKIPPABLE_SLOW_SOURCE_SET.has(name);
    if (shouldSkip) {
      skipped.push(name);
    }
    return !shouldSkip;
  });

  return { scrapers, skipped };
}

async function persistScraper(result: FetchResult) {
  if (!result.success) {
    return { name: result.name, count: 0, success: false, elapsed: ((Date.now() - result.startedAt) / 1000).toFixed(1) };
  }

  try {
    const uploadStats = await uploadJobs(result.jobs);
    let staleCount = 0;

    // jobspy jobs carry per-site sources (e.g. jobspy_indeed) so we can't
    // deactivate stale entries by the orchestrator-level name 'jobspy'.
    if (result.name !== 'jobspy') {
      staleCount = await deactivateStaleJobs(result.name, result.jobs.map(job => job.dedup_hash));
    }

    if (result.name === 'workday') {
      console.log(`  [workday] Upserted ${uploadStats.upserted} jobs; marked ${staleCount} stale`);
    }

    const elapsed = ((Date.now() - result.startedAt) / 1000).toFixed(1);
    console.log(`  [${result.name}] ✓ Done in ${elapsed}s`);

    return { name: result.name, count: result.jobs.length, success: true, elapsed };
  } catch (err) {
    const elapsed = ((Date.now() - result.startedAt) / 1000).toFixed(1);
    console.error(`  [${result.name}] ✗ Failed after ${elapsed}s:`, (err as Error).message);
    return { name: result.name, count: 0, success: false, elapsed };
  }
}

async function fetchScraper(name: string, fn: () => Promise<NormalizedJob[]>) {
  const start = Date.now();
  console.log(`  [${name}] Starting...`);

  try {
    const jobs = await withTimeout(fn, getScraperTimeoutMs(name), name);
    console.log(`  [${name}] Fetched ${jobs.length} jobs`);
    return { name, jobs, success: true, startedAt: start } satisfies FetchResult;
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`  [${name}] ✗ Fetch failed after ${elapsed}s:`, (err as Error).message);
    return { name, jobs: [], success: false, startedAt: start } satisfies FetchResult;
  }
}

async function run() {
  const { scrapers, skipped } = getActiveScrapers();

  console.log(`\n🚀 NextRole scrape run — ${new Date().toISOString()}`);
  console.log(`   Running ${scrapers.length} scrapers concurrently...`);
  if (skipped.length > 0) {
    console.log(`   Skipping ${skipped.length} slow sources via SKIP_SLOW_SOURCES=true: ${skipped.join(', ')}`);
  }
  console.log('');

  const globalStart = Date.now();

  const fetched = await Promise.allSettled(
    scrapers.map(({ name, fn }) => fetchScraper(name, fn))
  );

  const fetchResults: FetchResult[] = fetched.map((result, index): FetchResult =>
    result.status === 'fulfilled'
      ? result.value
      : {
          name: scrapers[index]?.name ?? 'unknown',
          jobs: [],
          success: false,
          startedAt: Date.now(),
        },
  );

  const dedupedResults = dedupeGitHubRepoJobs(fetchResults);
  const summary = [];

  for (const result of dedupedResults) {
    summary.push(await persistScraper(result));
  }

  // Summarize
  const totalElapsed = ((Date.now() - globalStart) / 1000).toFixed(1);

  console.log('\n─── Scrape Summary ───────────────────────────────');
  for (const s of summary) {
    const icon = s.success ? '✓' : '✗';
    console.log(`  ${icon} ${s.name.padEnd(22)} ${s.success ? `${s.count} jobs` : 'FAILED'}`);
  }
  console.log(`\n  Total jobs processed: ${summary.reduce((acc, s) => acc + s.count, 0)}`);
  console.log(`  Wall time: ${totalElapsed}s`);
  console.log('──────────────────────────────────────────────────\n');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

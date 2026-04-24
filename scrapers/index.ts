import { scrapePittCSC }             from './sources/pittcsc';
import { scrapeSimplifyInternships } from './sources/simplify-internships';
import { scrapeVanshb03Newgrad }     from './sources/vanshb03-newgrad';
import { scrapeVanshb03Internships } from './sources/vanshb03-internships';
import { scrapeAmbicuity }           from './sources/ambicuity';
import { scrapeSpeedyapplyAiNewgrad } from './sources/speedyapply-ai-newgrad';
import { scrapeSpeedyApplySWENewGrad } from './sources/speedyapply-swe-newgrad';
import { scrapeJobrightSwe }         from './sources/jobright-swe';
import { scrapeJobrightData }        from './sources/jobright-data';
import { scrapeJobrightBusiness }    from './sources/jobright-business';
import { scrapeJobrightDesign }      from './sources/jobright-design';
import { scrapeJobrightMarketing }   from './sources/jobright-marketing';
import { scrapeJobrightAccounting }  from './sources/jobright-accounting';
import { scrapeJobrightPm }          from './sources/jobright-pm';
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
import { scrapeRecruitee }           from './sources/recruitee';
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
import { scrapeBreezy }            from './sources/breezy';
import { scrapePersonio }           from './sources/personio';
import { scrapeIcims }             from './sources/icims';
import { scrapeJazzHr }            from './sources/jazzhr';
import { scrapeJobvite }           from './sources/jobvite';
import { scrapeOracleCloud }       from './sources/oracle-cloud';
// Rippling disabled: Next.js build IDs change on
// every deployment, breaking this scraper. Only
// ever returned 2 jobs. Re-enable if stable API found.
// import { scrapeRippling } from './sources/rippling';
import { scrapeDiceRss }            from './sources/dice-rss';
import { scrapeUSAJobs }            from './sources/usajobs';
import { uploadJobs, deactivateStaleJobs, countActiveJobsForSource } from './utils/upload';
import { NormalizedJob } from './utils/normalize';
import { GITHUB_REPO_SOURCE_SET } from '../lib/source-groups';

const SCRAPERS: { name: string; fn: () => Promise<NormalizedJob[]> }[] = [
  // Week 1 — active
  { name: 'pittcsc',               fn: scrapePittCSC },
  { name: 'simplify_internships',  fn: scrapeSimplifyInternships },
  { name: 'vanshb03_newgrad',      fn: scrapeVanshb03Newgrad },
  { name: 'vanshb03_internships',  fn: scrapeVanshb03Internships },
  { name: 'ambicuity',             fn: scrapeAmbicuity },
  { name: 'speedyapply_ai_newgrad', fn: scrapeSpeedyapplyAiNewgrad },
  { name: 'speedyapply_swe_newgrad', fn: scrapeSpeedyApplySWENewGrad },
  { name: 'jobright_swe',          fn: scrapeJobrightSwe },
  { name: 'jobright_data',         fn: scrapeJobrightData },
  { name: 'jobright_business',     fn: scrapeJobrightBusiness },
  { name: 'jobright_design',       fn: scrapeJobrightDesign },
  { name: 'jobright_marketing',    fn: scrapeJobrightMarketing },
  { name: 'jobright_accounting',   fn: scrapeJobrightAccounting },
  { name: 'jobright_pm',           fn: scrapeJobrightPm },
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
  { name: 'recruitee',            fn: scrapeRecruitee },
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
  { name: 'breezy',             fn: scrapeBreezy },
  { name: 'icims',              fn: scrapeIcims },
  { name: 'jazzhr',             fn: scrapeJazzHr },
  { name: 'jobvite',            fn: scrapeJobvite },
  { name: 'oraclecloud',        fn: scrapeOracleCloud },
  { name: 'personio',            fn: scrapePersonio },
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

const PRIORITY_SCRAPERS = ['lever', 'workday', 'workable'] as const;
const PRIORITY_SCRAPER_SET = new Set<string>(PRIORITY_SCRAPERS);

const SKIPPABLE_SLOW_SOURCE_SET = new Set([
  'ziprecruiter',
  'glassdoor',
  'wellfound',
  'handshake',
  'bamboohr',
  'dice_rss',
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

type PersistResult = {
  name: string;
  count: number;
  success: boolean;
  elapsed: string;
  freshHashes: string[];
};

const DEFAULT_SCRAPER_TIMEOUT_MS = 120_000;

function getScraperTimeoutMs(name: string): number {
  switch (name) {
    case 'ashby':
      return 900_000;
    case 'lever':
      return 600_000;
    case 'simplyhired':
      return 90_000;
    case 'workday':
      return 480_000;
    case 'workable':
      return 180_000;
    case 'recruitee':
      return 300_000;
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
    return {
      name: result.name,
      count: 0,
      success: false,
      elapsed: ((Date.now() - result.startedAt) / 1000).toFixed(1),
      freshHashes: [],
    } satisfies PersistResult;
  }

  try {
    await uploadJobs(result.jobs);

    const elapsed = ((Date.now() - result.startedAt) / 1000).toFixed(1);
    console.log(`  [${result.name}] ✓ Done in ${elapsed}s`);

    return {
      name: result.name,
      count: result.jobs.length,
      success: true,
      elapsed,
      freshHashes: result.jobs.map(job => job.dedup_hash),
    } satisfies PersistResult;
  } catch (err) {
    const elapsed = ((Date.now() - result.startedAt) / 1000).toFixed(1);
    console.error(`  [${result.name}] ✗ Failed after ${elapsed}s:`, (err as Error).message);
    return {
      name: result.name,
      count: 0,
      success: false,
      elapsed,
      freshHashes: [],
    } satisfies PersistResult;
  }
}

async function fetchScraper(
  name: string,
  fn: () => Promise<NormalizedJob[]>,
  options?: { useTimeout?: boolean },
) {
  const start = Date.now();
  console.log(`  [${name}] Starting...`);

  try {
    const jobs =
      options?.useTimeout === false
        ? await fn()
        : await withTimeout(fn, getScraperTimeoutMs(name), name);
    console.log(`  [${name}] Fetched ${jobs.length} jobs`);
    return { name, jobs, success: true, startedAt: start } satisfies FetchResult;
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`  [${name}] ✗ Fetch failed after ${elapsed}s:`, (err as Error).message);
    return { name, jobs: [], success: false, startedAt: start } satisfies FetchResult;
  }
}

function getRejectedFetchResult(name: string): FetchResult {
  return {
    name,
    jobs: [],
    success: false,
    startedAt: Date.now(),
  };
}

async function run() {
  const { scrapers, skipped } = getActiveScrapers();
  const priorityScrapers = scrapers.filter(({ name }) => PRIORITY_SCRAPER_SET.has(name));
  const remainingScrapers = scrapers.filter(({ name }) => !PRIORITY_SCRAPER_SET.has(name));

  console.log(`\n🚀 NextRole scrape run — ${new Date().toISOString()}`);
  console.log(
    `   Running ${scrapers.length} scrapers in 2 phases ` +
      `(${priorityScrapers.length} priority sequential, ${remainingScrapers.length} concurrent)...`,
  );
  if (skipped.length > 0) {
    console.log(`   Skipping ${skipped.length} slow sources via SKIP_SLOW_SOURCES=true: ${skipped.join(', ')}`);
  }
  console.log('');

  const globalStart = Date.now();
  const fetchResultsByName = new Map<string, FetchResult>();

  console.log('  [pipeline] Phase 1: Running priority scrapers sequentially...');
  for (const { name, fn } of priorityScrapers) {
    const result = await fetchScraper(name, fn, { useTimeout: name !== 'workday' });
    fetchResultsByName.set(name, result);
  }

  console.log('  [pipeline] Phase 1 complete. Starting Phase 2: concurrent scrapers...');
  const concurrentFetched = await Promise.allSettled(
    remainingScrapers.map(({ name, fn }) => fetchScraper(name, fn))
  );

  concurrentFetched.forEach((result, index) => {
    const name = remainingScrapers[index]?.name ?? 'unknown';
    fetchResultsByName.set(
      name,
      result.status === 'fulfilled' ? result.value : getRejectedFetchResult(name),
    );
  });

  const fetchResults: FetchResult[] = scrapers.map(
    ({ name }) => fetchResultsByName.get(name) ?? getRejectedFetchResult(name),
  );

  const dedupedResults = dedupeGitHubRepoJobs(fetchResults);
  const summary: PersistResult[] = [];

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

  const deactivationTargets = summary.filter(
    result => result.success && result.name !== 'jobspy',
  );

  console.log(`Starting stale job deactivation for ${deactivationTargets.length} sources...`);

  const deactivationStart = Date.now();
  let totalDeactivated = 0;

  for (const target of deactivationTargets) {
    if (target.freshHashes.length === 0) {
      try {
        const activeCount = await countActiveJobsForSource(target.name);
        if (activeCount > 0) {
          console.warn(
            `[${target.name}] ⚠ Returned 0 jobs but has ${activeCount} active jobs in DB. Skipping deactivation as a precaution.`,
          );
          continue;
        }
      } catch (error) {
        console.warn(
          `[${target.name}] ⚠ Failed to verify active job count after 0-job scrape: ${(error as Error).message}. Skipping deactivation as a precaution.`,
        );
        continue;
      }
    }

    totalDeactivated += await deactivateStaleJobs(target.name, target.freshHashes);
  }

  const deactivationElapsed = ((Date.now() - deactivationStart) / 1000).toFixed(1);
  console.log(`All deactivation complete. Total wall time: ${deactivationElapsed}s`);
  console.log(
    `Deactivation complete. Total deactivated: ${totalDeactivated} jobs across ${deactivationTargets.length} sources.`,
  );
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

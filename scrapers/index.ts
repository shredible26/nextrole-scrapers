import { scrapePittCSC }             from './sources/pittcsc';
import { scrapeSimplifyInternships } from './sources/simplify-internships';
import { scrapeVanshb03Newgrad }     from './sources/vanshb03-newgrad';
import { scrapeVanshb03Internships } from './sources/vanshb03-internships';
import { scrapeAmbicuity }           from './sources/ambicuity';
import { scrapeSpeedyapplySwe }      from './sources/speedyapply-swe';
import { scrapeSpeedyapplyAi }       from './sources/speedyapply-ai';
import { scrapeAdzuna }              from './sources/adzuna';
import { scrapeRemoteOK }            from './sources/remoteok';
import { scrapeArbeitnow }           from './sources/arbeitnow';
import { scrapeTheMuse }             from './sources/themuse';
import { scrapeJobSpy }              from './sources/jobspy';
import { scrapeGreenhouse }          from './sources/greenhouse';
import { scrapeLever }               from './sources/lever';
import { scrapeWorkday }             from './sources/workday';
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

const SCRAPERS: { name: string; fn: () => Promise<NormalizedJob[]> }[] = [
  // Week 1 — active
  { name: 'pittcsc',               fn: scrapePittCSC },
  { name: 'simplify_internships',  fn: scrapeSimplifyInternships },
  { name: 'vanshb03_newgrad',      fn: scrapeVanshb03Newgrad },
  { name: 'vanshb03_internships',  fn: scrapeVanshb03Internships },
  { name: 'ambicuity',             fn: scrapeAmbicuity },
  { name: 'speedyapply_swe',       fn: scrapeSpeedyapplySwe },
  { name: 'speedyapply_ai',        fn: scrapeSpeedyapplyAi },
  { name: 'adzuna',                fn: scrapeAdzuna },
  { name: 'remoteok',             fn: scrapeRemoteOK },
  { name: 'arbeitnow',            fn: scrapeArbeitnow },
  { name: 'themuse',              fn: scrapeTheMuse },
  { name: 'jobspy',               fn: scrapeJobSpy },
  { name: 'greenhouse',           fn: scrapeGreenhouse },
  { name: 'lever',                fn: scrapeLever },
  { name: 'workday',              fn: scrapeWorkday },
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

let persistQueue: Promise<void> = Promise.resolve();

function enqueuePersistence<T>(task: () => Promise<T>): Promise<T> {
  const next = persistQueue.then(task, task);
  persistQueue = next.then(() => undefined, () => undefined);
  return next;
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

async function runScraper(name: string, fn: () => Promise<NormalizedJob[]>) {
  const start = Date.now();
  console.log(`  [${name}] Starting...`);

  try {
    const jobs = await fn();
    console.log(`  [${name}] Fetched ${jobs.length} jobs`);
    return await enqueuePersistence(() =>
      persistScraper({ name, jobs, success: true, startedAt: start }),
    );
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`  [${name}] ✗ Fetch failed after ${elapsed}s:`, (err as Error).message);
    return { name, count: 0, success: false, elapsed };
  }
}

async function run() {
  console.log(`\n🚀 NextRole scrape run — ${new Date().toISOString()}`);
  console.log(`   Running ${SCRAPERS.length} scrapers concurrently...\n`);

  const globalStart = Date.now();

  const results = await Promise.allSettled(
    SCRAPERS.map(({ name, fn }) => runScraper(name, fn))
  );

  // Summarize
  const totalElapsed = ((Date.now() - globalStart) / 1000).toFixed(1);
  const summary = results.map(r =>
    r.status === 'fulfilled' ? r.value : { name: 'unknown', count: 0, success: false }
  );

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

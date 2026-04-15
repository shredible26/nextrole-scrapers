// Source: https://www.themuse.com/api/public/jobs
// Public API — optional key for higher rate limits. Entry-level focused.
// Filters by category only (level filter was causing 0 results).

import { pathToFileURL } from 'node:url';

import { generateHash } from '../utils/dedup';
import { inferRoles, inferRemote, NormalizedJob } from '../utils/normalize';
import {
  cleanScrapedDescription,
  fetchWithTimeout,
  mapInBatches,
} from '../utils/scraper-helpers';

const CATEGORIES = ['Engineering', 'Data Science', 'IT', 'Product'];
const BASE = 'https://www.themuse.com/api/public/jobs';
const DETAIL_BATCH_SIZE = 5;
const DETAIL_BATCH_DELAY_MS = 500;
const DETAIL_REQUEST_TIMEOUT_MS = 10_000;

type TheMuseSummaryJob = {
  id?: number;
  name?: string;
  publication_date?: string;
  locations?: Array<{ name?: string }>;
  refs?: { landing_page?: string };
  company?: { name?: string };
};

type TheMuseCategoryResponse = {
  results?: TheMuseSummaryJob[];
};

type TheMuseDetailResponse = {
  contents?: string;
};

type TheMusePendingJob = {
  job: NormalizedJob;
  detailId: number;
};

async function fetchTheMuseDescription(detailId: number): Promise<string> {
  const url = new URL(`${BASE}/${detailId}`);
  if (process.env.MUSE_API_KEY) {
    url.searchParams.set('api_key', process.env.MUSE_API_KEY);
  }

  const response = await fetchWithTimeout(url.toString(), { method: 'GET' }, DETAIL_REQUEST_TIMEOUT_MS);
  if (!response?.ok) return '';

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return '';

  try {
    const detail = await response.json() as TheMuseDetailResponse;
    return cleanScrapedDescription(detail.contents);
  } catch {
    return '';
  }
}

export async function scrapeTheMuse(): Promise<NormalizedJob[]> {
  const results: TheMusePendingJob[] = [];

  for (const category of CATEGORIES) {
    try {
      const url = new URL(BASE);
      url.searchParams.set('category', category);
      url.searchParams.set('page', '0');
      if (process.env.MUSE_API_KEY) {
        url.searchParams.set('api_key', process.env.MUSE_API_KEY);
      }

      const res = await fetch(url.toString());
      if (!res.ok) {
        console.warn(`  ⚠ TheMuse category "${category}" returned HTTP ${res.status}`);
        continue;
      }

      const data = await res.json() as TheMuseCategoryResponse;
      const rawCount = data.results?.length ?? 0;
      console.log(`  → TheMuse [${category}]: ${rawCount} raw results`);

      for (const job of data.results ?? []) {
        if (typeof job.id !== 'number') continue;

        const location = job.locations?.[0]?.name ?? '';
        results.push({
          job: {
            source: 'themuse',
            source_id: String(job.id),
            title: job.name ?? '',
            company: job.company?.name ?? 'Unknown',
            location,
            remote: inferRemote(location),
            url: job.refs?.landing_page ?? '',
            description: '',
            experience_level: 'entry_level',
            roles: inferRoles(job.name ?? ''),
            posted_at: job.publication_date,
            dedup_hash: generateHash(
              job.company?.name ?? '',
              job.name ?? '',
              location,
            ),
          },
          detailId: job.id,
        });
      }

      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      console.warn(`  ⚠ TheMuse category "${category}" failed:`, err);
    }
  }

  const jobs = await mapInBatches(
    results,
    DETAIL_BATCH_SIZE,
    DETAIL_BATCH_DELAY_MS,
    async (result) => ({
      ...result.job,
      description: await fetchTheMuseDescription(result.detailId),
    }),
  );

  console.log(
    `  [themuse] Jobs with description: ${
      jobs.filter(job => job.description?.trim()).length
    }/${jobs.length}`,
  );

  return jobs;
}

async function runStandalone(): Promise<void> {
  const startedAt = Date.now();
  const jobs = await scrapeTheMuse();
  const jobsWithDescription = jobs.filter(job => job.description?.trim()).length;
  const elapsedSeconds = ((Date.now() - startedAt) / 1_000).toFixed(1);

  console.log(`  [themuse] Standalone final count: ${jobs.length}`);
  console.log(`  [themuse] Standalone descriptions: ${jobsWithDescription}/${jobs.length}`);
  console.log(`  [themuse] Standalone run completed in ${elapsedSeconds}s`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runStandalone().catch((error) => {
    console.error('  [themuse] Standalone run failed', error);
    process.exit(1);
  });
}

// Source: https://developer.adzuna.com/
// Free API tier — register for app_id + app_key (takes 2 minutes).
// Returns real job listings, legally, with salary data.

import { generateHash } from '../utils/dedup';
import { inferRoles, inferRemote, inferExperienceLevel, NormalizedJob } from '../utils/normalize';

const BASE = 'https://api.adzuna.com/v1/api/jobs/us/search';

const SEARCH_TERMS = [
  'software engineer new grad',
  'software engineer entry level',
  'data scientist new grad',
  'machine learning engineer entry level',
  'data analyst entry level',
  'software engineer',
  'data engineer',
  'frontend engineer',
  'backend engineer',
  'data analyst',
  'product manager entry level',
  'machine learning engineer',
  'AI engineer',
  'full stack engineer',
  'junior software engineer',
  'junior developer',
  'associate engineer',
];

const PAGES = [1, 2];

export async function scrapeAdzuna(): Promise<NormalizedJob[]> {
  if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) {
    console.warn('  ⚠ Adzuna: no API keys configured, skipping');
    return [];
  }

  const results: NormalizedJob[] = [];
  const seenIds = new Set<string>();

  for (const term of SEARCH_TERMS) {
    for (const page of PAGES) {
      try {
        const url = new URL(`${BASE}/${page}`);
        url.searchParams.set('app_id', process.env.ADZUNA_APP_ID);
        url.searchParams.set('app_key', process.env.ADZUNA_APP_KEY);
        url.searchParams.set('what', term);
        url.searchParams.set('results_per_page', '50');
        url.searchParams.set('content-type', 'application/json');

        const res = await fetch(url.toString());
        const data = await res.json();

        for (const job of data.results ?? []) {
          if (seenIds.has(job.id)) continue;
          seenIds.add(job.id);

          const location = job.location?.display_name ?? '';
          const level = inferExperienceLevel(job.title ?? '', job.description ?? '');
          if (level === null) continue;

          results.push({
            source: 'adzuna',
            source_id: job.id,
            title: job.title,
            company: job.company?.display_name ?? 'Unknown',
            location,
            remote: inferRemote(location),
            url: job.redirect_url ? `${job.redirect_url}&utm_source=nextrole` : job.redirect_url,
            description: job.description,
            salary_min: job.salary_min ? Math.round(job.salary_min) : undefined,
            salary_max: job.salary_max ? Math.round(job.salary_max) : undefined,
            experience_level: level,
            roles: inferRoles(job.title),
            posted_at: job.created,
            dedup_hash: generateHash(job.company?.display_name ?? '', job.title, location),
          });
        }

        await new Promise(r => setTimeout(r, 500)); // be polite between requests
      } catch (err) {
        console.warn(`  ⚠ Adzuna term "${term}" page ${page} failed:`, err);
      }
    }
  }

  return results;
}

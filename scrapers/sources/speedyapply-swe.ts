// Source: https://github.com/speedyapply/2026-SWE-College-Jobs
// Method: Raw GitHub JSON — same pittcsc format.
// Tries primary URL first; falls back to alternate path on 404.

import { generateHash } from '../utils/dedup';
import { inferRoles, inferExperienceLevel, NormalizedJob } from '../utils/normalize';

const PRIMARY_URL =
  'https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main/.github/scripts/listings.json';
const FALLBACK_URL =
  'https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main/.github/workflows/listings.json';

export async function scrapeSpeedyapplySwe(): Promise<NormalizedJob[]> {
  let res = await fetch(PRIMARY_URL);
  if (res.status === 404) {
    res = await fetch(FALLBACK_URL);
  }
  if (res.status === 404) {
    console.warn('  ⚠ speedyapply_swe: both URLs returned 404, skipping');
    return [];
  }
  if (!res.ok) throw new Error(`speedyapply_swe fetch failed: ${res.status}`);
  const listings = await res.json();

  const jobs: NormalizedJob[] = [];
  for (const job of listings.filter((j: any) => j.active !== false)) {
    const level = inferExperienceLevel(job.title);
    if (level === null) continue; // excluded senior/management role
    const location = job.locations?.[0] ?? 'Remote';
    const remote = job.locations?.some((l: string) => l.toLowerCase().includes('remote')) ?? false;
    jobs.push({
      source: 'speedyapply_swe',
      source_id: job.id,
      title: job.title,
      company: job.company_name,
      location,
      remote,
      url: job.url,
      experience_level: level,
      roles: inferRoles(job.title),
      posted_at: job.date_posted
        ? new Date(job.date_posted * 1000).toISOString()
        : new Date().toISOString(),
      dedup_hash: generateHash(job.company_name, job.title, location),
    });
  }
  return jobs;
}

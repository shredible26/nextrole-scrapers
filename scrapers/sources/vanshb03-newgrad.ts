// Source: https://github.com/vanshb03/New-Grad-2026
// Method: Raw GitHub JSON — same pittcsc format.
// Experience level: 'internship' if title signals it, otherwise 'new_grad'.

import { generateHash } from '../utils/dedup';
import { inferRoles, inferExperienceLevel, NormalizedJob } from '../utils/normalize';

const RAW_URL =
  'https://raw.githubusercontent.com/vanshb03/New-Grad-2026/dev/.github/scripts/listings.json';

export async function scrapeVanshb03Newgrad(): Promise<NormalizedJob[]> {
  const res = await fetch(RAW_URL);
  if (!res.ok) throw new Error(`vanshb03 newgrad fetch failed: ${res.status}`);
  const listings = await res.json();

  return listings
    .filter((job: any) => job.active !== false)
    .map((job: any) => {
      const location = job.locations?.[0] ?? 'Remote';
      const remote = job.locations?.some((l: string) => l.toLowerCase().includes('remote')) ?? false;
      // Keep 'internship' if title signals it; everything else defaults to 'new_grad'
      const inferred = inferExperienceLevel(job.title);
      const experience_level = inferred === 'internship' ? 'internship' : 'new_grad';
      return {
        source: 'vanshb03_newgrad',
        source_id: job.id,
        title: job.title,
        company: job.company_name,
        location,
        remote,
        url: job.url,
        experience_level,
        roles: inferRoles(job.title),
        posted_at: job.date_posted
          ? new Date(job.date_posted * 1000).toISOString()
          : new Date().toISOString(),
        dedup_hash: generateHash(job.company_name, job.title, location),
      } satisfies NormalizedJob;
    });
}

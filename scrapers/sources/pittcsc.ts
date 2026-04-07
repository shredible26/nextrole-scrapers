// Source: https://github.com/SimplifyJobs/New-Grad-Positions
// Method: Raw GitHub JSON — no scraping, no legal risk, no rate limits.
// Data format: JSON array of job objects.

import { generateHash } from '../utils/dedup';
import { inferRoles, inferRemote, NormalizedJob } from '../utils/normalize';

const RAW_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json';

export async function scrapePittCSC(): Promise<NormalizedJob[]> {
  const res = await fetch(RAW_URL);
  if (!res.ok) throw new Error(`PittCSC fetch failed: ${res.status}`);
  const listings = await res.json();

  return listings
    .filter((job: any) => job.is_visible !== false)
    .map((job: any) => {
      const location = job.locations?.[0] ?? '';
      return {
        source: 'pittcsc',
        source_id: job.id,
        title: job.title,
        company: job.company_name,
        location,
        remote: inferRemote(location),
        url: job.url,
        description: job.notes,
        experience_level: 'new_grad' as const,
        roles: inferRoles(job.title),
        posted_at: job.date_posted ? new Date(job.date_posted * 1000).toISOString() : undefined,
        dedup_hash: generateHash(job.company_name, job.title, location),
      };
    });
}

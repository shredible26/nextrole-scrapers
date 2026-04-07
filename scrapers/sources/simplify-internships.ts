// Source: https://github.com/SimplifyJobs/Summer2026-Internships
// Same JSON format as pittcsc.ts — just different repo and experience_level.

import { generateHash } from '../utils/dedup';
import { inferRoles, inferRemote, NormalizedJob } from '../utils/normalize';

const RAW_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json';

export async function scrapeSimplifyInternships(): Promise<NormalizedJob[]> {
  const res = await fetch(RAW_URL);
  if (!res.ok) throw new Error(`Simplify internships fetch failed: ${res.status}`);
  const listings = await res.json();

  return listings
    .filter((job: any) => job.is_visible !== false)
    .map((job: any) => {
      const location = job.locations?.[0] ?? '';
      return {
        source: 'simplify_internships',
        source_id: job.id,
        title: job.title,
        company: job.company_name,
        location,
        remote: inferRemote(location),
        url: job.url,
        description: job.notes,
        experience_level: 'internship' as const,
        roles: inferRoles(job.title),
        posted_at: job.date_posted ? new Date(job.date_posted * 1000).toISOString() : undefined,
        dedup_hash: generateHash(job.company_name, job.title, location),
      };
    });
}

// Source: Rippling public job board API
// Tries two endpoint variants per company; skips silently on failure.

import { generateHash } from '../utils/dedup';
import { inferRoles, inferExperienceLevel, NormalizedJob } from '../utils/normalize';

const COMPANIES: Record<string, string> = {
  'deel': 'Deel',
  'remote': 'Remote',
  'oyster': 'Oyster',
  'papaya-global': 'Papaya Global',
  'justworks': 'Justworks',
  'lattice': 'Lattice',
  'culture-amp': 'Culture Amp',
  'leapsome': 'Leapsome',
  'betterworks': 'BetterWorks',
  '15five': '15Five',
  'reflektive': 'Reflektive',
  'small-improvements': 'Small Improvements',
  'perdoo': 'Perdoo',
  'weekdone': 'Weekdone',
  'workpath': 'Workpath',
  'hireable': 'Hireable',
  'recruitee': 'Recruitee',
  'teamtailor': 'Teamtailor',
  'homerun': 'Homerun',
  'jobvite': 'Jobvite',
  'icims': 'iCIMS',
  'smartrecruiters': 'SmartRecruiters',
  'workable': 'Workable',
  'breezyhr': 'Breezy HR',
  'jazzhr': 'JazzHR',
  'pinpoint': 'Pinpoint',
  'personio': 'Personio',
  'reachdesk': 'Reachdesk',
  'sendoso': 'Sendoso',
  'alyce': 'Alyce',
  'postal': 'Postal',
  'corporate-gift': 'CorporateGift',
  'snappy': 'Snappy',
};

const ENDPOINTS = [
  (slug: string) =>
    `https://app.rippling.com/api/ats/jobs/get_open_positions/?company=${slug}`,
  (slug: string) =>
    `https://app.rippling.com/api/career-page/get-jobs?company=${slug}`,
];

/**
 * Extract the jobs array from a variety of possible response shapes:
 * - Array directly
 * - Object with a "jobs" key
 * - Object with a "positions" key
 * - Object with a "data" key
 */
function extractJobs(data: unknown): any[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.jobs)) return obj.jobs;
    if (Array.isArray(obj.positions)) return obj.positions;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
}

async function fetchCompany(slug: string, companyName: string): Promise<NormalizedJob[]> {
  for (const buildUrl of ENDPOINTS) {
    try {
      const res = await fetch(buildUrl(slug), {
        signal: AbortSignal.timeout(10_000),
        headers: { 'Accept': 'application/json' },
      });

      if (!res.ok) continue;

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('json')) continue;

      const data = await res.json();
      const rawJobs = extractJobs(data);
      if (rawJobs.length === 0) continue;

      const normalized: NormalizedJob[] = [];
      for (const job of rawJobs) {
        if (!job.title) continue;

        const description: string = job.description ?? '';
        const level = inferExperienceLevel(job.title, description);
        if (level === null) continue;

        const location: string = job.location ?? 'Remote';
        const remote: boolean = location.toLowerCase().includes('remote');

        normalized.push({
          source: 'rippling',
          source_id: String(job.id ?? ''),
          title: job.title,
          company: companyName,
          location,
          remote,
          url: job.url ?? `https://app.rippling.com/jobs`,
          description: description || undefined,
          experience_level: level,
          roles: inferRoles(job.title),
          posted_at: job.datePosted ? new Date(job.datePosted).toISOString() : undefined,
          dedup_hash: generateHash(companyName, job.title, location),
        });
      }

      if (normalized.length > 0) {
        console.log(`    [rippling] ${companyName}: ${normalized.length} jobs`);
      }
      return normalized;
    } catch {
      // Try next endpoint
    }
  }

  return [];
}

export async function scrapeRippling(): Promise<NormalizedJob[]> {
  const entries = Object.entries(COMPANIES);
  const all: NormalizedJob[] = [];

  const results = await Promise.allSettled(
    entries.map(async ([slug, name], i) => {
      await new Promise(r => setTimeout(r, i * 50)); // 50ms stagger
      return fetchCompany(slug, name);
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    }
  }

  return all;
}

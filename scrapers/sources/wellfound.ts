import { generateHash } from '../utils/dedup';
import { inferRoles, inferRemote, inferExperienceLevel, NormalizedJob } from '../utils/normalize';

const GRAPHQL_ENDPOINT = 'https://wellfound.com/api/graphql';

const SEARCH_TERMS = [
  'software engineer entry level',
  'data scientist new grad',
  'machine learning engineer',
  'software engineer new grad',
  'data analyst entry level',
  'product manager new grad',
];

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; NextRole job aggregator)',
};

function parseCompensation(comp?: string): { salary_min?: number; salary_max?: number } {
  if (!comp) return {};
  // e.g. "$100k – $150k" or "$80,000 - $120,000"
  const numbers = comp.replace(/,/g, '').match(/\d+(?:\.\d+)?k?/gi) ?? [];
  const parsed = numbers.map(n => {
    const val = parseFloat(n);
    return n.toLowerCase().endsWith('k') ? val * 1000 : val;
  }).filter(n => n >= 1000); // filter out noise like "401k"
  if (parsed.length === 0) return {};
  if (parsed.length === 1) return { salary_min: parsed[0] };
  return { salary_min: Math.min(...parsed), salary_max: Math.max(...parsed) };
}

function mapWellfoundRole(role: Record<string, unknown>): NormalizedJob | null {
  const title = (role.title as string) ?? '';
  const description = (role.description as string) ?? '';
  const experienceLevel = inferExperienceLevel(title, description);
  if (!experienceLevel) return null;

  const locationNames = (role.locationNames as string[]) ?? [];
  const startup = (role.startup as Record<string, string>) ?? {};
  const company = startup.name ?? 'Unknown';
  const isRemote = role.remote === true || locationNames.some(l => inferRemote(l));
  const location = locationNames[0] ?? (isRemote ? 'Remote' : '');
  const { salary_min, salary_max } = parseCompensation(role.compensation as string | undefined);

  return {
    source: 'wellfound',
    source_id: String(role.id ?? ''),
    title,
    company,
    location,
    remote: isRemote,
    url: (role.applyUrl as string) ?? startup.websiteUrl ?? '',
    description,
    salary_min,
    salary_max,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at: (role.createdAt as string) ?? undefined,
    dedup_hash: generateHash(company, title, location),
  };
}

async function tryGraphQL(term: string): Promise<NormalizedJob[]> {
  const query = `{
    talent {
      jobListings(
        query: "${term.replace(/"/g, '\\"')}"
        locationNames: ["United States", "Remote"]
        jobTypes: ["fulltime"]
      ) {
        startupRoles {
          id
          title
          description
          applyUrl
          remote
          locationNames
          compensation
          startup {
            name
            websiteUrl
          }
          createdAt
        }
      }
    }
  }`;

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ query }),
  });

  if (!res.ok) throw new Error(`GraphQL responded ${res.status}`);

  const json = await res.json() as Record<string, unknown>;
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);

  const roles =
    (((json.data as Record<string, unknown>)
      ?.talent as Record<string, unknown>)
      ?.jobListings as Record<string, unknown>)
      ?.startupRoles as Record<string, unknown>[];

  if (!Array.isArray(roles)) throw new Error('Unexpected GraphQL response shape');

  const jobs: NormalizedJob[] = [];
  for (const role of roles) {
    const job = mapWellfoundRole(role);
    if (job) jobs.push(job);
  }
  return jobs;
}

async function tryFallback(term: string): Promise<NormalizedJob[]> {
  const params = new URLSearchParams({
    'job_types[]': 'full-time',
    keywords: term,
    remote: 'true',
  });

  const res = await fetch(`https://wellfound.com/jobs?${params}`, {
    headers: {
      'User-Agent': HEADERS['User-Agent'],
      Accept: 'application/json',
    },
  });

  if (!res.ok) throw new Error(`Fallback responded ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) throw new Error('Fallback returned HTML, not JSON');

  const json = await res.json() as Record<string, unknown>;
  const rawRoles = (json.startupRoles ?? json.jobs ?? json.results ?? []) as Record<string, unknown>[];

  const jobs: NormalizedJob[] = [];
  for (const role of rawRoles) {
    // Remap any difference in field names from the fallback shape
    const normalized = {
      ...role,
      startup: role.startup ?? { name: role.company, websiteUrl: '' },
      locationNames: role.locationNames ?? (role.location ? [role.location as string] : []),
    };
    const job = mapWellfoundRole(normalized);
    if (job) jobs.push(job);
  }
  return jobs;
}

export async function scrapeWellfound(): Promise<NormalizedJob[]> {
  const allJobs: NormalizedJob[] = [];
  const seenHashes = new Set<string>();

  for (const term of SEARCH_TERMS) {
    let termJobs: NormalizedJob[] = [];

    try {
      termJobs = await tryGraphQL(term);
    } catch (gqlErr) {
      console.warn(`  ⚠ Wellfound GraphQL "${term}" failed: ${(gqlErr as Error).message} — trying fallback`);
      try {
        termJobs = await tryFallback(term);
      } catch (fallbackErr) {
        console.warn(`  ⚠ Wellfound fallback "${term}" failed: ${(fallbackErr as Error).message}`);
      }
    }

    for (const job of termJobs) {
      if (!seenHashes.has(job.dedup_hash)) {
        seenHashes.add(job.dedup_hash);
        allJobs.push(job);
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  if (allJobs.length === 0) {
    console.warn('  ⚠ Wellfound: 0 jobs returned — API may require auth or have changed');
  }

  return allJobs;
}

import { generateHash } from '../utils/dedup';
import { isNonUsLocation } from '../utils/location';
import {
  inferExperienceLevel,
  inferRemote,
  inferRoles,
  NormalizedJob,
} from '../utils/normalize';

const SOURCE = 'workable';
const SEARCH_URL = 'https://jobs.workable.com/api/v1/jobs';
const SEARCH_LOCATION = 'United States';
const SEARCH_LIMIT = 50;
const MAX_OFFSET = 500;
const BATCH_SIZE = 4;
const BATCH_DELAY_MS = 600;

const SEARCH_TERMS = [
  // Core engineering roles
  'software engineer', 'software developer',
  'frontend engineer', 'backend engineer',
  'full stack engineer', 'fullstack developer',
  'web developer', 'mobile engineer',
  'ios engineer', 'android engineer',
  'embedded engineer', 'firmware engineer',

  // Infrastructure & DevOps
  'devops engineer', 'site reliability engineer',
  'platform engineer', 'infrastructure engineer',
  'cloud engineer', 'systems engineer',
  'network engineer', 'solutions engineer',

  // Data & ML
  'data engineer', 'data scientist',
  'machine learning engineer', 'ml engineer',
  'ai engineer', 'deep learning engineer',
  'data analyst', 'business intelligence',
  'analytics engineer', 'research scientist',
  'applied scientist', 'quantitative analyst',
  'quantitative researcher',

  // Security
  'security engineer', 'application security',
  'cybersecurity analyst', 'penetration tester',
  'information security',

  // Product & Design
  'product manager', 'technical program manager',
  'product analyst', 'ux engineer',
  'ui engineer', 'design engineer',

  // General tech
  'software intern', 'engineer intern',
  'new grad engineer', 'junior engineer',
  'junior developer', 'associate engineer',
  'entry level engineer', 'entry level developer',
  'graduate software', 'university grad',
] as const;

type WorkableLocation = {
  city?: string | null;
  subregion?: string | null;
  countryName?: string | null;
};

type WorkableCompany = {
  id?: string;
  title?: string;
  url?: string;
};

type WorkableJob = {
  id?: string;
  title?: string;
  state?: string;
  description?: string;
  requirementsSection?: string;
  url?: string;
  locations?: string[];
  location?: WorkableLocation;
  created?: string;
  company?: WorkableCompany;
  workplace?: string;
};

type WorkableSearchResponse = {
  title?: string;
  totalSize?: number;
  nextPageToken?: string;
  jobs?: WorkableJob[];
  results?: WorkableJob[];
  autoAppliedFilters?: Record<string, unknown>;
};

type WorkableSearchTermResult = {
  term: string;
  jobs: WorkableJob[];
  zeroReason?: string;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const MAX_RATE_LIMIT_RETRIES = 3;

function normalizeLocationText(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const withoutCountry = trimmed.replace(/,\s*United States$/i, '').trim();
  return withoutCountry || trimmed;
}

function buildLocation(job: WorkableJob): string | undefined {
  const listedLocation = (job.locations ?? [])
    .map(value => normalizeLocationText(value))
    .find((value): value is string => Boolean(value));

  if (listedLocation) return listedLocation;

  const structuredLocation = [
    job.location?.city?.trim(),
    job.location?.subregion?.trim(),
    job.location?.countryName?.trim(),
  ]
    .filter((value): value is string => Boolean(value))
    .join(', ');

  return normalizeLocationText(structuredLocation);
}

function buildExperienceSignalText(job: WorkableJob): string | undefined {
  const sections = [job.description?.trim(), job.requirementsSection?.trim()]
    .filter((value): value is string => Boolean(value));

  return sections.length ? sections.join('\n') : undefined;
}

function isRemoteJob(job: WorkableJob, location: string | undefined): boolean {
  if (job.workplace?.trim().toLowerCase() === 'remote') return true;
  if ((job.locations ?? []).some(entry => inferRemote(entry))) return true;

  return inferRemote(location);
}

function normalizePostedAt(created?: string): string | undefined {
  if (!created?.trim()) return undefined;

  const date = new Date(created);
  if (Number.isNaN(date.getTime())) return undefined;

  return date.toISOString();
}

function getRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  const retryAfterSeconds = retryAfter ? Number.parseFloat(retryAfter) : Number.NaN;

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.ceil(retryAfterSeconds * 1_000);
  }

  return Math.min(8_000, 1_500 * (attempt + 1));
}

function normalizeWorkableJob(job: WorkableJob): NormalizedJob | null {
  const sourceId = job.id?.trim();
  const title = job.title?.trim();
  const company = job.company?.title?.trim();
  const url = job.url?.trim();
  const location = buildLocation(job);
  const description = job.description?.trim() || undefined;
  const experienceSignalText = buildExperienceSignalText(job);

  if (!sourceId || !title || !company || !url) return null;
  if (job.state?.trim().toLowerCase() !== 'published') return null;
  if (location && isNonUsLocation(location)) return null;

  const experienceLevel = inferExperienceLevel(title, experienceSignalText);
  if (experienceLevel === null) return null;

  return {
    source: SOURCE,
    source_id: sourceId,
    title,
    company,
    location,
    remote: isRemoteJob(job, location),
    url,
    description,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at: normalizePostedAt(job.created),
    dedup_hash: generateHash(company, title, location ?? ''),
  };
}

async function fetchSearchTerm(term: string): Promise<WorkableSearchTermResult> {
  let offset = 0;
  const termJobs: WorkableJob[] = [];
  let zeroReason: string | undefined;

  while (true) {
    const url =
      `${SEARCH_URL}?query=${encodeURIComponent(term)}` +
      `&location=${encodeURIComponent(SEARCH_LOCATION)}` +
      `&limit=${SEARCH_LIMIT}&offset=${offset}`;

    try {
      let attempt = 0;
      let res: Response;

      while (true) {
        res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });

        if (res.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) break;

        const retryDelayMs = getRetryDelayMs(res, attempt);
        attempt += 1;
        await delay(retryDelayMs);
      }

      if (!res.ok) {
        if (termJobs.length === 0) zeroReason = `HTTP ${res.status}`;
        break;
      }

      const data = (await res.json()) as WorkableSearchResponse;
      const jobs = data.results ?? data.jobs ?? [];

      if (jobs.length === 0) {
        if (termJobs.length === 0) zeroReason = 'no results';
        break;
      }

      termJobs.push(...jobs);

      if (jobs.length < SEARCH_LIMIT) break;

      offset += SEARCH_LIMIT;
      if (offset > MAX_OFFSET) break;
    } catch (error) {
      if (termJobs.length === 0) {
        zeroReason = error instanceof Error ? error.message : String(error);
      }
      break;
    }
  }

  return { term, jobs: termJobs, zeroReason };
}

export async function scrapeWorkable(): Promise<NormalizedJob[]> {
  const jobsById = new Map<string, WorkableJob>();

  for (let i = 0; i < SEARCH_TERMS.length; i += BATCH_SIZE) {
    const batch = SEARCH_TERMS.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(term => fetchSearchTerm(term)));

    for (const result of results) {
      if (result.jobs.length === 0) {
        console.log(`[workable] ${result.term}: 0 jobs${result.zeroReason ? ` (${result.zeroReason})` : ''}`);
        continue;
      }

      console.log(`[workable] ${result.term}: ${result.jobs.length} raw jobs`);

      for (const job of result.jobs) {
        const sourceId = job.id?.trim();
        if (!sourceId) continue;

        jobsById.set(sourceId, job);
      }
    }

    if (i + BATCH_SIZE < SEARCH_TERMS.length) {
      await delay(BATCH_DELAY_MS);
    }
  }

  const normalized: NormalizedJob[] = [];

  for (const job of jobsById.values()) {
    const mapped = normalizeWorkableJob(job);
    if (!mapped) continue;
    normalized.push(mapped);
  }

  console.log(`[workable] Total unique jobs: ${normalized.length}`);
  return normalized;
}

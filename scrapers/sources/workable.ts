import { setTimeout as delay } from 'node:timers/promises';

import { generateHash } from '../utils/dedup';
import { isNonUsLocation } from '../utils/location';
import { inferExperienceLevel, inferRoles, NormalizedJob } from '../utils/normalize';

const SOURCE = 'workable';
const REQUEST_TIMEOUT_MS = 8_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_TERM = 10;
const PAGE_DELAY_MS = 300;
const TERM_DELAY_MS = 1_000;
const WORKABLE_SEARCH_URL = 'https://jobs.workable.com/api/v1/jobs';

const SEARCH_TERMS = [
  'software engineer',
  'data scientist',
  'machine learning engineer',
  'data analyst',
  'product manager',
  'devops engineer',
  'cloud engineer',
  'backend engineer',
  'frontend engineer',
  'full stack engineer',
  'site reliability engineer',
  'data engineer',
  'security engineer',
  'mobile engineer',
  'platform engineer',
  'junior software engineer',
  'associate software engineer',
  'entry level software engineer',
  'new grad software engineer',
  'software engineer intern',
] as const;

const TECH_TITLE_SIGNALS = [
  'engineer',
  'developer',
  'scientist',
  'analyst',
  'architect',
  'devops',
  'sre',
  'platform',
  'backend',
  'frontend',
  'fullstack',
  'full stack',
  'machine learning',
  'data',
  'software',
  'cloud',
  'security',
  'infrastructure',
  'ml',
  'ai',
  'product manager',
  'program manager',
  'technical',
  'systems',
  'mobile',
  'ios',
  'android',
  'web',
  'api',
  'database',
  'network',
  'cyber',
  'quantitative',
  'quant',
  'researcher',
  'site reliability',
] as const;

type WorkableCompany = {
  name?: string;
  slug?: string;
  title?: string;
};

type WorkableLocation = {
  city?: string;
  region?: string;
  country?: string;
  subregion?: string | null;
  countryName?: string | null;
  remote?: boolean;
};

type WorkableJob = {
  id?: string;
  title?: string;
  state?: string;
  description?: string;
  company?: WorkableCompany;
  location?: WorkableLocation;
  created?: string;
  url?: string;
  workplace?: string;
  locations?: string[];
};

type WorkableSearchResponse = {
  totalSize?: number;
  nextPageToken?: string;
  jobs?: WorkableJob[];
};

type FetchJsonResult<T> = {
  status: number;
  data: T | null;
};

const stripHtml = (value: string): string =>
  value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function buildLocation(job: WorkableJob): string | undefined {
  const location = [job.location?.city, job.location?.region, job.location?.subregion]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(', ');

  return location || undefined;
}

function buildLocationSignal(job: WorkableJob): string {
  return [job.location?.city, job.location?.region, job.location?.subregion]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

function buildDescription(description?: string): string | undefined {
  if (!description?.trim()) return undefined;

  const stripped = stripHtml(description);
  if (!stripped) return undefined;

  return stripped.slice(0, 5_000);
}

function buildUrl(job: WorkableJob): string | undefined {
  const url = job.url?.trim();
  if (url) return url;
  if (!job.id?.trim()) return undefined;

  return `https://jobs.workable.com/view/${encodeURIComponent(job.id.trim())}`;
}

function normalizePostedAt(created?: string): string | undefined {
  if (!created?.trim()) return undefined;

  const date = new Date(created);
  if (Number.isNaN(date.getTime())) return undefined;

  return date.toISOString();
}

function isRemoteJob(job: WorkableJob): boolean {
  if (job.location?.remote === true) return true;
  if (job.workplace?.trim().toLowerCase() === 'remote') return true;

  return (job.locations ?? []).some(location => /remote|telecommute/i.test(location));
}

function isUsCountry(country?: string | null): boolean {
  const normalized = country?.trim().toLowerCase();
  return normalized === 'us' || normalized === 'united states';
}

function normalizeWorkableJob(job: WorkableJob): NormalizedJob | null {
  const sourceId = job.id?.trim();
  const title = job.title?.trim();
  const company = job.company?.name?.trim() || job.company?.title?.trim();
  const remote = isRemoteJob(job);
  const country = job.location?.country ?? job.location?.countryName;

  if (!sourceId || !title || !company) return null;
  if (job.state?.trim().toLowerCase() !== 'published') return null;
  if (!isUsCountry(country) && !remote) return null;

  const locationSignal = buildLocationSignal(job);
  if (isNonUsLocation(locationSignal)) return null;

  const isTechTitle = TECH_TITLE_SIGNALS.some(signal => title.toLowerCase().includes(signal));
  if (!isTechTitle) return null;

  const description = buildDescription(job.description);
  const experienceLevel = inferExperienceLevel(title, description);
  if (experienceLevel === null) return null;

  const location = buildLocation(job);
  const url = buildUrl(job);
  if (!url) return null;

  return {
    source: SOURCE,
    source_id: sourceId,
    title,
    company,
    location,
    remote,
    url,
    description,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at: normalizePostedAt(job.created),
    dedup_hash: generateHash(company, title, location ?? ''),
  };
}

async function fetchJson<T>(url: string): Promise<FetchJsonResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { status: response.status, data: null };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return { status: response.status, data: null };
    }

    const data = (await response.json()) as T;
    return { status: response.status, data };
  } catch {
    return { status: 0, data: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSearchPage(
  term: string,
  nextPageToken?: string,
): Promise<WorkableSearchResponse | null> {
  const params = new URLSearchParams({
    q: term,
    location: 'United States',
    limit: String(PAGE_SIZE),
  });

  if (nextPageToken) {
    params.set('nextPageToken', nextPageToken);
  }

  const { status, data } = await fetchJson<WorkableSearchResponse>(
    `${WORKABLE_SEARCH_URL}?${params.toString()}`,
  );

  if (!data) {
    console.log(
      `  [workable] Search failed for "${term}"${nextPageToken ? ' (next page)' : ''} with status ${status}`,
    );
    return null;
  }

  return data;
}

export async function scrapeWorkableSearchTerm(term: string): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];
  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  let nextPageToken: string | undefined;
  let page = 0;
  let previousPageSignature: string | undefined;

  while (page < MAX_PAGES_PER_TERM) {
    if (nextPageToken && seenTokens.has(nextPageToken)) {
      break;
    }

    const data = await fetchSearchPage(term, nextPageToken);
    if (nextPageToken) {
      seenTokens.add(nextPageToken);
    }

    if (!data || !Array.isArray(data.jobs) || data.jobs.length === 0) {
      break;
    }

    page += 1;
    const pageSignature = data.jobs
      .map(job => job.id?.trim())
      .filter((value): value is string => Boolean(value))
      .join('|');

    if (previousPageSignature && pageSignature === previousPageSignature) {
      console.log(`  [workable] "${term}" pagination stalled on page ${page}; stopping early`);
      break;
    }

    previousPageSignature = pageSignature;

    for (const job of data.jobs) {
      const sourceId = job.id?.trim();
      if (!sourceId || seenIds.has(sourceId)) continue;

      const normalized = normalizeWorkableJob(job);
      if (!normalized) continue;

      seenIds.add(sourceId);
      jobs.push(normalized);
    }

    nextPageToken = data.nextPageToken?.trim() || undefined;
    if (!nextPageToken || page >= MAX_PAGES_PER_TERM) {
      break;
    }

    await delay(PAGE_DELAY_MS);
  }

  console.log(`  [workable] "${term}" -> ${jobs.length} jobs across ${page} page(s)`);

  return jobs;
}

export async function scrapeWorkable(): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < SEARCH_TERMS.length; index += 1) {
    const term = SEARCH_TERMS[index];
    const termJobs = await scrapeWorkableSearchTerm(term);

    for (const job of termJobs) {
      const sourceId = job.source_id?.trim();
      if (!sourceId || seenIds.has(sourceId)) continue;

      seenIds.add(sourceId);
      jobs.push(job);
    }

    if (index < SEARCH_TERMS.length - 1) {
      await delay(TERM_DELAY_MS);
    }
  }

  console.log(`  [workable] Total unique jobs: ${jobs.length}`);

  return jobs;
}

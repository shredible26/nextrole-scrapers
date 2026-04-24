import { pathToFileURL } from 'node:url';
import { generateHash } from '../utils/dedup';
import { isNonUsLocation } from '../utils/location';
import {
  finalizeNormalizedJob,
  inferExperienceLevel,
  inferRemote,
  inferRoles,
  NormalizedJob,
} from '../utils/normalize';
import { stripHtml } from '../utils/scraper-helpers';
import { deactivateStaleJobs, uploadJobs } from '../utils/upload';

const SOURCE = 'workable';
const SEARCH_URL = 'https://jobs.workable.com/search';
const SEARCH_LOCATION = 'United States';
const MAX_PAGES_PER_TERM = 3;
const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 400;
const PAGE_DELAY_MS = 150;
const REQUEST_TIMEOUT_MS = 20_000;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_FETCH_RETRIES = 5;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

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
  benefitsSection?: string;
  requirementsSection?: string;
  url?: string;
  locations?: string[];
  location?: WorkableLocation;
  created?: string;
  updated?: string;
  company?: WorkableCompany;
  workplace?: string;
};

type WorkableSearchPageData = {
  title?: string;
  totalSize?: number;
  nextPageToken?: string;
  jobs?: WorkableJob[];
};

type WorkableSearchTermResult = {
  term: string;
  jobs: WorkableJob[];
  totalSize?: number;
  zeroReason?: string;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeLocationText(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  if (/^(telecommute|remote)$/i.test(trimmed)) {
    return 'Remote';
  }

  const withoutCountry = trimmed.replace(/,\s*United States$/i, '').trim();
  return withoutCountry || trimmed;
}

function buildLocation(job: WorkableJob): string | undefined {
  const normalizedLocations = (job.locations ?? [])
    .map(value => normalizeLocationText(value))
    .filter((value): value is string => Boolean(value));

  const listedLocation =
    normalizedLocations.find(value => !inferRemote(value)) ?? normalizedLocations[0];

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
  const sections = [
    stripHtml(job.description),
    stripHtml(job.requirementsSection),
    stripHtml(job.benefitsSection),
  ].filter(Boolean);

  return sections.length > 0 ? sections.join('\n') : undefined;
}

function isRemoteJob(job: WorkableJob, location: string | undefined): boolean {
  if (job.workplace?.trim().toLowerCase() === 'remote') return true;

  const normalizedLocations = (job.locations ?? [])
    .map(value => normalizeLocationText(value))
    .filter((value): value is string => Boolean(value));

  if (normalizedLocations.some(entry => inferRemote(entry))) return true;

  return inferRemote(location);
}

function normalizePostedAt(created?: string): string | undefined {
  if (!created?.trim()) return undefined;

  const date = new Date(created);
  if (Number.isNaN(date.getTime())) return undefined;

  return date.toISOString();
}

function getRetryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after');
  const retryAfterSeconds = retryAfter ? Number.parseFloat(retryAfter) : Number.NaN;

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(retryAfterSeconds * 1_000));
  }

  const retryAfterDate = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  if (Number.isFinite(retryAfterDate)) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(1_000, retryAfterDate - Date.now()));
  }

  return Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** attempt);
}

function extractJsonObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function extractSearchPageData(html: string): WorkableSearchPageData {
  const jobsMarker = '"api/v1/jobs":{"status":';
  const jobsMarkerIndex = html.indexOf(jobsMarker);
  if (jobsMarkerIndex === -1) {
    throw new Error('embedded jobs payload not found');
  }

  const dataKeyIndex = html.indexOf('"data":', jobsMarkerIndex);
  if (dataKeyIndex === -1) {
    throw new Error('embedded jobs payload missing data key');
  }

  const objectStartIndex = html.indexOf('{', dataKeyIndex);
  if (objectStartIndex === -1) {
    throw new Error('embedded jobs payload missing JSON object');
  }

  const rawJson = extractJsonObject(html, objectStartIndex);
  if (!rawJson) {
    throw new Error('embedded jobs payload was truncated');
  }

  return JSON.parse(rawJson) as WorkableSearchPageData;
}

async function fetchSearchPageHtml(term: string, pageToken?: string): Promise<string> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('query', term);
  url.searchParams.set('location', SEARCH_LOCATION);

  if (pageToken) {
    url.searchParams.set('pageToken', pageToken);
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt += 1) {
    let response: Response | null = null;

    try {
      response = await fetch(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.ok) {
        return await response.text();
      }

      const body = await response.text();
      const errorMessage = `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
      lastError = new Error(errorMessage);

      if (response.status !== 429 && response.status < 500) {
        throw lastError;
      }

      const delayMs = getRetryDelayMs(response, attempt);
      console.warn(
        `  [workable] ${term}${pageToken ? ' paginated' : ''} attempt ${attempt + 1}/${MAX_FETCH_RETRIES} failed (${errorMessage}); retrying in ${delayMs}ms`,
      );
      await delay(delayMs);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= MAX_FETCH_RETRIES - 1) {
        break;
      }

      const delayMs = getRetryDelayMs(response, attempt);
      console.warn(
        `  [workable] ${term}${pageToken ? ' paginated' : ''} attempt ${attempt + 1}/${MAX_FETCH_RETRIES} errored (${lastError.message}); retrying in ${delayMs}ms`,
      );
      await delay(delayMs);
    }
  }

  throw lastError ?? new Error('Workable search request failed');
}

function normalizeWorkableJob(job: WorkableJob): NormalizedJob | null {
  const sourceId = job.id?.trim();
  const title = job.title?.trim();
  const company = job.company?.title?.trim();
  const url = job.url?.trim();
  const location = buildLocation(job);
  const description = stripHtml(job.description) || undefined;
  const experienceSignalText = buildExperienceSignalText(job);

  if (!sourceId || !title || !company || !url) return null;
  if (job.state?.trim().toLowerCase() !== 'published') return null;
  if (location && isNonUsLocation(location)) return null;

  const experienceLevel = inferExperienceLevel(title, experienceSignalText);
  if (experienceLevel === null) return null;

  return finalizeNormalizedJob({
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
    posted_at: normalizePostedAt(job.created ?? job.updated),
    dedup_hash: generateHash(company, title, location ?? ''),
  });
}

async function fetchSearchTerm(term: string): Promise<WorkableSearchTermResult> {
  let pageToken: string | undefined;
  let totalSize: number | undefined;
  const termJobs: WorkableJob[] = [];
  let zeroReason: string | undefined;

  for (let page = 1; page <= MAX_PAGES_PER_TERM; page += 1) {
    try {
      const html = await fetchSearchPageHtml(term, pageToken);
      const data = extractSearchPageData(html);
      const jobs = data.jobs ?? [];
      totalSize = data.totalSize;

      if (jobs.length === 0) {
        if (termJobs.length === 0) zeroReason = 'no results';
        break;
      }

      termJobs.push(...jobs);

      if (!data.nextPageToken) {
        break;
      }

      pageToken = data.nextPageToken;

      if (page < MAX_PAGES_PER_TERM) {
        await delay(PAGE_DELAY_MS);
      }
    } catch (error) {
      if (termJobs.length === 0) {
        zeroReason = error instanceof Error ? error.message : String(error);
      } else {
        console.warn(`  [workable] ${term} page ${page} failed after partial success: ${String(error)}`);
      }
      break;
    }
  }

  return { term, jobs: termJobs, totalSize, zeroReason };
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

      console.log(
        `[workable] ${result.term}: ${result.jobs.length} raw jobs${result.totalSize ? ` (${result.totalSize} available)` : ''}`,
      );

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

async function runStandalone(): Promise<void> {
  const startedAt = Date.now();
  const jobs = await scrapeWorkable();

  await uploadJobs(jobs);
  await deactivateStaleJobs(SOURCE, jobs.map(job => job.dedup_hash));

  const elapsedSeconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
  console.log(`  [${SOURCE}] Standalone run completed in ${elapsedSeconds}s`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runStandalone().catch((error) => {
    console.error(`  [${SOURCE}] Standalone run failed`, error);
    process.exit(1);
  });
}

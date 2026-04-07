import { generateHash } from '../utils/dedup';
import {
  hasTechTitleSignal,
  inferExperienceLevel,
  inferRoles,
  NormalizedJob,
} from '../utils/normalize';
import { isNonUsLocation } from '../utils/location';

const SOURCE = 'workatastartup';
const APP_ID = '45BWZJ1SGC';
const INDEX_NAME = 'WaaSPublicCompanyJob_created_at_desc_production';
const JOBS_PAGE_URL = 'https://www.workatastartup.com/jobs';
const ROOT_URL = 'https://www.workatastartup.com';
const SEARCH_URL = `https://${APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/${INDEX_NAME}/query`;
const FALLBACK_API_KEYS = ['b4b5a7956ec7f55c3d4e8d6e12c0e8b4'];
const HITS_PER_PAGE = 1000;
const ROLE_PAGE_URLS = [
  'https://www.workatastartup.com/jobs/l/software-engineer',
  'https://www.workatastartup.com/jobs/l/science',
  'https://www.workatastartup.com/jobs/l/product-manager',
];

type WorkAtAStartupHit = {
  objectID?: string;
  title?: string;
  company_name?: string;
  company_slug?: string;
  locations?: string[];
  remote?: boolean;
  job_type?: string;
  description?: string;
  created_at?: number;
  url?: string;
};

type WorkAtAStartupSearchResponse = {
  hits?: WorkAtAStartupHit[];
  nbHits?: number;
  page?: number;
  nbPages?: number;
};

type WorkAtAStartupPageJob = {
  id?: number;
  title?: string;
  jobType?: string;
  location?: string;
  roleType?: string;
  companyName?: string;
  companySlug?: string;
  companyBatch?: string;
  companyOneLiner?: string;
  applyUrl?: string;
};

type WorkAtAStartupPagePayload = {
  props?: {
    jobs?: WorkAtAStartupPageJob[];
  };
};

function extractAlgoliaApiKey(html: string): string | null {
  const patterns = [
    /"apiKey"\s*:\s*"([^"]+)"/i,
    /"key"\s*:\s*"([^"]+)"/i,
    /\\"apiKey\\"\s*:\s*\\"([^"]+)\\"/i,
    /\\"key\\"\s*:\s*\\"([^"]+)\\"/i,
    /x-algolia-api-key["']?\s*[:=]\s*["']([^"']+)["']/i,
    /\\"x-algolia-api-key\\"\s*:\s*\\"([^"]+)\\"/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'NextRole Job Aggregator (+https://nextrole-phi.vercel.app)',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(
        `  [${SOURCE}] Failed to fetch ${url}: HTTP ${res.status}:`,
        body.slice(0, 200),
      );
      return null;
    }

    return await res.text();
  } catch (err) {
    console.warn(`  [${SOURCE}] Failed to fetch ${url}:`, (err as Error).message);
    return null;
  }
}

async function getApiKeyCandidates(): Promise<string[]> {
  const candidates: string[] = [];

  const jobsHtml = await fetchHtml(JOBS_PAGE_URL);
  const jobsPageKey = jobsHtml ? extractAlgoliaApiKey(jobsHtml) : null;
  if (jobsPageKey) {
    candidates.push(jobsPageKey);
  } else {
    console.warn(`  [${SOURCE}] Could not extract Algolia key from ${JOBS_PAGE_URL}`);
  }

  candidates.push(...FALLBACK_API_KEYS);

  const rootHtml = await fetchHtml(ROOT_URL);
  const rootPageKey = rootHtml ? extractAlgoliaApiKey(rootHtml) : null;
  if (rootPageKey) {
    candidates.push(rootPageKey);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractPagePayload(html: string): WorkAtAStartupPagePayload | null {
  const match = html.match(/data-page="([^"]+)"/);
  if (!match?.[1]) return null;

  try {
    return JSON.parse(decodeHtmlEntities(match[1])) as WorkAtAStartupPagePayload;
  } catch (err) {
    console.warn(`  [${SOURCE}] Failed to parse public role page payload:`, (err as Error).message);
    return null;
  }
}

async function scrapeRolePagesFallback(existingIds: Set<string>): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];

  for (const url of ROLE_PAGE_URLS) {
    const html = await fetchHtml(url);
    if (!html) continue;

    const payload = extractPagePayload(html);
    const pageJobs = payload?.props?.jobs ?? [];
    if (pageJobs.length === 0) {
      console.warn(`  [${SOURCE}] Public role page returned 0 jobs: ${url}`);
      continue;
    }

    for (const pageJob of pageJobs) {
      const sourceId = String(pageJob.id ?? '').trim();
      const title = (pageJob.title ?? '').trim();
      const company = (pageJob.companyName ?? '').trim();
      if (!sourceId || !title || !company || existingIds.has(sourceId)) continue;

      const location = (pageJob.location ?? '').trim();
      const description = (pageJob.companyOneLiner ?? '').trim() || undefined;
      if (!hasTechTitleSignal(title)) continue;
      if (location && isNonUsLocation(location)) continue;

      const level = inferExperienceLevel(title, description);
      if (!level) continue;

      existingIds.add(sourceId);
      jobs.push({
        source: SOURCE,
        source_id: sourceId,
        title,
        company,
        location: location || undefined,
        remote: location.toLowerCase().includes('remote'),
        url: pageJob.applyUrl?.trim() || `https://www.workatastartup.com/jobs/${sourceId}`,
        description,
        experience_level: level,
        roles: inferRoles(title),
        dedup_hash: generateHash(company, title, location),
      });
    }
  }

  return jobs;
}

async function fetchSearchPage(
  apiKey: string,
  page: number,
): Promise<
  | { kind: 'ok'; data: WorkAtAStartupSearchResponse }
  | { kind: 'forbidden' }
  | { kind: 'error' }
> {
  try {
    const params = new URLSearchParams({
      hitsPerPage: String(HITS_PER_PAGE),
      page: String(page),
      filters: '',
      query: '',
    });

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Algolia-Application-Id': APP_ID,
        'X-Algolia-API-Key': apiKey,
      },
      body: JSON.stringify({ params: params.toString() }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 403) {
      const body = await res.text();
      console.warn(
        `  [${SOURCE}] Algolia key rejected on page ${page} with HTTP 403:`,
        body.slice(0, 200),
      );
      return { kind: 'forbidden' };
    }

    if (!res.ok) {
      const body = await res.text();
      console.warn(
        `  [${SOURCE}] Algolia page ${page} failed with HTTP ${res.status}:`,
        body.slice(0, 200),
      );
      return { kind: 'error' };
    }

    return {
      kind: 'ok',
      data: await res.json() as WorkAtAStartupSearchResponse,
    };
  } catch (err) {
    console.warn(`  [${SOURCE}] Algolia page ${page} failed:`, (err as Error).message);
    return { kind: 'error' };
  }
}

export async function scrapeWorkAtAStartup(): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];
  const seenIds = new Set<string>();
  const apiKeys = await getApiKeyCandidates();

  if (apiKeys.length === 0) {
    console.warn(`  [${SOURCE}] No Algolia API keys available, returning 0 jobs`);
    return [];
  }

  let attemptedKey = false;
  let algoliaReturnedZeroHits = false;

  for (const apiKey of apiKeys) {
    attemptedKey = true;

    for (let page = 0; ; page++) {
      const result = await fetchSearchPage(apiKey, page);

      if (result.kind === 'forbidden') {
        break;
      }

      if (result.kind === 'error') {
        console.log(`  [${SOURCE}] ${jobs.length} jobs fetched before stopping`);
        return jobs;
      }

      if ((result.data.nbHits ?? 0) === 0) {
        algoliaReturnedZeroHits = true;
        console.warn(`  [${SOURCE}] Algolia returned 0 hits with the current public key`);
        break;
      }

      const hits = result.data.hits ?? [];
      for (const hit of hits) {
        const sourceId = String(hit.objectID ?? '').trim();
        const title = (hit.title ?? '').trim();
        const company = (hit.company_name ?? '').trim();
        if (!sourceId || !title || !company || seenIds.has(sourceId)) continue;
        if (!hasTechTitleSignal(title)) continue;

        const locations = (hit.locations ?? []).filter(
          (location): location is string => typeof location === 'string' && location.trim().length > 0,
        );
        const location =
          locations.find(locationValue => !isNonUsLocation(locationValue)) ??
          locations[0] ??
          locations.join(', ');
        if (location && isNonUsLocation(location)) continue;
        const description = typeof hit.description === 'string'
          ? hit.description.slice(0, 5000)
          : undefined;
        const level = inferExperienceLevel(title, description);
        if (!level) continue;

        seenIds.add(sourceId);
        jobs.push({
          source: SOURCE,
          source_id: sourceId,
          title,
          company,
          location: location || undefined,
          remote:
            hit.remote === true ||
            locations.some(locationValue => locationValue.toLowerCase().includes('remote')),
          url: `https://www.workatastartup.com/jobs/${sourceId}`,
          description,
          experience_level: level,
          roles: inferRoles(title),
          posted_at:
            typeof hit.created_at === 'number'
              ? new Date(hit.created_at * 1000).toISOString()
              : undefined,
          dedup_hash: generateHash(company, title, location),
        });
      }

      const totalPages = result.data.nbPages ?? 0;
      if (totalPages === 0 || page >= totalPages - 1) {
        console.log(`  [${SOURCE}] ${jobs.length} jobs fetched`);
        return jobs;
      }
    }
  }

  if (jobs.length === 0 && (algoliaReturnedZeroHits || attemptedKey)) {
    console.warn(`  [${SOURCE}] Falling back to public role pages because Algolia returned no usable jobs`);
    const fallbackJobs = await scrapeRolePagesFallback(seenIds);
    console.log(`  [${SOURCE}] ${fallbackJobs.length} jobs fetched from public role pages`);
    return fallbackJobs;
  }

  if (attemptedKey) {
    console.warn(`  [${SOURCE}] All Algolia key attempts failed, returning ${jobs.length} jobs`);
  }

  console.log(`  [${SOURCE}] ${jobs.length} jobs fetched`);
  return jobs;
}

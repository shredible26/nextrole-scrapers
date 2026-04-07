import { generateHash } from '../utils/dedup';
import { inferExperienceLevel, inferRoles, type NormalizedJob } from '../utils/normalize';

const SOURCE = 'builtin';
const API_ENDPOINTS = [
  'https://builtin.com/jobs/api/get-jobs',
  'https://builtin.com/jobs/api',
];
const HTML_SEARCH_URL = 'https://builtin.com/jobs';
const HTML_ENTRY_LEVEL_PATH = '/entry-level';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_TERMS = [
  'software engineer',
  'data scientist',
  'machine learning engineer',
  'data analyst',
  'product manager',
  'software developer',
  'backend engineer',
  'frontend engineer',
  'full stack engineer',
  'devops engineer',
  'cloud engineer',
  'site reliability engineer',
  'data engineer',
];
const PAGE_DELAY_MS = 500;
const MAX_PAGES = 10;
const API_PAGE_SIZE = 100;
const MAX_CONCURRENT_REQUESTS = 2;

type BuiltInApiJob = {
  id?: number;
  title?: string;
  companyDetails?: {
    name?: string;
    slug?: string;
  };
  city?: string;
  state?: string;
  country?: string;
  remote?: boolean;
  builtinUrl?: string;
  description?: string;
  datePosted?: string;
  salaryMin?: number;
  salaryMax?: number;
};

type BuiltInApiResponse = {
  jobs?: BuiltInApiJob[];
  totalJobsCount?: number;
  page?: number;
  data?: {
    jobs?: BuiltInApiJob[];
    totalJobsCount?: number;
    page?: number;
  };
  results?: BuiltInApiJob[];
  total?: number;
};

type BuiltInApiPage = {
  jobs: BuiltInApiJob[];
  totalJobsCount: number;
  page: number;
};

type BuiltInStrategy =
  | { kind: 'api'; endpoint: string }
  | { kind: 'html' };

type HtmlCardJob = {
  id: number;
  title: string;
  company: string;
  location?: string;
  remote: boolean;
  url: string;
  description?: string;
  salaryMin?: number;
  salaryMax?: number;
  postedAt?: string;
};

const cookieJar = new Map<string, string>();
const requestQueue: Array<() => void> = [];
let activeRequests = 0;

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRequestSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>(resolve => requestQueue.push(resolve));
  }

  activeRequests += 1;
  try {
    return await fn();
  } finally {
    activeRequests -= 1;
    const next = requestQueue.shift();
    if (next) next();
  }
}

function getCookieHeader(): string | undefined {
  if (cookieJar.size === 0) return undefined;
  return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function storeCookies(setCookieHeader: string | null) {
  if (!setCookieHeader) return;

  for (const part of setCookieHeader.split(/,(?=\s*[^;=]+=[^;]+)/)) {
    const cookie = part.split(';')[0]?.trim();
    if (!cookie) continue;

    const separatorIndex = cookie.indexOf('=');
    if (separatorIndex <= 0) continue;

    const name = cookie.slice(0, separatorIndex).trim();
    const value = cookie.slice(separatorIndex + 1).trim();
    if (name && value) {
      cookieJar.set(name, value);
    }
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/&apos;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function parseNumberToken(value: string): number | undefined {
  const cleaned = value.replace(/[$,\s]/g, '');
  if (!cleaned) return undefined;

  const suffix = cleaned.slice(-1).toLowerCase();
  const base = suffix === 'k' || suffix === 'm' ? cleaned.slice(0, -1) : cleaned;
  const amount = Number(base);
  if (!Number.isFinite(amount)) return undefined;

  if (suffix === 'k') return Math.round(amount * 1_000);
  if (suffix === 'm') return Math.round(amount * 1_000_000);
  return Math.round(amount);
}

function parseSalaryRange(value?: string): { min?: number; max?: number } {
  if (!value) return {};

  const matches = [...value.matchAll(/\$?\d[\d,.]*(?:\.\d+)?\s*[kKmM]?/g)]
    .map(match => parseNumberToken(match[0]))
    .filter((amount): amount is number => typeof amount === 'number');

  if (matches.length === 0) return {};
  if (matches.length === 1) return { min: matches[0] };
  return { min: matches[0], max: matches[1] };
}

function normalizePostedAt(value?: string): string | undefined {
  if (!value) return undefined;

  try {
    const iso = value.endsWith('Z') ? value : `${value}Z`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  } catch {
    return undefined;
  }
}

function extractApiPage(raw: unknown): BuiltInApiPage | null {
  if (!raw || typeof raw !== 'object') return null;

  const response = raw as BuiltInApiResponse;

  if (Array.isArray(response.jobs)) {
    return {
      jobs: response.jobs,
      totalJobsCount: Number(response.totalJobsCount ?? response.jobs.length ?? 0),
      page: Number(response.page ?? 1),
    };
  }

  if (response.data && Array.isArray(response.data.jobs)) {
    return {
      jobs: response.data.jobs,
      totalJobsCount: Number(response.data.totalJobsCount ?? response.data.jobs.length ?? 0),
      page: Number(response.data.page ?? 1),
    };
  }

  if (Array.isArray(response.results)) {
    return {
      jobs: response.results,
      totalJobsCount: Number(response.total ?? response.results.length ?? 0),
      page: 1,
    };
  }

  return null;
}

function logUnexpectedApiResponse(
  endpoint: string,
  status: number,
  contentType: string,
  body: string,
) {
  console.warn(
    `  [${SOURCE}] Unexpected API response from ${endpoint} (HTTP ${status}, ${contentType}):`,
    body.slice(0, 500),
  );
}

async function fetchApiPage(
  endpoint: string,
  term: string,
  page: number,
): Promise<BuiltInApiPage | null> {
  const params = new URLSearchParams({
    country: '4',
    experience: '1',
    page: String(page),
    num_jobs: String(API_PAGE_SIZE),
    title: term,
  });
  const url = `${endpoint}?${params}`;

  try {
    const res = await withRequestSlot(async () =>
      fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          Referer: 'https://builtin.com/jobs',
          ...(getCookieHeader() ? { Cookie: getCookieHeader() as string } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      }),
    );
    storeCookies(res.headers.get('set-cookie'));

    const contentType = res.headers.get('content-type') ?? 'unknown';
    const body = await res.text();
    if (!res.ok) {
      logUnexpectedApiResponse(endpoint, res.status, contentType, body);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      logUnexpectedApiResponse(endpoint, res.status, contentType, body);
      return null;
    }

    const pageData = extractApiPage(parsed);
    if (!pageData) {
      logUnexpectedApiResponse(
        endpoint,
        res.status,
        contentType,
        typeof parsed === 'object' ? JSON.stringify(parsed).slice(0, 500) : body,
      );
      return null;
    }

    return pageData;
  } catch (err) {
    console.warn(
      `  [${SOURCE}] API request failed for "${term}" page ${page} via ${endpoint}:`,
      (err as Error).message,
    );
    return null;
  }
}

async function detectStrategy(): Promise<BuiltInStrategy> {
  for (const endpoint of API_ENDPOINTS) {
    const page = await fetchApiPage(endpoint, SEARCH_TERMS[0], 1);
    if (page) {
      console.log(`  [${SOURCE}] Using API endpoint ${endpoint}`);
      return { kind: 'api', endpoint };
    }
  }

  console.warn(`  [${SOURCE}] Falling back to HTML parsing`);
  return { kind: 'html' };
}

function extractPublishedDates(html: string): Map<number, string> {
  const result = new Map<number, string>();

  for (const match of html.matchAll(/'id':\s*(\d+)\s*,\s*'published_date':'([^']+)'/g)) {
    const id = Number(match[1]);
    const postedAt = normalizePostedAt(match[2]);
    if (!Number.isNaN(id) && postedAt) {
      result.set(id, postedAt);
    }
  }

  return result;
}

function extractLdDescriptions(html: string): Map<number, string> {
  const descriptions = new Map<number, string>();
  const scriptMatch =
    html.match(/<script[^>]*type="application\/ld&#x2B;json"[^>]*>([\s\S]*?)<\/script>/i) ??
    html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);

  if (!scriptMatch?.[1]) return descriptions;

  try {
    const parsed = JSON.parse(scriptMatch[1]) as {
      '@graph'?: Array<{
        '@type'?: string;
        itemListElement?: Array<{ url?: string; description?: string }>;
      }>;
    };

    const itemList = parsed['@graph']?.find(item => item['@type'] === 'ItemList');
    for (const item of itemList?.itemListElement ?? []) {
      if (!item.url) continue;
      const idMatch = item.url.match(/\/(\d+)(?:[/?#]|$)/);
      const id = Number(idMatch?.[1]);
      if (!Number.isNaN(id) && item.description) {
        descriptions.set(id, stripHtml(item.description));
      }
    }
  } catch (err) {
    console.warn(`  [${SOURCE}] Failed to parse JSON-LD fallback data:`, (err as Error).message);
  }

  return descriptions;
}

function extractText(block: string, pattern: RegExp): string | undefined {
  const match = block.match(pattern);
  const value = match?.[1] ? stripHtml(match[1]) : '';
  return value || undefined;
}

function extractTextAfterIcon(block: string, iconClass: string): string | undefined {
  return extractText(
    block,
    new RegExp(
      `${iconClass}[^>]*><\\/i><\\/div>\\s*(?:<div>)?\\s*<span class="font-barlow text-gray-04">([\\s\\S]*?)<\\/span>`,
      'i',
    ),
  );
}

function parseHtmlCards(html: string): { jobs: HtmlCardJob[]; hasNextPage: boolean } {
  const jobs: HtmlCardJob[] = [];
  const cardMatches = [...html.matchAll(/<div id="job-card-(\d+)"/g)];
  const postedAtById = extractPublishedDates(html);
  const descriptionsById = extractLdDescriptions(html);

  for (let index = 0; index < cardMatches.length; index += 1) {
    const match = cardMatches[index];
    const start = match.index;
    if (start === undefined) continue;

    const end =
      index + 1 < cardMatches.length && cardMatches[index + 1].index !== undefined
        ? (cardMatches[index + 1].index as number)
        : html.length;

    const id = Number(match[1]);
    const block = html.slice(start, end);
    const titleMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*data-id="job-card-title"[^>]*>([\s\S]*?)<\/a>/i);
    const company = extractText(block, /data-id="company-title"[^>]*>\s*<span>([\s\S]*?)<\/span>/i);
    const title = titleMatch?.[2] ? stripHtml(titleMatch[2]) : '';
    const relativeUrl = titleMatch?.[1] ? decodeHtmlEntities(titleMatch[1]) : '';

    if (!id || !title || !company || !relativeUrl) continue;

    const workingOption = extractTextAfterIcon(block, 'fa-house-building');
    const location = extractTextAfterIcon(block, 'fa-location-dot');
    const salaryText = extractTextAfterIcon(block, 'fa-sack-dollar');
    const description =
      descriptionsById.get(id) ??
      extractText(block, /<div class="fs-sm fw-regular mb-md text-gray-04">([\s\S]*?)<\/div>/i);
    const salary = parseSalaryRange(salaryText);

    jobs.push({
      id,
      title,
      company,
      location,
      remote: /\bremote\b/i.test(workingOption ?? '') || /\bremote\b/i.test(location ?? ''),
      url: relativeUrl.startsWith('http') ? relativeUrl : `https://builtin.com${relativeUrl}`,
      description,
      salaryMin: salary.min,
      salaryMax: salary.max,
      postedAt: postedAtById.get(id),
    });
  }

  return {
    jobs,
    hasNextPage: /aria-label="Go to Next Page"/i.test(html),
  };
}

async function fetchHtmlPage(term: string, page: number): Promise<{ jobs: HtmlCardJob[]; hasNextPage: boolean } | null> {
  const params = new URLSearchParams({
    search: term,
    country: 'USA',
    page: String(page),
  });
  const url = `${HTML_SEARCH_URL}${HTML_ENTRY_LEVEL_PATH}?${params}`;

  try {
    const res = await withRequestSlot(async () =>
      fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          Referer: 'https://builtin.com/jobs',
          ...(getCookieHeader() ? { Cookie: getCookieHeader() as string } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      }),
    );
    storeCookies(res.headers.get('set-cookie'));

    const html = await res.text();
    if (!res.ok) {
      console.warn(
        `  [${SOURCE}] HTML fallback failed for "${term}" page ${page} with HTTP ${res.status}:`,
        html.slice(0, 500),
      );
      return null;
    }

    return parseHtmlCards(html);
  } catch (err) {
    console.warn(
      `  [${SOURCE}] HTML fallback failed for "${term}" page ${page}:`,
      (err as Error).message,
    );
    return null;
  }
}

function normalizeApiJob(job: BuiltInApiJob): NormalizedJob | null {
  const title = job.title?.trim() ?? '';
  const company = job.companyDetails?.name?.trim() ?? '';
  const location = [job.city, job.state].filter(Boolean).join(', ').trim();
  const description = job.description?.slice(0, 5000);
  const level = inferExperienceLevel(title, description);

  if (!job.id || !title || !company || !level) return null;

  return {
    source: SOURCE,
    source_id: String(job.id),
    title,
    company,
    location: location || undefined,
    remote: job.remote === true,
    url: job.builtinUrl
      ? `https://builtin.com${job.builtinUrl}`
      : `https://builtin.com/job/${job.id}`,
    description,
    salary_min: job.salaryMin || undefined,
    salary_max: job.salaryMax || undefined,
    experience_level: level,
    roles: inferRoles(title),
    posted_at: normalizePostedAt(job.datePosted),
    dedup_hash: generateHash(company, title, location),
  };
}

function normalizeHtmlJob(job: HtmlCardJob): NormalizedJob | null {
  const description = job.description?.slice(0, 5000);
  const location = job.location ?? '';
  const level = inferExperienceLevel(job.title, description);

  if (!level) return null;

  return {
    source: SOURCE,
    source_id: String(job.id),
    title: job.title,
    company: job.company,
    location: location || undefined,
    remote: job.remote,
    url: job.url,
    description,
    salary_min: job.salaryMin,
    salary_max: job.salaryMax,
    experience_level: level,
    roles: inferRoles(job.title),
    posted_at: job.postedAt,
    dedup_hash: generateHash(job.company, job.title, location),
  };
}

async function scrapeViaApi(endpoint: string, seenIds: Set<number>): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];

  await Promise.all(
    SEARCH_TERMS.map(async term => {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const pageData = await fetchApiPage(endpoint, term, page);
        if (!pageData) break;
        if (pageData.jobs.length === 0) break;

        for (const job of pageData.jobs) {
          if (!job.id || seenIds.has(job.id)) continue;

          const normalized = normalizeApiJob(job);
          if (!normalized) continue;

          seenIds.add(job.id);
          jobs.push(normalized);
        }

        if (page * API_PAGE_SIZE >= pageData.totalJobsCount) break;
        await delay(PAGE_DELAY_MS);
      }
    }),
  );

  return jobs;
}

async function scrapeViaHtml(seenIds: Set<number>): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];

  await Promise.all(
    SEARCH_TERMS.map(async term => {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const pageData = await fetchHtmlPage(term, page);
        if (!pageData) break;
        if (pageData.jobs.length === 0) break;

        for (const job of pageData.jobs) {
          if (seenIds.has(job.id)) continue;

          const normalized = normalizeHtmlJob(job);
          if (!normalized) continue;

          seenIds.add(job.id);
          jobs.push(normalized);
        }

        if (!pageData.hasNextPage) break;
        await delay(PAGE_DELAY_MS);
      }
    }),
  );

  return jobs;
}

export async function scrapeBuiltIn(): Promise<NormalizedJob[]> {
  const seenIds = new Set<number>();

  try {
    const strategy = await detectStrategy();
    const jobs =
      strategy.kind === 'api'
        ? await scrapeViaApi(strategy.endpoint, seenIds)
        : await scrapeViaHtml(seenIds);

    console.log(`  [${SOURCE}] ${jobs.length} jobs fetched`);
    return jobs;
  } catch (err) {
    console.warn(`  [${SOURCE}] Unhandled scraper error:`, (err as Error).message);
    return [];
  }
}

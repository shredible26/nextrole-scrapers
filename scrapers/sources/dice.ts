import { pathToFileURL } from 'node:url';
import { generateHash } from '../utils/dedup';
import { inferRoles, inferRemote, inferExperienceLevel, NormalizedJob } from '../utils/normalize';
import { deactivateStaleJobs, uploadJobs } from '../utils/upload';

const SOURCE = 'dice';
const DICE_API_ENDPOINT = 'https://job-search-api.svc.dhigroupinc.com/v1/dice/jobs/search';
const DICE_HTML_ENDPOINT = 'https://www.dice.com/jobs/search';
const MAX_PAGES = 5;
const PAGE_DELAY_MS = 200;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const DICE_API_KEY = '1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WAZcKd8';

const DICE_SEARCHES = [
  'software engineer',
  'data scientist',
  'machine learning',
  'data analyst',
  'product manager',
  'devops',
  'cloud engineer',
  'frontend engineer',
  'backend engineer',
  'full stack',
  'mobile engineer',
  'security engineer',
  'site reliability',
  'data engineer',
  'ai engineer',
  'entry level software engineer',
  'new grad engineer',
  'junior developer',
  'associate engineer',
];

type DiceApiJob = {
  id?: string;
  guid?: string;
  title?: string;
  companyName?: string;
  jobLocation?: {
    displayName?: string;
  };
  detailsPageUrl?: string;
  postedDate?: string;
  modifiedDate?: string;
  salary?: string;
  summary?: string;
  isRemote?: boolean;
  workplaceTypes?: string[];
};

type DiceApiResponse = {
  data?: DiceApiJob[];
  meta?: {
    pageCount?: number;
  };
};

type DicePageResult = {
  jobs: Record<string, unknown>[];
  pageCount?: number;
  endpoint: string;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function sanitizePreview(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

function toAbsoluteDiceUrl(url: string): string {
  if (!url) return '';
  return url.startsWith('http') ? url : `https://www.dice.com${url}`;
}

function parseSalary(salaryStr?: string): { salary_min?: number; salary_max?: number } {
  if (!salaryStr) return {};

  const normalized = salaryStr.replace(/USD/gi, '').replace(/,/g, '');
  const numbers = normalized.match(/\d+(?:\.\d+)?k?/gi) ?? [];
  const parsed = numbers
    .map(value => {
      const amount = parseFloat(value);
      return value.toLowerCase().endsWith('k') ? amount * 1000 : amount;
    })
    .map(amount => Math.round(amount))
    .filter(amount => amount >= 1_000);

  if (parsed.length === 0) return {};
  if (parsed.length === 1) return { salary_min: parsed[0] };
  return { salary_min: Math.min(...parsed), salary_max: Math.max(...parsed) };
}

function parseRelativeDate(raw?: string): string | undefined {
  if (!raw) return undefined;

  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  const now = Date.now();

  if (lower === 'today' || lower === 'just posted') {
    return new Date(now).toISOString();
  }

  const dayMatch = lower.match(/(\d+)\s*d/);
  if (dayMatch) {
    return new Date(now - Number(dayMatch[1]) * 86_400_000).toISOString();
  }

  const hourMatch = lower.match(/(\d+)\s*h/);
  if (hourMatch) {
    return new Date(now - Number(hourMatch[1]) * 3_600_000).toISOString();
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function collectJsonLdJobs(node: unknown, results: Record<string, unknown>[]): void {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdJobs(item, results);
    return;
  }

  if (typeof node !== 'object') return;

  const record = node as Record<string, unknown>;
  const type = record['@type'];
  const isJobPosting =
    type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));

  if (isJobPosting) {
    const hiringOrganization = record.hiringOrganization as
      | { name?: string }
      | undefined;
    const identifier = record.identifier as { value?: string } | undefined;
    const location =
      typeof record.jobLocation === 'string'
        ? record.jobLocation
        : stripHtml(JSON.stringify(record.jobLocation ?? ''));

    results.push({
      id: identifier?.value ?? record.identifier ?? record.url,
      title: record.title,
      companyName: hiringOrganization?.name,
      detailsPageUrl: record.url,
      postedDate: record.datePosted,
      salary:
        typeof record.baseSalary === 'string'
          ? record.baseSalary
          : stripHtml(JSON.stringify(record.baseSalary ?? '')),
      summary: typeof record.description === 'string' ? stripHtml(record.description) : '',
      jobLocation: { displayName: location },
      isRemote: /\bremote\b/i.test(location),
      workplaceTypes: /\bremote\b/i.test(location) ? ['Remote'] : [],
    });
  }

  for (const value of Object.values(record)) {
    collectJsonLdJobs(value, results);
  }
}

function extractJsonLdJobs(html: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];

  for (const match of html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      collectJsonLdJobs(parsed, results);
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }

  return results;
}

function extractDiceHtmlCards(html: string): Record<string, unknown>[] {
  const jobs: Record<string, unknown>[] = [];

  for (const match of html.matchAll(
    /<div[^>]*data-jobkey="([^"]+)"[^>]*data-testid="searchSerpJob"[\s\S]*?<\/div>\s*<\/li>/gi,
  )) {
    const jobKey = match[1];
    const block = match[0];
    const titleMatch = block.match(
      /data-testid="searchSerpJobTitle"[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const companyMatch = block.match(/data-testid="companyName">([\s\S]*?)<\/span>/i);
    const locationMatch = block.match(
      /data-testid="searchSerpJobLocation"[^>]*>([\s\S]*?)<\/span>/i,
    );
    const dateMatch = block.match(/data-testid="searchSerpJobDateStamp"[^>]*>([\s\S]*?)<\/p>/i);
    const salaryMatch = block.match(/data-testid="salaryChip-\d+"[^>]*>([\s\S]*?)<\/span>/i);
    const chipTexts = [...block.matchAll(
      /data-testid="(?:jobTypeChip|requirementChip|benefitChip)-\d+"[^>]*>([\s\S]*?)<\/span>/gi,
    )].map(item => decodeHtmlEntities(stripHtml(item[1])));

    const title = titleMatch?.[2] ? decodeHtmlEntities(stripHtml(titleMatch[2])) : '';
    const companyName = companyMatch?.[1]
      ? decodeHtmlEntities(stripHtml(companyMatch[1]))
      : '';
    const location = locationMatch?.[1]
      ? decodeHtmlEntities(stripHtml(locationMatch[1]))
      : '';
    const url = titleMatch?.[1] ? toAbsoluteDiceUrl(decodeHtmlEntities(titleMatch[1])) : '';
    const salary = salaryMatch?.[1]
      ? decodeHtmlEntities(stripHtml(salaryMatch[1]))
      : '';
    const postedDate = dateMatch?.[1]
      ? parseRelativeDate(decodeHtmlEntities(stripHtml(dateMatch[1])))
      : undefined;
    const remote =
      inferRemote(location) ||
      chipTexts.some(text => /\b(remote|hybrid|work from home)\b/i.test(text));

    if (!title || !companyName || !url) continue;

    jobs.push({
      id: jobKey,
      title,
      companyName,
      detailsPageUrl: url,
      postedDate,
      salary,
      summary: chipTexts.join(' '),
      jobLocation: { displayName: location },
      isRemote: remote,
      workplaceTypes: remote ? ['Remote'] : [],
    });
  }

  return jobs;
}

function mapDiceJob(raw: Record<string, unknown>): NormalizedJob | null {
  const title = String(raw.title ?? '').trim();
  const description = String(raw.summary ?? raw.description ?? '').trim();
  const company = String(raw.companyName ?? raw.company ?? '').trim() || 'Unknown';
  const location =
    typeof raw.jobLocation === 'object' && raw.jobLocation
      ? String((raw.jobLocation as { displayName?: string }).displayName ?? '').trim()
      : String(raw.location ?? '').trim();
  const url = toAbsoluteDiceUrl(String(raw.detailsPageUrl ?? raw.url ?? ''));
  const salary = parseSalary(String(raw.salary ?? ''));
  const workplaceTypes = Array.isArray(raw.workplaceTypes)
    ? raw.workplaceTypes.map(value => String(value))
    : [];
  const remote =
    raw.isRemote === true ||
    workplaceTypes.some(value => value.toLowerCase() === 'remote') ||
    inferRemote(location);
  const posted_at =
    parseRelativeDate(String(raw.postedDate ?? raw.modifiedDate ?? '')) ??
    parseRelativeDate(String(raw.date ?? ''));

  const experienceLevel = inferExperienceLevel(title, description);
  if (!experienceLevel || !title || !url) return null;

  return {
    source: SOURCE,
    source_id: String(raw.guid ?? raw.id ?? url),
    title,
    company,
    location,
    remote,
    url,
    description: description || undefined,
    salary_min: salary.salary_min,
    salary_max: salary.salary_max,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at,
    dedup_hash: generateHash(company, title, location),
  };
}

async function fetchLoggedResponse(
  url: string,
  init: RequestInit,
  label: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    console.warn(`  [dice] ${label} HTTP ${res.status}: ${sanitizePreview(text)}`);
  }
  return { status: res.status, text };
}

function parseDiceApiText(text: string): { jobs: Record<string, unknown>[]; pageCount?: number } {
  try {
    const parsed = JSON.parse(text) as DiceApiResponse;
    return {
      jobs: Array.isArray(parsed.data) ? (parsed.data as Record<string, unknown>[]) : [],
      pageCount: parsed.meta?.pageCount,
    };
  } catch {
    return { jobs: [] };
  }
}

async function fetchApiPage(term: string, page: number): Promise<DicePageResult> {
  const params = new URLSearchParams({
    q: term,
    countryCode2: 'US',
    radius: '100',
    radiusUnit: 'mi',
    page: String(page),
    pageSize: '100',
    language: 'en',
    iam: '0',
    oip: '0',
    includeRemote: 'true',
    includeExternalJobs: 'false',
    sortBy: 'relevance',
    descending: 'false',
  });

  const { status, text } = await fetchLoggedResponse(
    `${DICE_API_ENDPOINT}?${params}`,
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        Referer: 'https://www.dice.com/jobs',
        'x-api-key': DICE_API_KEY,
      },
    },
    `api "${term}" page ${page}`,
  );

  if (status >= 400) {
    return { jobs: [], endpoint: 'api' };
  }

  const parsed = parseDiceApiText(text);
  return { jobs: parsed.jobs, pageCount: parsed.pageCount, endpoint: 'api' };
}

async function fetchHtmlPage(term: string, page: number): Promise<DicePageResult> {
  const params = new URLSearchParams({
    q: term,
    location: 'United States',
    page: String(page),
  });

  const { status, text } = await fetchLoggedResponse(
    `${DICE_HTML_ENDPOINT}?${params}`,
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        Referer: 'https://www.dice.com/jobs',
      },
    },
    `html "${term}" page ${page}`,
  );

  if (status >= 400) {
    return { jobs: [], endpoint: 'html' };
  }

  const jsonLdJobs = extractJsonLdJobs(text);
  if (jsonLdJobs.length > 0) {
    return { jobs: jsonLdJobs, endpoint: 'html' };
  }

  return { jobs: extractDiceHtmlCards(text), endpoint: 'html' };
}

async function fetchDicePage(term: string, page: number): Promise<DicePageResult> {
  const apiResult = await fetchApiPage(term, page);
  if (apiResult.jobs.length > 0) {
    return apiResult;
  }

  return fetchHtmlPage(term, page);
}

export async function scrapeDice(): Promise<NormalizedJob[]> {
  const seenUrls = new Set<string>();
  const jobs: NormalizedJob[] = [];

  for (const term of DICE_SEARCHES) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      try {
        const result = await fetchDicePage(term, page);
        if (result.jobs.length === 0) {
          break;
        }

        for (const raw of result.jobs) {
          const normalized = mapDiceJob(raw);
          if (!normalized || !normalized.url || seenUrls.has(normalized.url)) continue;
          seenUrls.add(normalized.url);
          jobs.push(normalized);
        }

        console.log(
          `  [dice] ${term} page ${page}: ${result.jobs.length} raw jobs via ${result.endpoint}; total=${jobs.length}`,
        );

        if (result.pageCount && page >= result.pageCount) {
          break;
        }

        await sleep(PAGE_DELAY_MS);
      } catch (err) {
        console.warn(`  [dice] "${term}" page ${page} failed: ${(err as Error).message}`);
        break;
      }
    }
  }

  if (jobs.length === 0) {
    console.warn('  [dice] 0 jobs returned after probing all endpoints');
  }

  return jobs;
}

async function runStandalone(): Promise<void> {
  const startedAt = Date.now();
  const jobs = await scrapeDice();

  console.log(`  [${SOURCE}] Total unique jobs: ${jobs.length}`);

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

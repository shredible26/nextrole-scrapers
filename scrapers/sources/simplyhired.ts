import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { generateHash } from '../utils/dedup';
import { inferRoles, inferRemote, inferExperienceLevel, NormalizedJob } from '../utils/normalize';

const SOURCE = 'simplyhired';
const SEARCH_URL = 'https://www.simplyhired.com/search';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};
const BLOCKED_HEADERS: Record<string, string> = {
  ...BASE_HEADERS,
  Cookie: '',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
};
const MAX_PAGES = 5;
const PAGE_DELAY_MS = 500;

const SEARCH_TERMS = [
  'software engineer entry level',
  'software engineer new grad',
  'data scientist entry level',
  'machine learning engineer entry level',
  'junior software engineer',
  'associate software engineer',
  'data analyst entry level',
  'backend engineer entry level',
  'frontend engineer entry level',
  'devops engineer entry level',
];

type SimplyHiredJobRecord = Record<string, unknown>;

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

function toAbsoluteUrl(url: string): string {
  if (!url) return '';
  return url.startsWith('http') ? url : `https://www.simplyhired.com${url}`;
}

function parseSalary(salaryStr?: string): { salary_min?: number; salary_max?: number } {
  if (!salaryStr) return {};

  const numbers = salaryStr.replace(/,/g, '').match(/\d+(?:\.\d+)?k?/gi) ?? [];
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

  const dayMatch = lower.match(/(\d+)\s*\+?\s*d/);
  if (dayMatch) {
    return new Date(now - Number(dayMatch[1]) * 86_400_000).toISOString();
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function isChallengePage(html: string): boolean {
  return /just a moment|enable javascript and cookies to continue|_cf_chl_opt/i.test(html);
}

function extractBalancedJson(text: string, startIndex: number): string | null {
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
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function collectJsonLdJobs(node: unknown, results: SimplyHiredJobRecord[]): void {
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
      url: record.url,
      postedDate: record.datePosted,
      salary:
        typeof record.baseSalary === 'string'
          ? record.baseSalary
          : stripHtml(JSON.stringify(record.baseSalary ?? '')),
      description: typeof record.description === 'string' ? stripHtml(record.description) : '',
      location,
      isRemote: /\bremote\b/i.test(location),
    });
  }

  for (const value of Object.values(record)) {
    collectJsonLdJobs(value, results);
  }
}

function extractJsonLdJobs(html: string): SimplyHiredJobRecord[] {
  const jobs: SimplyHiredJobRecord[] = [];

  for (const match of html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      collectJsonLdJobs(parsed, jobs);
    } catch {
      // Ignore malformed JSON-LD.
    }
  }

  return jobs;
}

function collectEmbeddedJobs(node: unknown, results: SimplyHiredJobRecord[]): void {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const item of node) collectEmbeddedJobs(item, results);
    return;
  }

  if (typeof node !== 'object') return;

  const record = node as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title : '';
  const companyName =
    typeof record.companyName === 'string'
      ? record.companyName
      : typeof record.company === 'string'
      ? record.company
      : '';
  const location =
    typeof record.location === 'string'
      ? record.location
      : typeof record.formattedLocation === 'string'
      ? record.formattedLocation
      : '';
  const url =
    typeof record.url === 'string'
      ? record.url
      : typeof record.link === 'string'
      ? record.link
      : '';

  if (title && companyName && url) {
    results.push({
      id: record.id ?? record.jobKey ?? url,
      title,
      companyName,
      url,
      location,
      postedDate: record.datePosted ?? record.postedDate,
      salary: record.salaryText ?? record.salary,
      description: record.description ?? record.snippet,
      isRemote:
        record.isRemote === true ||
        /\bremote\b/i.test(location) ||
        /\bremote\b/i.test(String(record.description ?? '')),
    });
  }

  for (const value of Object.values(record)) {
    collectEmbeddedJobs(value, results);
  }
}

function extractEmbeddedJobs(html: string): SimplyHiredJobRecord[] {
  const jobs: SimplyHiredJobRecord[] = [];
  const markers = [
    'window.__initialData',
    'window.__INITIAL_DATA__',
    'window.__PRELOADED_STATE__',
    'window.__INITIAL_STATE__',
  ];

  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex === -1) continue;

    const objectStart = html.indexOf('{', markerIndex);
    if (objectStart === -1) continue;

    const jsonText = extractBalancedJson(html, objectStart);
    if (!jsonText) continue;

    try {
      const parsed = JSON.parse(jsonText) as unknown;
      collectEmbeddedJobs(parsed, jobs);
      if (jobs.length > 0) {
        return jobs;
      }
    } catch {
      // Ignore malformed embedded JSON.
    }
  }

  return jobs;
}

function extractHtmlJobs(html: string): SimplyHiredJobRecord[] {
  const jobs: SimplyHiredJobRecord[] = [];

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
    const url = titleMatch?.[1] ? toAbsoluteUrl(decodeHtmlEntities(titleMatch[1])) : '';
    const salaryText = salaryMatch?.[1]
      ? decodeHtmlEntities(stripHtml(salaryMatch[1]))
      : '';
    const description = chipTexts.join(' ');
    const remote =
      inferRemote(location) ||
      chipTexts.some(text => /\b(remote|hybrid|work from home)\b/i.test(text));

    if (!title || !companyName || !url) continue;

    jobs.push({
      id: jobKey,
      title,
      companyName,
      url,
      location,
      postedDate: dateMatch?.[1]
        ? parseRelativeDate(decodeHtmlEntities(stripHtml(dateMatch[1])))
        : undefined,
      salary: salaryText,
      description,
      isRemote: remote,
    });
  }

  return jobs;
}

function mapJob(raw: SimplyHiredJobRecord): NormalizedJob | null {
  const title = String(raw.title ?? '').trim();
  const company = String(raw.companyName ?? raw.company ?? '').trim();
  const location = String(raw.location ?? '').trim();
  const url = toAbsoluteUrl(String(raw.url ?? ''));
  const description = String(raw.description ?? '').trim();
  const posted_at = parseRelativeDate(String(raw.postedDate ?? ''));
  const remote = raw.isRemote === true || inferRemote(location);
  const salary = parseSalary(String(raw.salary ?? ''));
  const level = inferExperienceLevel(title, description);

  if (!level || !title || !company || !url) return null;

  return {
    source: SOURCE,
    source_id: String(raw.id ?? url),
    title,
    company,
    location,
    remote,
    url,
    description: description || undefined,
    salary_min: salary.salary_min,
    salary_max: salary.salary_max,
    experience_level: level,
    roles: inferRoles(title),
    posted_at,
    dedup_hash: generateHash(company, title, location),
  };
}

export async function scrapeSimplyHired(): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];
  const seenUrls = new Set<string>();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  const getBrowserPage = async (): Promise<Page> => {
    if (page) return page;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: 'en-US',
    });
    page = await context.newPage();
    return page;
  };

  const fetchWithBrowser = async (url: string): Promise<string | null> => {
    try {
      const browserPage = await getBrowserPage();
      await browserPage.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
      return await browserPage.content();
    } catch (err) {
      console.warn(`  [${SOURCE}] browser fallback failed: ${(err as Error).message}`);
      return null;
    }
  };

  const fetchSearchHtml = async (url: string): Promise<string | null> => {
    try {
      let res = await fetch(url, {
        headers: BASE_HEADERS,
        signal: AbortSignal.timeout(20_000),
      });
      let html = await res.text();
      console.log(`  [${SOURCE}] fetch HTTP ${res.status}: ${sanitizePreview(html)}`);

      if (res.status === 403) {
        res = await fetch(url, {
          headers: BLOCKED_HEADERS,
          signal: AbortSignal.timeout(20_000),
        });
        html = await res.text();
        console.log(`  [${SOURCE}] retry HTTP ${res.status}: ${sanitizePreview(html)}`);
      }

      if (res.status === 403 || isChallengePage(html)) {
        console.log(`  [${SOURCE}] challenge detected, using browser fallback`);
        return await fetchWithBrowser(url);
      }

      return html;
    } catch (err) {
      console.warn(`  [${SOURCE}] fetch failed: ${(err as Error).message}`);
      return await fetchWithBrowser(url);
    }
  };

  try {
    for (const term of SEARCH_TERMS) {
      for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
        const params = new URLSearchParams({
          q: term,
          l: 'United States',
          fdb: '7',
          sb: 'dd',
          pn: String(pageNumber),
        });
        const url = `${SEARCH_URL}?${params}`;
        const html = await fetchSearchHtml(url);
        if (!html) break;

        const parsedJobs =
          extractJsonLdJobs(html).length > 0
            ? extractJsonLdJobs(html)
            : extractEmbeddedJobs(html).length > 0
            ? extractEmbeddedJobs(html)
            : extractHtmlJobs(html);

        if (parsedJobs.length === 0) {
          break;
        }

        for (const rawJob of parsedJobs) {
          const job = mapJob(rawJob);
          if (!job || seenUrls.has(job.url)) continue;
          seenUrls.add(job.url);
          jobs.push(job);
        }

        await sleep(PAGE_DELAY_MS);
      }
    }
  } finally {
    const currentPage = page as Page | null;
    const currentContext = context as BrowserContext | null;
    const currentBrowser = browser as Browser | null;

    if (currentPage) {
      await currentPage.close().catch(() => undefined);
    }
    if (currentContext) {
      await currentContext.close().catch(() => undefined);
    }
    if (currentBrowser) {
      await currentBrowser.close().catch(() => undefined);
    }
  }

  return jobs;
}

import type { Browser, BrowserContext, Page } from 'playwright';

import { createBrowser, sleep } from '../base';
import { generateHash } from '../utils/dedup';
import {
  inferExperienceLevel,
  inferRemote,
  inferRoles,
  NormalizedJob,
} from '../utils/normalize';

const SOURCE = 'wellfound';
const WELLFOUND_BASE_URL = 'https://wellfound.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQUEST_DELAY_MS = 1000;
const HTML_PREVIEW_CHARS = 300;

const SEARCH_PATHS = [
  '/role/r/software-engineer',
  '/role/r/full-stack-engineer',
  '/role/r/data-scientist',
  '/role/r/machine-learning-engineer',
  '/role/r/data-analyst',
  '/role/r/product-manager',
] as const;

const BASE_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

type ApolloGraph = Record<string, unknown>;
type ApolloNode = Record<string, unknown>;

function sanitizePreview(value: string, limit = HTML_PREVIEW_CHARS): string {
  return value.replace(/\s+/g, ' ').slice(0, limit);
}

function isChallengePage(html: string): boolean {
  return /please enable js and disable any ad blocker|access is temporarily restricted|captcha-delivery|just a moment/i
    .test(html);
}

function parseCompensation(comp?: string): { salary_min?: number; salary_max?: number } {
  if (!comp) return {};

  const numbers = comp.replace(/,/g, '').match(/\d+(?:\.\d+)?k?/gi) ?? [];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (typeof item === 'string') return item.trim();
      if (!isRecord(item)) return '';
      return toString(item.name) || toString(item.label) || toString(item.displayName);
    })
    .filter(Boolean);
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  return undefined;
}

function toAbsoluteUrl(value: string): string {
  if (!value) return '';
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  if (value.startsWith('/')) return `${WELLFOUND_BASE_URL}${value}`;
  return `${WELLFOUND_BASE_URL}/${value}`;
}

function extractApolloGraph(html: string): ApolloGraph | null {
  const match = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) return null;

  try {
    const nextData = JSON.parse(match[1]) as {
      props?: {
        pageProps?: {
          apolloState?: {
            data?: ApolloGraph;
          };
        };
      };
    };

    const graph = nextData.props?.pageProps?.apolloState?.data;
    return isRecord(graph) ? graph : null;
  } catch {
    return null;
  }
}

function resolveApolloValue(value: unknown, graph: ApolloGraph, seen = new Set<string>()): unknown {
  if (Array.isArray(value)) {
    return value.map(item => resolveApolloValue(item, graph, new Set(seen)));
  }

  if (!isRecord(value)) return value;

  const ref =
    typeof value.__ref === 'string'
      ? value.__ref
      : value.type === 'id' && typeof value.id === 'string'
      ? value.id
      : null;

  if (ref) {
    if (seen.has(ref)) {
      return graph[ref] ?? value;
    }

    const resolved = graph[ref];
    if (resolved === undefined) return value;

    const nextSeen = new Set(seen);
    nextSeen.add(ref);
    return resolveApolloValue(resolved, graph, nextSeen);
  }

  const flattened: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    flattened[key] = resolveApolloValue(entry, graph, new Set(seen));
  }
  return flattened;
}

function extractPageCount(graph: ApolloGraph): number {
  const rootQuery = isRecord(graph.ROOT_QUERY) ? graph.ROOT_QUERY : null;
  if (!rootQuery) return 1;

  const talent = resolveApolloValue(rootQuery.talent, graph);
  if (!isRecord(talent)) return 1;

  for (const [key, value] of Object.entries(talent)) {
    if (!key.includes('seoLandingPageJobSearchResults') && !key.includes('jobSearchResults')) {
      continue;
    }

    if (!isRecord(value)) continue;
    const pageCount = value.pageCount;
    if (typeof pageCount === 'number' && Number.isFinite(pageCount) && pageCount >= 1) {
      return Math.floor(pageCount);
    }
  }

  return 1;
}

function extractStartupResults(graph: ApolloGraph): ApolloNode[] {
  return Object.entries(graph)
    .filter(([key]) => key.startsWith('StartupResult:'))
    .map(([, value]) => resolveApolloValue(value, graph))
    .filter(isRecord);
}

function mapStartupJob(startup: ApolloNode, listing: ApolloNode): NormalizedJob | null {
  const title = toString(listing.title);
  if (!title) return null;

  const description = toString(listing.description) || toString(startup.highConcept);
  const experienceLevel = inferExperienceLevel(title, description);
  if (!experienceLevel) return null;

  const company = toString(startup.name) || 'Unknown';
  const locationNames = toStringArray(listing.locationNames);
  const remote =
    listing.remotable === true ||
    listing.remote === true ||
    locationNames.some(location => inferRemote(location));
  const location = locationNames[0] ?? (remote ? 'Remote' : '');

  const rawUrl =
    toString(listing.url) ||
    toString(listing.applyUrl) ||
    (toString(listing.id) && toString(listing.slug)
      ? `${WELLFOUND_BASE_URL}/jobs/${toString(listing.id)}-${toString(listing.slug)}`
      : '') ||
    (toString(startup.slug) ? `${WELLFOUND_BASE_URL}/company/${toString(startup.slug)}/jobs` : '');

  const { salary_min, salary_max } = parseCompensation(toString(listing.compensation));

  return {
    source: SOURCE,
    source_id: toString(listing.id) || generateHash(company, title, rawUrl),
    title,
    company,
    location,
    remote,
    url: toAbsoluteUrl(rawUrl),
    description,
    salary_min,
    salary_max,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at:
      toIsoTimestamp(listing.liveStartAt) ??
      toIsoTimestamp(listing.createdAt) ??
      toIsoTimestamp(listing.postedAt),
    dedup_hash: generateHash(company, title, location),
  };
}

function parseSearchHtml(html: string): { jobs: NormalizedJob[]; pageCount: number } {
  const graph = extractApolloGraph(html);
  if (!graph) {
    throw new Error('No __NEXT_DATA__ Apollo state found in HTML');
  }

  const jobs: NormalizedJob[] = [];
  const startupResults = extractStartupResults(graph);

  for (const startup of startupResults) {
    const highlightedJobs = Array.isArray(startup.highlightedJobListings)
      ? startup.highlightedJobListings
      : [];

    for (const item of highlightedJobs) {
      if (!isRecord(item)) continue;
      const job = mapStartupJob(startup, item);
      if (job) jobs.push(job);
    }
  }

  return {
    jobs,
    pageCount: extractPageCount(graph),
  };
}

async function fetchDirectHtml(url: string): Promise<{ status: number; html: string }> {
  const response = await fetch(url, {
    headers: BASE_HEADERS,
    redirect: 'follow',
  });
  return {
    status: response.status,
    html: await response.text(),
  };
}

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

async function getBrowserPage(): Promise<Page> {
  if (page) return page;

  const useProxy = Boolean(process.env.PROXY_SERVER?.trim());
  browser = await createBrowser(useProxy);
  context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
  });
  page = await context.newPage();
  return page;
}

async function fetchBrowserHtml(url: string): Promise<{ status: number; html: string }> {
  const browserPage = await getBrowserPage();
  const response = await browserPage.goto(url, {
    waitUntil: 'networkidle',
    timeout: 90_000,
  });
  return {
    status: response?.status() ?? 0,
    html: await browserPage.content(),
  };
}

async function fetchSearchHtml(url: string): Promise<{ status: number; html: string }> {
  const direct = await fetchDirectHtml(url);
  console.log(`  [${SOURCE}] GET ${url} -> ${direct.status} :: ${sanitizePreview(direct.html)}`);

  if (direct.status === 200 && !isChallengePage(direct.html)) {
    return direct;
  }

  console.log(`  [${SOURCE}] challenge detected on direct fetch, trying browser${process.env.PROXY_SERVER?.trim() ? ' with proxy support' : ''}`);
  const browserResult = await fetchBrowserHtml(url);
  console.log(
    `  [${SOURCE}] Browser ${url} -> ${browserResult.status} :: ${sanitizePreview(browserResult.html)}`,
  );
  return browserResult;
}

async function scrapeSearchPath(path: string): Promise<NormalizedJob[]> {
  const baseUrl = `${WELLFOUND_BASE_URL}${path}`;
  const firstPage = await fetchSearchHtml(baseUrl);

  if (firstPage.status !== 200 || isChallengePage(firstPage.html)) {
    throw new Error(`Search page blocked at ${path} (status ${firstPage.status})`);
  }

  const firstParse = parseSearchHtml(firstPage.html);
  const jobs = [...firstParse.jobs];
  const totalPages = Math.max(1, firstParse.pageCount);

  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    await sleep(REQUEST_DELAY_MS);
    const pageUrl = `${baseUrl}?page=${pageNumber}`;
    const pageResult = await fetchSearchHtml(pageUrl);

    if (pageResult.status !== 200 || isChallengePage(pageResult.html)) {
      console.warn(`  [${SOURCE}] page ${pageNumber} for ${path} blocked (status ${pageResult.status})`);
      continue;
    }

    try {
      const parsed = parseSearchHtml(pageResult.html);
      jobs.push(...parsed.jobs);
    } catch (err) {
      console.warn(`  [${SOURCE}] failed to parse ${pageUrl}: ${(err as Error).message}`);
    }
  }

  return jobs;
}

export async function scrapeWellfound(): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];
  const seenHashes = new Set<string>();

  try {
    for (const path of SEARCH_PATHS) {
      let pathJobs: NormalizedJob[] = [];

      try {
        pathJobs = await scrapeSearchPath(path);
      } catch (err) {
        console.warn(`  [${SOURCE}] ${path} failed: ${(err as Error).message}`);
      }

      for (const job of pathJobs) {
        if (!seenHashes.has(job.dedup_hash)) {
          seenHashes.add(job.dedup_hash);
          jobs.push(job);
        }
      }

      await sleep(REQUEST_DELAY_MS);
    }
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    page = null;
    context = null;
    browser = null;
  }

  if (jobs.length === 0) {
    const proxyHint = process.env.PROXY_SERVER?.trim()
      ? 'Configured proxy still could not clear Wellfound.'
      : 'Current IP appears blocked by Wellfound/DataDome. Configure PROXY_SERVER/PROXY_USER/PROXY_PASS to retry with a clean proxy.';
    console.warn(`  [${SOURCE}] 0 jobs returned. ${proxyHint}`);
  }

  return jobs;
}

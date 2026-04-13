// Source: https://{slug}.recruitee.com/api/offers/
// Public JSON API — no auth required. The main challenge is discovering active
// company slugs, so this scraper combines seed lists, GitHub resources,
// passive-DNS feeds, urlscan, sitemap probes, and Common Crawl.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generateHash } from '../utils/dedup';
import {
  type ExperienceLevel,
  inferExperienceLevel,
  inferRemote,
  inferRoles,
  type NormalizedJob,
} from '../utils/normalize';

const SOURCE = 'recruitee';
const SLUG_CACHE_PATH = join(process.cwd(), 'scrapers', 'cache', 'recruitee-slugs.json');

const OFFER_FETCH_TIMEOUT_MS = 5_000;
const DISCOVERY_TIMEOUT_MS = 20_000;
const COMMON_CRAWL_TIMEOUT_MS = 12_000;
const COMMON_CRAWL_LIMIT = 500;
const FETCH_BATCH_SIZE = 2;
const FETCH_BATCH_DELAY_MS = 100;

const MANUAL_SEED_SLUGS = [
  'basecamp', 'miro', 'contentful', 'personio', 'hotjar', 'typeform', 'pitch', 'pleo',
  'leapsome', 'remote', 'loom', 'linear', 'zeplin', 'storyblok', 'lokalise', 'appcues',
  'usersnap', 'maze', 'rows', 'passionfroot', 'orbit', 'cal', 'dopt', 'primer',
  'ashbyhq', 'breezy', 'factorial', 'bamboo', 'hibob', 'smallpdf', 'phrase', 'swisscom',
  'n26', 'klarna', 'ecosia', 'deepl', 'pricehubly', 'junto', 'pitch-avatar', 'pitch',
  'sketch', 'bynder', 'vimcar', 'taxfix',
] as const;

const GITHUB_SOURCE_URLS = [
  'https://raw.githubusercontent.com/tramcar/tramcar/master/config/ats/recruitee.txt',
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json',
  // GitHub search surfaced this internship issue with a Recruitee board URL.
  'https://github.com/vanshb03/Summer2026-Internships/issues/1230',
] as const;

const SITEMAP_URLS = [
  'https://recruitee.com/sitemap.xml',
  'https://app.recruitee.com/sitemap.xml',
] as const;

const COMMON_CRAWL_INDEXES = [
  'CC-MAIN-2024-51-index',
  'CC-MAIN-2025-13-index',
] as const;

const URLSCAN_DISCOVERY_QUERIES = [
  { query: 'page.domain:recruitee.com', maxPages: 1 },
  { query: 'task.domain:recruitee.com', maxPages: 1 },
  { query: 'domain:recruitee.com', maxPages: 1 },
  { query: 'page.title:"Careers @" AND page.domain:recruitee.com', maxPages: 3 },
  { query: 'page.title:"Jobs @" AND page.domain:recruitee.com', maxPages: 1 },
  { query: 'page.title:"Vacatures @" AND page.domain:recruitee.com', maxPages: 1 },
  { query: 'page.title:"Karriere @" AND page.domain:recruitee.com', maxPages: 1 },
  { query: 'page.title:"Stellenangebote @" AND page.domain:recruitee.com', maxPages: 1 },
  { query: 'page.title:"Join @" AND page.domain:recruitee.com', maxPages: 1 },
  { query: 'page.title:"Career @" AND page.domain:recruitee.com', maxPages: 1 },
] as const;

type FetchTextResult = {
  ok: boolean;
  status: number;
  text: string;
  timedOut: boolean;
};

type RecruiteeLocation = {
  city?: unknown;
  country?: unknown;
  name?: unknown;
};

type RecruiteeOffer = {
  id?: unknown;
  guid?: unknown;
  title?: unknown;
  slug?: unknown;
  city?: unknown;
  country?: unknown;
  location?: unknown;
  locations?: unknown;
  remote?: unknown;
  description?: unknown;
  careers_url?: unknown;
  company_name?: unknown;
  department?: unknown;
  experience_code?: unknown;
  employment_type_code?: unknown;
  created_at?: unknown;
  published_at?: unknown;
  status?: unknown;
};

type RecruiteeApiResponse = {
  offers?: unknown;
};

type UrlscanResult = {
  page?: {
    domain?: string | null;
  } | null;
  task?: {
    domain?: string | null;
  } | null;
  sort?: [number, string] | null;
};

type UrlscanSearchResponse = {
  results?: UrlscanResult[];
};

type StructuredExperienceResult = ExperienceLevel | 'reject' | null;

const RECRUITEE_ENTRY_LEVEL_CODES = new Set(['entry_level']);
const RECRUITEE_STUDENT_CODES = new Set(['student_college', 'student_school']);
const RECRUITEE_MID_OR_HIGH_CODES = new Set([
  'experienced',
  'mid_level',
  'manager',
  'senior_manager',
  'executive',
]);
const RECRUITEE_INTERNSHIP_EMPLOYMENT_CODES = new Set(['internship']);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeSlug(rawSlug: string): string | null {
  const slug = rawSlug.trim().toLowerCase();
  if (slug.length < 2 || slug.length > 100) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
  return slug;
}

function extractSlugFromHostname(hostname: string): string | null {
  const normalizedHost = hostname.toLowerCase().trim().replace(/\.+$/, '');
  const match = normalizedHost.match(/([a-z0-9-]+)\.recruitee\.com$/);
  return match ? normalizeSlug(match[1]) : null;
}

function extractSlugFromUrl(rawUrl: string): string | null {
  try {
    return extractSlugFromHostname(new URL(rawUrl).hostname);
  } catch {
    return null;
  }
}

function collectSlugsFromText(text: string): Set<string> {
  const slugs = new Set<string>();

  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    const slug = extractSlugFromUrl(match[0]);
    if (slug) {
      slugs.add(slug);
    }
  }

  for (const match of text.matchAll(/\b[a-z0-9.-]+\.recruitee\.com\b/gi)) {
    const slug = extractSlugFromHostname(match[0]);
    if (slug) {
      slugs.add(slug);
    }
  }

  return slugs;
}

function collectPlainSlugsFromText(text: string): Set<string> {
  const slugs = new Set<string>();

  for (const line of text.split('\n')) {
    const cleaned = line.trim().replace(/#.*/, '');
    if (!cleaned) continue;

    const slug = normalizeSlug(cleaned);
    if (slug) {
      slugs.add(slug);
    }
  }

  return slugs;
}

function addAll(target: Set<string>, source: Iterable<string>): void {
  for (const item of source) {
    target.add(item);
  }
}

function formatCompanyName(slug: string): string {
  return slug
    .split('-')
    .map(part => {
      if (!part) return part;
      if (part === 'ai' || part === 'io' || part === 'qa' || part === 'hr') {
        return part.toUpperCase();
      }

      return part[0].toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePostedAt(value?: string): string | undefined {
  if (!value) return undefined;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;

  return date.toISOString();
}

function buildLocation(offer: RecruiteeOffer): string | undefined {
  const city = coerceString(offer.city);
  const country = coerceString(offer.country);

  if (city && country) {
    return city.toLowerCase() === country.toLowerCase() ? city : `${city}, ${country}`;
  }

  const directLocation = coerceString(offer.location);
  if (directLocation) {
    return directLocation;
  }

  if (Array.isArray(offer.locations)) {
    for (const rawLocation of offer.locations) {
      if (!rawLocation || typeof rawLocation !== 'object') continue;

      const location = rawLocation as RecruiteeLocation;
      const nestedCity = coerceString(location.city);
      const nestedCountry = coerceString(location.country);
      const nestedName = coerceString(location.name);

      if (nestedCity && nestedCountry) {
        return nestedCity.toLowerCase() === nestedCountry.toLowerCase()
          ? nestedCity
          : `${nestedCity}, ${nestedCountry}`;
      }

      if (nestedName) {
        return nestedName;
      }
    }
  }

  return country;
}

function normalizeJobUrl(slug: string, offer: RecruiteeOffer): string | undefined {
  const careersUrl = coerceString(offer.careers_url);
  if (careersUrl) {
    try {
      return new URL(careersUrl).toString();
    } catch {
      if (careersUrl.startsWith('/')) {
        return `https://${slug}.recruitee.com${careersUrl}`;
      }
    }
  }

  const offerSlug = coerceString(offer.slug);
  return offerSlug ? `https://${slug}.recruitee.com/o/${offerSlug}` : undefined;
}

function inferStructuredExperienceLevel(
  offer: RecruiteeOffer,
  title: string,
): StructuredExperienceResult {
  const experienceCode = coerceString(offer.experience_code)?.toLowerCase();
  const employmentType = coerceString(offer.employment_type_code)?.toLowerCase();

  if (
    (employmentType && RECRUITEE_INTERNSHIP_EMPLOYMENT_CODES.has(employmentType)) ||
    (experienceCode && RECRUITEE_STUDENT_CODES.has(experienceCode))
  ) {
    return 'internship';
  }

  if (experienceCode && RECRUITEE_MID_OR_HIGH_CODES.has(experienceCode)) {
    return 'reject';
  }

  if (experienceCode && RECRUITEE_ENTRY_LEVEL_CODES.has(experienceCode)) {
    return /\bintern(ship)?\b/i.test(title) ? 'internship' : 'entry_level';
  }

  return null;
}

async function fetchTextWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: '*/*',
        'User-Agent': 'NextRole Job Aggregator (+https://nextrole-phi.vercel.app)',
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });

    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
      timedOut: false,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';

    return {
      ok: false,
      status: 0,
      text: '',
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<T | null> {
  const result = await fetchTextWithTimeout(url, init, timeoutMs);
  if (!result.ok) return null;

  try {
    return JSON.parse(result.text) as T;
  } catch {
    return null;
  }
}

async function loadCachedSlugs(): Promise<string[]> {
  try {
    const raw = await readFile(SLUG_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(value => (typeof value === 'string' ? normalizeSlug(value) : null))
      .filter((value): value is string => value !== null);
  } catch {
    return [];
  }
}

async function saveDiscoveredSlugs(slugs: string[]): Promise<void> {
  await mkdir(join(process.cwd(), 'scrapers', 'cache'), { recursive: true });
  await writeFile(SLUG_CACHE_PATH, `${JSON.stringify(slugs, null, 2)}\n`);
}

async function discoverFromGitHub(): Promise<Set<string>> {
  const slugs = new Set<string>();

  for (const url of GITHUB_SOURCE_URLS) {
    const result = await fetchTextWithTimeout(url);
    if (!result.ok) continue;

    addAll(slugs, collectSlugsFromText(result.text));

    if (url.endsWith('/recruitee.txt')) {
      addAll(slugs, collectPlainSlugsFromText(result.text));
    }
  }

  return slugs;
}

async function discoverFromSitemaps(): Promise<Set<string>> {
  const slugs = new Set<string>();

  for (const url of SITEMAP_URLS) {
    const result = await fetchTextWithTimeout(url);
    if (!result.ok) continue;

    addAll(slugs, collectSlugsFromText(result.text));
  }

  return slugs;
}

async function discoverFromCommonCrawlIndex(
  index: typeof COMMON_CRAWL_INDEXES[number],
): Promise<Set<string>> {
  const slugs = new Set<string>();
  const url =
    `https://index.commoncrawl.org/${index}` +
    `?url=${encodeURIComponent('*.recruitee.com/api/offers*')}` +
    `&output=json&limit=${COMMON_CRAWL_LIMIT}`;

  const result = await fetchTextWithTimeout(url, {}, COMMON_CRAWL_TIMEOUT_MS);
  if (!result.ok || result.text.trimStart().startsWith('<')) {
    return slugs;
  }

  for (const line of result.text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const record = JSON.parse(trimmed) as { url?: string };
      if (typeof record.url !== 'string') continue;

      const slug = extractSlugFromUrl(record.url);
      if (slug) {
        slugs.add(slug);
      }
    } catch {
      // Skip malformed JSONL rows.
    }
  }

  return slugs;
}

async function discoverFromCommonCrawl(): Promise<Set<string>> {
  const discovered = new Set<string>();

  for (const index of COMMON_CRAWL_INDEXES) {
    addAll(discovered, await discoverFromCommonCrawlIndex(index));
  }

  return discovered;
}

async function discoverFromHackertarget(): Promise<Set<string>> {
  const result = await fetchTextWithTimeout('https://api.hackertarget.com/hostsearch/?q=recruitee.com');
  return result.ok ? collectSlugsFromText(result.text) : new Set<string>();
}

async function discoverFromAnubis(): Promise<Set<string>> {
  const data = await fetchJsonWithTimeout<string[]>(
    'https://jldc.me/anubis/subdomains/recruitee.com',
  );
  if (!Array.isArray(data)) return new Set<string>();

  const slugs = new Set<string>();
  for (const hostname of data) {
    if (typeof hostname !== 'string') continue;

    const slug = extractSlugFromHostname(hostname);
    if (slug) {
      slugs.add(slug);
    }
  }

  return slugs;
}

async function discoverFromRapidDns(): Promise<Set<string>> {
  const result = await fetchTextWithTimeout('https://rapiddns.io/subdomain/recruitee.com?full=1');
  return result.ok ? collectSlugsFromText(result.text) : new Set<string>();
}

async function discoverFromUrlscanQuery(query: string, maxPages: number): Promise<Set<string>> {
  const slugs = new Set<string>();
  let searchAfter: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const url =
      `https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=100` +
      (searchAfter ? `&search_after=${encodeURIComponent(searchAfter)}` : '');

    const response = await fetchJsonWithTimeout<UrlscanSearchResponse>(url);
    const results = response?.results ?? [];
    if (results.length === 0) break;

    for (const result of results) {
      const domains = [result.page?.domain, result.task?.domain];

      for (const domain of domains) {
        if (!domain) continue;

        const slug = extractSlugFromHostname(domain);
        if (slug) {
          slugs.add(slug);
        }
      }
    }

    const lastSort = results.at(-1)?.sort;
    if (!lastSort?.[0] || !lastSort[1]) break;
    searchAfter = `${lastSort[0]},${lastSort[1]}`;
    await sleep(150);
  }

  return slugs;
}

async function discoverFromUrlscan(): Promise<Set<string>> {
  const slugs = new Set<string>();

  for (const { query, maxPages } of URLSCAN_DISCOVERY_QUERIES) {
    addAll(slugs, await discoverFromUrlscanQuery(query, maxPages));
  }

  return slugs;
}

async function discoverRecruiteeSlugs(): Promise<string[]> {
  const cachedSlugs = await loadCachedSlugs();
  const slugSet = new Set<string>(cachedSlugs);
  addAll(slugSet, MANUAL_SEED_SLUGS);

  const [
    githubSlugs,
    sitemapSlugs,
    commonCrawlSlugs,
    hackertargetSlugs,
    anubisSlugs,
    rapidDnsSlugs,
    urlscanSlugs,
  ] = await Promise.all([
    discoverFromGitHub(),
    discoverFromSitemaps(),
    discoverFromCommonCrawl(),
    discoverFromHackertarget(),
    discoverFromAnubis(),
    discoverFromRapidDns(),
    discoverFromUrlscan(),
  ]);

  addAll(slugSet, githubSlugs);
  addAll(slugSet, sitemapSlugs);
  addAll(slugSet, commonCrawlSlugs);
  addAll(slugSet, hackertargetSlugs);
  addAll(slugSet, anubisSlugs);
  addAll(slugSet, rapidDnsSlugs);
  addAll(slugSet, urlscanSlugs);

  const slugs = Array.from(slugSet).sort();
  await saveDiscoveredSlugs(slugs);

  console.log(`  [${SOURCE}] Cached slugs loaded: ${cachedSlugs.length}`);
  console.log(`  [${SOURCE}] Manual seed slugs: ${MANUAL_SEED_SLUGS.length}`);
  console.log(`  [${SOURCE}] GitHub discovered: ${githubSlugs.size}`);
  console.log(`  [${SOURCE}] Sitemap discovered: ${sitemapSlugs.size}`);
  console.log(`  [${SOURCE}] Common Crawl discovered: ${commonCrawlSlugs.size}`);
  console.log(`  [${SOURCE}] Hackertarget discovered: ${hackertargetSlugs.size}`);
  console.log(`  [${SOURCE}] Anubis discovered: ${anubisSlugs.size}`);
  console.log(`  [${SOURCE}] RapidDNS discovered: ${rapidDnsSlugs.size}`);
  console.log(`  [${SOURCE}] urlscan discovered: ${urlscanSlugs.size}`);
  console.log(`  [${SOURCE}] Total unique slugs cached: ${slugs.length}`);

  return slugs;
}

function normalizeOffer(slug: string, rawOffer: unknown): NormalizedJob | null {
  if (!rawOffer || typeof rawOffer !== 'object') return null;

  const offer = rawOffer as RecruiteeOffer;
  const title = coerceString(offer.title);
  if (!title) return null;

  const status = coerceString(offer.status);
  if (status && status.toLowerCase() !== 'published') {
    return null;
  }

  const description = stripHtml(coerceString(offer.description) ?? '');
  const structuredExperience = inferStructuredExperienceLevel(offer, title);
  if (structuredExperience === 'reject') {
    return null;
  }

  const experienceLevel = structuredExperience ?? inferExperienceLevel(title, description);
  if (experienceLevel === null) return null;

  const company =
    coerceString(offer.company_name) ??
    coerceString(offer.department) ??
    formatCompanyName(slug);

  const location = buildLocation(offer);
  const url = normalizeJobUrl(slug, offer);
  if (!url) return null;

  const sourceId =
    offer.id !== undefined && offer.id !== null
      ? String(offer.id)
      : coerceString(offer.guid) ?? coerceString(offer.slug);

  const remote =
    typeof offer.remote === 'boolean'
      ? offer.remote
      : inferRemote(location);
  const roles = inferRoles(title);

  return {
    source: SOURCE,
    source_id: sourceId,
    title,
    company,
    location,
    remote,
    url,
    description: description || undefined,
    experience_level: experienceLevel,
    roles,
    posted_at: normalizePostedAt(coerceString(offer.created_at) ?? coerceString(offer.published_at)),
    dedup_hash: generateHash(company, title, location ?? ''),
  };
}

async function fetchCompany(slug: string): Promise<NormalizedJob[]> {
  const data = await fetchJsonWithTimeout<RecruiteeApiResponse>(
    `https://${slug}.recruitee.com/api/offers/`,
    {
      headers: {
        Accept: 'application/json',
      },
    },
    OFFER_FETCH_TIMEOUT_MS,
  );

  if (!data || !Array.isArray(data.offers)) {
    return [];
  }

  const jobs: NormalizedJob[] = [];

  for (const offer of data.offers) {
    const normalized = normalizeOffer(slug, offer);
    if (normalized) {
      jobs.push(normalized);
    }
  }

  return jobs;
}

export async function scrapeRecruitee(): Promise<NormalizedJob[]> {
  const start = Date.now();
  const slugs = await discoverRecruiteeSlugs();
  const jobsByHash = new Map<string, NormalizedJob>();
  const liveCompanySlugs = new Set<string>();

  for (let i = 0; i < slugs.length; i += FETCH_BATCH_SIZE) {
    if (i % 50 === 0) {
      console.log(`  [${SOURCE}] Processing slugs ${i}/${slugs.length}...`);
    }

    const batch = slugs.slice(i, i + FETCH_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(fetchCompany));

    for (const [index, result] of results.entries()) {
      if (result.status !== 'fulfilled') continue;

      if (result.value.length > 0) {
        liveCompanySlugs.add(batch[index]);
      }

      for (const job of result.value) {
        jobsByHash.set(job.dedup_hash, job);
      }
    }

    if (i + FETCH_BATCH_SIZE < slugs.length) {
      await sleep(FETCH_BATCH_DELAY_MS);
    }
  }

  const jobs = Array.from(jobsByHash.values());
  const companiesWithJobs = new Set(jobs.map(job => job.company)).size;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`  [${SOURCE}] Live boards with qualifying roles: ${liveCompanySlugs.size}`);
  console.log(`  [${SOURCE}] Companies with qualifying roles: ${companiesWithJobs}`);
  console.log(`  [${SOURCE}] Total unique jobs: ${jobs.length}`);
  console.log(`  [${SOURCE}] Completed in ${elapsed}s`);

  return jobs;
}

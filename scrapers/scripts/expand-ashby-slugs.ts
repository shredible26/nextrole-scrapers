import { execFile as execFileCallback } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const CACHE_PATH = join(process.cwd(), 'scrapers', 'cache', 'ashby-valid-slugs.json');

const USER_AGENT = 'NextRole Ashby Slug Expander (+https://nextrole-phi.vercel.app)';
const REQUEST_TIMEOUT_MS = 20_000;
const LONG_REQUEST_TIMEOUT_MS = 60_000;
const COMMON_CRAWL_TIMEOUT_MS = 25_000;
const VALIDATION_CONCURRENCY = 10;
const VALIDATION_BATCH_DELAY_MS = 300;
const DISCOVERY_BATCH_DELAY_MS = 200;

const COMMON_CRAWL_INDEXES = [
  'CC-MAIN-2024-51-index',
  'CC-MAIN-2025-05-index',
  'CC-MAIN-2025-13-index',
] as const;

const COMMON_CRAWL_PATTERNS = [
  '*.ashby.io*',
  'jobs.ashbyhq.com/*',
] as const;

const CRT_PATTERNS = [
  '%.ashby.io',
  '%.ashbyhq.com',
] as const;

const GITHUB_SEARCHES = [
  { pages: 1, query: 'ashby.io/jobs in:file' },
  { pages: 1, query: 'jobs.ashby.io in:file' },
  { pages: 3, query: 'jobs.ashbyhq.com in:file' },
] as const;

const YC_ALGOLIA_APP = '45BWZJ1SGC';
const YC_ALGOLIA_KEY =
  'NzllNTY5MzJiZGM2OTY2ZTQwMDEzOTNhYWZiZGRjODlhYzVkNjBmOGRjNzJiMWM4ZTU0ZDlhYTZjOTJiMjlhMWFuYWx5dGljc1RhZ3M9eWNkYyZyZXN0cmljdEluZGljZXM9WUNDb21wYW55X3Byb2R1Y3Rpb24lMkNZQ0NvbXBhbnlfQnlfTGF1bmNoX0RhdGVfcHJvZHVjdGlvbiZ0YWdGaWx0ZXJzPSU1QiUyMnljZGNfcHVibGljJTIyJTVE';
const YC_INDEX_NAME = 'YCCompany_production';
const YC_BATCH_HITS_PER_PAGE = 500;

type AshbyCache = Record<string, string>;

type FetchTextResult = {
  ok: boolean;
  status: number;
  text: string;
};

type GitHubCodeSearchResponse = {
  items?: Array<{
    html_url?: string;
    path?: string;
    repository?: {
      full_name?: string;
    };
    url?: string;
  }>;
  total_count?: number;
};

type CrtShEntry = {
  common_name?: string;
  name_value?: string;
};

type CommonCrawlEntry = {
  url?: string;
};

type YcCompany = {
  former_names?: string[];
  name?: string;
  slug?: string;
  website?: string | null;
};

type YcAlgoliaResponse = {
  facets?: {
    batch?: Record<string, number>;
  };
  hits?: YcCompany[];
  nbPages?: number;
};

type AshbyBoardResponse = {
  jobs?: unknown[];
};

type AshbyValidationResponse = {
  data?: {
    organizationFromHostedJobsPageName?: {
      name?: string | null;
    } | null;
  };
};

type ValidatedSlug = {
  companyName: string;
  jobCount: number;
  slug: string;
};

type SourceBuckets = {
  commonCrawl: Set<string>;
  crt: Set<string>;
  github: Set<string>;
  related: Set<string>;
  yc: Set<string>;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeAshbySlug(rawSlug: string): string | null {
  let decoded = rawSlug.trim();

  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }

  const slug = decoded.toLowerCase().trim();
  if (slug.length < 2 || slug.length > 100) return null;
  if (/^\d+$/.test(slug)) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) return null;

  return slug;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function cleanupUrlToken(rawToken: string): string {
  return rawToken
    .replace(/^[("'`\[]+/, '')
    .replace(/[)\]'"`,;:!?]+$/, '')
    .trim();
}

function addCandidate(set: Set<string>, rawSlug: string | null | undefined) {
  if (!rawSlug) return;

  const normalized = normalizeAshbySlug(rawSlug);
  if (normalized) {
    set.add(normalized);
  }
}

function extractHostnameVariants(hostname: string): string[] {
  const clean = hostname.toLowerCase().replace(/^\*\./, '').replace(/^www\d*\./, '');
  if (!clean) return [];

  const labels = clean.split('.').filter(Boolean);
  const variants = new Set<string>();

  variants.add(clean);

  if (labels.length >= 2) {
    const tld = labels.at(-1) ?? '';
    const sld = labels.at(-2) ?? '';
    const third = labels.at(-3) ?? '';

    if (tld.length === 2 && sld.length <= 3 && third) {
      variants.add(third);
    } else {
      variants.add(sld);
    }
  }

  return Array.from(variants);
}

function slugifyName(rawName: string): string | null {
  const normalized = normalizeWhitespace(rawName)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[@+]/g, ' ')
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return normalizeAshbySlug(normalized);
}

function buildNameVariants(rawName: string): Set<string> {
  const variants = new Set<string>();
  const candidates = new Set<string>();

  const cleaned = normalizeWhitespace(
    rawName
      .replace(/[|]/g, ' ')
      .replace(/[()]/g, ' ')
      .replace(/[/:]/g, ' '),
  );

  candidates.add(cleaned);

  for (const piece of cleaned.split(/[-,]/).map(part => normalizeWhitespace(part))) {
    if (piece.length >= 2) {
      candidates.add(piece);
    }
  }

  for (const candidate of Array.from(candidates)) {
    const base = slugifyName(candidate);
    if (!base) continue;

    variants.add(base);
    variants.add(base.replace(/-/g, ''));
    variants.add(base.replace(/and/g, ''));
    variants.add(base.replace(/\./g, '-'));
    variants.add(base.replace(/\./g, ''));

    if (base.endsWith('-ai')) {
      variants.add(base.replace(/-ai$/, 'ai'));
    } else if (base.endsWith('ai') && !base.endsWith('-ai')) {
      variants.add(`${base.slice(0, -2)}-ai`);
    }
  }

  return new Set(
    Array.from(variants)
      .map(variant => normalizeAshbySlug(variant))
      .filter((variant): variant is string => variant !== null),
  );
}

function buildSlugVariants(rawSlug: string): Set<string> {
  const variants = new Set<string>();
  const normalized = normalizeAshbySlug(rawSlug);

  if (!normalized) {
    return variants;
  }

  variants.add(normalized);
  variants.add(normalized.replace(/-/g, ''));
  variants.add(normalized.replace(/\./g, '-'));
  variants.add(normalized.replace(/\./g, ''));

  if (normalized.includes('.')) {
    const [first] = normalized.split('.');
    if (first) {
      variants.add(first);
    }
  }

  if (normalized.endsWith('-ai')) {
    variants.add(normalized.replace(/-ai$/, 'ai'));
  } else if (normalized.endsWith('ai') && !normalized.endsWith('-ai')) {
    variants.add(`${normalized.slice(0, -2)}-ai`);
  }

  return new Set(
    Array.from(variants)
      .map(variant => normalizeAshbySlug(variant))
      .filter((variant): variant is string => variant !== null),
  );
}

function extractAshbyCandidatesFromUrl(rawUrl: string): Set<string> {
  const candidates = new Set<string>();
  const cleaned = cleanupUrlToken(rawUrl);

  if (!cleaned || !/ashby/i.test(cleaned)) {
    return candidates;
  }

  const withProtocol = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;

  try {
    const url = new URL(withProtocol);
    const hostname = url.hostname.toLowerCase().replace(/^www\d*\./, '');
    const segments = url.pathname.split('/').filter(Boolean);

    if (hostname === 'jobs.ashbyhq.com') {
      addCandidate(candidates, segments[0]);
    }

    if (hostname === 'api.ashby.io' || hostname === 'api.ashbyhq.com') {
      addCandidate(candidates, url.searchParams.get('organizationHostedJobsPageName'));
    }

    if (hostname.endsWith('.ashby.io')) {
      const subdomain = hostname.slice(0, -'.ashby.io'.length);
      for (const variant of Array.from(buildSlugVariants(subdomain))) {
        candidates.add(variant);
      }
    }

    if (hostname.endsWith('.ashbyhq.com') && hostname !== 'jobs.ashbyhq.com' && hostname !== 'api.ashbyhq.com') {
      const subdomain = hostname.slice(0, -'.ashbyhq.com'.length);
      for (const variant of Array.from(buildSlugVariants(subdomain))) {
        candidates.add(variant);
      }
    }
  } catch {
    return candidates;
  }

  return candidates;
}

function extractAshbyCandidatesFromText(text: string): Set<string> {
  const candidates = new Set<string>();
  const regexes = [
    /\bhttps?:\/\/[^\s<>"'`]+/gi,
    /\bjobs\.ashbyhq\.com\/[a-z0-9._-]+[^\s<>"'`]*/gi,
    /\b[a-z0-9.-]+\.ashby\.io(?:\/[^\s<>"'`]*)?/gi,
    /\b[a-z0-9.-]+\.ashbyhq\.com(?:\/[^\s<>"'`]*)?/gi,
  ];

  for (const regex of regexes) {
    for (const match of Array.from(text.matchAll(regex))) {
      for (const candidate of Array.from(extractAshbyCandidatesFromUrl(match[0]))) {
        candidates.add(candidate);
      }
    }
  }

  return candidates;
}

async function fetchText(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: '*/*',
        'User-Agent': USER_AGENT,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });

    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  } catch {
    return {
      ok: false,
      status: 0,
      text: '',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T | null> {
  const result = await fetchText(url, init, timeoutMs);
  if (!result.ok) {
    return null;
  }

  try {
    return JSON.parse(result.text) as T;
  } catch {
    return null;
  }
}

async function loadCache(): Promise<AshbyCache> {
  try {
    const raw = await readFile(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([slug, companyName]) => {
          const normalizedSlug = normalizeAshbySlug(slug);
          const normalizedName =
            typeof companyName === 'string' ? normalizeWhitespace(companyName) : '';

          return normalizedSlug && normalizedName ? [normalizedSlug, normalizedName] : null;
        })
        .filter((entry): entry is [string, string] => entry !== null),
    );
  } catch {
    return {};
  }
}

async function saveCache(cache: AshbyCache): Promise<void> {
  const sorted = Object.fromEntries(
    Object.entries(cache).sort(([leftSlug], [rightSlug]) => leftSlug.localeCompare(rightSlug)),
  );

  await writeFile(CACHE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
}

async function discoverFromCommonCrawl(): Promise<Set<string>> {
  const discovered = new Set<string>();

  for (const index of COMMON_CRAWL_INDEXES) {
    for (const pattern of COMMON_CRAWL_PATTERNS) {
      const url =
        `https://index.commoncrawl.org/${index}` +
        `?url=${encodeURIComponent(pattern)}&output=json&limit=5000`;
      const result = await fetchText(url, {}, COMMON_CRAWL_TIMEOUT_MS);

      if (!result.ok) {
        console.warn(`[ashby-expand] Common Crawl failed: ${index} ${pattern} (HTTP ${result.status})`);
        continue;
      }

      let parsedRows = 0;
      let addedBefore = discovered.size;

      for (const line of result.text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        parsedRows += 1;

        try {
          const record = JSON.parse(trimmed) as CommonCrawlEntry;
          if (typeof record.url !== 'string') continue;

          for (const candidate of Array.from(extractAshbyCandidatesFromUrl(record.url))) {
            discovered.add(candidate);
          }
        } catch {
          // Common Crawl responses are JSONL; malformed rows are skipped.
        }
      }

      console.log(
        `[ashby-expand] Common Crawl ${index} ${pattern}: ${parsedRows} rows, +${discovered.size - addedBefore} candidates`,
      );
      await sleep(DISCOVERY_BATCH_DELAY_MS);
    }
  }

  return discovered;
}

async function getGitHubToken(): Promise<string | null> {
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (envToken?.trim()) {
    return envToken.trim();
  }

  try {
    const { stdout } = await execFile('gh', ['auth', 'token']);
    const token = stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

async function fetchGitHubRawContent(url: string, token: string): Promise<string | null> {
  const result = await fetchText(
    url,
    {
      headers: {
        Accept: 'application/vnd.github.raw',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
    REQUEST_TIMEOUT_MS,
  );

  return result.ok ? result.text : null;
}

async function discoverFromGitHub(): Promise<Set<string>> {
  const discovered = new Set<string>();
  const token = await getGitHubToken();

  if (!token) {
    console.warn('[ashby-expand] GitHub code search skipped: no authenticated token available');
    return discovered;
  }

  for (const search of GITHUB_SEARCHES) {
    for (let page = 1; page <= search.pages; page += 1) {
      const params = new URLSearchParams({
        per_page: '100',
        page: String(page),
        q: search.query,
      });
      const result = await fetchJson<GitHubCodeSearchResponse>(
        `https://api.github.com/search/code?${params.toString()}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
        LONG_REQUEST_TIMEOUT_MS,
      );

      const items = result?.items ?? [];
      if (items.length === 0) {
        console.log(`[ashby-expand] GitHub ${search.query} page ${page}: no results`);
        break;
      }

      let discoveredBefore = discovered.size;

      for (let index = 0; index < items.length; index += VALIDATION_CONCURRENCY) {
        const batch = items.slice(index, index + VALIDATION_CONCURRENCY);
        const contents = await Promise.all(
          batch.map(async item => {
            if (!item.url) return null;

            const text = await fetchGitHubRawContent(item.url, token);
            return text ? { item, text } : null;
          }),
        );

        for (const content of contents) {
          if (!content) continue;

          for (const candidate of Array.from(extractAshbyCandidatesFromText(content.text))) {
            discovered.add(candidate);
          }
        }

        if (index + VALIDATION_CONCURRENCY < items.length) {
          await sleep(DISCOVERY_BATCH_DELAY_MS);
        }
      }

      console.log(
        `[ashby-expand] GitHub ${search.query} page ${page}: ${items.length} files, +${discovered.size - discoveredBefore} candidates`,
      );
      await sleep(DISCOVERY_BATCH_DELAY_MS);
    }
  }

  return discovered;
}

async function discoverFromCrtSh(): Promise<Set<string>> {
  const discovered = new Set<string>();

  for (const pattern of CRT_PATTERNS) {
    const result = await fetchJson<CrtShEntry[]>(
      `https://crt.sh/?q=${encodeURIComponent(pattern)}&output=json`,
      {},
      LONG_REQUEST_TIMEOUT_MS,
    );

    if (!result) {
      console.warn(`[ashby-expand] crt.sh failed for ${pattern}`);
      continue;
    }

    const discoveredBefore = discovered.size;

    for (const entry of result) {
      for (const value of [entry.common_name, entry.name_value]) {
        if (!value) continue;

        for (const name of value.split('\n')) {
          const trimmed = name.trim().replace(/^\*\./, '');
          if (!trimmed) continue;

          for (const candidate of Array.from(extractAshbyCandidatesFromUrl(trimmed))) {
            discovered.add(candidate);
          }
        }
      }
    }

    console.log(
      `[ashby-expand] crt.sh ${pattern}: ${result.length} rows, +${discovered.size - discoveredBefore} candidates`,
    );
    await sleep(DISCOVERY_BATCH_DELAY_MS);
  }

  return discovered;
}

async function fetchYcCompanies(): Promise<YcCompany[]> {
  const batchFacetResponse = await fetchJson<YcAlgoliaResponse>(
    `https://${YC_ALGOLIA_APP}-dsn.algolia.net/1/indexes/${YC_INDEX_NAME}/query`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Algolia-API-Key': YC_ALGOLIA_KEY,
        'X-Algolia-Application-Id': YC_ALGOLIA_APP,
      },
      body: JSON.stringify({
        params: 'query=&hitsPerPage=0&facets=batch',
      }),
    },
    LONG_REQUEST_TIMEOUT_MS,
  );

  const batches = Object.keys(batchFacetResponse?.facets?.batch ?? {}).sort();
  if (batches.length === 0) {
    console.warn('[ashby-expand] YC Algolia batch facets unavailable');
    return [];
  }

  const companies = new Map<string, YcCompany>();

  for (const batch of batches) {
    let page = 0;
    let totalPages = 1;

    while (page < totalPages) {
      const response = await fetchJson<YcAlgoliaResponse>(
        `https://${YC_ALGOLIA_APP}-dsn.algolia.net/1/indexes/${YC_INDEX_NAME}/query`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Algolia-API-Key': YC_ALGOLIA_KEY,
            'X-Algolia-Application-Id': YC_ALGOLIA_APP,
          },
          body: JSON.stringify({
            params:
              `query=&hitsPerPage=${YC_BATCH_HITS_PER_PAGE}` +
              `&page=${page}` +
              `&filters=${encodeURIComponent(`batch:"${batch}"`)}`,
          }),
        },
        LONG_REQUEST_TIMEOUT_MS,
      );

      if (!response) {
        console.warn(`[ashby-expand] YC Algolia batch ${batch} page ${page + 1} failed`);
        break;
      }

      for (const company of response.hits ?? []) {
        const key =
          normalizeWhitespace(company.slug ?? '') ||
          normalizeWhitespace(company.name ?? '') ||
          normalizeWhitespace(company.website ?? '');

        if (key) {
          companies.set(key, company);
        }
      }

      totalPages = Math.max(response.nbPages ?? 0, 1);
      page += 1;
    }
  }

  return Array.from(companies.values());
}

function discoverFromYcCompanies(companies: YcCompany[]): Set<string> {
  const discovered = new Set<string>();

  for (const company of companies) {
    addCandidate(discovered, company.slug);
    addCandidate(discovered, slugifyName(company.name ?? ''));

    for (const formerName of company.former_names ?? []) {
      addCandidate(discovered, slugifyName(formerName));
    }

    if (company.website) {
      try {
        const url = new URL(company.website.startsWith('http') ? company.website : `https://${company.website}`);
        for (const variant of extractHostnameVariants(url.hostname)) {
          addCandidate(discovered, variant);
        }
      } catch {
        // Skip malformed company websites.
      }
    }
  }

  return discovered;
}

function discoverRelatedSlugs(cache: AshbyCache): Set<string> {
  const discovered = new Set<string>();

  for (const [slug, companyName] of Object.entries(cache)) {
    for (const variant of Array.from(buildSlugVariants(slug))) {
      discovered.add(variant);
    }

    for (const variant of Array.from(buildNameVariants(companyName))) {
      discovered.add(variant);
    }
  }

  return discovered;
}

function humanizeSlug(slug: string): string {
  const cleaned = slug
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.replace(/\b\w/g, char => char.toUpperCase()) || slug;
}

async function fetchAshbyCompanyName(slug: string): Promise<string | null> {
  const response = await fetchJson<AshbyValidationResponse>(
    'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiOrganizationFromHostedJobsPageName',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        operationName: 'ApiOrganizationFromHostedJobsPageName',
        variables: {
          organizationHostedJobsPageName: slug,
          searchContext: 'JobBoard',
        },
        query:
          'query ApiOrganizationFromHostedJobsPageName($organizationHostedJobsPageName: String!, $searchContext: OrganizationSearchContext) { organizationFromHostedJobsPageName(organizationHostedJobsPageName: $organizationHostedJobsPageName, searchContext: $searchContext) { name } }',
      }),
    },
    REQUEST_TIMEOUT_MS,
  );

  const companyName = response?.data?.organizationFromHostedJobsPageName?.name;
  return companyName ? normalizeWhitespace(companyName) : null;
}

async function validateSlug(slug: string, cachedName?: string): Promise<ValidatedSlug | null> {
  const response = await fetchJson<AshbyBoardResponse>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
    {},
    REQUEST_TIMEOUT_MS,
  );

  const jobCount = response?.jobs?.length ?? 0;
  if (jobCount < 1) {
    return null;
  }

  const companyName =
    cachedName ||
    (await fetchAshbyCompanyName(slug)) ||
    humanizeSlug(slug);

  return {
    companyName,
    jobCount,
    slug,
  };
}

async function validateSlugs(candidates: string[], existingCache: AshbyCache): Promise<ValidatedSlug[]> {
  const validated: ValidatedSlug[] = [];

  for (let index = 0; index < candidates.length; index += VALIDATION_CONCURRENCY) {
    const batch = candidates.slice(index, index + VALIDATION_CONCURRENCY);
    const results = await Promise.all(
      batch.map(slug => validateSlug(slug, existingCache[slug])),
    );

    for (const result of results) {
      if (result) {
        validated.push(result);
      }
    }

    const completed = Math.min(index + batch.length, candidates.length);
    console.log(
      `[ashby-expand] Validation progress: ${completed}/${candidates.length}, active ${validated.length}`,
    );

    if (completed < candidates.length) {
      await sleep(VALIDATION_BATCH_DELAY_MS);
    }
  }

  return validated;
}

function buildSourceBuckets(existingCache: AshbyCache, ycCompanies: YcCompany[]): SourceBuckets {
  return {
    commonCrawl: new Set<string>(),
    crt: new Set<string>(),
    github: new Set<string>(),
    related: discoverRelatedSlugs(existingCache),
    yc: discoverFromYcCompanies(ycCompanies),
  };
}

async function main() {
  const candidateLimit = Number.parseInt(process.env.ASHBY_MAX_CANDIDATES ?? '', 10);
  const existingCache = await loadCache();
  const existingCount = Object.keys(existingCache).length;

  console.log(`[ashby-expand] Existing cache entries: ${existingCount}`);

  const ycCompanies = await fetchYcCompanies();
  console.log(`[ashby-expand] YC companies fetched: ${ycCompanies.length}`);

  const buckets = buildSourceBuckets(existingCache, ycCompanies);

  buckets.commonCrawl = await discoverFromCommonCrawl();
  buckets.github = await discoverFromGitHub();
  buckets.crt = await discoverFromCrtSh();

  console.log(`[ashby-expand] Common Crawl candidates: ${buckets.commonCrawl.size}`);
  console.log(`[ashby-expand] GitHub candidates: ${buckets.github.size}`);
  console.log(`[ashby-expand] crt.sh candidates: ${buckets.crt.size}`);
  console.log(`[ashby-expand] YC-derived candidates: ${buckets.yc.size}`);
  console.log(`[ashby-expand] Related-name candidates: ${buckets.related.size}`);

  const candidateSet = new Set<string>();
  const candidates: string[] = [];

  const candidateGroups = [
    Object.keys(existingCache).sort(),
    Array.from(buckets.github).sort(),
    Array.from(buckets.related).sort(),
    Array.from(buckets.commonCrawl).sort(),
    Array.from(buckets.crt).sort(),
    Array.from(buckets.yc).sort(),
  ];

  for (const group of candidateGroups) {
    for (const slug of group) {
      if (candidateSet.has(slug)) {
        continue;
      }

      candidateSet.add(slug);
      candidates.push(slug);
    }
  }

  const limitedCandidates =
    Number.isFinite(candidateLimit) && candidateLimit > 0
      ? candidates.slice(0, candidateLimit)
      : candidates;

  console.log(`[ashby-expand] Total unique candidates to validate: ${candidates.length}`);
  if (limitedCandidates.length !== candidates.length) {
    console.log(`[ashby-expand] Candidate limit applied: ${limitedCandidates.length}`);
  }

  const validated = await validateSlugs(limitedCandidates, existingCache);
  const nextCache = Object.fromEntries(
    validated
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map(result => [result.slug, result.companyName]),
  );

  await saveCache(nextCache);

  const added = validated.filter(result => !existingCache[result.slug]);
  const removed = Object.keys(existingCache).filter(slug => !nextCache[slug]);
  const totalJobs = validated.reduce((sum, result) => sum + result.jobCount, 0);

  console.log(`[ashby-expand] Active slugs saved: ${validated.length}`);
  console.log(`[ashby-expand] Newly added active slugs: ${added.length}`);
  console.log(`[ashby-expand] Removed inactive slugs: ${removed.length}`);
  console.log(`[ashby-expand] Raw jobs across active boards: ${totalJobs}`);
  console.log('[ashby-expand] Top additions by raw job count:');

  for (const result of added.sort((left, right) => right.jobCount - left.jobCount).slice(0, 30)) {
    console.log(`  ${result.slug.padEnd(30)} ${String(result.jobCount).padStart(4)} ${result.companyName}`);
  }
}

void main().catch(error => {
  console.error('[ashby-expand] Failed:', error);
  process.exitCode = 1;
});

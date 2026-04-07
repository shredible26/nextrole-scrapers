// Source: Rippling public ATS board pages.
// Current public data comes from Next.js `/_next/data/...` JSON, not the old
// `app.rippling.com` endpoints.

import { setTimeout as delay } from 'node:timers/promises';

import { generateHash } from '../utils/dedup';
import {
  hasTechTitleSignal,
  inferExperienceLevel,
  inferRemote,
  inferRoles,
  NormalizedJob,
} from '../utils/normalize';

const RIPPLING_COMPANIES = [
  'rippling', 'brex', 'mercury', 'deel', 'remote',
  'gusto', 'lattice', 'ramp', 'notion', 'linear',
  'figma', 'vercel', 'supabase', 'planetscale', 'railway',
  'fly', 'render', 'clerk', 'workos', 'stytch',
  'posthog', 'highlight', 'mintlify', 'resend', 'loops',
  'cal', 'dub', 'trigger', 'inngest', 'temporal',
  'turso', 'neon', 'xata', 'fauna', 'convex',
  'upstash', 'qstash', 'inngest', 'trigger',
  'liveblocks', 'partykit', 'electric-sql',
  'prisma', 'drizzle', 'sequelize', 'typeorm',
  'trpc', 'hono', 'elysia', 'fastify',
  'vite', 'turbopack', 'esbuild', 'swc', 'oxc',
  'biome', 'rome', 'prettier', 'eslint',
  'vitest', 'jest', 'playwright', 'cypress',
  'storybook', 'chromatic', 'percy', 'applitools',
  'sentry', 'highlight', 'logflare', 'axiom',
  'grafana', 'prometheus', 'opentelemetry',
  'datadog', 'newrelic', 'dynatrace',
  'pagerduty', 'incident-io', 'rootly', 'firehydrant',
  'linear', 'height', 'shortcut', 'jira',
  'notion', 'coda', 'outline', 'bookstack',
  'loom', 'tldv', 'fireflies', 'otter',
  'slack', 'discord', 'telegram', 'signal',
] as const;

const ATS_BASE_URL = 'https://ats.rippling.com';
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json, text/html;q=0.9, */*;q=0.8',
} as const;
const HTML_HEADERS = {
  ...DEFAULT_HEADERS,
  'Accept': 'text/html',
} as const;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 20;
const COMPANY_BATCH_SIZE = 10;
const COMPANY_BATCH_DELAY_MS = 300;
const NEXT_DATA_REGEX = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

type RipplingLocation = {
  name?: string;
  country?: string;
  countryCode?: string;
  state?: string;
  stateCode?: string;
  city?: string;
  workplaceType?: string;
};

type RipplingBoardJob = {
  id?: string;
  name?: string;
  url?: string;
  department?: { name?: string };
  locations?: RipplingLocation[];
  language?: string;
};

type RipplingPaginated<T> = {
  items?: T[];
  page?: number;
  pageSize?: number;
  totalItems?: number;
  totalPages?: number;
};

type RipplingBoard = {
  slug?: string;
  title?: string;
  subtitle?: string;
  boardURL?: string;
};

type RipplingBoardPayload = {
  notFound?: boolean;
  pageProps?: {
    __N_REDIRECT?: string;
    __N_REDIRECT_STATUS?: number;
    apiData?: {
      jobBoard?: RipplingBoard;
    };
    dehydratedState?: {
      queries?: Array<{
        queryKey?: unknown[];
        state?: {
          data?: unknown;
        };
      }>;
    };
  };
  buildId?: string;
};

type RipplingJobPost = {
  uuid?: string;
  name?: string;
  url?: string;
  companyName?: string;
  createdOn?: string;
  description?: {
    company?: string;
    role?: string;
  };
  workLocations?: RipplingLocation[];
};

type RipplingJobDetailPayload = {
  pageProps?: {
    apiData?: {
      jobPost?: RipplingJobPost;
    };
  };
};

function uniqueCompanies(companies: readonly string[]): string[] {
  return [...new Set(companies)];
}

function buildBoardJsonUrl(buildId: string, slug: string, page = 0): string {
  const params = new URLSearchParams({
    jobBoardSlug: slug,
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  return `${ATS_BASE_URL}/_next/data/${buildId}/${encodeURIComponent(slug)}/jobs.json?${params.toString()}`;
}

function buildJobJsonUrl(buildId: string, slug: string, jobId: string): string {
  const params = new URLSearchParams({
    jobBoardSlug: slug,
    jobId,
  });
  return `${ATS_BASE_URL}/_next/data/${buildId}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(jobId)}.json?${params.toString()}`;
}

function parseNextData<T>(html: string): T | null {
  const match = html.match(NEXT_DATA_REGEX);
  if (!match) return null;

  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return null;
  }
}

function getJobPostsPage(payload: RipplingBoardPayload): RipplingPaginated<RipplingBoardJob> | null {
  const queries = payload.pageProps?.dehydratedState?.queries ?? [];
  for (const query of queries) {
    if (!Array.isArray(query.queryKey)) continue;
    if (query.queryKey[2] !== 'job-posts') continue;

    const data = query.state?.data as RipplingPaginated<RipplingBoardJob> | undefined;
    if (data && Array.isArray(data.items)) {
      return data;
    }
  }

  return null;
}

function htmlToText(html?: string): string {
  if (!html) return '';

  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function buildDescription(jobPost?: RipplingJobPost | null): string | undefined {
  if (!jobPost?.description) return undefined;

  const parts = [
    htmlToText(jobPost.description.company),
    htmlToText(jobPost.description.role),
  ].filter(Boolean);

  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}

function formatLocations(locations?: RipplingLocation[]): string | undefined {
  const names = [...new Set((locations ?? []).map(location => location.name?.trim()).filter(Boolean))];
  return names.length > 0 ? names.join(' | ') : undefined;
}

function isRemote(locations: RipplingLocation[] | undefined, locationText: string | undefined): boolean {
  if ((locations ?? []).some(location => location.workplaceType === 'REMOTE')) {
    return true;
  }

  return inferRemote(locationText);
}

function toIsoDate(value?: string): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function fallbackCompanyName(slug: string): string {
  return slug
    .split('-')
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

async function fetchJson<T>(url: string): Promise<{ status: number; data: T | null }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: DEFAULT_HEADERS,
  });

  if (!response.ok) {
    return { status: response.status, data: null };
  }

  return { status: response.status, data: await response.json() as T };
}

async function fetchBoardHtmlPayload(slug: string): Promise<RipplingBoardPayload | null> {
  const response = await fetch(`${ATS_BASE_URL}/${slug}/jobs`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: HTML_HEADERS,
  });

  if (!response.ok) return null;

  const html = await response.text();
  return parseNextData<RipplingBoardPayload>(html);
}

async function fetchBoardPage(buildId: string, slug: string, page: number): Promise<RipplingBoardPayload | null> {
  try {
    const { status, data } = await fetchJson<RipplingBoardPayload>(buildBoardJsonUrl(buildId, slug, page));
    if (data) return data;
    if (status === 404) return { notFound: true };
  } catch {
    // Fall back to HTML parsing below.
  }

  if (page !== 0) return null;
  return fetchBoardHtmlPayload(slug);
}

async function fetchJobDetail(buildId: string, slug: string, jobId: string): Promise<RipplingJobPost | null> {
  try {
    const { status, data } = await fetchJson<RipplingJobDetailPayload>(buildJobJsonUrl(buildId, slug, jobId));
    const jobPost = data?.pageProps?.apiData?.jobPost;
    if (jobPost) return jobPost;
    if (status === 404) return null;
  } catch {
    // Fall through to HTML fallback.
  }

  try {
    const response = await fetch(`${ATS_BASE_URL}/${slug}/jobs/${jobId}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: HTML_HEADERS,
    });

    if (!response.ok) return null;

    const html = await response.text();
    const payload = parseNextData<RipplingJobDetailPayload>(html);
    return payload?.pageProps?.apiData?.jobPost ?? null;
  } catch {
    return null;
  }
}

async function fetchBuildId(): Promise<string> {
  const response = await fetch(`${ATS_BASE_URL}/__nextrole_probe__/jobs`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: HTML_HEADERS,
  });

  const html = await response.text();
  const payload = parseNextData<RipplingBoardPayload>(html);
  const buildId = payload?.buildId;

  if (!buildId) {
    throw new Error(`Could not extract Rippling ATS build ID from probe response ${response.status}`);
  }

  return buildId;
}

async function fetchCompany(buildId: string, slug: string): Promise<NormalizedJob[]> {
  const firstPagePayload = await fetchBoardPage(buildId, slug, 0);
  if (!firstPagePayload || firstPagePayload.notFound) return [];

  const redirect = firstPagePayload.pageProps?.__N_REDIRECT;
  if (redirect) {
    console.log(`    [rippling] ${slug}: redirected to ${redirect}`);
    return [];
  }

  const board = firstPagePayload.pageProps?.apiData?.jobBoard;
  const firstPage = getJobPostsPage(firstPagePayload);
  if (!firstPage) return [];

  const totalPages = Math.max(1, firstPage.totalPages ?? 1);
  const boardJobs = new Map<string, RipplingBoardJob>();

  for (const item of firstPage.items ?? []) {
    if (item.id) boardJobs.set(item.id, item);
  }

  for (let page = 1; page < totalPages; page += 1) {
    const payload = await fetchBoardPage(buildId, slug, page);
    const jobPage = payload ? getJobPostsPage(payload) : null;
    for (const item of jobPage?.items ?? []) {
      if (item.id) boardJobs.set(item.id, item);
    }
  }

  const normalized: NormalizedJob[] = [];

  for (const boardJob of boardJobs.values()) {
    const title = boardJob.name?.trim();
    const jobId = boardJob.id?.trim();
    if (!title || !jobId) continue;
    if (!hasTechTitleSignal(title)) continue;
    if (inferExperienceLevel(title) === null) continue;

    const detail = await fetchJobDetail(buildId, slug, jobId);
    const description = buildDescription(detail);
    const level = inferExperienceLevel(title, description);
    if (level === null) continue;

    const locations = detail?.workLocations?.length ? detail.workLocations : boardJob.locations;
    const location = formatLocations(locations);
    const company = detail?.companyName?.trim() || board?.title?.trim() || fallbackCompanyName(slug);

    normalized.push({
      source: 'rippling',
      source_id: `${slug}:${detail?.uuid ?? jobId}`,
      title,
      company,
      location,
      remote: isRemote(locations, location),
      url: detail?.url ?? boardJob.url ?? board?.boardURL ?? `${ATS_BASE_URL}/${slug}/jobs/${jobId}`,
      description,
      experience_level: level,
      roles: inferRoles(title),
      posted_at: toIsoDate(detail?.createdOn),
      dedup_hash: generateHash(company, title, location ?? ''),
    });
  }

  if (normalized.length > 0) {
    console.log(`    [rippling] ${slug}: ${normalized.length} jobs`);
  }

  return normalized;
}

export async function scrapeRippling(): Promise<NormalizedJob[]> {
  const buildId = await fetchBuildId();
  const slugs = uniqueCompanies(RIPPLING_COMPANIES);
  const all: NormalizedJob[] = [];

  console.log(`    [rippling] build ${buildId}; probing ${slugs.length} boards`);

  for (let index = 0; index < slugs.length; index += COMPANY_BATCH_SIZE) {
    const batch = slugs.slice(index, index + COMPANY_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(slug => fetchCompany(buildId, slug))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        all.push(...result.value);
      }
    }

    if (index + COMPANY_BATCH_SIZE < slugs.length) {
      await delay(COMPANY_BATCH_DELAY_MS);
    }
  }

  return all;
}

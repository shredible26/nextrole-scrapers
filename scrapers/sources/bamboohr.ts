import { generateHash } from '../utils/dedup';
import { isNonUsLocation } from '../utils/location';
import {
  finalizeNormalizedJob,
  inferExperienceLevel,
  inferRemote,
  inferRoles,
  NormalizedJob,
} from '../utils/normalize';

const BAMBOOHR_COMPANIES = [
  'github', 'zapier', 'buffer', 'close', 'doist',
  'invisionapp', 'wildbit', 'balsamiq', 'basecamp', 'automattic',
  'hotjar', 'convertkit', 'baremetrics', 'transistor', 'loom',
  'airtable', 'notion', 'figma', 'linear', 'vercel',
  'planetscale', 'render', 'railway', 'fly', 'supabase',
  'neon', 'turso', 'xata', 'fauna', 'convex',
  'clerk', 'stytch', 'magic', 'auth0', 'okta',
  'launchdarkly', 'split', 'statsig', 'growthbook',
  'mixpanel', 'amplitude', 'posthog', 'june', 'heap',
  'segment', 'rudderstack', 'jitsu', 'snowplow',
  'dbt', 'airbyte', 'fivetran', 'stitch', 'matillion',
  'dataiku', 'domino', 'weights-biases', 'comet', 'neptune',
  'huggingface', 'replicate', 'modal', 'banana', 'beam',
  'openai', 'anthropic', 'cohere', 'ai21', 'together',
  'scale', 'labelbox', 'snorkel', 'aquarium', 'encord',
  'sentry', 'rollbar', 'bugsnag', 'honeybadger', 'airbrake',
  'datadog', 'newrelic', 'dynatrace', 'elastic', 'splunk',
  'pagerduty', 'opsgenie', 'victorops', 'statuspage',
  'cloudflare', 'fastly', 'akamai', 'bunny', 'imagekit',
] as const;

const COMPANY_NAME_OVERRIDES: Record<string, string> = {
  ai21: 'AI21',
  auth0: 'Auth0',
  dbt: 'dbt',
  newrelic: 'New Relic',
  openai: 'OpenAI',
  'weights-biases': 'Weights & Biases',
};

const GENERIC_SKIP_PATTERNS = [
  'general application',
  'open application',
  'talent community',
  'future opportunity',
  'future opportunities',
  'demo job',
];

const KNOWN_DEMO_TITLES = new Set([
  'financial analyst',
  'general application',
  'it security engineer',
  'marketing manager',
  'software engineer',
]);

type ParsedBambooHrJob = {
  id: string;
  title: string;
  location: string;
  url: string;
  remote?: boolean;
};

type BambooHrCareersResponse = {
  meta?: {
    totalCount?: number;
  };
  result?: BambooHrCareersJob[];
};

type BambooHrCareersJob = {
  id?: string | number;
  jobOpeningName?: string;
  departmentLabel?: string;
  location?: {
    city?: string | null;
    state?: string | null;
  };
  atsLocation?: {
    country?: string | null;
    state?: string | null;
    province?: string | null;
    city?: string | null;
  };
  isRemote?: boolean | null;
  locationType?: string | null;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function formatCompanyName(slug: string): string {
  const overridden = COMPANY_NAME_OVERRIDES[slug];
  if (overridden) return overridden;

  return slug
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBambooUrl(company: string, href: string): string {
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) return `https://${company}.bamboohr.com${href}`;
  return `https://${company}.bamboohr.com/${href}`;
}

function buildJsonLocation(job: BambooHrCareersJob): string {
  const directLocation = [job.location?.city, job.location?.state]
    .filter((part): part is string => Boolean(part))
    .join(', ');
  if (directLocation) return directLocation;

  return [
    job.atsLocation?.city,
    job.atsLocation?.state ?? job.atsLocation?.province,
    job.atsLocation?.country,
  ]
    .filter((part): part is string => Boolean(part))
    .join(', ');
}

function isGenericBambooTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return GENERIC_SKIP_PATTERNS.some(pattern => lower.includes(pattern));
}

function isDemoDataset(rawJobs: ParsedBambooHrJob[]): boolean {
  if (rawJobs.length !== KNOWN_DEMO_TITLES.size) return false;

  const titles = new Set(rawJobs.map(job => job.title.toLowerCase()));
  return [...KNOWN_DEMO_TITLES].every(title => titles.has(title));
}

function parseEmbedJobs(company: string, html: string): ParsedBambooHrJob[] {
  const jobs: ParsedBambooHrJob[] = [];
  const jobPattern =
    /<li[^>]*id="bhrPositionID_(\d+)"[\s\S]*?<a href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<span[^>]*class="BambooHR-ATS-Location"[^>]*>([\s\S]*?)<\/span>/g;

  let match: RegExpExecArray | null;
  while ((match = jobPattern.exec(html)) !== null) {
    jobs.push({
      id: match[1],
      title: decodeHtmlEntities(match[3]),
      location: decodeHtmlEntities(match[4]),
      url: normalizeBambooUrl(company, match[2]),
    });
  }

  return jobs;
}

function parseCareersListJobs(company: string, data: BambooHrCareersResponse): ParsedBambooHrJob[] {
  const jobs = Array.isArray(data.result) ? data.result : [];

  return jobs
    .filter(job => job.id !== undefined && job.jobOpeningName)
    .map(job => ({
      id: String(job.id),
      title: job.jobOpeningName ?? '',
      location: buildJsonLocation(job),
      url: `https://${company}.bamboohr.com/careers/${job.id}`,
      remote: job.isRemote === true || job.locationType === '2',
    }));
}

async function fetchEmbedJobs(company: string): Promise<ParsedBambooHrJob[]> {
  try {
    const res = await fetch(
      `https://${company}.bamboohr.com/jobs/embed2.php?version=1.0.0`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (res.status === 404 || !res.ok) return [];

    const html = await res.text();
    if (!html.includes('BambooHR-ATS-board')) return [];

    const jobs = parseEmbedJobs(company, html);
    return isDemoDataset(jobs) ? [] : jobs;
  } catch {
    return [];
  }
}

async function fetchCareersListJobs(company: string): Promise<ParsedBambooHrJob[]> {
  try {
    const res = await fetch(`https://${company}.bamboohr.com/careers/list`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 404 || !res.ok) return [];

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return [];

    const data = (await res.json()) as BambooHrCareersResponse;
    const jobs = parseCareersListJobs(company, data);
    return isDemoDataset(jobs) ? [] : jobs;
  } catch {
    return [];
  }
}

function normalizeBambooHrJob(company: string, rawJob: ParsedBambooHrJob): NormalizedJob | null {
  const companyName = formatCompanyName(company);
  const title = rawJob.title.trim();
  const location = rawJob.location.trim();

  if (!title || !rawJob.url) return null;
  if (isGenericBambooTitle(title)) return null;
  if (location && isNonUsLocation(location)) return null;

  const experienceLevel = inferExperienceLevel(title);
  if (experienceLevel === null) return null;

  return finalizeNormalizedJob({
    source: 'bamboohr',
    source_id: rawJob.id,
    title,
    company: companyName,
    location,
    remote: rawJob.remote === true || inferRemote(location),
    url: rawJob.url,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    dedup_hash: generateHash(companyName, title, location),
  });
}

async function fetchCompany(company: string): Promise<NormalizedJob[]> {
  const embedJobs = await fetchEmbedJobs(company);
  const rawJobs = embedJobs.length > 0 ? embedJobs : await fetchCareersListJobs(company);
  if (rawJobs.length === 0) return [];

  const normalized = rawJobs
    .map(job => normalizeBambooHrJob(company, job))
    .filter((job): job is NormalizedJob => job !== null);

  if (normalized.length > 0) {
    console.log(`    [bamboohr] ${formatCompanyName(company)}: ${normalized.length} jobs`);
  }

  return normalized;
}

export async function scrapeBambooHR(): Promise<NormalizedJob[]> {
  const all: NormalizedJob[] = [];

  for (let i = 0; i < BAMBOOHR_COMPANIES.length; i += 10) {
    const batch = BAMBOOHR_COMPANIES.slice(i, i + 10);
    const results = await Promise.allSettled(batch.map(company => fetchCompany(company)));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        all.push(...result.value);
      }
    }

    if (i + 10 < BAMBOOHR_COMPANIES.length) {
      await delay(200);
    }
  }

  return all;
}

import { generateHash } from '../utils/dedup';
import { isNonUsLocation } from '../utils/location';
import { inferExperienceLevel, inferRoles, NormalizedJob } from '../utils/normalize';

const SOURCE = 'workable';

const BASE_WORKABLE_COMPANIES = [
  'beekeeper',
  'docplanner',
  'preply',
  'bending-spoons',
  'travelperk',
  'factorial',
  'oyster',
  'manychat',
  'collibra',
  'deliveroo',
  'bunq',
  'volt',
  'payhawk',
  'wefox',
  'mews',
  'hygraph',
  'soldo',
  'deel',
  'remote',
  'quantexa',
  'contentsquare',
  'sumup',
  'mirakl',
  'ledger',
  'algolia',
  'aircall',
  'revolut',
  'klarna',
  'wise',
  'n26',
  'pleo',
  'babbel',
  'personiojobs',
] as const;

const EXPANDED_WORKABLE_COMPANIES = [
  'niantic',
  'typeform',
  'hotjar',
  'personio',
  'learnworlds',
  'blueground',
  'taxfix',
  'vivino',
  'hack-the-box',
  'quizlet',
  'carwow',
  'primer',
  'pave',
  'omnipresent',
  'juro',
  'jit',
  'cyolo',
  'cato-networks',
  'checkmarx',
  'aqua-security',
  'snyk',
  'orca-security',
  'hunters',
  'axonius',
  'fireblocks',
  'alchemy',
  'chainalysis',
  'opensea',
] as const;

const WORKABLE_COMPANIES = Array.from(
  new Set(
    BASE_WORKABLE_COMPANIES.length < 50
      ? [...BASE_WORKABLE_COMPANIES, ...EXPANDED_WORKABLE_COMPANIES]
      : BASE_WORKABLE_COMPANIES,
  ),
);

const TECH_TITLE_SIGNALS = [
  'engineer',
  'developer',
  'scientist',
  'analyst',
  'architect',
  'devops',
  'sre',
  'platform',
  'backend',
  'frontend',
  'fullstack',
  'full stack',
  'machine learning',
  'data',
  'software',
  'cloud',
  'security',
  'infrastructure',
  'ml',
  'ai',
  'product manager',
  'program manager',
  'technical',
  'systems',
  'mobile',
  'ios',
  'android',
  'web',
  'api',
  'database',
  'network',
  'cyber',
  'quantitative',
  'quant',
  'researcher',
  'site reliability',
] as const;

type WorkableCompany = {
  name?: string;
  slug?: string;
  title?: string;
};

type WorkableLocation = {
  city?: string;
  region?: string;
  country?: string;
  subregion?: string | null;
  countryName?: string | null;
  remote?: boolean;
};

type WorkableJob = {
  id?: string;
  title?: string;
  state?: string;
  description?: string;
  company?: WorkableCompany;
  location?: WorkableLocation;
  created?: string;
  url?: string;
  workplace?: string;
  locations?: string[];
};

type WorkableAccountResponse = {
  jobs?: WorkableJob[];
  next_page?: string | null;
};

const stripHtml = (value: string): string =>
  value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function buildLocation(job: WorkableJob): string | undefined {
  const location = [job.location?.city, job.location?.region, job.location?.subregion]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(', ');

  return location || undefined;
}

function buildLocationSignal(job: WorkableJob): string {
  return [job.location?.city, job.location?.region, job.location?.subregion]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

function buildDescription(description?: string): string | undefined {
  if (!description?.trim()) return undefined;

  const stripped = stripHtml(description);
  if (!stripped) return undefined;

  return stripped.slice(0, 5_000);
}

function buildUrl(job: WorkableJob): string | undefined {
  const url = job.url?.trim();
  if (url) return url;
  if (!job.id?.trim()) return undefined;

  return `https://jobs.workable.com/view/${encodeURIComponent(job.id.trim())}`;
}

function normalizePostedAt(created?: string): string | undefined {
  if (!created?.trim()) return undefined;

  const date = new Date(created);
  if (Number.isNaN(date.getTime())) return undefined;

  return date.toISOString();
}

function isRemoteJob(job: WorkableJob): boolean {
  if (job.location?.remote === true) return true;
  if (job.workplace?.trim().toLowerCase() === 'remote') return true;

  return (job.locations ?? []).some(location => /remote|telecommute/i.test(location));
}

function isUsCountry(country?: string | null): boolean {
  const normalized = country?.trim().toLowerCase();
  return normalized === 'us' || normalized === 'united states';
}

function normalizeWorkableJob(job: WorkableJob): NormalizedJob | null {
  const sourceId = job.id?.trim();
  const title = job.title?.trim();
  const company = job.company?.name?.trim() || job.company?.title?.trim();
  const remote = isRemoteJob(job);
  const country = job.location?.country ?? job.location?.countryName;

  if (!sourceId || !title || !company) return null;
  if (job.state?.trim().toLowerCase() !== 'published') return null;
  if (!isUsCountry(country) && !remote) return null;

  const locationSignal = buildLocationSignal(job);
  if (isNonUsLocation(locationSignal)) return null;

  const isTechTitle = TECH_TITLE_SIGNALS.some(signal => title.toLowerCase().includes(signal));
  if (!isTechTitle) return null;

  const description = buildDescription(job.description);
  const experienceLevel = inferExperienceLevel(title, description);
  if (experienceLevel === null) return null;

  const location = buildLocation(job);
  const url = buildUrl(job);
  if (!url) return null;

  return {
    source: SOURCE,
    source_id: sourceId,
    title,
    company,
    location,
    remote,
    url,
    description,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at: normalizePostedAt(job.created),
    dedup_hash: generateHash(company, title, location ?? ''),
  };
}

async function fetchCompanyJobs(subdomain: string): Promise<WorkableJob[]> {
  let page: string | null = null;
  const jobs: WorkableJob[] = [];

  do {
    const url = page
      ? `https://www.workable.com/api/accounts/${subdomain}/jobs?details=true&page=${encodeURIComponent(page)}`
      : `https://www.workable.com/api/accounts/${subdomain}/jobs?details=true`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      break;
    }

    const data = (await response.json()) as WorkableAccountResponse;
    jobs.push(...(data.jobs ?? []));
    page = data.next_page ?? null;
  } while (page !== null);

  return jobs;
}

export async function scrapeWorkable(): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];
  const seenIds = new Set<string>();

  for (const subdomain of WORKABLE_COMPANIES) {
    try {
      const companyJobs = await fetchCompanyJobs(subdomain);
      console.log(`[workable] ${subdomain}: ${companyJobs.length} jobs`);

      for (const job of companyJobs) {
        const sourceId = job.id?.trim();
        if (!sourceId || seenIds.has(sourceId)) continue;

        const normalized = normalizeWorkableJob(job);
        if (!normalized) continue;

        seenIds.add(sourceId);
        jobs.push(normalized);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[workable] ${subdomain}: failed — ${message}`);
    }
  }

  console.log(`[workable] Total unique jobs: ${jobs.length}`);

  return jobs;
}

// Source: Breezy public job boards expose a per-company JSON feed at:
//   https://{company}.breezy.hr/json
// Official Breezy API docs cover authenticated API usage under api.breezy.hr/v3,
// but the public board feed is tenant-scoped and no global public jobs endpoint was found.

import { pathToFileURL } from 'node:url';

import {
  inferTargetRoles,
  normalizeJob,
  type NormalizedJob,
  type Role,
} from '../utils/normalize';
import {
  extractJobPostingJsonLd,
  fetchWithTimeout,
  mapInBatches,
  stripHtml,
} from '../utils/scraper-helpers';
import { deactivateStaleJobs, uploadJobs } from '../utils/upload';

const SOURCE = 'breezy';
const REQUEST_TIMEOUT_MS = 12_000;
const COMPANY_BATCH_SIZE = 5;
const COMPANY_BATCH_DELAY_MS = 250;
const DETAIL_BATCH_SIZE = 6;
const DETAIL_BATCH_DELAY_MS = 150;

const BREEZY_COMPANIES = [
  { slug: 'adquick', company: 'AdQuick' },
  { slug: 'alooola', company: 'alooola' },
  { slug: 'aptask', company: 'ApTask' },
  { slug: 'codebase', company: 'Codebase' },
  { slug: 'datamaxis', company: 'DATAMAXIS' },
  { slug: 'edge', company: 'Edge' },
  { slug: 'gen-tech', company: 'Genesis' },
  { slug: 'givzey', company: 'Givzey' },
  { slug: 'hmt-tank', company: 'HMT' },
  { slug: 'north-wind-group', company: 'North Wind Group' },
  { slug: 'nuview', company: 'NuView' },
  { slug: 'onebridge', company: 'Onebridge' },
  { slug: 'onyx-insight', company: 'ONYX Insight' },
  { slug: 'otto-engineering-inc', company: 'OTTO Engineering' },
  { slug: 'retail-zipline', company: 'Zipline' },
  { slug: 'shuvel', company: 'Shuvel Digital' },
  { slug: 'subscribe', company: 'SUBSCRIBE' },
  { slug: 'the-sugrue-group-llc', company: 'TSG Risk Management' },
  { slug: 'transparent-hiring', company: 'Transparent Hiring' },
  { slug: 'vagaro', company: 'Vagaro' },
  { slug: 'vantage-point-solutions-inc', company: 'Vantage Point Solutions' },
  { slug: 'vetsez', company: 'VetsEZ' },
  { slug: 'wavetronix', company: 'Wavetronix' },
  { slug: 'wevideo', company: 'WeVideo' },
  { slug: 'westlight-ai', company: 'Westlight AI' },
  { slug: 'wolf-games', company: 'Wolf Games' },
] as const;

type BreezyCompany = (typeof BREEZY_COMPANIES)[number];

type BreezyLocation = {
  name?: string;
  city?: string;
  state?: { id?: string; name?: string };
  country?: { id?: string; name?: string };
  is_remote?: boolean;
};

type BreezyJob = {
  id?: string;
  friendly_id?: string;
  name?: string;
  url?: string;
  published_date?: string;
  department?: string;
  location?: BreezyLocation;
  locations?: BreezyLocation[];
  company?: {
    name?: string;
  };
};

type BreezyListing = {
  sourceId: string;
  title: string;
  url: string;
  company: string;
  location?: string;
  remote: boolean;
  postedAt?: string;
  targetRoles: Role[];
};

function buildJsonUrl(slug: string): string {
  return `https://${slug}.breezy.hr/json`;
}

function buildLocationName(location?: BreezyLocation): string | undefined {
  if (!location) return undefined;

  const explicit = location.name?.trim();
  if (explicit) return explicit;

  const state = location.state?.id?.trim() || location.state?.name?.trim();
  const built = [location.city?.trim(), state]
    .filter((part): part is string => Boolean(part))
    .join(', ');

  if (built) return built;
  return location.country?.name?.trim() || undefined;
}

function pickBestLocation(job: BreezyJob): string | undefined {
  const candidates = [job.location, ...(job.locations ?? [])];

  for (const candidate of candidates) {
    const name = buildLocationName(candidate);
    if (!name) continue;

    if (candidate?.is_remote) return 'Remote, United States';
    if (candidate?.country?.id === 'US' || candidate?.country?.name === 'United States') return name;
  }

  return candidates.map(buildLocationName).find((value): value is string => Boolean(value));
}

function isRemote(job: BreezyJob, location?: string): boolean {
  const candidates = [job.location, ...(job.locations ?? [])];
  if (candidates.some(candidate => candidate?.is_remote)) return true;
  return (location ?? '').toLowerCase().includes('remote');
}

function toListing(job: BreezyJob, fallbackCompany: string): BreezyListing | null {
  const sourceId = job.id?.trim() || job.friendly_id?.trim();
  const title = job.name?.trim();
  const url = job.url?.trim();
  const company = job.company?.name?.trim() || fallbackCompany;
  const location = pickBestLocation(job);
  const targetRoles = inferTargetRoles([title ?? '', job.department ?? '', location ?? ''].join('\n'));

  if (!sourceId || !title || !url || targetRoles.length === 0) return null;

  return {
    sourceId,
    title,
    url,
    company,
    location,
    remote: isRemote(job, location),
    postedAt: job.published_date,
    targetRoles,
  };
}

function toStringValue(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function buildLocationFromJobPosting(jobPosting: Record<string, unknown>, fallback?: string): string | undefined {
  const rawLocations = jobPosting.jobLocation;
  const locations = Array.isArray(rawLocations) ? rawLocations : rawLocations ? [rawLocations] : [];

  for (const location of locations) {
    if (!location || typeof location !== 'object') continue;

    const address = (location as Record<string, unknown>).address;
    if (!address || typeof address !== 'object') continue;

    const addressRecord = address as Record<string, unknown>;
    const city = toStringValue(addressRecord.addressLocality);
    const region = toStringValue(addressRecord.addressRegion);
    const country = toStringValue(addressRecord.addressCountry);

    const built = [city, region, country && country !== 'US' ? country : undefined]
      .filter((part): part is string => Boolean(part))
      .join(', ');

    if (built) return built;
  }

  return fallback;
}

function normalizeBreezyDetail(listing: BreezyListing, html: string): NormalizedJob | null {
  const jobPosting = extractJobPostingJsonLd(html);
  const description = stripHtml(
    typeof jobPosting?.description === 'string' ? jobPosting.description : undefined,
  );
  const title = toStringValue(jobPosting?.title) ?? listing.title;
  const company =
    toStringValue((jobPosting?.hiringOrganization as Record<string, unknown> | undefined)?.name) ??
    listing.company;
  const location = buildLocationFromJobPosting(jobPosting ?? {}, listing.location);
  const roles = inferTargetRoles([title, description].join('\n'));

  if (roles.length === 0) return null;

  const normalized = normalizeJob({
    source: SOURCE,
    sourceId: listing.sourceId,
    title,
    company,
    location,
    remote: listing.remote || String(jobPosting?.jobLocationType ?? '').toLowerCase().includes('remote'),
    url: listing.url,
    description,
    postedAt: toStringValue(jobPosting?.datePosted) ?? listing.postedAt,
    roles,
    experienceText: description,
  });

  if (!normalized || normalized.experience_level === 'internship' || normalized.roles.length === 0) {
    return null;
  }

  return normalized;
}

async function fetchCompany(company: BreezyCompany): Promise<NormalizedJob[]> {
  const res = await fetchWithTimeout(
    buildJsonUrl(company.slug),
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    },
    REQUEST_TIMEOUT_MS,
  );
  if (!res?.ok) return [];

  const rawJobs = await res.json() as unknown;
  if (!Array.isArray(rawJobs)) return [];

  const listings = rawJobs
    .map((job) => toListing(job as BreezyJob, company.company))
    .filter((listing): listing is BreezyListing => listing !== null);

  if (listings.length === 0) return [];

  const normalized = await mapInBatches(
    listings,
    DETAIL_BATCH_SIZE,
    DETAIL_BATCH_DELAY_MS,
    async (listing) => {
      const detailRes = await fetchWithTimeout(
        listing.url,
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
        REQUEST_TIMEOUT_MS,
      );
      if (!detailRes?.ok) return null;

      const html = await detailRes.text();
      return normalizeBreezyDetail(listing, html);
    },
  );

  const jobs = normalized.filter((job): job is NormalizedJob => job !== null);
  if (jobs.length > 0) {
    console.log(`  [${SOURCE}] ${company.company}: ${jobs.length} jobs`);
  }

  return jobs;
}

export async function scrapeBreezy(): Promise<NormalizedJob[]> {
  const results = await mapInBatches(
    BREEZY_COMPANIES,
    COMPANY_BATCH_SIZE,
    COMPANY_BATCH_DELAY_MS,
    fetchCompany,
  );

  const deduped = new Map<string, NormalizedJob>();
  for (const jobs of results) {
    for (const job of jobs) {
      const key = job.source_id ?? job.url;
      deduped.set(key, job);
    }
  }

  const all = [...deduped.values()];
  console.log(`  [${SOURCE}] Final count: ${all.length}`);
  return all;
}

async function runStandalone(): Promise<void> {
  const startedAt = Date.now();
  const jobs = await scrapeBreezy();
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

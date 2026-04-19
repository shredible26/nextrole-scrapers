// Source: iCIMS public career sites expose per-company HTML search pages at:
//   https://{company-host}.icims.com/jobs/search?ss=1&in_iframe=1
// Search pagination uses `pr={pageIndex}` and detail pages expose JobPosting JSON-LD.
// iCIMS' documented XML feed is vendor/auth enabled, so the best public method here is
// per-company HTML parsing plus detail-page JSON-LD extraction. No global public endpoint found.

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

const SOURCE = 'icims';
const REQUEST_TIMEOUT_MS = 12_000;
const COMPANY_BATCH_SIZE = 4;
const COMPANY_BATCH_DELAY_MS = 300;
const DETAIL_BATCH_SIZE = 6;
const DETAIL_BATCH_DELAY_MS = 150;
const SEARCH_PAGE_LIMIT = 2;
const SEARCH_KEYWORDS = [
  'software',
  'developer',
  'data',
  'machine learning',
  'product manager',
  'analyst',
] as const;

const ICIMS_COMPANIES = [
  { host: 'careers-gdms.icims.com', company: 'General Dynamics Mission Systems' },
  { host: 'careers-sig.icims.com', company: 'Susquehanna International Group' },
  { host: 'careers-peraton.icims.com', company: 'Peraton' },
  { host: 'university-uber.icims.com', company: 'Uber' },
  { host: 'careers-ice.icims.com', company: 'Intercontinental Exchange' },
  { host: 'careersus-shure.icims.com', company: 'Shure' },
  { host: 'careers-kinaxis.icims.com', company: 'Kinaxis' },
  { host: 'careers-sas.icims.com', company: 'SAS' },
  { host: 'careers-rovisys.icims.com', company: 'RoviSys' },
  { host: 'careers-gdeb.icims.com', company: 'General Dynamics Electric Boat' },
  { host: 'career-schwab.icims.com', company: 'Charles Schwab' },
  { host: 'careers-cotiviti.icims.com', company: 'Cotiviti' },
  { host: 'careers-rambus.icims.com', company: 'Rambus' },
  { host: 'careers-sri.icims.com', company: 'SRI International' },
  { host: 'uscareers-waters.icims.com', company: 'Waters' },
  { host: 'careers-lmi.icims.com', company: 'LMI' },
  { host: 'careers-scires.icims.com', company: 'Scientific Research Corporation' },
  { host: 'careers-markon.icims.com', company: 'Markon' },
  { host: 'jobs-legrand.icims.com', company: 'Legrand' },
  { host: 'careers-daktronics.icims.com', company: 'Daktronics' },
  { host: 'careers-quanta.icims.com', company: 'Quanta Services' },
  { host: 'careers-blackhawknetwork.icims.com', company: 'Blackhawk Network' },
  { host: 'careers-biorad.icims.com', company: 'Bio-Rad Laboratories' },
  { host: 'careers-ebscoind.icims.com', company: 'EBSCO' },
  { host: 'careers-geosyntec.icims.com', company: 'Geosyntec Consultants' },
  { host: 'careers-gannettfleming.icims.com', company: 'Gannett Fleming' },
] as const;

type IcimsCompany = (typeof ICIMS_COMPANIES)[number];

type IcimsSearchListing = {
  sourceId: string;
  title: string;
  url: string;
  company: string;
  summary?: string;
  location?: string;
  category?: string;
  targetRoles: Role[];
};

function buildSearchUrl(host: string, keyword: string, pageIndex: number): string {
  const params = new URLSearchParams({
    ss: '1',
    in_iframe: '1',
    searchKeyword: keyword,
  });

  if (pageIndex > 0) {
    params.set('pr', String(pageIndex));
  }

  return `https://${host}/jobs/search?${params.toString()}`;
}

function normalizeIcimsLocation(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const usMatch = trimmed.match(/^US-([A-Z]{2})-(.+)$/);
  if (!usMatch) return trimmed;

  const state = usMatch[1];
  const city = usMatch[2].replace(/-/g, ' ').trim();

  if (!city) return state;
  if (city.toLowerCase() === 'remote') return 'Remote, United States';

  return `${city}, ${state}`;
}

function extractHeaderFieldMap(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const tagPattern = /<div class="iCIMS_JobHeaderTag">([\s\S]*?)<\/div>/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(block)) !== null) {
    const tagBlock = match[1];
    const field = stripHtml(tagBlock.match(/<dt[^>]*>([\s\S]*?)<\/dt>/i)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const value = stripHtml(tagBlock.match(/<dd[^>]*>([\s\S]*?)<\/dd>/i)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    if (field && value) {
      fields[field] = value;
    }
  }

  return fields;
}

function extractSearchListings(html: string, company: string): IcimsSearchListing[] {
  const parts = html.split('<li class="iCIMS_JobCardItem">').slice(1);
  const listings: IcimsSearchListing[] = [];

  for (const part of parts) {
    const block = part.split('</li>')[0] ?? part;
    const url = block.match(/<a href="([^"]+\/jobs\/\d+\/[^"]+\/job\?[^"]*)"/i)?.[1];
    const title = stripHtml(block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '');

    if (!url || !title) continue;

    const sourceId = url.match(/\/jobs\/(\d+)\//)?.[1];
    if (!sourceId) continue;

    const fields = extractHeaderFieldMap(block);
    const summary = stripHtml(block.match(/<div class="col-xs-12 description">([\s\S]*?)<\/div>/i)?.[1] ?? '') || undefined;
    const category = fields.Category?.trim() || undefined;
    const location = normalizeIcimsLocation(fields['Job Location'] ?? fields.JobLocation);
    const targetRoles = inferTargetRoles([title, category ?? '', summary ?? ''].join('\n'));

    if (targetRoles.length === 0) continue;

    listings.push({
      sourceId,
      title,
      url,
      company,
      summary,
      location,
      category,
      targetRoles,
    });
  }

  return listings;
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

function isRemoteJobPosting(jobPosting: Record<string, unknown>, fallbackLocation?: string, description?: string): boolean {
  const jobLocationType = String(jobPosting.jobLocationType ?? '').toLowerCase();
  if (jobLocationType.includes('telecommute') || jobLocationType.includes('remote')) return true;

  const text = `${fallbackLocation ?? ''}\n${description ?? ''}`.toLowerCase();
  return text.includes('remote');
}

function normalizeIcimsDetail(listing: IcimsSearchListing, html: string): NormalizedJob | null {
  const jobPosting = extractJobPostingJsonLd(html);
  const description = stripHtml(
    (typeof jobPosting?.description === 'string' ? jobPosting.description : undefined) ??
    html.match(/<div class="iCIMS_JobContent">([\s\S]*?)<\/div>/i)?.[1] ??
    listing.summary,
  ) || listing.summary;

  const company =
    toStringValue((jobPosting?.hiringOrganization as Record<string, unknown> | undefined)?.name) ??
    listing.company;
  const title = toStringValue(jobPosting?.title) ?? listing.title;
  const location = buildLocationFromJobPosting(jobPosting ?? {}, listing.location);
  const roles = inferTargetRoles([title, listing.category ?? '', description ?? ''].join('\n'));

  if (roles.length === 0) return null;

  const normalized = normalizeJob({
    source: SOURCE,
    sourceId: listing.sourceId,
    title,
    company,
    location,
    remote: isRemoteJobPosting(jobPosting ?? {}, location, description),
    url: listing.url,
    description,
    postedAt: toStringValue(jobPosting?.datePosted),
    roles,
    experienceText: description,
  });

  if (!normalized || normalized.experience_level === 'internship' || normalized.roles.length === 0) {
    return null;
  }

  return normalized;
}

async function fetchCompany(company: IcimsCompany): Promise<NormalizedJob[]> {
  const listingsById = new Map<string, IcimsSearchListing>();

  for (const keyword of SEARCH_KEYWORDS) {
    for (let pageIndex = 0; pageIndex < SEARCH_PAGE_LIMIT; pageIndex += 1) {
      const res = await fetchWithTimeout(
        buildSearchUrl(company.host, keyword, pageIndex),
        {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        },
        REQUEST_TIMEOUT_MS,
      );
      if (!res?.ok) break;

      const html = await res.text();
      const listings = extractSearchListings(html, company.company);
      if (listings.length === 0) break;

      for (const listing of listings) {
        listingsById.set(listing.sourceId, listing);
      }
    }
  }

  const listings = [...listingsById.values()];
  if (listings.length === 0) return [];

  const normalized = await mapInBatches(
    listings,
    DETAIL_BATCH_SIZE,
    DETAIL_BATCH_DELAY_MS,
    async (listing) => {
      const res = await fetchWithTimeout(
        listing.url,
        {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        },
        REQUEST_TIMEOUT_MS,
      );
      if (!res?.ok) return null;

      const html = await res.text();
      return normalizeIcimsDetail(listing, html);
    },
  );

  const jobs = normalized.filter((job): job is NormalizedJob => job !== null);
  if (jobs.length > 0) {
    console.log(`  [${SOURCE}] ${company.company}: ${jobs.length} jobs`);
  }

  return jobs;
}

export async function scrapeIcims(): Promise<NormalizedJob[]> {
  const results = await mapInBatches(
    ICIMS_COMPANIES,
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
  const jobs = await scrapeIcims();
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

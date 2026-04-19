// Source: Jobvite public boards are tenant-scoped rather than globally searchable.
// Public feed/API endpoints are not exposed without customer enablement/auth, but many boards
// render job rows in HTML at:
//   https://jobs.jobvite.com/{company}/jobs
//   https://jobs.jobvite.com/careers/{company}/jobs
// Detail pages expose schema.org JobPosting JSON-LD, so the best public method is
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

const SOURCE = 'jobvite';
const REQUEST_TIMEOUT_MS = 12_000;
const COMPANY_BATCH_SIZE = 4;
const COMPANY_BATCH_DELAY_MS = 250;
const DETAIL_BATCH_SIZE = 6;
const DETAIL_BATCH_DELAY_MS = 150;

const JOBVITE_COMPANIES = [
  { slug: 'altamiracorps', company: 'Altamira Technologies' },
  { slug: 'blackboard', company: 'Blackboard' },
  { slug: 'egnyte', company: 'Egnyte' },
  { slug: 'enphase-energy', company: 'Enphase Energy' },
  { slug: 'evgo', company: 'EVgo' },
  { slug: 'hachette-book-group', company: 'Hachette Book Group' },
  { slug: 'idtus', company: 'Innovative Defense Technologies' },
  { slug: 'inogen', company: 'Inogen' },
  { slug: 'internetbrands', company: 'Internet Brands' },
  { slug: 'isoftstone', company: 'iSoftStone' },
  { slug: 'ninjaone', company: 'NinjaOne' },
  { slug: 'nortek', company: 'Nortek' },
  { slug: 'nutanix', company: 'Nutanix' },
  { slug: 'openlending', company: 'Open Lending' },
  { slug: 'rhi', company: 'Robert Half Technology' },
  { slug: 'sikichcareers', company: 'Sikich' },
  { slug: 'splunk-careers', company: 'Splunk' },
  { slug: 'src-inc', company: 'SRC' },
  { slug: 'tibertechnologies', company: 'Tiber Technologies' },
  { slug: 'tylertech', company: 'Tyler Technologies' },
  { slug: 'versa-networks', company: 'Versa Networks' },
  { slug: 'visionist', company: 'Visionist' },
  { slug: 'weisiger', company: 'Weisiger Group' },
  { slug: 'windriver', company: 'Wind River' },
  { slug: 'yodlee', company: 'Yodlee' },
] as const;

type JobviteCompany = (typeof JOBVITE_COMPANIES)[number];

type JobviteListing = {
  sourceId: string;
  title: string;
  url: string;
  company: string;
  location?: string;
  targetRoles: Role[];
};

function listPageCandidates(slug: string): string[] {
  return [
    `https://jobs.jobvite.com/${slug}/jobs`,
    `https://jobs.jobvite.com/careers/${slug}/jobs`,
    `https://jobs.jobvite.com/${slug}`,
  ];
}

function normalizeRelativeUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  if (path.startsWith('/')) return `https://jobs.jobvite.com${path}`;
  return `https://jobs.jobvite.com/${path}`;
}

function parseListPage(html: string, company: string): JobviteListing[] {
  const rowPattern =
    /<tr>\s*<td class="jv-job-list-name">\s*<a href="([^"]+)">([\s\S]*?)<\/a>\s*<\/td>\s*<td class="jv-job-list-location">([\s\S]*?)<\/td>\s*<\/tr>/gi;

  const listings: JobviteListing[] = [];
  let match: RegExpExecArray | null;

  while ((match = rowPattern.exec(html)) !== null) {
    const url = normalizeRelativeUrl(match[1]);
    const title = stripHtml(match[2]);
    const location = stripHtml(match[3]) || undefined;
    const sourceId = url.match(/\/job\/([^/?#]+)/i)?.[1];
    const targetRoles = inferTargetRoles([title, location ?? ''].join('\n'));

    if (!sourceId || !title || targetRoles.length === 0) continue;

    listings.push({
      sourceId,
      title,
      url,
      company,
      location,
      targetRoles,
    });
  }

  return listings;
}

async function fetchListings(company: JobviteCompany): Promise<JobviteListing[]> {
  for (const url of listPageCandidates(company.slug)) {
    const res = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
      REQUEST_TIMEOUT_MS,
    );
    if (!res?.ok) continue;

    const html = await res.text();
    const listings = parseListPage(html, company.company);
    if (listings.length > 0) return listings;
  }

  return [];
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

function normalizeJobviteDetail(listing: JobviteListing, html: string): NormalizedJob | null {
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
    remote:
      (location ?? '').toLowerCase().includes('remote') ||
      String(jobPosting?.jobLocationType ?? '').toLowerCase().includes('remote'),
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

async function fetchCompany(company: JobviteCompany): Promise<NormalizedJob[]> {
  const listings = await fetchListings(company);
  if (listings.length === 0) return [];

  const normalized = await mapInBatches(
    listings,
    DETAIL_BATCH_SIZE,
    DETAIL_BATCH_DELAY_MS,
    async (listing) => {
      const res = await fetchWithTimeout(
        listing.url,
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
        REQUEST_TIMEOUT_MS,
      );
      if (!res?.ok) return null;

      const html = await res.text();
      return normalizeJobviteDetail(listing, html);
    },
  );

  const jobs = normalized.filter((job): job is NormalizedJob => job !== null);
  if (jobs.length > 0) {
    console.log(`  [${SOURCE}] ${company.company}: ${jobs.length} jobs`);
  }

  return jobs;
}

export async function scrapeJobvite(): Promise<NormalizedJob[]> {
  const results = await mapInBatches(
    JOBVITE_COMPANIES,
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
  const jobs = await scrapeJobvite();
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

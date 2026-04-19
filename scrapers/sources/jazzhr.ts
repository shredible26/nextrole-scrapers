// Source: JazzHR public boards are tenant-scoped and commonly live on:
//   https://{company}.jazz.co/
//   https://{company}.applytojob.com/
// Public API access is not exposed for anonymous board-wide scraping, but the
// career pages render job cards in HTML and detail pages expose JobPosting JSON-LD.
// No global public jobs endpoint was found.

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

const SOURCE = 'jazzhr';
const REQUEST_TIMEOUT_MS = 12_000;
const COMPANY_BATCH_SIZE = 4;
const COMPANY_BATCH_DELAY_MS = 250;
const DETAIL_BATCH_SIZE = 6;
const DETAIL_BATCH_DELAY_MS = 125;

const JAZZHR_COMPANIES = [
  { careerUrl: 'https://alluvionic.applytojob.com/', company: 'Alluvionic' },
  { careerUrl: 'https://analyticallc.applytojob.com/', company: 'Analytica' },
  { careerUrl: 'https://biotabhealthcare.applytojob.com/', company: 'BioTAB Healthcare' },
  { careerUrl: 'https://bizflow.applytojob.com/', company: 'BizFlow' },
  { careerUrl: 'https://bookofthemonth.applytojob.com/', company: 'Book of the Month' },
  { careerUrl: 'https://cmsprep.applytojob.com/', company: 'CMS Prep' },
  { careerUrl: 'https://codametrix.applytojob.com/', company: 'CodaMetrix' },
  { careerUrl: 'https://comfrt.jazz.co/', company: 'Comfrt' },
  { careerUrl: 'https://datasociety.applytojob.com/', company: 'Data Society' },
  { careerUrl: 'https://firstadvantage.applytojob.com/', company: 'First Advantage' },
  { careerUrl: 'https://g2ops.jazz.co/', company: 'G2 Ops' },
  { careerUrl: 'https://innovatingjustice.applytojob.com/', company: 'Center for Justice Innovation' },
  { careerUrl: 'https://intelliforceitsolutionsgroup.applytojob.com/', company: 'Intelliforce-IT Solutions Group' },
  { careerUrl: 'https://intellisurvey.applytojob.com/', company: 'IntelliSurvey' },
  { careerUrl: 'https://intrepidstudios.applytojob.com/', company: 'Intrepid Studios' },
  { careerUrl: 'https://kharon.applytojob.com/', company: 'Kharon' },
  { careerUrl: 'https://prometheusfederalservices.applytojob.com/', company: 'Prometheus Federal Services' },
  { careerUrl: 'https://spacedynamicslaboratory.applytojob.com/', company: 'Space Dynamics Laboratory' },
  { careerUrl: 'https://tapengineering.applytojob.com/', company: 'TAP Engineering' },
  { careerUrl: 'https://teambuilder.applytojob.com/', company: 'TeamBuilder' },
  { careerUrl: 'https://wellhealthtechnologiescorpc4.applytojob.com/', company: 'WELL Health Technologies' },
  { careerUrl: 'https://winning.applytojob.com/', company: 'Winning Consulting' },
] as const;

type JazzCompany = (typeof JAZZHR_COMPANIES)[number];

type JazzListing = {
  sourceId: string;
  title: string;
  url: string;
  company: string;
  location?: string;
  department?: string;
  targetRoles: Role[];
};

function parseListings(html: string, company: string): JazzListing[] {
  const blocks = html.split('<li class="list-group-item">').slice(1);
  const listings: JazzListing[] = [];

  for (const part of blocks) {
    const block = part.split('</li>')[0] ?? part;
    const url = block.match(/<a href="([^"]+)"/i)?.[1]?.trim();
    const title = stripHtml(block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '');

    if (!url || !title) continue;

    const listItemPattern = /<li>\s*<i class='fa fa-[^']+'><\/i>([\s\S]*?)<\/li>/gi;
    const values: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = listItemPattern.exec(block)) !== null) {
      const value = stripHtml(match[1]);
      if (value) values.push(value);
    }

    const location = values[0] || undefined;
    const department = values[1] || undefined;
    const sourceId =
      url.match(/\/apply\/([^/]+)/i)?.[1] ??
      url.match(/\/app\/share\/([^/?#]+)/i)?.[1];
    const targetRoles = inferTargetRoles([title, department ?? '', location ?? ''].join('\n'));

    if (!sourceId || targetRoles.length === 0) continue;

    listings.push({
      sourceId,
      title,
      url,
      company,
      location,
      department,
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

function normalizeJazzDetail(listing: JazzListing, html: string): NormalizedJob | null {
  const jobPosting = extractJobPostingJsonLd(html);
  const description = stripHtml(
    typeof jobPosting?.description === 'string' ? jobPosting.description : undefined,
  );
  const title = toStringValue(jobPosting?.title) ?? listing.title;
  const company =
    toStringValue((jobPosting?.hiringOrganization as Record<string, unknown> | undefined)?.name) ??
    listing.company;
  const location = buildLocationFromJobPosting(jobPosting ?? {}, listing.location);
  const roles = inferTargetRoles([title, listing.department ?? '', description].join('\n'));

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

async function fetchCompany(company: JazzCompany): Promise<NormalizedJob[]> {
  const res = await fetchWithTimeout(
    company.careerUrl,
    { headers: { 'User-Agent': 'Mozilla/5.0' } },
    REQUEST_TIMEOUT_MS,
  );
  if (!res?.ok) return [];

  const html = await res.text();
  const listings = parseListings(html, company.company);
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

      const detailHtml = await detailRes.text();
      return normalizeJazzDetail(listing, detailHtml);
    },
  );

  const jobs = normalized.filter((job): job is NormalizedJob => job !== null);
  if (jobs.length > 0) {
    console.log(`  [${SOURCE}] ${company.company}: ${jobs.length} jobs`);
  }

  return jobs;
}

export async function scrapeJazzHr(): Promise<NormalizedJob[]> {
  const results = await mapInBatches(
    JAZZHR_COMPANIES,
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
  const jobs = await scrapeJazzHr();
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

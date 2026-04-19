// Source: Oracle Cloud Recruiting public candidate sites expose unauthenticated REST endpoints:
//   {baseUrl}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
//   {baseUrl}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
// Boards are tenant-scoped by base domain + siteNumber. No global public endpoint found.

import { pathToFileURL } from 'node:url';

import {
  inferTargetRoles,
  normalizeJob,
  type NormalizedJob,
  type Role,
} from '../utils/normalize';
import {
  fetchWithTimeout,
  mapInBatches,
  stripHtml,
} from '../utils/scraper-helpers';
import { deactivateStaleJobs, uploadJobs } from '../utils/upload';

const SOURCE = 'oraclecloud';
const REQUEST_TIMEOUT_MS = 12_000;
const COMPANY_BATCH_SIZE = 4;
const COMPANY_BATCH_DELAY_MS = 250;
const DETAIL_BATCH_SIZE = 6;
const DETAIL_BATCH_DELAY_MS = 125;
const LIST_PAGE_SIZE = 50;
const LIST_PAGE_COUNT = 3;

const ORACLE_COMPANIES = [
  { baseUrl: 'https://eeho.fa.us2.oraclecloud.com', siteNumber: 'CX_45001', company: 'Oracle' },
  { baseUrl: 'https://fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com', siteNumber: 'CX_1', company: 'Nokia' },
  { baseUrl: 'https://edel.fa.us2.oraclecloud.com', siteNumber: 'CX_2001', company: 'Fortinet' },
  { baseUrl: 'https://egup.fa.us2.oraclecloud.com', siteNumber: 'CX', company: 'Vertiv' },
  { baseUrl: 'https://ibqbjb.fa.ocs.oraclecloud.com', siteNumber: 'Honeywell', company: 'Honeywell' },
  { baseUrl: 'https://hdjq.fa.us2.oraclecloud.com', siteNumber: 'CX_1', company: 'Emerson' },
  { baseUrl: 'https://hcwp.fa.us2.oraclecloud.com', siteNumber: 'CX_1', company: 'Coherent' },
  { baseUrl: 'https://fa-espx-saasfaprod1.fa.ocs.oraclecloud.com', siteNumber: 'CX_1', company: 'Cummins' },
  { baseUrl: 'https://ejta.fa.us6.oraclecloud.com', siteNumber: 'CX_2001', company: 'Fortive' },
  { baseUrl: 'https://efds.fa.em5.oraclecloud.com', siteNumber: 'CX_1', company: 'Ford Motor Company' },
  { baseUrl: 'https://hctz.fa.us2.oraclecloud.com', siteNumber: 'CX_1001', company: 'onsemi' },
  { baseUrl: 'https://fa-ewmy-saasfaprod1.fa.ocs.oraclecloud.com', siteNumber: 'CX_1', company: 'Verisk' },
  { baseUrl: 'https://emit.fa.ca3.oraclecloud.com', siteNumber: 'CX_2001', company: 'WSP' },
  { baseUrl: 'https://hcog.fa.em2.oraclecloud.com', siteNumber: 'CX_1', company: 'Intertek' },
  { baseUrl: 'https://eevd.fa.us6.oraclecloud.com', siteNumber: 'CX_1', company: 'Hearst' },
  { baseUrl: 'https://ebcs.fa.em2.oraclecloud.com', siteNumber: 'CX_1', company: 'Arcadis' },
  { baseUrl: 'https://ebwb.fa.us2.oraclecloud.com', siteNumber: 'CX', company: 'Hologic' },
  { baseUrl: 'https://ejhp.fa.us6.oraclecloud.com', siteNumber: 'CX_2', company: 'Sherwin-Williams' },
  { baseUrl: 'https://fa-exvu-saasfaprod1.fa.ocs.oraclecloud.com', siteNumber: 'CX_1', company: 'GM Financial' },
  { baseUrl: 'https://jpmc.fa.oraclecloud.com', siteNumber: 'CX_1001', company: 'JPMorgan Chase' },
  { baseUrl: 'https://fa-exty-saasfaprod1.fa.ocs.oraclecloud.com', siteNumber: 'CX_1', company: 'Howmet Aerospace' },
  { baseUrl: 'https://fa-ewgu-saasfaprod1.fa.ocs.oraclecloud.com', siteNumber: 'CX_2001', company: 'Chubb' },
  { baseUrl: 'https://hdhl.fa.us6.oraclecloud.com', siteNumber: 'CX_1', company: 'Stantec' },
  { baseUrl: 'https://fa-essf-saasfaprod1.fa.ocs.oraclecloud.com', siteNumber: 'CX_1', company: 'Berkshire Hathaway Energy' },
  { baseUrl: 'https://ecnf.fa.us2.oraclecloud.com', siteNumber: 'CX', company: 'Tradeweb' },
] as const;

type OracleCompany = (typeof ORACLE_COMPANIES)[number];

type OracleSearchResult = {
  items?: Array<{
    requisitionList?: OracleRequisitionSummary[];
  }>;
};

type OracleRequisitionSummary = {
  Id?: string;
  Title?: string;
  PostedDate?: string;
  PrimaryLocation?: string;
  WorkplaceType?: string;
};

type OracleDetailResult = {
  items?: OracleRequisitionDetail[];
};

type OracleWorkLocation = {
  TownOrCity?: string;
  Region2?: string;
  Country?: string;
  LocationName?: string;
};

type OracleRequisitionDetail = {
  Id?: string;
  Title?: string;
  PostedDate?: string;
  PrimaryLocation?: string;
  WorkplaceType?: string;
  ExternalDescriptionStr?: string;
  ExternalQualificationsStr?: string;
  ExternalResponsibilitiesStr?: string;
  workLocation?: OracleWorkLocation[];
  otherWorkLocations?: OracleWorkLocation[];
};

type OracleListing = {
  sourceId: string;
  title: string;
  company: string;
  url: string;
  location?: string;
  remote: boolean;
  postedAt?: string;
  targetRoles: Role[];
  companyConfig: OracleCompany;
};

function buildListUrl(company: OracleCompany, offset: number): string {
  const params = new URLSearchParams({
    onlyData: 'true',
    expand: 'requisitionList.secondaryLocations',
    finder: `findReqs;siteNumber=${company.siteNumber},facetsList=NONE,limit=${LIST_PAGE_SIZE},offset=${offset},sortBy=POSTING_DATES_DESC`,
  });

  return `${company.baseUrl}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?${params.toString()}`;
}

function buildDetailUrl(company: OracleCompany, id: string): string {
  const params = new URLSearchParams({
    expand: 'all',
    onlyData: 'true',
    finder: `ById;Id="${id}",siteNumber=${company.siteNumber}`,
  });

  return `${company.baseUrl}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?${params.toString()}`;
}

function buildPublicJobUrl(company: OracleCompany, id: string): string {
  return `${company.baseUrl}/hcmUI/CandidateExperience/en/sites/${company.siteNumber}/job/${id}`;
}

function buildDescription(detail: OracleRequisitionDetail): string {
  return stripHtml([
    detail.ExternalDescriptionStr,
    detail.ExternalQualificationsStr,
    detail.ExternalResponsibilitiesStr,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n\n'));
}

function buildLocation(detail: OracleRequisitionDetail): string | undefined {
  const locations = [...(detail.workLocation ?? []), ...(detail.otherWorkLocations ?? [])];

  for (const location of locations) {
    const built = [location.TownOrCity?.trim(), location.Region2?.trim(), location.Country && location.Country !== 'US' ? location.Country.trim() : undefined]
      .filter((part): part is string => Boolean(part))
      .join(', ');
    if (built) return built;

    const name = location.LocationName?.trim();
    if (name) return name;
  }

  return detail.PrimaryLocation?.trim() || undefined;
}

function isRemote(detail: OracleRequisitionDetail, fallbackLocation?: string): boolean {
  const workplaceType = detail.WorkplaceType?.trim().toLowerCase() ?? '';
  if (workplaceType.includes('remote')) return true;
  return (fallbackLocation ?? '').toLowerCase().includes('remote');
}

async function fetchSearchPage(company: OracleCompany, offset: number): Promise<OracleRequisitionSummary[]> {
  const res = await fetchWithTimeout(
    buildListUrl(company, offset),
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    },
    REQUEST_TIMEOUT_MS,
  );
  if (!res?.ok) return [];

  const data = await res.json() as OracleSearchResult;
  return data.items?.[0]?.requisitionList ?? [];
}

function toListing(company: OracleCompany, job: OracleRequisitionSummary): OracleListing | null {
  const sourceId = job.Id?.trim();
  const title = job.Title?.trim();
  const targetRoles = inferTargetRoles(title ?? '');

  if (!sourceId || !title || targetRoles.length === 0) return null;

  return {
    sourceId,
    title,
    company: company.company,
    url: buildPublicJobUrl(company, sourceId),
    location: job.PrimaryLocation?.trim() || undefined,
    remote: (job.WorkplaceType?.trim().toLowerCase() ?? '').includes('remote'),
    postedAt: job.PostedDate,
    targetRoles,
    companyConfig: company,
  };
}

function normalizeOracleDetail(listing: OracleListing, detail: OracleRequisitionDetail): NormalizedJob | null {
  const description = buildDescription(detail);
  const title = detail.Title?.trim() || listing.title;
  const location = buildLocation(detail) ?? listing.location;
  const roles = inferTargetRoles([title, description].join('\n'));

  if (roles.length === 0) return null;

  const normalized = normalizeJob({
    source: SOURCE,
    sourceId: listing.sourceId,
    title,
    company: listing.company,
    location,
    remote: listing.remote || isRemote(detail, location),
    url: listing.url,
    description,
    postedAt: detail.PostedDate ?? listing.postedAt,
    roles,
    experienceText: description,
  });

  if (!normalized || normalized.experience_level === 'internship' || normalized.roles.length === 0) {
    return null;
  }

  return normalized;
}

async function fetchCompany(company: OracleCompany): Promise<NormalizedJob[]> {
  const listingsById = new Map<string, OracleListing>();

  for (let page = 0; page < LIST_PAGE_COUNT; page += 1) {
    const jobs = await fetchSearchPage(company, page * LIST_PAGE_SIZE);
    if (jobs.length === 0) break;

    for (const job of jobs) {
      const listing = toListing(company, job);
      if (listing) listingsById.set(listing.sourceId, listing);
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
        buildDetailUrl(listing.companyConfig, listing.sourceId),
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0',
          },
        },
        REQUEST_TIMEOUT_MS,
      );
      if (!res?.ok) return null;

      const data = await res.json() as OracleDetailResult;
      const detail = data.items?.[0];
      if (!detail) return null;

      return normalizeOracleDetail(listing, detail);
    },
  );

  const jobs = normalized.filter((job): job is NormalizedJob => job !== null);
  if (jobs.length > 0) {
    console.log(`  [${SOURCE}] ${company.company}: ${jobs.length} jobs`);
  }

  return jobs;
}

export async function scrapeOracleCloud(): Promise<NormalizedJob[]> {
  const results = await mapInBatches(
    ORACLE_COMPANIES,
    COMPANY_BATCH_SIZE,
    COMPANY_BATCH_DELAY_MS,
    fetchCompany,
  );

  const deduped = new Map<string, NormalizedJob>();
  for (const jobs of results) {
    for (const job of jobs) {
      deduped.set(job.url, job);
    }
  }

  const all = [...deduped.values()];
  console.log(`  [${SOURCE}] Final count: ${all.length}`);
  return all;
}

async function runStandalone(): Promise<void> {
  const startedAt = Date.now();
  const jobs = await scrapeOracleCloud();
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

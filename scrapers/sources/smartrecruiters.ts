import { setTimeout as delay } from 'node:timers/promises';

import { generateHash } from '../utils/dedup';
import { isNonUsLocation } from '../utils/location';
import {
  hasTechTitleSignal,
  inferExperienceLevel,
  inferRemote,
  inferRoles,
  NormalizedJob,
} from '../utils/normalize';

const SOURCE = 'smartrecruiters';
const REQUEST_TIMEOUT_MS = 8_000;
const COMPANY_BATCH_SIZE = 15;
const COMPANY_BATCH_DELAY_MS = 300;
const DETAIL_BATCH_SIZE = 5;

const SMARTRECRUITERS_COMPANIES = [
  'Visa', 'McDonald', 'Bosch', 'Siemens', 'Adidas',
  'Lidl', 'Aldi', 'Carrefour', 'Zalando',
  'Spotify', 'Klarna', 'Revolut', 'N26', 'Monzo',
  'Transferwise', 'Wise', 'Starling', 'Atom',
  'Deliveroo', 'Glovo', 'Getir', 'Gorillas',
  'Bolt', 'Cabify', 'FREE_NOW', 'MyTaxi',
  'HelloFresh', 'Flixbus', 'Omio', 'GoEuro',
  'Zalando', 'AboutYou', 'Westwing', 'Home24',
  'Personio', 'Kenjo', 'Factorial', 'HiBob',
  'Workato', 'Celonis', 'UiPath', 'Automation',
  'SAP', 'Software', 'TeamViewer', 'IFS',
  'Criteo', 'Adjust', 'AppsFlyer', 'Branch',
  'Unity', 'Playtika', 'Verizon', 'Comcast',
  'T-Mobile', 'Sprt', 'AT&T', 'Charter',
  'Square', 'Block', 'CashApp', 'Afterpay',
  'Affirm', 'Klarna', 'Sezzle', 'Splitit',
  'DoorDash', 'Instacart', 'Gopuff', 'Rappi',
  'Lyft', 'Waymo', 'Cruise', 'Argo',
  'Rivian', 'Lucid', 'Canoo', 'Arrival',
  'Relativity', 'Everlaw', 'Disco', 'Logikcull',
  'Veeva', 'Medidata', 'Flatiron', 'Tempus',
  'Ro', 'Hims', 'Noom', 'Calibrate',
  'Oscar', 'Clover', 'Alignment', 'Devoted',
] as const;

const US_COUNTRY_VALUES = new Set([
  'us',
  'usa',
  'united states',
  'united states of america',
]);

type SmartRecruitersLocation = {
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
  hybrid?: boolean;
  fullLocation?: string;
};

type SmartRecruitersCompany = {
  name?: string;
  identifier?: string;
};

type SmartRecruitersDepartment = {
  label?: string;
};

type SmartRecruitersPostingSummary = {
  id?: string;
  uuid?: string;
  name?: string;
  releasedDate?: string;
  ref?: string;
  company?: SmartRecruitersCompany;
  department?: SmartRecruitersDepartment;
  location?: SmartRecruitersLocation;
};

type SmartRecruitersCompanyResponse = {
  content?: SmartRecruitersPostingSummary[];
};

type SmartRecruitersJobSection = {
  text?: string;
};

type SmartRecruitersPostingDetail = SmartRecruitersPostingSummary & {
  applyUrl?: string;
  postingUrl?: string;
  jobAd?: {
    sections?: Record<string, SmartRecruitersJobSection>;
  };
};

type SmartRecruitersCompanyFetch = {
  companyName: string;
  companyPath: string;
  postings: SmartRecruitersPostingSummary[];
};

type FetchJsonResult<T> = {
  status: number;
  data: T | null;
};

const stripHtml = (value: string): string =>
  value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function isLikelyTechTitle(title: string): boolean {
  return hasTechTitleSignal(title) || inferRoles(title).length > 0;
}

function normalizeCountry(country?: string): string | undefined {
  if (!country) return undefined;

  const trimmed = country.trim();
  const lower = trimmed.toLowerCase();
  if (US_COUNTRY_VALUES.has(lower)) return 'United States';
  return trimmed;
}

function isUsCountry(country?: string): boolean {
  if (!country) return false;
  return US_COUNTRY_VALUES.has(country.trim().toLowerCase());
}

function buildLocation(location?: SmartRecruitersLocation): string | undefined {
  if (!location) return undefined;
  if (location.fullLocation?.trim()) return location.fullLocation.trim();

  const values = new Set<string>();
  if (location.city?.trim()) values.add(location.city.trim());
  if (location.region?.trim()) values.add(location.region.trim());

  const country = normalizeCountry(location.country);
  if (country) values.add(country);

  return Array.from(values).join(', ') || undefined;
}

function isRemoteLocation(location?: SmartRecruitersLocation): boolean {
  if (!location) return false;
  if (location.remote === true) return true;
  return inferRemote(location.fullLocation);
}

function isUsOrRemoteLocation(location?: SmartRecruitersLocation): boolean {
  if (!location) return false;
  if (isRemoteLocation(location)) return true;
  if (isUsCountry(location.country)) return true;

  const fullLocation = buildLocation(location);
  return fullLocation ? !isNonUsLocation(fullLocation) : false;
}

function extractDescription(detail: SmartRecruitersPostingDetail): string | undefined {
  const sections = detail.jobAd?.sections;
  if (!sections) return undefined;

  const text = Object.values(sections)
    .map(section => section.text?.trim())
    .filter((section): section is string => Boolean(section))
    .map(stripHtml)
    .join(' ')
    .trim();

  return text || undefined;
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildPublicUrl(
  detail: SmartRecruitersPostingDetail,
  companyIdentifier: string,
  title: string,
  postingId: string,
): string {
  const applyUrl = detail.applyUrl?.trim();
  if (applyUrl) return applyUrl;

  const postingUrl = detail.postingUrl?.trim();
  if (postingUrl) return postingUrl;

  const ref = detail.ref?.trim();
  if (ref && !ref.includes('api.smartrecruiters.com')) return ref;

  const titleSlug = slugifyTitle(title);
  const companyPath = encodeURIComponent(companyIdentifier);
  return titleSlug
    ? `https://jobs.smartrecruiters.com/${companyPath}/${postingId}-${titleSlug}`
    : `https://jobs.smartrecruiters.com/${companyPath}/${postingId}`;
}

async function fetchJson<T>(url: string): Promise<FetchJsonResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { status: response.status, data: null };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return { status: response.status, data: null };
    }

    const data = (await response.json()) as T;
    return { status: response.status, data };
  } catch {
    return { status: 0, data: null };
  } finally {
    clearTimeout(timeout);
  }
}

function getCompanyPathVariants(companyName: string): string[] {
  return Array.from(new Set([companyName, encodeURIComponent(companyName)]));
}

async function fetchCompanyPostings(companyName: string): Promise<SmartRecruitersCompanyFetch | null> {
  for (const companyPath of getCompanyPathVariants(companyName)) {
    const { status, data } = await fetchJson<SmartRecruitersCompanyResponse>(
      `https://api.smartrecruiters.com/v1/companies/${companyPath}/postings?limit=100`,
    );

    if (status === 404) {
      continue;
    }

    if (data && Array.isArray(data.content)) {
      return {
        companyName,
        companyPath,
        postings: data.content,
      };
    }
  }

  return null;
}

async function fetchPostingDetail(
  companyPath: string,
  postingId: string,
): Promise<SmartRecruitersPostingDetail | null> {
  const { data } = await fetchJson<SmartRecruitersPostingDetail>(
    `https://api.smartrecruiters.com/v1/companies/${companyPath}/postings/${postingId}`,
  );

  return data;
}

async function normalizePosting(
  companyFetch: SmartRecruitersCompanyFetch,
  posting: SmartRecruitersPostingSummary,
): Promise<NormalizedJob | null> {
  const postingId = posting.id?.trim();
  const title = posting.name?.trim();
  if (!postingId || !title || !isLikelyTechTitle(title)) {
    return null;
  }

  if (!isUsOrRemoteLocation(posting.location)) {
    return null;
  }

  if (inferExperienceLevel(title) === null) {
    return null;
  }

  const detail = await fetchPostingDetail(companyFetch.companyPath, postingId);
  if (!detail) {
    return null;
  }

  const description = extractDescription(detail);
  const experienceLevel = inferExperienceLevel(title, description);
  if (experienceLevel === null) {
    return null;
  }

  const company =
    detail.company?.name?.trim() ||
    posting.company?.name?.trim() ||
    companyFetch.companyName;
  if (!company) {
    return null;
  }

  const companyIdentifier =
    detail.company?.identifier?.trim() ||
    posting.company?.identifier?.trim() ||
    companyFetch.companyName;

  const location = buildLocation(detail.location ?? posting.location);
  const remote =
    isRemoteLocation(detail.location ?? posting.location) ||
    inferRemote(location);

  return {
    source: SOURCE,
    source_id: postingId,
    title,
    company,
    location,
    remote,
    url: buildPublicUrl(detail, companyIdentifier, title, postingId),
    description,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at: detail.releasedDate ?? posting.releasedDate,
    dedup_hash: generateHash(company, title, location ?? ''),
  };
}

async function fetchCompanyJobs(companyFetch: SmartRecruitersCompanyFetch): Promise<NormalizedJob[]> {
  const normalized: NormalizedJob[] = [];
  const candidates = companyFetch.postings.filter(posting => {
    const title = posting.name?.trim();
    if (!title) return false;
    if (!isLikelyTechTitle(title)) return false;
    if (!isUsOrRemoteLocation(posting.location)) return false;
    return inferExperienceLevel(title) !== null;
  });

  for (let index = 0; index < candidates.length; index += DETAIL_BATCH_SIZE) {
    const batch = candidates.slice(index, index + DETAIL_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(posting => normalizePosting(companyFetch, posting)),
    );

    for (const result of results) {
      if (result.status !== 'fulfilled' || result.value === null) continue;
      normalized.push(result.value);
    }
  }

  return normalized;
}

export async function scrapeSmartRecruiters(): Promise<NormalizedJob[]> {
  const companies = Array.from(new Set(SMARTRECRUITERS_COMPANIES));
  const jobMap = new Map<string, NormalizedJob>();
  let companiesWithPostings = 0;

  for (let index = 0; index < companies.length; index += COMPANY_BATCH_SIZE) {
    const batch = companies.slice(index, index + COMPANY_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(fetchCompanyPostings));
    const liveCompanies: SmartRecruitersCompanyFetch[] = [];

    for (const result of results) {
      if (result.status !== 'fulfilled' || result.value === null) continue;
      liveCompanies.push(result.value);
    }

    for (const companyFetch of liveCompanies) {
      if (companyFetch.postings.length > 0) {
        companiesWithPostings += 1;
      }
    }

    const jobResults = await Promise.allSettled(
      liveCompanies.map(fetchCompanyJobs),
    );

    for (const result of jobResults) {
      if (result.status !== 'fulfilled') continue;

      for (const job of result.value) {
        jobMap.set(job.source_id || job.dedup_hash, job);
      }
    }

    if (index + COMPANY_BATCH_SIZE < companies.length) {
      await delay(COMPANY_BATCH_DELAY_MS);
    }
  }

  console.log(`  [smartrecruiters] Companies with postings: ${companiesWithPostings}`);
  console.log(`  [smartrecruiters] Total unique jobs: ${jobMap.size}`);

  return Array.from(jobMap.values());
}

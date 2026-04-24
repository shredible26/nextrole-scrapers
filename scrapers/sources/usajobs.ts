// Source: https://data.usajobs.gov/api/search
// Official US government jobs API — free, no key required for basic search.
// Returns federal tech jobs with GS grade info for seniority filtering.

import { generateHash } from '../utils/dedup';
import {
  finalizeNormalizedJob,
  inferRoles,
  inferRemote,
  inferExperienceLevel,
  ExperienceLevel,
  NormalizedJob,
} from '../utils/normalize';

const BASE_URL = 'https://data.usajobs.gov/api/search';

const SEARCH_TERMS = [
  'software engineer',
  'data scientist',
  'machine learning',
  'data analyst',
  'software developer',
  'information technology',
  'computer scientist',
];

const HEADERS_WITH_KEY = {
  'Host': 'data.usajobs.gov',
  'User-Agent': process.env.USAJOBS_EMAIL ?? '',
  'Authorization-Key': process.env.USAJOBS_API_KEY ?? '',
};

const HEADERS_WITHOUT_KEY = {
  'Host': 'data.usajobs.gov',
  'User-Agent': 'nextrole@example.com',
};

const MAX_PAGES = 3;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

interface USAJobsDescriptor {
  PositionTitle?: string;
  OrganizationName?: string;
  PositionLocationDisplay?: string;
  PositionRemuneration?: Array<{
    MinimumRange?: string;
    MaximumRange?: string;
    RateIntervalCode?: string;
  }>;
  ApplyURI?: string[];
  PublicationStartDate?: string;
  QualificationSummary?: string;
  UserArea?: {
    Details?: {
      LowGrade?: string;
      HighGrade?: string;
      TotalOpenings?: string;
    };
  };
}

interface USAJobsItem {
  MatchedObjectId?: string;
  MatchedObjectDescriptor?: USAJobsDescriptor;
}

/**
 * Determine experience level from GS grade when title inference is ambiguous.
 * Returns null if grade indicates too-senior (grade 12+).
 * GS-9/10/11 are included: GS-9 is standard for new MS grads, GS-10/11 cover rotational programs.
 */
function levelFromGsGrade(lowGrade: number): ExperienceLevel | null {
  if (lowGrade <= 7) return 'entry_level';
  if (lowGrade <= 9) return 'new_grad';
  if (lowGrade <= 11) return 'entry_level'; // rotational / associate programs
  return null; // grade 12+ → genuinely mid-level
}

async function fetchPage(
  searchTerm: string,
  page: number,
  useKey: boolean,
): Promise<{ items: USAJobsItem[]; total: number } | null> {
  const url = new URL(BASE_URL);
  url.searchParams.set('Keyword', searchTerm);
  url.searchParams.set('ResultsPerPage', '50');
  url.searchParams.set('Page', String(page));
  url.searchParams.set('WhoMayApply', 'public');
  url.searchParams.set('PositionOfferingTypeCode', '15317');

  const headers = useKey ? HEADERS_WITH_KEY : HEADERS_WITHOUT_KEY;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(url.toString(), { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) return null; // signal to retry without key
    if (!res.ok) return { items: [], total: 0 };

    const data = await res.json();
    const searchResult = data?.SearchResult;
    return {
      items: searchResult?.SearchResultItems ?? [],
      total: searchResult?.SearchResultCountAll ?? 0,
    };
  } catch {
    return { items: [], total: 0 };
  }
}

async function fetchSearchTerm(searchTerm: string): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];
  let useKey = true;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await fetchPage(searchTerm, page, useKey);

    if (result === null) {
      // 401 — retry without Authorization-Key
      useKey = false;
      const retryResult = await fetchPage(searchTerm, page, false);
      if (!retryResult || retryResult.items.length === 0) break;

      processItems(retryResult.items, jobs);
      if (retryResult.items.length < 10) break;
    } else {
      if (result.items.length === 0) break;
      processItems(result.items, jobs);
      if (result.items.length < 10) break;
    }

    if (page < MAX_PAGES) await delay(300);
  }

  return jobs;
}

function processItems(items: USAJobsItem[], out: NormalizedJob[]): void {
  for (const item of items) {
    const descriptor = item.MatchedObjectDescriptor;
    if (!descriptor) continue;

    const title = descriptor.PositionTitle ?? '';
    const company = descriptor.OrganizationName ?? 'US Government';
    const location = descriptor.PositionLocationDisplay ?? '';
    const description = descriptor.QualificationSummary ?? '';
    const applyUrl = descriptor.ApplyURI?.[0] ?? '';
    const pubDate = descriptor.PublicationStartDate;
    const details = descriptor.UserArea?.Details;
    const remuneration = descriptor.PositionRemuneration;

    if (!title || !applyUrl) continue;

    // Infer level from title+description first
    let level: ExperienceLevel | null = inferExperienceLevel(title, description);

    // Skip if title inference says null (senior role)
    if (level === null) continue;

    // Additionally enforce GS grade ceiling — skip grade 12+ jobs
    const lowGradeRaw = parseInt(details?.LowGrade ?? '0', 10);
    if (lowGradeRaw >= 12) continue;

    // If grade is present and title gave a generic entry_level result,
    // use the grade-based level for more precision
    if (lowGradeRaw > 0) {
      const gradeLevel = levelFromGsGrade(lowGradeRaw);
      if (gradeLevel === null) continue; // shouldn't happen after the >= 9 check above
      level = gradeLevel;
    }

    const remote =
      location.toLowerCase().includes('remote') ||
      location.toLowerCase().includes('anywhere') ||
      inferRemote(location);

    let salaryMin: number | undefined;
    let salaryMax: number | undefined;
    const rem = remuneration?.[0];
    if (rem?.RateIntervalCode === 'PA') {
      const min = parseFloat(rem.MinimumRange ?? '');
      const max = parseFloat(rem.MaximumRange ?? '');
      if (!isNaN(min)) salaryMin = Math.round(min);
      if (!isNaN(max)) salaryMax = Math.round(max);
    }

    out.push(finalizeNormalizedJob({
      source: 'usajobs',
      source_id: item.MatchedObjectId,
      title,
      company,
      location: location || undefined,
      remote,
      url: applyUrl,
      description: description || undefined,
      salary_min: salaryMin,
      salary_max: salaryMax,
      experience_level: level,
      roles: inferRoles(title),
      posted_at: pubDate ? new Date(pubDate).toISOString() : undefined,
      dedup_hash: generateHash(company, title, location),
    }));
  }
}

export async function scrapeUSAJobs(): Promise<NormalizedJob[]> {
  // Run all search terms concurrently
  let results: PromiseSettledResult<NormalizedJob[]>[];
  try {
    results = await Promise.allSettled(
      SEARCH_TERMS.map(term => fetchSearchTerm(term))
    );
  } catch {
    console.warn('  [usajobs] API completely unreachable — skipping');
    return [];
  }

  // Deduplicate by source_id across all search terms
  const seen = new Set<string>();
  const all: NormalizedJob[] = [];

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const job of result.value) {
      const key = job.source_id ?? job.dedup_hash;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(job);
    }
  }

  console.log(`  [usajobs] ${all.length} unique jobs across ${SEARCH_TERMS.length} search terms`);
  return all;
}

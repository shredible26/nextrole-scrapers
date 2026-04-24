import { generateHash } from './dedup';
import { isNonUsLocation } from './location';
import {
  finalizeNormalizedJob,
  inferExperienceLevel,
  inferRemote,
  inferRoles,
  NormalizedJob,
} from './normalize';

const REQUEST_TIMEOUT_MS = 15_000;

export type CuratedRepoRow = {
  company: string;
  title: string;
  location: string;
  url?: string;
  posted?: string;
  remoteHint?: string;
};

type CuratedGitHubJobsConfig = {
  source: string;
  repo: string;
  branches?: string[];
  markdownPath?: string;
  markdownPaths?: string[];
  allowJson?: boolean;
  parseMarkdown: (markdown: string) => CuratedRepoRow[];
};

type JsonListing = Record<string, unknown>;

type ResolvedFetch = {
  response: Response;
  url: string;
};

function buildRawUrl(repo: string, branch: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
}

async function fetchFirstAvailable(
  repo: string,
  path: string,
  branches: string[],
): Promise<ResolvedFetch | null> {
  for (const branch of branches) {
    const url = buildRawUrl(repo, branch, path);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      return { response, url };
    }

    if (response.status !== 404) {
      throw new Error(`fetch failed for ${url}: ${response.status}`);
    }
  }

  return null;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function parsePostedAt(raw?: string): string | undefined {
  if (!raw) return undefined;

  const value = raw.trim();
  if (!value) return undefined;

  const lower = value.toLowerCase();
  const now = Date.now();

  if (lower === 'today' || lower === 'just now') {
    return new Date(now).toISOString();
  }

  if (lower === 'yesterday') {
    return new Date(now - 86_400_000).toISOString();
  }

  const relativeMatch = lower.match(
    /^(\d+)\s*(h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)$/,
  );
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2];
    let deltaMs = 0;

    if (unit.startsWith('h')) deltaMs = amount * 3_600_000;
    else if (unit.startsWith('d')) deltaMs = amount * 86_400_000;
    else deltaMs = amount * 7 * 86_400_000;

    return new Date(now - deltaMs).toISOString();
  }

  const monthDayMatch = value.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
  if (monthDayMatch) {
    const year = new Date().getFullYear();
    const parsed = new Date(`${monthDayMatch[1]} ${monthDayMatch[2]}, ${year}`);
    if (!Number.isNaN(parsed.getTime())) {
      if (parsed.getTime() > now + 86_400_000) {
        parsed.setFullYear(year - 1);
      }
      return parsed.toISOString();
    }
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function locationFromJson(job: JsonListing): string {
  const locations = job.locations;
  if (Array.isArray(locations)) {
    const firstLocation = locations.find(
      (location): location is string =>
        typeof location === 'string' && location.trim().length > 0,
    );
    if (firstLocation) return firstLocation.trim();
  }

  if (typeof job.location === 'string' && job.location.trim()) {
    return job.location.trim();
  }

  const city = typeof job.job_city === 'string' ? job.job_city.trim() : '';
  const state = typeof job.job_state === 'string' ? job.job_state.trim() : '';
  const country =
    typeof job.job_country === 'string' ? job.job_country.trim() : '';

  return [city, state, country].filter(Boolean).join(', ');
}

function postedAtFromJson(job: JsonListing): string | undefined {
  const datePosted = job.date_posted;
  if (typeof datePosted === 'number') {
    const timestamp = datePosted > 1_000_000_000_000 ? datePosted : datePosted * 1000;
    return new Date(timestamp).toISOString();
  }

  if (typeof datePosted === 'string' && datePosted.trim()) {
    const parsed = new Date(datePosted);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  if (
    typeof job.job_posted_at_datetime_utc === 'string' &&
    job.job_posted_at_datetime_utc.trim()
  ) {
    const parsed = new Date(job.job_posted_at_datetime_utc);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}

function normalizeRow(source: string, row: CuratedRepoRow): NormalizedJob | null {
  const company = row.company.trim();
  const title = row.title.trim();
  const location = row.location.trim();
  const url = row.url?.trim() ?? '';

  if (!company || !title || !url) return null;
  if (location && isNonUsLocation(location)) return null;

  const experienceLevel = inferExperienceLevel(title, '') ?? 'new_grad';
  const remoteText = row.remoteHint ? `${location} ${row.remoteHint}` : location;

  return finalizeNormalizedJob({
    source,
    source_id: url,
    title,
    company,
    location,
    remote: inferRemote(remoteText),
    url,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at: parsePostedAt(row.posted),
    dedup_hash: generateHash(company, title, location),
  });
}

function normalizeJsonListing(
  source: string,
  listing: JsonListing,
): NormalizedJob | null {
  const company =
    typeof listing.company_name === 'string'
      ? listing.company_name.trim()
      : typeof listing.company === 'string'
      ? listing.company.trim()
      : typeof listing.employer_name === 'string'
      ? listing.employer_name.trim()
      : '';
  const title =
    typeof listing.title === 'string'
      ? listing.title.trim()
      : typeof listing.job_title === 'string'
      ? listing.job_title.trim()
      : '';
  const location = locationFromJson(listing);
  const url =
    typeof listing.url === 'string'
      ? listing.url.trim()
      : typeof listing.job_apply_link === 'string'
      ? listing.job_apply_link.trim()
      : '';

  if (!company || !title || !url) return null;
  if (location && isNonUsLocation(location)) return null;

  const experienceLevel = inferExperienceLevel(title, '') ?? 'new_grad';
  const remoteHint =
    listing.job_is_remote === true ? 'Remote' : location;

  return finalizeNormalizedJob({
    source,
    source_id:
      typeof listing.id === 'string' || typeof listing.id === 'number'
        ? String(listing.id)
        : typeof listing.job_id === 'string'
        ? listing.job_id
        : url,
    title,
    company,
    location,
    remote: inferRemote(remoteHint),
    url,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at: postedAtFromJson(listing),
    dedup_hash: generateHash(company, title, location),
  });
}

function dedupeByUrl(jobs: NormalizedJob[]): NormalizedJob[] {
  const seenUrls = new Set<string>();
  const deduped: NormalizedJob[] = [];

  for (const job of jobs) {
    const key = normalizeUrl(job.url);
    if (!key || seenUrls.has(key)) continue;

    seenUrls.add(key);
    deduped.push(job);
  }

  return deduped;
}

async function fetchCuratedGitHubJson(
  source: string,
  repo: string,
  branches: string[],
): Promise<NormalizedJob[] | null> {
  const resolved = await fetchFirstAvailable(
    repo,
    '.github/scripts/listings.json',
    branches,
  );
  if (!resolved) return null;

  const payload = (await resolved.response.json()) as unknown;
  const listings = Array.isArray(payload)
    ? payload
    : payload &&
      typeof payload === 'object' &&
      Array.isArray((payload as { jobs?: unknown }).jobs)
    ? (payload as { jobs: unknown[] }).jobs
    : [];

  const jobs = dedupeByUrl(
    listings
      .filter(
        (listing): listing is JsonListing =>
          Boolean(listing) && typeof listing === 'object',
      )
      .filter(listing => listing.active !== false && listing.is_visible !== false)
      .map(listing => normalizeJsonListing(source, listing))
      .filter((job): job is NormalizedJob => job !== null),
  );

  console.log(`  [${source}] Loaded ${jobs.length} jobs from ${resolved.url}`);
  return jobs;
}

export function isMarkdownTableSeparator(line: string): boolean {
  return /^(\|\s*:?-{3,}:?\s*)+\|$/.test(line.trim());
}

export function splitMarkdownRow(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)
    .map(cell => cell.trim());
}

export function extractFirstUrl(value: string): string | undefined {
  const htmlMatch = value.match(/href="([^"]+)"/i);
  if (htmlMatch?.[1]) return htmlMatch[1];

  const markdownMatch = value.match(/\((https?:\/\/[^)\s]+)\)/);
  return markdownMatch?.[1];
}

export function extractCellText(value: string): string {
  return value
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<a\b[^>]*>(.*?)<\/a>/gi, '$1')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^↳\s*/, '')
    .replace(/^[^A-Za-z0-9]+/, '')
    .trim();
}

export async function fetchCuratedGitHubJobs(
  config: CuratedGitHubJobsConfig,
): Promise<NormalizedJob[]> {
  const branches = config.branches ?? ['main', 'master'];

  if (config.allowJson !== false) {
    try {
      const jsonJobs = await fetchCuratedGitHubJson(
        config.source,
        config.repo,
        branches,
      );
      if (jsonJobs) {
        return jsonJobs;
      }
    } catch (error) {
      console.warn(
        `  [${config.source}] listings.json unavailable, falling back to markdown:`,
        (error as Error).message,
      );
    }
  }

  const markdownPaths = config.markdownPaths ??
    (config.markdownPath ? [config.markdownPath] : []);

  for (const markdownPath of markdownPaths) {
    const resolved = await fetchFirstAvailable(
      config.repo,
      markdownPath,
      branches,
    );
    if (!resolved) continue;

    const markdown = await resolved.response.text();
    const jobs = dedupeByUrl(
      config
        .parseMarkdown(markdown)
        .map(row => normalizeRow(config.source, row))
        .filter((job): job is NormalizedJob => job !== null),
    );

    console.log(`  [${config.source}] Loaded ${jobs.length} jobs from ${resolved.url}`);
    return jobs;
  }

  return [];
}

import { generateHash } from '../utils/dedup';
import { isNonUsLocation } from '../utils/location';
import {
  ExperienceLevel,
  hasTechTitleSignal,
  inferExperienceLevel,
  inferRoles,
  NormalizedJob,
} from '../utils/normalize';

const SOURCE = 'hackernews';
const REQUEST_TIMEOUT_MS = 10_000;
const THREAD_COUNT = 2;
const THREAD_LOOKUP_BATCH_SIZE = 10;
const COMMENT_BATCH_SIZE = 20;
const MAX_COMMENTS_PER_THREAD = 500;
const SUBMITTED_URL =
  'https://hacker-news.firebaseio.com/v0/user/whoishiring/submitted.json';
const ITEM_URL = 'https://hacker-news.firebaseio.com/v0/item';
const FALLBACK_URL_PREFIX = 'https://news.ycombinator.com/item?id=';
const FALLBACK_THREAD_IDS = [47601859, 47219668] as const;
const EARLY_CAREER_DESCRIPTION_RE =
  /\b(?:new grad|entry level|entry-level|junior|0\s*(?:-|to)\s*2 years?)\b/i;
const EMPLOYMENT_TYPE_RE =
  /\b(?:full[-\s]?time|part[-\s]?time|contract|intern(?:ship)?|temporary)\b/i;
const WEBSITE_SEGMENT_RE =
  /^(?:https?:\/\/|www\.|[a-z0-9.-]+\.[a-z]{2,})(?:\/[^\s]*)?$/i;

type HackerNewsItem = {
  by?: string;
  dead?: boolean;
  deleted?: boolean;
  id?: number;
  kids?: number[];
  parent?: number;
  text?: string;
  time?: number;
  title?: string;
  type?: string;
};

type FetchJsonOptions = {
  logRawResponse?: boolean;
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/&apos;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<a\b[^>]*>(.*?)<\/a>/gi, '$1')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractUrls(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const decoded = decodeHtmlEntities(html);

  const addUrl = (value?: string) => {
    const url = value?.trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  for (const match of html.matchAll(/href="([^"]+)"/gi)) {
    addUrl(decodeHtmlEntities(match[1]));
  }

  for (const match of decoded.matchAll(/\bhttps?:\/\/[^\s<>"')]+/gi)) {
    addUrl(match[0]);
  }

  return urls;
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/^(?:[-*]\s*)+/, '').trim();
}

function trimCandidateNoise(value: string): string {
  return value
    .replace(/\s+(?:\||-)\s+https?:\/\/.*$/i, '')
    .replace(/\s+https?:\/\/.*$/i, '')
    .replace(/\s+[|:-]\s*$/g, '')
    .trim();
}

function sanitizeCandidate(value: string): string {
  return trimCandidateNoise(
    normalizeLine(value)
      .replace(/^we are hiring for:?/i, '')
      .replace(/^hiring for:?/i, '')
      .replace(/^open roles?:?/i, '')
      .replace(/^roles?:?/i, '')
      .replace(/^positions?:?/i, '')
      .trim(),
  );
}

function cleanCompanyName(value: string): string {
  return sanitizeCandidate(value).replace(
    /\s+\((?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^)]*)?\)$/i,
    '',
  );
}

function isWebsiteSegment(value: string): boolean {
  return WEBSITE_SEGMENT_RE.test(value.trim());
}

function isEmploymentTypeSegment(value: string): boolean {
  return EMPLOYMENT_TYPE_RE.test(value.trim()) && !hasTechTitleSignal(value);
}

function extractCandidateFromLine(line: string): string | null {
  const normalized = sanitizeCandidate(line);
  if (!normalized) return null;
  if (
    /^(?:we(?:'re| are)|you(?:'ll| will)|join us|our mission|about\b|please\b|more info\b|see more\b|would love\b|reach out\b|apply here\b|apply now\b|come be\b|why\b)/i.test(
      normalized,
    )
  ) {
    return null;
  }

  const beforeColon = sanitizeCandidate(normalized.split(':')[0] ?? '');
  if (
    beforeColon &&
    beforeColon !== normalized &&
    hasTechTitleSignal(beforeColon) &&
    beforeColon.split(/\s+/).length <= 12
  ) {
    return beforeColon;
  }

  if (
    hasTechTitleSignal(normalized) &&
    normalized.split(/\s+/).length <= 12 &&
    !isWebsiteSegment(normalized) &&
    !isEmploymentTypeSegment(normalized)
  ) {
    return normalized;
  }

  return null;
}

function collectTitleCandidates(lines: string[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (value?: string | null) => {
    const candidate = sanitizeCandidate(value ?? '');
    if (!candidate) return;
    if (!hasTechTitleSignal(candidate)) return;
    if (isWebsiteSegment(candidate) || isEmploymentTypeSegment(candidate)) return;

    const key = candidate.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const headerSegments = (lines[0] ?? '')
    .split('|')
    .map(segment => sanitizeCandidate(segment))
    .filter(Boolean);

  for (const segment of headerSegments.slice(1)) {
    pushCandidate(segment);
  }

  for (const line of lines.slice(1)) {
    pushCandidate(extractCandidateFromLine(line));
  }

  return candidates;
}

function extractLocation(headerSegments: string[], title: string, remote: boolean): string | undefined {
  const candidates = headerSegments
    .slice(1)
    .map(segment => sanitizeCandidate(segment))
    .filter(Boolean)
    .filter(segment => !isWebsiteSegment(segment))
    .filter(segment => !isEmploymentTypeSegment(segment))
    .filter(segment => segment.toLowerCase() !== title.toLowerCase())
    .filter(segment => !hasTechTitleSignal(segment));

  const remoteCandidate = candidates.find(segment => /\bremote\b/i.test(segment));
  if (remoteCandidate) return remoteCandidate;

  if (candidates.length > 0) return candidates[0];
  if (remote) return 'Remote';
  return undefined;
}

function resolveExperienceLevel(
  title: string,
  description: string,
): ExperienceLevel | null {
  const inferred = inferExperienceLevel(title, description);
  if (inferred !== null) return inferred;

  return EARLY_CAREER_DESCRIPTION_RE.test(description) ? 'entry_level' : null;
}

function normalizeComment(comment: HackerNewsItem): NormalizedJob | null {
  if (!comment.id || !comment.text || comment.dead || comment.deleted) return null;

  const description = htmlToText(comment.text).slice(0, 3_000);
  if (!description) return null;

  const lines = description
    .split('\n')
    .map(line => normalizeLine(line))
    .filter(Boolean);
  if (lines.length === 0) return null;

  const headerSegments = lines[0]
    .split('|')
    .map(segment => sanitizeCandidate(segment))
    .filter(Boolean);
  const company = cleanCompanyName(headerSegments[0] ?? lines[0]);
  if (!company) return null;

  const remote = /\bremote\b/i.test(description);
  const titleCandidates = collectTitleCandidates(lines);

  let title: string | null = null;
  let experienceLevel: ExperienceLevel | null = null;

  for (const candidate of titleCandidates) {
    const resolvedLevel = resolveExperienceLevel(candidate, description);
    if (resolvedLevel === null) continue;

    title = candidate;
    experienceLevel = resolvedLevel;
    break;
  }

  if (!title || !experienceLevel) return null;

  const location = extractLocation(headerSegments, title, remote);
  if (location && isNonUsLocation(location) && !remote) return null;

  const url = extractUrls(comment.text)[0] ?? `${FALLBACK_URL_PREFIX}${comment.id}`;

  return {
    source: SOURCE,
    source_id: String(comment.id),
    title,
    company,
    location: location ?? (remote ? 'Remote' : undefined),
    remote,
    url,
    description,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at: comment.time
      ? new Date(comment.time * 1000).toISOString()
      : undefined,
    dedup_hash: generateHash(company, title, location ?? (remote ? 'Remote' : '')),
  };
}

async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });
    const raw = await response.text();

    if (options.logRawResponse) {
      console.log(`  [${SOURCE}] Firebase raw response for ${url}: ${raw}`);
    }

    if (!response.ok) {
      throw new Error(
        `Firebase request failed for ${url}: ${response.status} ${response.statusText}`,
      );
    }

    if (!raw.trim()) {
      return null;
    }

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new Error(
        `Invalid JSON returned for ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchItem(
  id: number,
  options: FetchJsonOptions = {},
): Promise<HackerNewsItem | null> {
  try {
    return await fetchJson<HackerNewsItem>(`${ITEM_URL}/${id}.json`, options);
  } catch (error) {
    console.warn(
      `  [${SOURCE}] Failed to fetch item ${id}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function fetchFallbackThreads(reason: string): Promise<HackerNewsItem[]> {
  console.warn(
    `  [${SOURCE}] Falling back to hardcoded thread IDs ${FALLBACK_THREAD_IDS.join(', ')}: ${reason}`,
  );

  const fallbackThreads = await Promise.all(
    FALLBACK_THREAD_IDS.map(id => fetchItem(id, { logRawResponse: true })),
  );
  const resolvedThreads = fallbackThreads.filter(
    (thread): thread is HackerNewsItem => Boolean(thread?.id && Array.isArray(thread.kids)),
  );

  if (resolvedThreads.length < THREAD_COUNT) {
    throw new Error(
      `Unable to resolve fallback hiring threads; found ${resolvedThreads.length}`,
    );
  }

  return resolvedThreads;
}

async function fetchLatestHiringThreads(): Promise<HackerNewsItem[]> {
  let submitted: number[] | null = null;

  try {
    submitted = await fetchJson<number[]>(SUBMITTED_URL, { logRawResponse: true });
  } catch (error) {
    return fetchFallbackThreads(
      error instanceof Error ? error.message : 'unknown whoishiring fetch error',
    );
  }

  if (!Array.isArray(submitted) || submitted.length === 0) {
    return fetchFallbackThreads(
      `unexpected whoishiring payload: ${JSON.stringify(submitted)}`,
    );
  }

  const threads: HackerNewsItem[] = [];

  for (
    let index = 0;
    index < submitted.length && threads.length < THREAD_COUNT;
    index += THREAD_LOOKUP_BATCH_SIZE
  ) {
    const batchIds = submitted.slice(index, index + THREAD_LOOKUP_BATCH_SIZE);
    const batchItems = await Promise.all(
      batchIds.map(id => fetchItem(id, { logRawResponse: true })),
    );

    for (const item of batchItems) {
      if (!item?.id || item.type !== 'story') continue;
      if (!/who is hiring\?/i.test(item.title ?? '')) continue;

      threads.push(item);
      if (threads.length === THREAD_COUNT) break;
    }
  }

  if (threads.length < THREAD_COUNT) {
    return fetchFallbackThreads(`expected ${THREAD_COUNT} hiring threads, found ${threads.length}`);
  }

  return threads;
}

async function fetchThreadJobs(thread: HackerNewsItem): Promise<NormalizedJob[]> {
  const commentIds = Array.isArray(thread.kids)
    ? thread.kids.slice(0, MAX_COMMENTS_PER_THREAD)
    : [];
  const jobs: NormalizedJob[] = [];

  for (let index = 0; index < commentIds.length; index += COMMENT_BATCH_SIZE) {
    const batchIds = commentIds.slice(index, index + COMMENT_BATCH_SIZE);
    const batchComments = await Promise.all(batchIds.map(id => fetchItem(id)));

    for (const comment of batchComments) {
      const job = comment ? normalizeComment(comment) : null;
      if (job) jobs.push(job);
    }
  }

  console.log(
    `  [${SOURCE}] Parsed ${jobs.length} jobs from thread ${thread.id} (${thread.title ?? 'unknown'})`,
  );

  return jobs;
}

export async function scrapeHackerNews(): Promise<NormalizedJob[]> {
  const threads = await fetchLatestHiringThreads();
  console.log(
    `  [${SOURCE}] Using threads ${threads
      .map(thread => `${thread.id} (${thread.title ?? 'unknown'})`)
      .join(', ')}`,
  );

  const jobsByHash = new Map<string, NormalizedJob>();

  for (const thread of threads) {
    const jobs = await fetchThreadJobs(thread);
    for (const job of jobs) {
      jobsByHash.set(job.dedup_hash, job);
    }
  }

  return [...jobsByHash.values()];
}

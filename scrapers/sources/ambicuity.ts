import { generateHash } from '../utils/dedup';
import { isNonUsLocation } from '../utils/location';
import {
  inferExperienceLevel,
  inferRemote,
  inferRoles,
  NormalizedJob,
} from '../utils/normalize';

type AmbicuityJsonJob = {
  company?: string;
  title?: string;
  location?: string;
  url?: string;
  posted_at?: string;
  posted_display?: string;
  is_closed?: boolean;
};

type AmbicuityJsonResponse = {
  jobs?: AmbicuityJsonJob[];
};

function cleanCompanyName(company: string): string {
  return company.replace(/^[^A-Za-z0-9]+/, '').replace(/\s+/g, ' ').trim();
}

function parseRelativePostedDate(raw?: string): string | undefined {
  if (!raw) return undefined;

  const value = raw.trim();
  const lower = value.toLowerCase();
  const now = Date.now();

  if (lower === 'today' || lower === 'just now') {
    return new Date(now).toISOString();
  }

  const daysAgo = lower.match(/(\d+)\s*d(?:ays?)?\s+ago/);
  if (daysAgo) {
    return new Date(now - Number(daysAgo[1]) * 86_400_000).toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function normalizeAmbicuityJob(job: AmbicuityJsonJob): NormalizedJob | null {
  const company = cleanCompanyName(job.company ?? '');
  const title = (job.title ?? '').trim();
  const location = (job.location ?? '').trim();
  const url = (job.url ?? '').trim();

  if (!company || !title || !url) return null;
  if (job.is_closed) return null;
  if (location && isNonUsLocation(location)) return null;

  const experienceLevel = inferExperienceLevel(title, '') ?? 'new_grad';

  return {
    source: 'ambicuity',
    source_id: url,
    title,
    company,
    location,
    remote: inferRemote(location),
    url,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at: job.posted_at ?? parseRelativePostedDate(job.posted_display),
    dedup_hash: generateHash(company, title, location),
  };
}

function parseMarkdownTable(markdown: string): NormalizedJob[] {
  const jobs: NormalizedJob[] = [];
  const lines = markdown.split('\n');

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (
      line.includes('| Company |') ||
      /^(\|\s*-+\s*)+\|$/.test(line.trim())
    ) {
      continue;
    }

    const cells = line
      .split('|')
      .slice(1, -1)
      .map(cell => cell.trim());

    if (cells.length !== 5) continue;

    const [rawCompany, rawTitle, rawLocation, rawPosted, rawApply] = cells;
    const urlMatch = rawApply.match(/\((https?:\/\/[^)]+)\)/);
    const normalized = normalizeAmbicuityJob({
      company: rawCompany,
      title: rawTitle,
      location: rawLocation,
      url: urlMatch?.[1],
      posted_display: rawPosted,
      is_closed: rawCompany.includes('🔒') || rawTitle.includes('🔒'),
    });

    if (normalized) jobs.push(normalized);
  }

  return jobs;
}

async function fetchAmbicuityJson(): Promise<NormalizedJob[]> {
  const res = await fetch(
    'https://raw.githubusercontent.com/ambicuity/New-Grad-Jobs/main/jobs.json',
    { signal: AbortSignal.timeout(15_000) },
  );

  if (!res.ok) return [];

  const data = (await res.json()) as AmbicuityJsonResponse;
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];

  return jobs
    .map(normalizeAmbicuityJob)
    .filter((job): job is NormalizedJob => job !== null);
}

async function fetchAmbicuityMarkdown(): Promise<NormalizedJob[]> {
  const res = await fetch(
    'https://raw.githubusercontent.com/ambicuity/New-Grad-Jobs/main/README.md',
    { signal: AbortSignal.timeout(15_000) },
  );

  if (!res.ok) return [];

  return parseMarkdownTable(await res.text());
}

export async function scrapeAmbicuity(): Promise<NormalizedJob[]> {
  try {
    const fromJson = await fetchAmbicuityJson();
    if (fromJson.length > 0) {
      console.log(`  [ambicuity] Loaded ${fromJson.length} jobs from jobs.json`);
      return fromJson;
    }
  } catch {
    // Fall back to README parsing below.
  }

  const fromMarkdown = await fetchAmbicuityMarkdown();
  if (fromMarkdown.length > 0) {
    console.log(`  [ambicuity] Loaded ${fromMarkdown.length} jobs from README.md`);
  }

  return fromMarkdown;
}

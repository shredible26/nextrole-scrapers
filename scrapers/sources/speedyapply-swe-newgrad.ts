import { generateHash } from '../utils/dedup';
import {
  extractCellText,
  extractFirstUrl,
  isMarkdownTableSeparator,
  splitMarkdownRow,
  type CuratedRepoRow,
} from '../utils/github-curated';
import { isNonUsLocation } from '../utils/location';
import {
  inferExperienceLevel,
  inferRemote,
  inferRoles,
  NormalizedJob,
} from '../utils/normalize';

const SOURCE = 'speedyapply_swe_newgrad';
const REQUEST_TIMEOUT_MS = 15_000;
const CANDIDATE_URLS = [
  'https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main/NEW_GRAD_USA.md',
  'https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main/README.md',
  'https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main/NEW_GRAD.md',
] as const;

type MarkdownTableColumns = {
  companyIndex: number;
  titleIndex: number;
  locationIndex: number;
  applyIndex: number;
  postedIndex?: number;
};

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

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function getMarkdownPath(url: string): string {
  return url.split('/').pop() ?? url;
}

function findHeaderIndex(headers: string[], patterns: RegExp[]): number {
  return headers.findIndex(header => patterns.some(pattern => pattern.test(header)));
}

function resolveTableColumns(headers: string[]): MarkdownTableColumns | null {
  const companyIndex = findHeaderIndex(headers, [/^company$/i]);
  const titleIndex = findHeaderIndex(headers, [/^(?:position|title|role)$/i]);
  const locationIndex = findHeaderIndex(headers, [/^location$/i]);
  const applyIndex = findHeaderIndex(headers, [/^(?:posting|apply|application)$/i]);
  const postedIndex = findHeaderIndex(headers, [/^(?:age|posted|date)$/i]);

  if (companyIndex === -1 || titleIndex === -1 || locationIndex === -1 || applyIndex === -1) {
    return null;
  }

  return {
    companyIndex,
    titleIndex,
    locationIndex,
    applyIndex,
    postedIndex: postedIndex === -1 ? undefined : postedIndex,
  };
}

function isNewGradHeading(line: string): boolean {
  return /^#{1,6}\s+.*\bnew\s+(?:grad|graduate)\b/i.test(line);
}

function rowFromCells(
  cells: string[],
  columns: MarkdownTableColumns | null,
): CuratedRepoRow | null {
  if (columns) {
    return {
      company: extractCellText(cells[columns.companyIndex] ?? ''),
      title: extractCellText(cells[columns.titleIndex] ?? ''),
      location: extractCellText(cells[columns.locationIndex] ?? ''),
      url: extractFirstUrl(cells[columns.applyIndex] ?? ''),
      posted:
        columns.postedIndex === undefined
          ? undefined
          : (cells[columns.postedIndex] ?? '').trim(),
    };
  }

  if (cells.length === 6) {
    const [companyCell, titleCell, locationCell, , applyCell, postedCell] = cells;
    return {
      company: extractCellText(companyCell),
      title: extractCellText(titleCell),
      location: extractCellText(locationCell),
      url: extractFirstUrl(applyCell),
      posted: postedCell.trim(),
    };
  }

  if (cells.length === 5) {
    const [companyCell, titleCell, locationCell, applyCell, postedCell] = cells;
    return {
      company: extractCellText(companyCell),
      title: extractCellText(titleCell),
      location: extractCellText(locationCell),
      url: extractFirstUrl(applyCell),
      posted: postedCell.trim(),
    };
  }

  return null;
}

function parseSpeedyapplyMarkdown(markdown: string, path: string): CuratedRepoRow[] {
  const rows: CuratedRepoRow[] = [];
  const isReadme = path === 'README.md';
  let inRelevantSection = !isReadme;
  let sawRelevantSection = !isReadme;
  let currentColumns: MarkdownTableColumns | null = null;

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();

    if (isReadme && /^#{1,6}\s+/.test(line)) {
      if (isNewGradHeading(line)) {
        inRelevantSection = true;
        sawRelevantSection = true;
        currentColumns = null;
        continue;
      }

      if (sawRelevantSection && /^##\s+/.test(line)) {
        break;
      }
    }

    if (!inRelevantSection) continue;

    if (!line.startsWith('|')) {
      currentColumns = null;
      continue;
    }

    if (isMarkdownTableSeparator(line)) continue;

    const cells = splitMarkdownRow(line);
    if (cells.length === 0) continue;

    const headerLabels = cells.map(cell => extractCellText(cell));
    if (
      headerLabels.some(label => /^company$/i.test(label)) &&
      headerLabels.some(label => /^(?:position|title|role)$/i.test(label))
    ) {
      currentColumns = resolveTableColumns(headerLabels);
      continue;
    }

    const row = rowFromCells(cells, currentColumns);
    if (!row) continue;

    if (!row.company || !row.title || !row.location || !row.url) continue;
    rows.push(row);
  }

  return rows;
}

function normalizeRow(row: CuratedRepoRow): NormalizedJob | null {
  const company = row.company.trim();
  const title = row.title.trim();
  const location = row.location.trim();
  const url = row.url?.trim() ?? '';

  if (!company || !title || !url) return null;
  if (location && isNonUsLocation(location)) return null;

  const experienceLevel = inferExperienceLevel(title, '');
  if (experienceLevel === null || experienceLevel === 'internship') return null;

  return {
    source: SOURCE,
    source_id: url,
    title,
    company,
    location,
    remote: inferRemote(location),
    url,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at: parsePostedAt(row.posted),
    dedup_hash: generateHash(company, title, location),
  };
}

function dedupeByUrl(jobs: NormalizedJob[]): NormalizedJob[] {
  const deduped: NormalizedJob[] = [];
  const seenUrls = new Set<string>();

  for (const job of jobs) {
    const key = job.url.trim().replace(/\/+$/, '');
    if (!key || seenUrls.has(key)) continue;

    seenUrls.add(key);
    deduped.push(job);
  }

  return deduped;
}

async function fetchMarkdown(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    console.log(
      `  [${SOURCE}] ${url} -> HTTP ${response.status}; first 200 chars: ${JSON.stringify(body.slice(0, 200))}`,
    );

    if (!response.ok) {
      return null;
    }

    return body;
  } catch (error) {
    console.error(
      `  [${SOURCE}] Failed to fetch ${url}:`,
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function scrapeSpeedyApplySWENewGrad(): Promise<NormalizedJob[]> {
  let firstParsedJobs: NormalizedJob[] | null = null;

  for (const url of CANDIDATE_URLS) {
    const markdown = await fetchMarkdown(url);
    if (!markdown) continue;

    const path = getMarkdownPath(url);
    const jobs = dedupeByUrl(
      parseSpeedyapplyMarkdown(markdown, path)
        .map(row => normalizeRow(row))
        .filter((job): job is NormalizedJob => job !== null),
    );

    console.log(`  [${SOURCE}] Parsed ${jobs.length} jobs from ${path}`);
    if (jobs.length > 0 && firstParsedJobs === null) {
      firstParsedJobs = jobs;
    }
  }

  if (firstParsedJobs) {
    return firstParsedJobs;
  }

  throw new Error('No parseable new-grad jobs found in SpeedyApply markdown sources');
}

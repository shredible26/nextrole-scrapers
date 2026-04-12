import {
  extractCellText,
  extractFirstUrl,
  fetchCuratedGitHubJobs,
  isMarkdownTableSeparator,
  splitMarkdownRow,
  type CuratedRepoRow,
} from '../utils/github-curated';
import { NormalizedJob } from '../utils/normalize';

type ZapplyColumnIndices = {
  title: number;
  location: number;
  posted?: number;
};

function normalizeHeaderCell(value: string): string {
  return extractCellText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isSeparatorRow(cells: string[]): boolean {
  return (
    cells.length > 0 &&
    cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()))
  );
}

function detectColumns(cells: string[]): ZapplyColumnIndices {
  const headers = cells.map(normalizeHeaderCell);
  const titleIndex = headers.findIndex(
    header => header === 'role' || header === 'title' || header === 'job title',
  );
  const locationIndex = headers.findIndex(header => header.includes('location'));
  const postedIndex = headers.findIndex(
    header => header === 'posted' || header === 'date posted',
  );

  return {
    title: titleIndex >= 0 ? titleIndex : 1,
    location: locationIndex >= 0 ? locationIndex : Math.min(Math.max(cells.length - 3, 2), cells.length - 2),
    posted: postedIndex >= 0 ? postedIndex : undefined,
  };
}

function cleanCompanyName(value: string): string {
  return extractCellText(value)
    .replace(/^[^\p{L}\p{N}]+/gu, '')
    .trim();
}

export function parseZapplyMarkdown(markdown: string): CuratedRepoRow[] {
  const rows: CuratedRepoRow[] = [];
  let columns: ZapplyColumnIndices | null = null;

  for (const line of markdown.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith('|') || isMarkdownTableSeparator(trimmedLine)) {
      continue;
    }

    const cells = splitMarkdownRow(trimmedLine);
    if (cells.length < 4) continue;
    if (isSeparatorRow(cells)) continue;

    const companyCell = cells[0] ?? '';
    const companyText = cleanCompanyName(companyCell);
    if (!companyText) continue;
    if (companyText.toLowerCase() === 'company') {
      columns = detectColumns(cells);
      continue;
    }

    const detectedColumns = columns ?? detectColumns(cells);
    const titleCell = cells[detectedColumns.title] ?? '';
    const locationCell = cells[detectedColumns.location] ?? '';
    const applyCell = cells[cells.length - 1] ?? '';
    const url = extractFirstUrl(applyCell) ?? '';
    const title = extractCellText(titleCell);

    if (!title || !url) continue;

    rows.push({
      company: companyText,
      title,
      location: extractCellText(locationCell),
      url,
      posted:
        detectedColumns.posted !== undefined
          ? extractCellText(cells[detectedColumns.posted] ?? '')
          : '',
    });
  }

  return rows;
}

export async function scrapeZapplyjobs(): Promise<NormalizedJob[]> {
  const repos = [
    'zapplyjobs/New-Grad-Jobs-2026',
    'zapplyjobs/New-Grad-Software-Engineering-Jobs-2026',
    'zapplyjobs/New-Grad-Data-Science-Jobs-2026',
    'zapplyjobs/Internships-2026',
    'zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2026',
    'zapplyjobs/Remote-Jobs-2026',
    'zapplyjobs/New-Grad-Positions',
  ];

  const results = await Promise.allSettled(
    repos.map(repo =>
      fetchCuratedGitHubJobs({
        source: 'zapplyjobs',
        repo,
        branches: ['main'],
        markdownPath: 'README.md',
        allowJson: false,
        parseMarkdown: parseZapplyMarkdown,
      }),
    ),
  );

  const all: NormalizedJob[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    }
  }

  console.log(`  [zapplyjobs] Total jobs from all repos: ${all.length}`);
  return all;
}

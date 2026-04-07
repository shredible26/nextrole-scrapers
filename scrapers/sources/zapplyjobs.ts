import {
  extractCellText,
  extractFirstUrl,
  fetchCuratedGitHubJobs,
  isMarkdownTableSeparator,
  splitMarkdownRow,
  type CuratedRepoRow,
} from '../utils/github-curated';
import { NormalizedJob } from '../utils/normalize';

function parseZapplyMarkdown(markdown: string): CuratedRepoRow[] {
  const rows: CuratedRepoRow[] = [];

  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|') || isMarkdownTableSeparator(line)) continue;

    const cells = splitMarkdownRow(line);
    if (cells.length !== 5 || cells[0] === 'Company') continue;

    const [companyCell, titleCell, locationCell, postedCell, applyCell] = cells;
    rows.push({
      company: extractCellText(companyCell),
      title: extractCellText(titleCell),
      location: extractCellText(locationCell),
      url: extractFirstUrl(applyCell),
      posted: postedCell.trim(),
    });
  }

  return rows;
}

export async function scrapeZapplyjobs(): Promise<NormalizedJob[]> {
  return fetchCuratedGitHubJobs({
    source: 'zapplyjobs',
    repo: 'zapplyjobs/New-Grad-Jobs-2026',
    branches: ['main'],
    markdownPath: 'README.md',
    parseMarkdown: parseZapplyMarkdown,
  });
}

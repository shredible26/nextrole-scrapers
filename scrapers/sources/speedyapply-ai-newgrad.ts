import {
  extractCellText,
  extractFirstUrl,
  fetchCuratedGitHubJobs,
  isMarkdownTableSeparator,
  splitMarkdownRow,
  type CuratedRepoRow,
} from '../utils/github-curated';
import { NormalizedJob } from '../utils/normalize';

function parseSpeedyapplyMarkdown(markdown: string): CuratedRepoRow[] {
  const rows: CuratedRepoRow[] = [];

  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|') || isMarkdownTableSeparator(line)) continue;

    const cells = splitMarkdownRow(line);
    if (cells.length !== 6 || cells[0] === 'Company') continue;

    const [companyCell, titleCell, locationCell, , applyCell, postedCell] = cells;
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

export async function scrapeSpeedyapplyAiNewgrad(): Promise<NormalizedJob[]> {
  return fetchCuratedGitHubJobs({
    source: 'speedyapply_ai_newgrad',
    repo: 'speedyapply/2026-AI-College-Jobs',
    branches: ['main'],
    markdownPath: 'NEW_GRAD_USA.md',
    parseMarkdown: parseSpeedyapplyMarkdown,
  });
}

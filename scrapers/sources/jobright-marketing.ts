import {
  extractCellText,
  extractFirstUrl,
  fetchCuratedGitHubJobs,
  isMarkdownTableSeparator,
  splitMarkdownRow,
  type CuratedRepoRow,
} from '../utils/github-curated';
import { NormalizedJob } from '../utils/normalize';

function parseJobrightMarkdown(markdown: string): CuratedRepoRow[] {
  const rows: CuratedRepoRow[] = [];
  let currentCompany = '';

  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|') || isMarkdownTableSeparator(line)) continue;

    const cells = splitMarkdownRow(line);
    if (cells.length !== 5 || cells[0] === 'Company') continue;

    const [companyCell, titleCell, locationCell, workModelCell, postedCell] = cells;
    const companyValue = companyCell.trim();

    if (companyValue !== '↳') {
      currentCompany = extractCellText(companyCell);
    }

    if (!currentCompany) continue;

    rows.push({
      company: currentCompany,
      title: extractCellText(titleCell),
      location: extractCellText(locationCell),
      remoteHint: workModelCell.trim(),
      url: extractFirstUrl(titleCell),
      posted: postedCell.trim(),
    });
  }

  return rows;
}

export async function scrapeJobrightMarketing(): Promise<NormalizedJob[]> {
  return fetchCuratedGitHubJobs({
    source: 'jobright_marketing',
    repo: 'jobright-ai/2026-Marketing-New-Grad',
    branches: ['main', 'master'],
    markdownPath: 'README.md',
    parseMarkdown: parseJobrightMarkdown,
  });
}

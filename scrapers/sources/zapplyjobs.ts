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
    if (cells.length < 3 || cells[0]?.trim() === 'Company' || cells[0]?.trim() === '') continue;

    const [companyCell, titleCell, locationCell, postedCell, applyCell] = cells;
    const urlCell = applyCell ?? locationCell ?? '';
    rows.push({
      company: extractCellText(companyCell),
      title: extractCellText(titleCell),
      location: extractCellText(locationCell),
      url: extractFirstUrl(urlCell),
      posted: postedCell.trim(),
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

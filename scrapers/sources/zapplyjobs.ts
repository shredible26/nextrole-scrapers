import {
  extractCellText,
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
    if (cells.length < 4) continue;

    const companyCell = cells[0] ?? '';
    const titleCell = cells[1] ?? '';
    const locationCell = cells.length === 6 ? (cells[3] ?? '') : (cells[2] ?? '');
    const applyCell = cells[cells.length - 1] ?? '';

    const companyText = extractCellText(companyCell);
    if (companyText === 'Company' || companyText === '') continue;

    const cleanCompany = companyText
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
      .replace(/[\u{2600}-\u{26FF}]/gu, '')
      .replace(/[\u{2700}-\u{27BF}]/gu, '')
      .replace(/\*\*/g, '')
      .trim();

    const urlMatch = applyCell.match(/\]\(([^)]+)\)/);
    const url = urlMatch ? urlMatch[1].trim() : '';

    if (!cleanCompany || !url) continue;

    rows.push({
      company: cleanCompany,
      title: extractCellText(titleCell),
      location: extractCellText(locationCell),
      url,
      posted: '',
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

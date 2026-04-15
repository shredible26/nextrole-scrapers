// Source: https://www.arbeitnow.com/api/job-board-api
// Fully public API — no key, no auth. Paginated. Good remote + EU coverage.
// Docs: https://documenter.getpostman.com/view/18545278/UVJbJdKh

import { pathToFileURL } from 'node:url';

import { generateHash } from '../utils/dedup';
import { inferRoles, inferExperienceLevel, NormalizedJob } from '../utils/normalize';
import { deactivateStaleJobs, uploadJobs } from '../utils/upload';

const TECH_TAGS = [
  'software-engineer', 'developer', 'data', 'machine-learning',
  'backend', 'frontend', 'fullstack', 'analyst', 'engineering',
  'javascript', 'python', 'react', 'node', 'java', 'typescript',
  'cloud', 'devops', 'mobile', 'product',
];

const TITLE_KEYWORDS = [
  'engineer', 'developer', 'analyst', 'scientist',
  'manager', 'designer', 'devops', 'cloud', 'security',
];

export async function scrapeArbeitnow(): Promise<NormalizedJob[]> {
  const results: NormalizedJob[] = [];
  let page = 1;
  const MAX_PAGES = 10;

  while (page <= MAX_PAGES) {
    const res = await fetch(
      `https://www.arbeitnow.com/api/job-board-api?page=${page}`
    );
    const data = await res.json();
    const jobs = data.data ?? [];
    if (jobs.length === 0) break;

    for (const job of jobs) {
      const tags: string[] = job.tags ?? [];
      const titleLower = (job.title ?? '').toLowerCase();

      const hasMatchingTag = tags.some((t: string) =>
        TECH_TAGS.some(k => t.toLowerCase().includes(k))
      );
      const hasMatchingTagInTitle = TECH_TAGS.some(k => titleLower.includes(k));
      const hasMatchingTitleKeyword = TITLE_KEYWORDS.some(k => titleLower.includes(k));

      const isTech = hasMatchingTag || hasMatchingTagInTitle || hasMatchingTitleKeyword;

      if (!isTech) continue;

      const level = inferExperienceLevel(job.title ?? '', job.description ?? '');
      if (level === null) continue;

      results.push({
        source: 'arbeitnow',
        source_id: job.slug,
        title: job.title,
        company: job.company_name,
        location: job.location ?? '',
        remote: job.remote ?? false,
        url: job.url,
        description: job.description,
        experience_level: level,
        roles: inferRoles(job.title),
        posted_at: new Date(job.created_at * 1000).toISOString(),
        dedup_hash: generateHash(job.company_name, job.title, job.location ?? ''),
      });
    }

    page++;
    await new Promise(r => setTimeout(r, 300));
  }

  return results;
}

async function runStandalone(): Promise<void> {
  const jobs = await scrapeArbeitnow();
  await uploadJobs(jobs);
  await deactivateStaleJobs('arbeitnow', jobs.map(job => job.dedup_hash));
  console.log(`  [arbeitnow] Uploaded ${jobs.length} jobs`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runStandalone().catch((error) => {
    console.error('  [arbeitnow] Standalone run failed', error);
    process.exit(1);
  });
}

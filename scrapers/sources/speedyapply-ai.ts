// Source: https://github.com/speedyapply/2026-AI-College-Jobs
// Method: Raw GitHub JSON — same pittcsc format.
// Tries primary URL first; falls back to alternate path on 404.
// AI/ML titles without internship signals are overridden to 'new_grad'.

import { generateHash } from '../utils/dedup';
import { inferRoles, inferExperienceLevel, NormalizedJob, ExperienceLevel } from '../utils/normalize';

const PRIMARY_URL =
  'https://raw.githubusercontent.com/speedyapply/2026-AI-College-Jobs/main/.github/scripts/listings.json';
const FALLBACK_URL =
  'https://raw.githubusercontent.com/speedyapply/2026-AI-College-Jobs/main/.github/workflows/listings.json';

const AI_ML_SIGNALS = [
  ' ai ', ' ai,', 'ai engineer', 'ai/ml', 'ml ', 'ml,', 'ml engineer',
  'machine learning', 'artificial intelligence', 'deep learning', 'llm',
  'nlp', 'computer vision', 'generative ai', 'gen ai', 'data science',
  'data scientist', 'neural network', 'reinforcement learning',
];

const INTERNSHIP_SIGNALS = ['intern', 'internship', 'co-op', 'coop', 'co op'];

function hasAiMlSignal(title: string): boolean {
  const t = ' ' + title.toLowerCase() + ' ';
  return AI_ML_SIGNALS.some(s => t.includes(s));
}

function hasInternshipSignal(title: string): boolean {
  const t = title.toLowerCase();
  return INTERNSHIP_SIGNALS.some(s => t.includes(s));
}

export async function scrapeSpeedyapplyAi(): Promise<NormalizedJob[]> {
  let res = await fetch(PRIMARY_URL);
  if (res.status === 404) {
    res = await fetch(FALLBACK_URL);
  }
  if (res.status === 404) {
    console.warn('  ⚠ speedyapply_ai: both URLs returned 404, skipping');
    return [];
  }
  if (!res.ok) throw new Error(`speedyapply_ai fetch failed: ${res.status}`);
  const listings = await res.json();

  const jobs: NormalizedJob[] = [];
  for (const job of listings.filter((j: any) => j.active !== false)) {
    const level = inferExperienceLevel(job.title);
    if (level === null) continue; // excluded senior/management role

    let experience_level: ExperienceLevel = level;
    if (level !== 'internship' && hasAiMlSignal(job.title) && !hasInternshipSignal(job.title)) {
      experience_level = 'new_grad';
    }

    const location = job.locations?.[0] ?? 'Remote';
    const remote = job.locations?.some((l: string) => l.toLowerCase().includes('remote')) ?? false;
    jobs.push({
      source: 'speedyapply_ai',
      source_id: job.id,
      title: job.title,
      company: job.company_name,
      location,
      remote,
      url: job.url,
      experience_level,
      roles: inferRoles(job.title),
      posted_at: job.date_posted
        ? new Date(job.date_posted * 1000).toISOString()
        : new Date().toISOString(),
      dedup_hash: generateHash(job.company_name, job.title, location),
    });
  }
  return jobs;
}

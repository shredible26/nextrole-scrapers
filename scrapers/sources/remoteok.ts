// Source: https://remoteok.com/api
// Fully public API — no key, no auth. Remote jobs only.
// Docs: https://remoteok.com/api

import { generateHash } from '../utils/dedup';
import {
  finalizeNormalizedJob,
  inferRoles,
  inferExperienceLevel,
  NormalizedJob,
} from '../utils/normalize';

const TECH_KEYWORDS = [
  'engineer', 'developer', 'scientist', 'analyst',
  'ml', 'ai', 'data', 'backend', 'frontend', 'fullstack',
  'product', 'design', 'manager', 'devops', 'cloud', 'security',
  'mobile', 'ios', 'android', 'python', 'javascript', 'typescript',
  'react', 'node', 'java', 'golang', 'rust',
];

export async function scrapeRemoteOK(): Promise<NormalizedJob[]> {
  const res = await fetch('https://remoteok.com/api', {
    headers: { 'User-Agent': 'NextRole Job Aggregator (nextrole.io)' },
  });
  const data = await res.json();

  const normalized: NormalizedJob[] = [];
  for (const job of data) {
    if (!job.slug) continue; // first element is metadata, skip it
    const title = job.position ?? '';
    if (!TECH_KEYWORDS.some(k => title.toLowerCase().includes(k))) continue;

    const level = inferExperienceLevel(title, job.description ?? '');
    if (level === null) continue;

    normalized.push(finalizeNormalizedJob({
      source: 'remoteok',
      source_id: String(job.id),
      title,
      company: job.company,
      location: 'Remote',
      remote: true,
      url: job.url,
      description: job.description,
      salary_min: job.salary_min ? Number(job.salary_min) : undefined,
      salary_max: job.salary_max ? Number(job.salary_max) : undefined,
      experience_level: level,
      roles: inferRoles(title),
      posted_at: new Date(job.epoch * 1000).toISOString(),
      dedup_hash: generateHash(job.company, title, 'Remote'),
    }));
  }
  return normalized;
}

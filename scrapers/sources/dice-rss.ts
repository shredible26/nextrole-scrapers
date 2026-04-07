// Source: https://www.dice.com/jobs/q-{searchTerm}-jobs.rss
// Public RSS feed — no authentication required.
// Returns XML with up to 50 items per page; paginate up to page 3.

import { generateHash } from '../utils/dedup';
import { inferRoles, inferRemote, inferExperienceLevel, NormalizedJob } from '../utils/normalize';

const SEARCH_TERMS = [
  'software+engineer+entry+level',
  'software+engineer+new+grad',
  'data+scientist+entry+level',
  'machine+learning+engineer+entry+level',
  'junior+software+engineer',
  'associate+software+engineer',
  'data+analyst+entry+level',
  'frontend+engineer+entry+level',
  'backend+engineer+entry+level',
  'software+engineer+2026',
  'new+grad+engineer',
  'entry+level+developer',
];

const MAX_PAGES = 3;
const MIN_ITEMS_TO_CONTINUE = 10;
const PAGE_DELAY_MS = 300;

function extractRssItems(xml: string): string[] {
  const items: string[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function extractTag(item: string, tag: string): string {
  const match = item.match(
    new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i')
  );
  return match?.[1]?.trim() ?? '';
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractSourceId(url: string): string {
  // https://www.dice.com/job-detail/abc123 → abc123
  const parts = url.split('/');
  return parts[parts.length - 1] ?? url;
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchPage(searchTerm: string, page: number): Promise<NormalizedJob[]> {
  const pageParam = page > 1 ? `?page=${page}` : '';
  const url = `https://www.dice.com/jobs/q-${searchTerm}-jobs.rss${pageParam}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': 'NextRole Job Aggregator (nextrole.io)',
          'Accept': 'application/rss+xml, application/xml, text/xml',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return [];

    const xml = await res.text();
    const rawItems = extractRssItems(xml);
    if (rawItems.length === 0) return [];

    const jobs: NormalizedJob[] = [];

    for (const item of rawItems) {
      const title = extractTag(item, 'title');
      const link = extractTag(item, 'link');
      const description = stripHtml(extractTag(item, 'description'));
      const pubDate = extractTag(item, 'pubDate');
      const company = extractTag(item, 'source');
      const location = extractTag(item, 'location');

      if (!title || !link) continue;

      const level = inferExperienceLevel(title, description);
      if (level === null) continue;

      const sourceId = extractSourceId(link);
      const remote = location.toLowerCase().includes('remote') || inferRemote(location);

      let postedAt: string | undefined;
      if (pubDate) {
        const d = new Date(pubDate);
        if (!isNaN(d.getTime())) postedAt = d.toISOString();
      }

      jobs.push({
        source: 'dice_rss',
        source_id: sourceId,
        title,
        company: company || 'Unknown',
        location: location || undefined,
        remote,
        url: link,
        description: description || undefined,
        experience_level: level,
        roles: inferRoles(title),
        posted_at: postedAt,
        dedup_hash: generateHash(company || 'Unknown', title, location),
      });
    }

    return jobs;
  } catch {
    return [];
  }
}

async function fetchSearchTerm(searchTerm: string): Promise<NormalizedJob[]> {
  const allJobs: NormalizedJob[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageJobs = await fetchPage(searchTerm, page);

    allJobs.push(...pageJobs);

    // Stop paginating if too few items returned
    if (pageJobs.length < MIN_ITEMS_TO_CONTINUE) break;

    if (page < MAX_PAGES) {
      await delay(PAGE_DELAY_MS);
    }
  }

  return allJobs;
}

export async function scrapeDiceRss(): Promise<NormalizedJob[]> {
  // Run all search terms concurrently
  const results = await Promise.allSettled(
    SEARCH_TERMS.map(term => fetchSearchTerm(term))
  );

  // Merge and deduplicate by source_id
  const seen = new Set<string>();
  const all: NormalizedJob[] = [];

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const job of result.value) {
      const key = job.source_id ?? job.dedup_hash;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(job);
    }
  }

  console.log(`  [dice_rss] ${all.length} unique jobs across ${SEARCH_TERMS.length} search terms`);
  return all;
}

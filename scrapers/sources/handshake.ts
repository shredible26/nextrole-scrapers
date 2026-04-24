// Source: https://app.joinhandshake.com
// Method: Public JSON API (no auth required for basic searches)
// Target: https://app.joinhandshake.com/api/v1/postings
// Fallback 1: https://app.joinhandshake.com/postings.json
// Fallback 2: HTML page parsing (__NEXT_DATA__ / window.__INITIAL_STATE__)

import { generateHash } from '../utils/dedup';
import {
  finalizeNormalizedJob,
  inferRoles,
  inferRemote,
  inferExperienceLevel,
  NormalizedJob,
} from '../utils/normalize';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent': UA,
};

const SEARCH_TERMS = [
  'software engineer',
  'data scientist',
  'machine learning',
  'data analyst',
  'software developer',
  'product manager',
  'data engineer',
  'ai engineer',
];

const EMPLOYMENT_TYPES = ['Full-Time', 'Internship'];

const MAJOR_GROUPS = [
  'Computer Science',
  'Engineering (Computer)',
  'Mathematics & Statistics',
  'Information Technology',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildParams(term: string, page: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('per_page', '25');
  params.set('sort_direction', 'desc');
  params.set('sort_column', 'default');
  params.set('query', term);
  params.set('item_type', 'Job');
  for (const t of EMPLOYMENT_TYPES) params.append('employment_type_names[]', t);
  for (const m of MAJOR_GROUPS) params.append('major_group_names[]', m);
  return params;
}

function mapPosting(posting: any): NormalizedJob | null {
  const id = posting.id ?? posting.posting_id;
  if (!id) return null;

  const title: string = posting.title ?? '';
  if (!title) return null;

  const company: string =
    posting.employer_name ?? posting.company_name ?? posting.employer?.name ?? 'Unknown';

  const city: string = posting.city ?? '';
  const state: string = posting.state_name ?? posting.state ?? '';
  const locationParts = [city, state].filter(Boolean);
  const location =
    locationParts.length > 0 ? locationParts.join(', ') : (posting.location ?? '');

  const remoteWorkType: string = posting.remote_work_type ?? '';
  const remote =
    remoteWorkType.toLowerCase().includes('remote') || inferRemote(location);

  const rawUrl: string =
    posting.job_posting_url ?? posting.url ?? posting.posting_url ?? '';
  const url = rawUrl.startsWith('http')
    ? rawUrl
    : rawUrl
    ? `https://app.joinhandshake.com${rawUrl}`
    : '';
  if (!url) return null;

  const rawDesc: string = posting.description ?? '';
  const description = rawDesc.includes('<') ? stripHtml(rawDesc) : rawDesc;

  const salaryMin = posting.salary_min != null
    ? Math.round(Number(posting.salary_min))
    : undefined;
  const salaryMax = posting.salary_max != null
    ? Math.round(Number(posting.salary_max))
    : undefined;

  const postedAt: string | undefined = posting.created_at ?? posting.posted_at;

  const employmentType: string = (
    posting.employment_type ?? posting.employment_type_name ?? ''
  ).toLowerCase();

  let experienceLevel = inferExperienceLevel(title, description);
  if (
    employmentType.includes('intern') ||
    title.toLowerCase().includes('intern')
  ) {
    experienceLevel = 'internship';
  }
  if (!experienceLevel) return null; // senior — skip

  return finalizeNormalizedJob({
    source: 'handshake',
    source_id: String(id),
    title,
    company,
    location,
    remote,
    url,
    description,
    salary_min: salaryMin,
    salary_max: salaryMax,
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at: postedAt,
    dedup_hash: generateHash(company, title, location),
  });
}

// ─── API fetch (primary or fallback URL) ─────────────────────────────────────

async function fetchPostingsPage(
  baseUrl: string,
  params: URLSearchParams,
): Promise<{ postings: any[]; status: number } | null> {
  const url = `${baseUrl}?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: HEADERS });
  } catch {
    return null;
  }

  if (!res.ok) return { postings: [], status: res.status };

  try {
    const data = await res.json();
    const list: any[] =
      data.results ?? data.postings ?? data.data ?? (Array.isArray(data) ? data : []);
    return { postings: list, status: res.status };
  } catch {
    return { postings: [], status: res.status };
  }
}

// ─── HTML page fallback — parse embedded JSON ─────────────────────────────────

async function tryHtmlFallback(term: string): Promise<any[]> {
  const pageUrl = `https://app.joinhandshake.com/jobs?query=${encodeURIComponent(term)}&employment_type=fulltime`;
  let res: Response;
  try {
    res = await fetch(pageUrl, {
      headers: {
        'User-Agent': UA,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
  } catch {
    return [];
  }

  if (!res.ok) return [];

  const html = await res.text();

  // Try __NEXT_DATA__
  const ndStart = html.indexOf('<script id="__NEXT_DATA__" type="application/json">');
  const ndEnd = html.indexOf('</script>', ndStart);
  if (ndStart !== -1 && ndEnd !== -1) {
    const jsonStr = html.slice(ndStart + '<script id="__NEXT_DATA__" type="application/json">'.length, ndEnd);
    try {
      const nd = JSON.parse(jsonStr);
      const jobs =
        nd?.props?.pageProps?.jobs ??
        nd?.props?.pageProps?.postings ??
        nd?.props?.pageProps?.results;
      if (Array.isArray(jobs) && jobs.length) return jobs;
    } catch {
      // continue
    }
  }

  // Try window.__INITIAL_STATE__
  const isMatch = html.match(
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\});\s*<\/script>/,
  );
  if (isMatch) {
    try {
      const state = JSON.parse(isMatch[1]);
      const jobs =
        state?.jobs ?? state?.postings ?? state?.results;
      if (Array.isArray(jobs) && jobs.length) return jobs;
    } catch {
      // continue
    }
  }

  return [];
}

// ─── Main scraper ─────────────────────────────────────────────────────────────

export async function scrapeHandshake(): Promise<NormalizedJob[]> {
  const seen = new Set<string>();
  const results: NormalizedJob[] = [];

  const PRIMARY = 'https://app.joinhandshake.com/api/v1/postings';
  const FALLBACK = 'https://app.joinhandshake.com/postings.json';
  const MAX_PAGES = 5;
  const DELAY_MS = 500;

  // Probe both endpoints with a minimal request to decide which one to use
  let activeUrl: string | null = null;
  let primaryStatus = 0;
  let fallbackStatus = 0;

  const probeParams = buildParams('software engineer', 1);

  const primaryProbe = await fetchPostingsPage(PRIMARY, probeParams);
  primaryStatus = primaryProbe?.status ?? 0;

  if (primaryProbe && primaryProbe.status === 200 && primaryProbe.postings.length > 0) {
    activeUrl = PRIMARY;
    console.log(`  [handshake] Primary API reachable (HTTP ${primaryStatus})`);
  } else {
    console.log(`  [handshake] Primary API unavailable (HTTP ${primaryStatus}), trying fallback...`);

    const fallbackProbe = await fetchPostingsPage(FALLBACK, probeParams);
    fallbackStatus = fallbackProbe?.status ?? 0;

    if (fallbackProbe && fallbackProbe.status === 200 && fallbackProbe.postings.length > 0) {
      activeUrl = FALLBACK;
      console.log(`  [handshake] Fallback API reachable (HTTP ${fallbackStatus})`);
    } else {
      console.log(`  [handshake] Fallback API unavailable (HTTP ${fallbackStatus})`);
    }
  }

  // ── Path A: API endpoint is working ──────────────────────────────────────
  if (activeUrl) {
    for (const term of SEARCH_TERMS) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        try {
          const params = buildParams(term, page);
          const result = await fetchPostingsPage(activeUrl, params);

          if (!result || result.status !== 200 || result.postings.length === 0) break;

          for (const posting of result.postings) {
            const job = mapPosting(posting);
            if (!job?.source_id) continue;
            if (seen.has(job.source_id)) continue;
            seen.add(job.source_id);
            results.push(job);
          }

          if (result.postings.length < 25) break; // last page

          await new Promise(r => setTimeout(r, DELAY_MS));
        } catch (err) {
          console.warn(`  [handshake] Error on term "${term}" page ${page}:`, err);
          break;
        }
      }
    }
  } else {
    // ── Path B: Both API endpoints failed — try HTML page parsing ────────────
    console.log(`  [handshake] Both endpoints failed (primary=${primaryStatus}, fallback=${fallbackStatus}). Trying HTML fallback...`);

    for (const term of SEARCH_TERMS) {
      try {
        const postings = await tryHtmlFallback(term);
        for (const posting of postings) {
          const job = mapPosting(posting);
          if (!job?.source_id) continue;
          if (seen.has(job.source_id)) continue;
          seen.add(job.source_id);
          results.push(job);
        }
        await new Promise(r => setTimeout(r, DELAY_MS));
      } catch (err) {
        console.warn(`  [handshake] HTML fallback error for term "${term}":`, err);
      }
    }
  }

  console.log(`  [handshake] Total unique jobs collected: ${results.length}`);
  return results;
}

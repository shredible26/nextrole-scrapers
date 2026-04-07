import { scrapeJobs } from 'ts-jobspy';
import { generateHash } from '../utils/dedup';
import { inferRoles, inferRemote, inferExperienceLevel, NormalizedJob } from '../utils/normalize';

const SEARCH_TERMS = [
  'software engineer new grad',
  'software engineer entry level',
  'data scientist new grad',
  'data scientist entry level',
  'machine learning engineer entry level',
  'data analyst entry level',
  'software developer entry level',
  'junior software engineer',
  'associate software engineer',
  'backend engineer entry level',
  'frontend engineer entry level',
  'full stack engineer entry level',
  'devops engineer entry level',
  'cloud engineer entry level',
  'software engineer 2026',
  'new grad engineer 2026',
  'associate data scientist',
  'junior data analyst',
  'associate machine learning',
  'software engineer internship 2026',
];

// ZipRecruiter and Google scrapers are under maintenance in ts-jobspy 2.0.3.
// Only 'indeed' is active; LinkedIn is excluded per product requirements.
const SITES = ['indeed'] as const;

export async function scrapeJobSpy(): Promise<NormalizedJob[]> {
  const results: NormalizedJob[] = [];
  const seenHashes = new Set<string>();

  for (const term of SEARCH_TERMS) {
    try {
      console.log(`  [jobspy] Scraping "${term}"...`);
      const jobs = await scrapeJobs({
        siteName: SITES as unknown as 'indeed'[],
        searchTerm: term,
        location: 'United States',
        resultsWanted: 50,
        hoursOld: 72,
        jobType: 'fulltime',
        countryIndeed: 'USA',
      });

      for (const job of jobs) {
        if (!job.title || !job.company) continue;

        // JobData.location is already a pre-formatted string
        const location = job.location ?? '';
        const hash = generateHash(job.company, job.title, location);
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        const isRemote = job.isRemote ?? inferRemote(location);
        const roles = inferRoles(job.title);

        const experienceLevel = inferExperienceLevel(job.title, job.description ?? '');
        if (experienceLevel === null) continue;

        results.push({
          source: `jobspy_${job.site ?? 'indeed'}`,
          source_id: job.jobUrl,
          title: job.title,
          company: job.company,
          location,
          remote: isRemote,
          url: job.jobUrl ?? '',
          description: job.description ?? undefined,
          salary_min: job.minAmount ? Math.round(job.minAmount) : undefined,
          salary_max: job.maxAmount ? Math.round(job.maxAmount) : undefined,
          experience_level: experienceLevel,
          roles,
          posted_at: job.datePosted
            ? new Date(job.datePosted).toISOString()
            : undefined,
          dedup_hash: hash,
        });
      }

      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.warn(`  [jobspy] "${term}" failed:`, (err as Error).message);
    }
  }

  return results;
}

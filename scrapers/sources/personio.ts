import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { generateHash } from '../utils/dedup';
import { isNonUsLocation } from '../utils/location';
import {
  finalizeNormalizedJob,
  inferExperienceLevel,
  inferRoles,
  type NormalizedJob,
  type Role,
} from '../utils/normalize';
import { deactivateStaleJobs, uploadJobs } from '../utils/upload';

const SOURCE = 'personio';
const REQUEST_TIMEOUT_MS = 10_000;
const COMPANY_BATCH_SIZE = 20;
const COMPANY_BATCH_DELAY_MS = 300;

const PERSONIO_SLUGS = [
  'n26', 'tier', 'gorillas', 'forto', 'taxfix', 'solarisbank',
  'contentful', 'adjust', 'mambu', 'wefox', 'clark', 'enpal',
  'kreditech', 'billie', 'compeon', 'crosslend', 'penta',
  'moss', 'kontist', 'finleap', 'raisin', 'deposit', 'auxmoney',
  'elinvar', 'banxware', 'pair-finance', 'aboalarm', 'zenjob',
  'homeday', 'mcmakler', 'propstack', 'evana', 'architrave',
  'thermondo', 'solarwatt', 'sonnen', 'lumenaza', '1komma5grad',
  'ada-health', 'avi-medical', 'benify', 'betterDoc', 'clickdoc',
  'doctolib', 'jameda', 'medwing', 'nilo-health', 'nu3',
  'foodspring', 'myprotein', 'lesara', 'outfittery', 'bonprix',
  'about-you', 'mytheresa', 'westwing', 'limango', 'otto',
  'hellofresh', 'marley-spoon', 'gousto', 'just-spices', 'kitchenstories',
  'delivery-hero', 'foodpanda', 'lieferando', 'mjam', 'pizza',
  'hypoport', 'check24', 'verivox', 'smava', 'creditplus',
  'tonies', 'flaschenpost', 'picnic', 'flink', 'gorillas',
  'celonis', 'personio', 'staffbase', 'uberall', 'userlike',
  'kenjo', 'factorial', 'hrworks', 'coachhub', 'leapsome',
  'moonfare', 'elinvar', 'liqid', 'scalable', 'trade-republic',
  'revolut', 'sumup', 'paysafe', 'klarna', 'adyen',
  'urban-sports-club', 'hometogo', 'tourradar', 'omio', 'fernbus',
  'flixbus', 'blablacar', 'moia', 'tier-mobility', 'coup',
  'volocopter', 'lilium', 'wingcopter', 'speed-bird-aero',
  'isar-aerospace', 'rocket-factory', 'mynaric', 'reflex-aerospace',
  'aleph-alpha', 'deepl', 'cognigy', 'parloa', 'micropsi',
  'blickfeld', 'konux', 'merantix', 'retorio', 'sievert',
  'lenze', 'wago', 'phoenix-contact', 'beckhoff', 'weidmuller',
  'siemens', 'bosch', 'continental', 'zf', 'schaeffler',
  'airbus', 'diehl', 'liebherr', 'mtu', 'rolls-royce',
  'bmw', 'mercedes-benz', 'volkswagen', 'porsche', 'audi',
  'zalando', 'baur', 'brax', 'gerry-weber', 'hugo-boss',
  'huk', 'allianz', 'ergo', 'signal-iduna', 'axa',
  'aok', 'barmer', 'tkk', 'dak', 'bkk',
  'deutsche-bank', 'commerzbank', 'ing', 'dkb', 'hypovereinsbank',
  'springer', 'axel-springer', 'funke', 'madsack', 'ippen',
  'bertelsmann', 'burda', 'hubert-burda', 'gruner-jahr', 'spiegel',
  'sap', 'software-ag', 'itelligence', 'orbis', 'nvh',
  'teamviewer', 'uipath', 'softwareone', 'bechtle', 'cancom',
  // Added from currently live public Personio job pages.
  'chargecloud-gmbh', 'certivity', 'gocomo', 'pacemaker',
  'enabl-technologies-gmbh', 'enpit', 'holidaycheck', 'gus-germany',
  'team-gmbh', 'tngtech', 'cevotec',
] as const;

const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
  'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york',
  'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
  'west virginia', 'wisconsin', 'wyoming', 'district of columbia',
] as const;

const US_STATE_ABBREVIATIONS = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA',
  'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME',
  'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM',
  'NV', 'NY', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX',
  'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY',
] as const;

const COMMON_US_CITY_TERMS = [
  'new york', 'san francisco', 'seattle', 'boston', 'chicago', 'austin',
  'los angeles', 'atlanta', 'denver', 'washington', 'dallas', 'houston',
  'philadelphia', 'san jose', 'san diego', 'raleigh', 'durham',
  'charlotte', 'miami', 'nashville', 'portland', 'phoenix', 'irvine',
  'palo alto', 'mountain view', 'menlo park', 'redmond', 'bellevue',
  'cambridge', 'arlington',
] as const;

const US_STATE_ABBREVIATION_RE = new RegExp(
  `(?:^|,\\s)(?:${US_STATE_ABBREVIATIONS.join('|')})(?:\\b|,|\\s|$)`,
  'i',
);

const US_STATE_NAME_RE = new RegExp(
  `\\b(?:${US_STATE_NAMES.join('|')})\\b`,
  'i',
);

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function unwrapCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(unwrapCdata(value))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

function extractTagValue(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return null;

  const value = stripHtml(match[1]);
  return value || null;
}

function extractTagValues(block: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const values: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(block)) !== null) {
    const value = stripHtml(match[1]);
    if (value) {
      values.push(value);
    }
  }

  return values;
}

function extractPositionBlocks(xml: string): string[] {
  return Array.from(xml.matchAll(/<position>([\s\S]*?)<\/position>/g), match => match[1]);
}

function extractDescription(positionXml: string): string | undefined {
  const blocks = Array.from(
    positionXml.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/gi),
    match => match[1],
  );

  const values = blocks
    .map(block => extractTagValue(block, 'value'))
    .filter((value): value is string => Boolean(value));

  if (values.length === 0) return undefined;
  return values.join('\n\n');
}

function formatCompanyName(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildJobUrl(slug: string, positionXml: string, fallbackId: string): string | null {
  const explicitUrl = extractTagValue(positionXml, 'url');
  if (explicitUrl) return explicitUrl;
  if (!fallbackId) return null;
  return `https://${slug}.jobs.personio.de/job/${fallbackId}?language=en`;
}

function extractSourceId(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split('/').filter(Boolean).pop();
    return lastSegment || undefined;
  } catch {
    return undefined;
  }
}

function inferPersonioRoles(title: string, description?: string): Role[] {
  const titleRoles = inferRoles(title);
  if (titleRoles.length > 0 || !description) {
    return titleRoles;
  }

  return inferRoles(description);
}

function isUsLikeLocation(location: string): boolean {
  const lower = location.toLowerCase();

  if (/\b(?:united states|united states of america|usa|u\.s\.|us-only|us remote|remote us)\b/i.test(location)) {
    return true;
  }

  if (/^\d+\s+locations?$/i.test(location)) {
    return true;
  }

  if (US_STATE_ABBREVIATION_RE.test(location) || US_STATE_NAME_RE.test(lower)) {
    return true;
  }

  return COMMON_US_CITY_TERMS.some(city => lower.includes(city));
}

function hasRemoteSignal(location: string | undefined, description: string | undefined, additionalOffices: string[]): boolean {
  const values = [location ?? '', description ?? '', ...additionalOffices];
  return values.some(value => value.toLowerCase().includes('remote'));
}

function shouldKeepLocation(
  location: string | undefined,
  description: string | undefined,
  additionalOffices: string[],
): boolean {
  if (!location) return true;
  if (hasRemoteSignal(location, description, additionalOffices)) return true;
  if (isUsLikeLocation(location)) return true;
  if (isNonUsLocation(location)) return false;
  return false;
}

function normalizePosition(slug: string, positionXml: string): NormalizedJob | null {
  const title = extractTagValue(positionXml, 'title') ?? extractTagValue(positionXml, 'name');
  const positionId = extractTagValue(positionXml, 'id') ?? '';
  const location = extractTagValue(positionXml, 'office') ?? undefined;
  const additionalOfficesBlock = positionXml.match(/<additionalOffices>([\s\S]*?)<\/additionalOffices>/i)?.[1] ?? '';
  const additionalOffices = extractTagValues(additionalOfficesBlock, 'office');
  const description = extractDescription(positionXml);

  if (!title) return null;
  if (!shouldKeepLocation(location, description, additionalOffices)) return null;

  const url = buildJobUrl(slug, positionXml, positionId);
  if (!url) return null;

  const experienceLevel = inferExperienceLevel(title, description);
  if (experienceLevel === null) return null;

  const company = formatCompanyName(slug);
  const remote = hasRemoteSignal(location, description, additionalOffices);
  const sourceId = extractSourceId(url);

  return finalizeNormalizedJob({
    source: SOURCE,
    source_id: sourceId,
    title,
    company,
    location,
    remote,
    url,
    description,
    posted_at: undefined,
    experience_level: experienceLevel,
    roles: inferPersonioRoles(title, description),
    dedup_hash: generateHash(company, title, location ?? ''),
  });
}

async function fetchCompanyJobs(slug: string): Promise<NormalizedJob[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`https://${slug}.jobs.personio.de/xml?language=en`, {
      headers: {
        Accept: 'application/xml, text/xml;q=0.9, */*;q=0.8',
        'User-Agent': 'NextRole Job Aggregator (nextrole-scrapers)',
      },
      signal: controller.signal,
    });

    if (response.status !== 200) return [];

    const xml = await response.text();
    const jobs = extractPositionBlocks(xml)
      .map(positionXml => normalizePosition(slug, positionXml))
      .filter((job): job is NormalizedJob => job !== null);

    const dedupedJobs = Array.from(new Map(jobs.map(job => [job.dedup_hash, job])).values());

    if (dedupedJobs.length > 0) {
      console.log(`    [${SOURCE}] ${formatCompanyName(slug)}: ${dedupedJobs.length} jobs`);
    }

    return dedupedJobs;
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function scrapePersonio(): Promise<NormalizedJob[]> {
  const allJobs: NormalizedJob[] = [];
  const uniqueSlugs = Array.from(new Set(PERSONIO_SLUGS));

  for (let index = 0; index < uniqueSlugs.length; index += COMPANY_BATCH_SIZE) {
    const batch = uniqueSlugs.slice(index, index + COMPANY_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(slug => fetchCompanyJobs(slug)));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allJobs.push(...result.value);
      }
    }

    if (index + COMPANY_BATCH_SIZE < uniqueSlugs.length) {
      await delay(COMPANY_BATCH_DELAY_MS);
    }
  }

  const dedupedJobs = Array.from(new Map(allJobs.map(job => [job.dedup_hash, job])).values());
  console.log(`  [${SOURCE}] Final count: ${dedupedJobs.length}`);
  return dedupedJobs;
}

async function runStandalone(): Promise<void> {
  const jobs = await scrapePersonio();
  await uploadJobs(jobs);
  await deactivateStaleJobs(SOURCE, jobs.map(job => job.dedup_hash));
  console.log(`  [${SOURCE}] Uploaded ${jobs.length} jobs`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runStandalone().catch((error) => {
    console.error(`  [${SOURCE}] Standalone run failed`, error);
    process.exit(1);
  });
}

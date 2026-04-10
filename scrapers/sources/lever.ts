// Source: https://api.lever.co/v0/postings/{company}?mode=json&limit=50
// Fully public API — no auth, no key. Returns JSON postings for each company.
// Strategy: fetch curated slugs in small batches and silently skip dead slugs/errors.

import { generateHash } from '../utils/dedup';
import { inferRoles, inferRemote, inferExperienceLevel, NormalizedJob } from '../utils/normalize';

// Live upstream-verified slugs from Simplify + ambicuity.
const UPSTREAM_VERIFIED_LEVER_COMPANIES = [
  '2os', 'agile-defense', 'agtonomy', 'AIFund', 'alertus',
  'allegiantair', 'alltrails', 'analyticpartners', 'anomali', 'appen',
  'appen-2', 'Aprio', 'arable', 'arcteryx.com', 'arrivelogistics',
  'atlassian', 'attentive', 'beghouconsulting', 'belvederetrading', 'beta',
  'bosonai', 'bumbleinc', 'canvasww', 'cascademgt', 'Catbird',
  'cef', 'certik', 'CesiumAstro', 'cfsenergy', 'cgsfederal',
  'cirrus', 'cleanspark', 'Clearer', 'cobaltrobotics', 'color',
  'commercearchitects', 'commonlit', 'compassx', 'CordTechnologies', 'cority',
  'crestoperations', 'cx2', 'datalabusa', 'deltasands', 'demiurgestudios',
  'dexterity', 'diversified-automation', 'dnb', 'e2optics', 'eastern-communications',
  'economicmodeling', 'elfbeauty', 'enable', 'entrata', 'eqbank',
  'espace', 'esrtreit', 'ethena', 'exowatt', 'field-ai',
  'finix', 'fiscalnote', 'fullscript', 'gauntlet', 'getwingapp',
  'getzuma', 'glsllc', 'gmo', 'goodamerican', 'goodleap',
  'gopuff', 'greenlight', 'Grid', 'gridmatic', 'hermeus',
  'hhaexchange', 'hive', 'honkforhelp', 'inductiveautomation', 'infstones',
  'intrafi', 'ion', 'ivo', 'jamcity', 'kddia',
  'kitware', 'latitudeinc', 'leverdemo', 'leverdemo-8', 'life',
  'lightedge', 'lightship', 'linkllc', 'lumafield', 'LuminDigital',
  'luxurypresence', 'makpar', 'masterycharter', 'matchgroup', 'mcaconnect',
  'mechanicalorchard', 'metergysolutions', 'modeln', 'moonpig', 'mti-inc',
  'netflix', 'nevados', 'nextech', 'NimbleAI', 'nitra',
  'nominal', 'oaknorth.ai', 'optionmetrics', 'palantir', 'parallelwireless',
  'pditechnologies', 'penumbrainc', 'perforce', 'perrknight', 'pibenchmark',
  'picklerobot', 'pingwind', 'pivotal', 'plaid', 'plusgrade',
  'procept-biorobotics', 'prominentedge', 'q-ctrl', 'quantcast', 'quantinuum',
  'RadicalAI', 'redsox', 'redwoodcu', 'regalvoice', 'reply',
  'researchinnovations.com', 'revefi', 'rivosinc', 'robinpowered', 'rover',
  'rws', 'saronic', 'saviynt', 'schmidt-entities', 'secureframe',
  'SeiLabs', 'sensortower', 'sep', 'sfgiants', 'shieldai',
  'shyftlabs', 'simulmedia', 'sonarsource', 'southwestwater', 'spotify',
  'sprucesystems', 'sprypointservices', 'starcompliance', 'sunsrce', 'sunwatercapital',
  'sylvera', 'sysdig', 'talentwerx.io', 'tangraminteriors', 'telesat',
  'theinformationlab', 'theodo', 'thinkahead', 'topanga', 'tramgroup',
  'Trend-Health-Partners', 'tri', 'truetandem', 'uncountable', 'unisoninfra',
  'vailsys', 'valkyrietrading', 'veeva', 'voleon', 'voltus',
  'wachter', 'webfx', 'welocalize', 'weride', 'whoop',
  'windfalldata', 'windownation', 'wintermute-trading', 'wmg', 'wolve',
  'wpromote', 'wyetechllc', 'xsolla', 'zoox', 'zopa',
];

// Prompt-provided slugs that still return HTTP 200 from Lever as of April 6, 2026.
const LIVE_MANUAL_VERIFIED_LEVER_COMPANIES = [
  'cloudinary',
  'jumpcloud',
  'osaro',
  'proof',
  'tesorio',
  'transcarent',
];

const ADDITIONAL_HIGH_VALUE_VERIFIED_LEVER_COMPANIES = [
  'stripe', 'lyft', 'airbnb', 'notion', 'linear',
  'figma', 'airtable', 'asana', 'zendesk', 'hubspot',
  'twilio', 'segment', 'amplitude', 'mixpanel',
  'intercom', 'freshworks', 'gong', 'outreach',
  'salesloft', 'clari', 'plaid', 'brex', 'ramp',
  'mercury', 'moderntreasury', 'unit', 'marqeta',
  'snyk', 'lacework', 'wiz', 'abnormal', 'netskope',
  'illumio', 'semgrep', 'chainguard',
  'scale-ai', 'labelbox', 'snorkel-ai',
  'sourcegraph', 'gitpod', 'render',
  'ro', 'cityblock', 'spring-health', 'lyra-health',
  'alma', 'headway', 'cerebral',
  'project44', 'fourkites', 'shipbob', 'flexport',
  'opendoor', 'roofstock',
  'benchling', 'ginkgo', 'recursion',
  'coursera', 'duolingo', 'quizlet',
  'rippling', 'deel', 'remote', 'lattice',
  'persona', 'verkada', 'samsara', 'anduril',
  'databricks', 'confluent', 'dbtlabs',
  'retool', 'replit', 'coreweave',
  'perplexity', 'mistral', 'together',
  'modal', 'weights-biases', 'determined-ai',
];

type LeverDiscoveryListing = {
  url?: unknown;
  link?: unknown;
  apply_url?: unknown;
};

function extractLeverSlug(value: unknown): string | null {
  if (!value) return null;

  const match = String(value).match(/jobs\.lever\.co\/([^\/\?\s#]+)/i);
  return match ? match[1] : null;
}

async function discoverLeverSlugs(): Promise<string[]> {
  const sources = [
    'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
    'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json',
    'https://raw.githubusercontent.com/vanshb03/Summer2026-Internships/dev/.github/scripts/listings.json',
  ] as const;

  const slugSet = new Set<string>();

  for (const url of sources) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;

      const data: unknown = await res.json();
      if (!Array.isArray(data)) continue;

      for (const item of data) {
        if (!item || typeof item !== 'object') continue;

        const listing = item as LeverDiscoveryListing;
        const urls = [listing.url, listing.link, listing.apply_url].filter(Boolean);
        for (const value of urls) {
          const slug = extractLeverSlug(value);
          if (slug) slugSet.add(slug);
        }
      }
    } catch {
      // Skip failed sources silently
    }
  }

  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/ReaVNaiL/New-Grad-2024/main/README.md',
      { signal: AbortSignal.timeout(10_000) }
    );
    if (res.ok) {
      const text = await res.text();
      const matches = text.matchAll(/jobs\.lever\.co\/([^\/\?\s\)"'#]+)/gi);
      for (const match of matches) {
        slugSet.add(match[1]);
      }
    }
  } catch {}

  return Array.from(slugSet);
}

// Lever's postings endpoint is slug-only and does not return company metadata.
const COMPANY_NAME_OVERRIDES: Record<string, string> = {
  'doordash': 'DoorDash',
  'epic-games': 'Epic Games',
  'gitlab': 'GitLab',
  'github': 'GitHub',
  'grafana-labs': 'Grafana Labs',
  'hims-hers': 'Hims & Hers',
  'honeycomb-io': 'Honeycomb.io',
  'jfrog': 'JFrog',
  'jumpcloud': 'JumpCloud',
  'khan-academy': 'Khan Academy',
  'launchdarkly': 'LaunchDarkly',
  'modern-treasury': 'Modern Treasury',
  'mongodb': 'MongoDB',
  'o3-world': 'O3 World',
  'openai': 'OpenAI',
  'opengov': 'OpenGov',
  'pagerduty': 'PagerDuty',
  'readme': 'ReadMe',
  'scale-ai': 'Scale AI',
  'scout-rx': 'Scout RX',
  'strongdm': 'StrongDM',
  'telemetry2u': 'Telemetry2U',
  'tiktok': 'TikTok',
  'usertesting': 'UserTesting',
};

function formatCompanyName(slug: string): string {
  const override = COMPANY_NAME_OVERRIDES[slug];
  if (override) return override;

  return slug
    .split('-')
    .map(part => {
      if (!part) return part;
      if (part === 'ai' || part === 'io' || part === 'rx') return part.toUpperCase();
      if (/^[a-z]\d+$/i.test(part)) return part[0].toUpperCase() + part.slice(1);
      return part[0].toUpperCase() + part.slice(1);
    })
    .join(' ');
}

const TECH_KEYWORDS = [
  'engineer', 'developer', 'scientist', 'analyst', 'ml', 'ai', 'data',
  'software', 'backend', 'frontend', 'fullstack', 'full stack', 'product manager',
];

function isTechRole(title: string): boolean {
  const lower = title.toLowerCase();
  return TECH_KEYWORDS.some(k => lower.includes(k));
}

async function fetchCompany(slug: string): Promise<NormalizedJob[]> {
  try {
    const res = await fetch(
      `https://api.lever.co/v0/postings/${slug}?mode=json&limit=50`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return []; // company not on Lever — skip silently

    const jobs: any[] = await res.json();
    if (!Array.isArray(jobs)) return [];

    const companyName = formatCompanyName(slug);
    const normalized: NormalizedJob[] = [];
    for (const job of jobs) {
      if (!isTechRole(job.text ?? '')) continue;
      const description = job.descriptionPlain ?? job.description ?? undefined;
      const level = inferExperienceLevel(job.text ?? '', description);
      if (level === null) continue;

      const location: string = job.categories?.location ?? job.categories?.allLocations?.[0] ?? '';
      normalized.push({
        source: 'lever',
        source_id: job.id ?? '',
        title: job.text ?? '',
        company: companyName,
        location,
        remote: inferRemote(location),
        url: job.hostedUrl ?? '',
        description,
        experience_level: level,
        roles: inferRoles(job.text ?? ''),
        // createdAt is Unix milliseconds
        posted_at: job.createdAt ? new Date(job.createdAt).toISOString() : undefined,
        dedup_hash: generateHash(companyName, job.text ?? '', location),
      });
    }
    return normalized;
  } catch {
    return []; // timeout or network error — skip silently
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function scrapeLever(): Promise<NormalizedJob[]> {
  const BATCH_SIZE = 10;
  const DELAY_MS = 200;
  const all: NormalizedJob[] = [];
  const discoveredSlugs = await discoverLeverSlugs();
  const allSlugs = [...new Set([
    ...UPSTREAM_VERIFIED_LEVER_COMPANIES,
    ...LIVE_MANUAL_VERIFIED_LEVER_COMPANIES,
    ...discoveredSlugs,
    ...ADDITIONAL_HIGH_VALUE_VERIFIED_LEVER_COMPANIES,
  ].map(slug => slug.toLowerCase()))];

  console.log(`  [lever] Discovered ${discoveredSlugs.length} slugs from GitHub repos`);
  console.log(`  [lever] Total unique slugs: ${allSlugs.length}`);

  for (let i = 0; i < allSlugs.length; i += BATCH_SIZE) {
    const batch = allSlugs.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(fetchCompany));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        all.push(...result.value);
      }
    }

    if (i + BATCH_SIZE < allSlugs.length) {
      await sleep(DELAY_MS);
    }
  }

  return all;
}

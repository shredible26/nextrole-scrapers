// Source: https://api.ashbyhq.com/posting-api/job-board/{slug}
// Fully public API — no auth, no key. Similar to Greenhouse.
// Strategy: discover slugs, validate them once, cache the good ones, then
// scrape the verified boards in batches.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { generateHash } from '../utils/dedup';
import { inferRoles, inferRemote, inferExperienceLevel, NormalizedJob } from '../utils/normalize';
import { isNonUsLocation } from '../utils/location';
import { deactivateStaleJobs, uploadJobs } from '../utils/upload';

const COMPANIES: Record<string, string> = {
  // AI / ML
  'openai': 'OpenAI',
  'anthropic': 'Anthropic',
  'cohere': 'Cohere',
  'perplexity': 'Perplexity',
  'harvey': 'Harvey',
  'cursor': 'Cursor',
  'cognition': 'Cognition',
  'imbue': 'Imbue',
  'adept': 'Adept',
  'runway': 'Runway',
  'replit': 'Replit',
  'huggingface': 'Hugging Face',
  'together-ai': 'Together AI',
  'modal': 'Modal',
  'replicate': 'Replicate',
  'baseten': 'Baseten',
  'vectara': 'Vectara',
  'weaviate': 'Weaviate',

  // Fintech
  'ramp': 'Ramp',
  'brex': 'Brex',
  'plaid': 'Plaid',
  'mercury': 'Mercury',
  'moderntreasury': 'Modern Treasury',
  'column': 'Column',
  'parafin': 'Parafin',
  'increase': 'Increase',
  'slope': 'Slope',
  'stytch': 'Stytch',
  'persona': 'Persona',
  'alloy': 'Alloy',

  // Dev Tools / Infra
  'linear': 'Linear',
  'retool': 'Retool',
  'vercel': 'Vercel',
  'planetscale': 'PlanetScale',
  'neon': 'Neon',
  'supabase': 'Supabase',
  'turso': 'Turso',
  'Railway': 'Railway',
  'render': 'Render',
  'dagger': 'Dagger',
  'depot': 'Depot',
  'grafana': 'Grafana',
  'posthog': 'PostHog',
  'highlight': 'Highlight',
  'axiom': 'Axiom',
  'tinybird': 'Tinybird',
  'inngest': 'Inngest',
  'trigger': 'Trigger.dev',
  'resend': 'Resend',
  'loops': 'Loops',
  'cal': 'Cal.com',
  'liveblocks': 'Liveblocks',
  'outerbase': 'Outerbase',

  // SaaS / Productivity
  'notion': 'Notion',
  'coda': 'Coda',
  'loom': 'Loom',
  'miro': 'Miro',
  'zapier': 'Zapier',
  'make': 'Make',
  'clay': 'Clay',
  'apollo': 'Apollo',
  'gong': 'Gong',
  'clari': 'Clari',
  'outreach': 'Outreach',
  'salesloft': 'Salesloft',
  'front': 'Front',
  'intercom': 'Intercom',
  'pendo': 'Pendo',
  'fullstory': 'FullStory',
  'heap': 'Heap',
  'june': 'June',
  'koala': 'Koala',

  // Security
  'vanta': 'Vanta',
  'drata': 'Drata',
  'secureframe': 'Secureframe',
  'thoropass': 'Thoropass',
  'wiz': 'Wiz',
  'lacework': 'Lacework',
  'snyk': 'Snyk',
  'semgrep': 'Semgrep',
  'hatica': 'Hatica',

  // Data
  'dbtlabs': 'dbt Labs',
  'fivetran': 'Fivetran',
  'hightouch': 'Hightouch',
  'census': 'Census',
  'airbyte': 'Airbyte',
  'hex': 'Hex',
  'lightdash': 'Lightdash',
  'metabase': 'Metabase',
  'preset': 'Preset',
  'evidence': 'Evidence',

  // Healthcare
  'headspace': 'Headspace',
  'brightline': 'Brightline',
  'devoted': 'Devoted Health',
  'cityblock': 'Cityblock Health',
  'color': 'Color Health',
  'benchling': 'Benchling',
  'recursion': 'Recursion',

  // E-commerce / Marketplace
  'faire': 'Faire',
  'shipbob': 'ShipBob',
  'flexport': 'Flexport',
  'stord': 'Stord',

  // Climate / Energy
  'watershed': 'Watershed',
  'patch': 'Patch',
  'arcadia': 'Arcadia',
  'leap': 'Leap',

  // Defense / Aerospace
  'anduril': 'Anduril',
  'shield-ai': 'Shield AI',
  'joby': 'Joby Aviation',
  'archer': 'Archer Aviation',

  // Other notable
  'canva': 'Canva',
  'grammarly': 'Grammarly',
  'duolingo': 'Duolingo',
  'quizlet': 'Quizlet',
  'discord': 'Discord',
  'roblox': 'Roblox',
  'figma': 'Figma',
  'webflow': 'Webflow',
  'framer': 'Framer',
  'bubble': 'Bubble',
  'airtable': 'Airtable',
  'asana': 'Asana',
  'lattice': 'Lattice',
  'rippling': 'Rippling',
  'gusto': 'Gusto',
  'checkr': 'Checkr',
  'gem': 'Gem',
  'ashby': 'Ashby',
  'greenhouse': 'Greenhouse',
  'lever': 'Lever',
  'clio': 'Clio',
  'ironclad': 'Ironclad',
  'opendoor': 'Opendoor',
  'compass': 'Compass',
  'lemonade': 'Lemonade',
  'root': 'Root Insurance',
  'coalition': 'Coalition',
  'lyft': 'Lyft',
  'doordash': 'DoorDash',
  'instacart': 'Instacart',
  'airbnb': 'Airbnb',
  'stripe': 'Stripe',
  'coinbase': 'Coinbase',
  'robinhood': 'Robinhood',
  'chime': 'Chime',
  'affirm': 'Affirm',
  'marqeta': 'Marqeta',
  'carta': 'Carta',
  'ripple': 'Ripple',
  'kraken': 'Kraken',
  'fireblocks': 'Fireblocks',
  'amplitude': 'Amplitude',
  'mixpanel': 'Mixpanel',
  'segment': 'Segment',
  'braze': 'Braze',
  'klaviyo': 'Klaviyo',
  'iterable': 'Iterable',
  'sendbird': 'Sendbird',
  'twilio': 'Twilio',
  'cloudflare': 'Cloudflare',
  'fastly': 'Fastly',
  'mongodb': 'MongoDB',
  'confluent': 'Confluent',
  'databricks': 'Databricks',
  'snowflake': 'Snowflake',
  'palantir': 'Palantir',
  'pagerduty': 'PagerDuty',
  'datadog': 'Datadog',
  'newrelic': 'New Relic',
  'sentry': 'Sentry',
  'hubspot': 'HubSpot',
  'zendesk': 'Zendesk',
  'dropbox': 'Dropbox',
  'box': 'Box',
  'okta': 'Okta',
  'crowdstrike': 'CrowdStrike',
  'sentinelone': 'SentinelOne',
  'zscaler': 'Zscaler',

  // AI / ML (more)
  'mistral': 'Mistral AI',
  'cohere-for-ai': 'Cohere for AI',
  'pika': 'Pika',
  'luma-ai': 'Luma AI',
  'eleven-labs': 'ElevenLabs',
  'synthesia': 'Synthesia',
  'heygen': 'HeyGen',
  'typeface': 'Typeface',
  'writer': 'Writer',
  'jasper': 'Jasper',
  'copy-ai': 'Copy.ai',
  'glean': 'Glean',
  'moveworks': 'Moveworks',
  'nexusflow': 'NexusFlow',
  'contextual-ai': 'Contextual AI',
  'comet-ml': 'CometML',
  'cleanlab': 'Cleanlab',
  'snorkelai': 'Snorkel AI',
  'scale': 'Scale AI',
  'labelbox': 'Labelbox',
  'aquarium': 'Aquarium',
  'landing-ai': 'Landing AI',
  'c3-ai': 'C3.ai',
  'datarobot': 'DataRobot',
  'h2oai': 'H2O.ai',
  'weights-biases': 'Weights & Biases',

  // Dev Tools (more)
  'tiptap': 'Tiptap',
  'clerk': 'Clerk',
  'nango': 'Nango',
  'merge': 'Merge',
  'apideck': 'Apideck',
  'codat': 'Codat',
  'lithic': 'Lithic',
  'modern-treasury': 'Modern Treasury',
  'treasury-prime': 'Treasury Prime',
  'unit': 'Unit',
  'synctera': 'Synctera',
  'bond': 'Bond',
  'apto-payments': 'Apto Payments',

  // SaaS (more)
  'attio': 'Attio',
  'folk': 'Folk',
  'close': 'Close',
  'instantly': 'Instantly',
  'lemlist': 'lemlist',
  'smartlead': 'Smartlead',
  'chorus': 'Chorus',
  'boomerang': 'Boomerang',
  'mixmax': 'Mixmax',
  'shortwave': 'Shortwave',

  // Security (more)
  'orca-security': 'Orca Security',
  'noname-security': 'Noname Security',
  'apiiro': 'Apiiro',
  'cyera': 'Cyera',
  'normalyze': 'Normalyze',
  'flow-security': 'Flow Security',
  'dig-security': 'Dig Security',
  'sentra': 'Sentra',
  'laminar': 'Laminar',
  'polar-security': 'Polar Security',

  // Defense / Aerospace (more)
  'joby-aviation': 'Joby Aviation',
  'archer-aviation': 'Archer Aviation',
  'wisk': 'Wisk',
  'overair': 'Overair',
  'electra': 'Electra',
  'beta-technologies': 'BETA Technologies',
  'lilium': 'Lilium',

  // Climate / Energy (more)
  'northvolt': 'Northvolt',
  'redwood-materials': 'Redwood Materials',
  'ascend-elements': 'Ascend Elements',
  'form-energy': 'Form Energy',
  'ambri': 'Ambri',
  'eos-energy': 'EOS Energy',
  'energy-vault': 'Energy Vault',
  'verdant-power': 'Verdant Power',
  'hydrostor': 'Hydrostor',
  'rwe': 'RWE',

  // Healthcare (more)
  'tempus': 'Tempus',
  'flatiron': 'Flatiron Health',
  'veeva': 'Veeva',
  'medidata': 'Medidata',
  'komodo-health': 'Komodo Health',
  'health-catalyst': 'Health Catalyst',
  'definitive-healthcare': 'Definitive Healthcare',
  'innovalon': 'Innovalon',
  'nuvation-bio': 'Nuvation Bio',
  'relay-therapeutics': 'Relay Therapeutics',
  'insitro': 'Insitro',
  'absci': 'Absci',
  'insilico': 'Insilico Medicine',
};

const SOURCE = 'ashby';
const REQUEST_TIMEOUT_MS = 15_000;
const COMMON_CRAWL_TIMEOUT_MS = 15_000;
const VALIDATION_BATCH_SIZE = 20;
const VALIDATION_BATCH_DELAY_MS = 300;
const VALIDATION_MAX_ATTEMPTS = 3;
const VALIDATION_RETRY_DELAY_MS = 400;
const SCRAPE_BATCH_SIZE = 20;
const SCRAPE_BATCH_DELAY_MS = 200;
const SCRAPE_MAX_ATTEMPTS = 3;
const COMMON_CRAWL_LIMIT = 10_000;
const COMMON_CRAWL_INDEXES = [
  'CC-MAIN-2025-13-index',
  'CC-MAIN-2024-51-index',
] as const;
const GITHUB_SOURCE_URLS = [
  'https://raw.githubusercontent.com/ambicuity/New-Grad-Jobs/main/config.yml',
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
  'https://raw.githubusercontent.com/ReaVNaiL/New-Grad-2024/main/README.md',
  'https://raw.githubusercontent.com/speedyapply/JobSpy/main/README.md',
] as const;
const ASHBY_VALID_SLUG_CACHE_PATH = join(
  process.cwd(),
  'scrapers',
  'cache',
  'ashby-valid-slugs.json',
);
const ASHBY_URL_REGEX = /https?:\/\/jobs\.ashbyhq\.com\/[^\s)"'\]]+/gi;
const USER_AGENT = 'NextRole Job Aggregator (+https://nextrole-phi.vercel.app)';
const SHOULD_REFRESH_CACHE = process.argv.includes('--refresh');

const ADDITIONAL_ASHBY_COMPANIES = [
  'notion', 'linear', 'ramp', 'mercury', 'brex',
  'plaid', 'vercel', 'retool', 'figma', 'loom',
  'rippling', 'deel', 'remote', 'gusto', 'lattice',
  'glean', 'runway', 'modal', 'replit', 'cursor',
  'perplexity', 'mistral', 'cohere', 'together',
  'anyscale', 'weights-biases', 'huggingface', 'replicate',
  'scale-ai', 'labelbox', 'snorkel', 'cleanlab',
  'dbtlabs', 'hightouch', 'census', 'rudderstack',
  'airbyte', 'fivetran', 'matillion', 'stitch',
  'hex', 'mode', 'sigma', 'metabase', 'lightdash',
  'preset', 'evidence', 'streamlit', 'gradio',
  'supabase', 'neon', 'planetscale', 'turso',
  'railway', 'render', 'fly', 'northflank',
  'clerk', 'stytch', 'workos', 'auth0',
  'launchdarkly', 'statsig', 'growthbook', 'split',
  'posthog', 'june', 'mixpanel', 'amplitude',
  'segment', 'rudderstack', 'jitsu', 'snowplow',
  'sentry', 'datadog', 'honeycomb-io', 'grafana',
  'elastic', 'opensearch', 'typesense', 'meilisearch',
  'algolia', 'pinecone', 'weaviate', 'qdrant', 'chroma',
  'langchain', 'llamaindex', 'dust', 'fixie',
  'openai', 'anthropic', 'cohere', 'ai21',
  'pika', 'runway', 'stability', 'midjourney',
  'synthesia', 'heygen', 'captions', 'descript',
  'eleven-labs', 'assemblyai', 'deepgram', 'rev',
  'grammarly', 'jasper', 'copy-ai', 'writesonic',
  'notion', 'coda', 'obsidian', 'roam',
  'linear', 'height', 'plane', 'gitlab',
  'github', 'gitpod', 'codespaces', 'replit',
  'sourcegraph', 'tabnine', 'codeium', 'continue',
  'snyk', 'sonarqube', 'checkmarx', 'veracode',
  'lacework', 'orca-security', 'wiz', 'prisma-cloud',
  'crowdstrike', 'sentinelone', 'cylance', 'darktrace',
  'cloudflare', 'fastly', 'akamai', 'imperva',
  'tailscale', 'netbird', 'twingate', 'zscaler',
  'okta', 'auth0', 'ping', 'jumpcloud',
  '1password', 'bitwarden', 'keeper', 'dashlane',
  'hashicorp', 'pulumi', 'terraform', 'ansible',
  'docker', 'rancher', 'portainer', 'lens',
  'dataiku', 'domino', 'h2o', 'rapidminer',
  'databricks', 'snowflake', 'dbt', 'great-expectations',
  'feast', 'tecton', 'hopsworks', 'arize',
  'whylabs', 'aporia', 'fiddler', 'truera',
  'stripe', 'adyen', 'checkout', 'braintree',
  'marqeta', 'lithic', 'unit', 'column',
  'mercury', 'brex', 'ramp', 'airbase',
  'expensify', 'divvy', 'center', 'spendesk',
  'rippling', 'deel', 'remote', 'oyster',
  'gusto', 'justworks', 'paychex', 'paylocity',
  'lattice', 'leapsome', 'culture-amp', 'betterup',
  'notion', 'confluence', 'tettra', 'guru',
  'intercom', 'zendesk', 'freshdesk', 'kustomer',
  'gong', 'chorus', 'salesloft', 'outreach',
  'hubspot', 'marketo', 'pardot', 'klaviyo',
  'sendgrid', 'mailchimp', 'customer-io', 'braze',
  'segment', 'mparticle', 'tealium', 'lytics',
  'figma', 'sketch', 'framer', 'webflow',
  'squarespace', 'wix', 'shopify', 'bigcommerce',
  'contentful', 'sanity', 'prismic', 'storyblok',
  'vercel', 'netlify', 'cloudflare-pages', 'gatsby',
  'nextjs', 'remix', 'astro', 'nuxt',
  'temporal', 'conductor', 'prefect', 'airflow',
  'dagster', 'kedro', 'metaflow', 'flyte',
  'feast', 'hopsworks', 'tecton', 'fennel',
  'anduril', 'shield', 'palantir', 'primer',
  'scale', 'labelbox', 'encord', 'aquarium',
  'weights-biases', 'neptune', 'comet', 'mlflow',
  'bentoml', 'ray', 'modal', 'banana',
  'together', 'anyscale', 'mosaic', 'mosaicml',
  'inflection', 'adept', 'imbue', 'aleph-alpha',
  'stability', 'midjourney', 'adobe-firefly',
  'airtable', 'notion', 'coda', 'fibery',
  'clickup', 'asana', 'monday', 'basecamp',
  'todoist', 'things', 'omnifocus', 'craft',
  'bear', 'ulysses', 'ia-writer', 'typora',
  'roam', 'logseq', 'obsidian', 'remnote',
  'readwise', 'pocket', 'instapaper', 'matter',
  'superhuman', 'hey', 'fastmail', 'protonmail',
  'calendar', 'fantastical', 'motion', 'reclaim',
  'loom', 'zoom', 'whereby', 'mmhmm',
  'miro', 'mural', 'figjam', 'whimsical',
  'pitch', 'beautiful-ai', 'tome', 'gamma',
  'dovetail', 'maze', 'usertesting', 'hotjar',
  'fullstory', 'logrocket', 'datadog', 'dynatrace',
  'newrelic', 'splunk', 'sumo-logic', 'papertrail',
  'incident-io', 'pagerduty', 'opsgenie', 'victorops',
  'statuspage', 'atlassian', 'jira', 'confluence',
  'linear', 'shortcut', 'height', 'plane',
  'github', 'gitlab', 'bitbucket', 'azure-devops',
  'jenkins', 'circleci', 'travisci', 'buildkite',
] as const;

type AshbyValidSlugCache = Record<string, string>;

type AshbyBoardJob = {
  id?: string;
  title?: string;
  employmentType?: string | null;
  location?: string | null;
  isListed?: boolean | null;
  isRemote?: boolean | null;
  workplaceType?: string | null;
  descriptionPlain?: string | null;
  jobUrl?: string | null;
  applyUrl?: string | null;
  publishedAt?: string | null;
  compensation?: {
    scrapeableCompensationSalarySummary?: string | null;
  } | null;
};

type AshbyBoardResponse = {
  jobs?: AshbyBoardJob[];
  apiVersion?: string;
};

type FetchTextResult = {
  ok: boolean;
  status: number;
  text: string;
  timedOut: boolean;
};

type CommonCrawlDiscoveryResult = {
  hitLimit: boolean;
  slugs: Set<string>;
  timedOut: boolean;
};

/**
 * Parse salary summary strings like "$120K - $150K", "$80K – $100K", "$50/hr"
 * into numeric min/max annual values.
 */
function parseSalary(summary?: string): { min?: number; max?: number } {
  if (!summary) return {};

  const clean = summary.replace(/,/g, '');

  // Hourly: "$50/hr" or "$50/hour"
  const hourlyMatch = clean.match(/\$?([\d.]+)\s*\/\s*hr/i);
  if (hourlyMatch) {
    const annual = Math.round(parseFloat(hourlyMatch[1]) * 2080);
    return { min: annual, max: annual };
  }

  // Range with K suffix: "$120K - $150K" or "$80K – $100K"
  const rangeKMatch = clean.match(/\$?([\d.]+)K?\s*[-–]\s*\$?([\d.]+)K/i);
  if (rangeKMatch) {
    const mult = (v: string) => Math.round(parseFloat(v) * 1000);
    return { min: mult(rangeKMatch[1]), max: mult(rangeKMatch[2]) };
  }

  // Single value with K suffix: "$120K"
  const singleKMatch = clean.match(/\$?([\d.]+)K/i);
  if (singleKMatch) {
    const val = Math.round(parseFloat(singleKMatch[1]) * 1000);
    return { min: val, max: val };
  }

  // Plain dollar range: "$120000 - $150000"
  const plainRangeMatch = clean.match(/\$?([\d]+)\s*[-–]\s*\$?([\d]+)/);
  if (plainRangeMatch) {
    return {
      min: parseInt(plainRangeMatch[1], 10),
      max: parseInt(plainRangeMatch[2], 10),
    };
  }

  return {};
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function normalizeAshbySlug(rawSlug: string): string | null {
  let decoded = rawSlug.trim();

  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }

  const slug = decoded.toLowerCase().trim();
  if (slug.length < 2 || slug.length > 100) return null;
  if (/^\d+$/.test(slug)) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) return null;

  return slug;
}

function humanizeAshbySlug(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function extractAshbySlugFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'jobs.ashbyhq.com') return null;

    const [firstPathSegment] = url.pathname.split('/').filter(Boolean);
    return firstPathSegment ? normalizeAshbySlug(firstPathSegment) : null;
  } catch {
    return null;
  }
}

async function fetchTextWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<FetchTextResult> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: '*/*',
        'User-Agent': USER_AGENT,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    return {
      ok: res.ok,
      status: res.status,
      text: await res.text(),
      timedOut: false,
    };
  } catch (error) {
    const timedOut = isTimeoutError(error);

    return {
      ok: false,
      status: 0,
      text: '',
      timedOut,
    };
  }
}

async function loadAshbyValidSlugCache(): Promise<AshbyValidSlugCache> {
  try {
    const raw = await readFile(ASHBY_VALID_SLUG_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([slug, companyName]) => {
          const normalizedSlug = normalizeAshbySlug(slug);
          const normalizedCompanyName =
            typeof companyName === 'string' ? companyName.trim() : '';

          return normalizedSlug && normalizedCompanyName
            ? [normalizedSlug, normalizedCompanyName]
            : null;
        })
        .filter((entry): entry is [string, string] => entry !== null),
    );
  } catch {
    return {};
  }
}

async function saveAshbyValidSlugCache(cache: AshbyValidSlugCache): Promise<void> {
  await mkdir(join(process.cwd(), 'scrapers', 'cache'), { recursive: true });
  await writeFile(ASHBY_VALID_SLUG_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
}

function collectAshbySlugsFromText(text: string): Set<string> {
  const slugs = new Set<string>();

  for (const match of text.matchAll(ASHBY_URL_REGEX)) {
    const slug = extractAshbySlugFromUrl(match[0]);
    if (slug) {
      slugs.add(slug);
    }
  }

  return slugs;
}

async function discoverAshbySlugsFromGitHub(): Promise<Set<string>> {
  const discoveredSlugs = new Set<string>();

  for (const url of GITHUB_SOURCE_URLS) {
    console.log(`  [${SOURCE}] Fetching GitHub slug source: ${url}`);
    const result = await fetchTextWithTimeout(url);
    console.log(
      `  [${SOURCE}] GitHub slug source status=${result.status}` +
        (result.timedOut ? ' timeout=true' : '') +
        `: ${url}`,
    );
    if (!result.ok) {
      const reason = result.timedOut ? 'timed out' : `HTTP ${result.status}`;
      console.warn(`  [${SOURCE}] GitHub slug source failed (${reason}): ${url}`);
      continue;
    }

    for (const slug of collectAshbySlugsFromText(result.text)) {
      discoveredSlugs.add(slug);
    }
  }

  return discoveredSlugs;
}

async function discoverAshbySlugsFromCommonCrawlIndex(
  index: typeof COMMON_CRAWL_INDEXES[number],
): Promise<CommonCrawlDiscoveryResult> {
  const url =
    `https://index.commoncrawl.org/${index}` +
    `?url=jobs.ashbyhq.com%2F*&output=json&limit=${COMMON_CRAWL_LIMIT}`;
  console.log(`  [${SOURCE}] Fetching Common Crawl index: ${index}`);
  const result = await fetchTextWithTimeout(url, {}, COMMON_CRAWL_TIMEOUT_MS);
  console.log(
    `  [${SOURCE}] Common Crawl ${index} status=${result.status}` +
      (result.timedOut ? ' timeout=true' : ''),
  );

  if (!result.ok) {
    if (!result.timedOut && result.status !== 504) {
      console.warn(`  [${SOURCE}] Common Crawl ${index} failed with HTTP ${result.status}`);
    }

    return {
      hitLimit: false,
      slugs: new Set<string>(),
      timedOut: result.timedOut || result.status === 504,
    };
  }

  if (result.text.trimStart().startsWith('<')) {
    return {
      hitLimit: false,
      slugs: new Set<string>(),
      timedOut: result.status === 504,
    };
  }

  const slugs = new Set<string>();
  let rowCount = 0;

  for (const line of result.text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    rowCount += 1;

    try {
      const record = JSON.parse(trimmed) as { url?: string };
      if (typeof record.url !== 'string') continue;

      const slug = extractAshbySlugFromUrl(record.url);
      if (slug) {
        slugs.add(slug);
      }
    } catch {
      // Skip malformed JSONL rows from the index response.
    }
  }

  return {
    hitLimit: rowCount >= COMMON_CRAWL_LIMIT,
    slugs,
    timedOut: false,
  };
}

async function discoverAshbySlugsFromCommonCrawl(): Promise<Set<string>> {
  const discoveredSlugs = new Set<string>();
  const primary = await discoverAshbySlugsFromCommonCrawlIndex(COMMON_CRAWL_INDEXES[0]);

  for (const slug of primary.slugs) {
    discoveredSlugs.add(slug);
  }

  if (primary.timedOut || primary.hitLimit) {
    const fallback = await discoverAshbySlugsFromCommonCrawlIndex(COMMON_CRAWL_INDEXES[1]);
    for (const slug of fallback.slugs) {
      discoveredSlugs.add(slug);
    }
  }

  return discoveredSlugs;
}

async function validateAshbySlug(
  slug: string,
): Promise<{ companyName: string | null; slug: string }> {
  for (let attempt = 1; attempt <= VALIDATION_MAX_ATTEMPTS; attempt += 1) {
    console.log(`  [${SOURCE}] Validating slug ${slug} (attempt ${attempt}/${VALIDATION_MAX_ATTEMPTS})`);
    const result = await fetchTextWithTimeout(
      `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    );
    console.log(
      `  [${SOURCE}] Validation fetch for ${slug} status=${result.status}` +
        (result.timedOut ? ' timeout=true' : ''),
    );

    if (result.status === 404) {
      console.log(`  [${SOURCE}] Skipping slug ${slug} because validation returned 404`);
      return { companyName: null, slug };
    }

    if (result.ok) {
      try {
        const response = JSON.parse(result.text) as AshbyBoardResponse;
        const companyName =
          COMPANIES[slug] ??
          humanizeAshbySlug(slug);

        if (Array.isArray(response.jobs)) {
          console.log(
            `  [${SOURCE}] Validation succeeded for ${slug} -> ${companyName}; rawJobs=${response.jobs.length}`,
          );
          return { companyName, slug };
        }
      } catch {
        console.log(`  [${SOURCE}] ${slug}: failed to parse validation JSON`);
      }
    }

    if (attempt < VALIDATION_MAX_ATTEMPTS && (result.timedOut || result.status === 0 || result.status === 429 || result.status >= 500)) {
      const backoffMs = VALIDATION_RETRY_DELAY_MS * (2 ** (attempt - 1));
      console.log(`  [${SOURCE}] ${slug}: retrying validation after ${backoffMs}ms`);
      await sleep(backoffMs);
      continue;
    }

    console.log(`  [${SOURCE}] Skipping slug ${slug} due to validation error`);
    return { companyName: null, slug };
  }

  return { companyName: null, slug };
}

async function fetchCompany(slug: string, companyName: string): Promise<NormalizedJob[]> {
  console.log(`  [${SOURCE}] Starting company: ${slug} (${companyName})`);

  let data: AshbyBoardResponse | null = null;

  for (let attempt = 1; attempt <= SCRAPE_MAX_ATTEMPTS; attempt += 1) {
    const result = await fetchTextWithTimeout(
      `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    );

    console.log(
      `  [${SOURCE}] ${slug}: fetch attempt ${attempt}/${SCRAPE_MAX_ATTEMPTS} status=${result.status}` +
        (result.timedOut ? ' timeout=true' : ''),
    );

    if (result.ok) {
      try {
        data = JSON.parse(result.text) as AshbyBoardResponse;
        console.log(
          `  [${SOURCE}] ${slug}: fetch succeeded with status=${result.status}; rawJobs=${data.jobs?.length ?? 0}`,
        );
        break;
      } catch {
        console.log(`  [${SOURCE}] ${slug}: failed to parse response JSON`);
      }
    }

    if (attempt < SCRAPE_MAX_ATTEMPTS && (result.timedOut || result.status === 0 || result.status === 429 || result.status >= 500)) {
      const backoffMs = VALIDATION_RETRY_DELAY_MS * attempt;
      console.log(`  [${SOURCE}] ${slug}: retrying after ${backoffMs}ms`);
      await sleep(backoffMs);
      continue;
    }

    console.log(`  [${SOURCE}] Skipping company ${slug} due to fetch error`);
    return [];
  }

  const jobs = data?.jobs ?? [];
  const normalized: NormalizedJob[] = [];

  for (const job of jobs) {
    const title = (job.title ?? '').trim();
    const sourceId = (job.id ?? '').trim();
    const url = (job.jobUrl ?? job.applyUrl ?? '').trim();
    const location = (job.location ?? 'Remote').trim() || 'Remote';

    if (!title || !sourceId || !url) continue;
    if (job.isListed === false) continue;
    if (job.employmentType === 'PartTime' || job.employmentType === 'Contract') continue;
    if (isNonUsLocation(location)) continue;

    const description = (job.descriptionPlain ?? '').trim();
    const level = inferExperienceLevel(title, description);
    if (level === null) continue;

    const remote =
      job.isRemote === true ||
      job.workplaceType === 'Remote' ||
      inferRemote(location);
    const { min, max } = parseSalary(job.compensation?.scrapeableCompensationSalarySummary ?? undefined);

    normalized.push({
      source: SOURCE,
      source_id: sourceId,
      title,
      company: companyName,
      location,
      remote,
      url,
      description: description || undefined,
      salary_min: min,
      salary_max: max,
      experience_level: level,
      roles: inferRoles(title),
      posted_at: job.publishedAt ?? undefined,
      dedup_hash: generateHash(companyName, title, location),
    });
  }

  if (normalized.length > 0) {
    console.log(`    [${SOURCE}] ${companyName}: ${normalized.length} jobs`);
  } else {
    console.log(`  [${SOURCE}] ${slug}: no qualifying jobs after normalization`);
  }

  return normalized;
}

export async function scrapeAshby(): Promise<NormalizedJob[]> {
  console.log(`  [${SOURCE}] Starting scrape`);
  if (SHOULD_REFRESH_CACHE) {
    console.log(`  [${SOURCE}] --refresh detected; ignoring cached valid slugs and rebuilding cache`);
  }

  const cachedValidSlugs = SHOULD_REFRESH_CACHE
    ? {}
    : await loadAshbyValidSlugCache();
  const cachedSlugs = new Set(
    Object.keys(cachedValidSlugs)
      .map(normalizeAshbySlug)
      .filter((slug): slug is string => slug !== null),
  );

  const existingSeedSlugs = new Set(
    Object.keys(COMPANIES)
      .map(normalizeAshbySlug)
      .filter((slug): slug is string => slug !== null),
  );
  const curatedSlugs = new Set(
    ADDITIONAL_ASHBY_COMPANIES
      .map(normalizeAshbySlug)
      .filter((slug): slug is string => slug !== null),
  );
  console.log(`  [${SOURCE}] Cached valid slugs loaded: ${cachedSlugs.size}`);

  let commonCrawlSlugs = new Set<string>();
  let githubSlugs = new Set<string>();
  let candidateSlugs: string[] = [];
  let slugsToValidate: string[] = [];
  const newlyValidatedSlugs: AshbyValidSlugCache = {};

  if (!SHOULD_REFRESH_CACHE && cachedSlugs.size > 0) {
    candidateSlugs = Array.from(cachedSlugs);
    console.log(`  [${SOURCE}] Using cached valid slugs only for standard run; skipping discovery and validation`);
  } else {
    [commonCrawlSlugs, githubSlugs] = await Promise.all([
      discoverAshbySlugsFromCommonCrawl(),
      discoverAshbySlugsFromGitHub(),
    ]);

    candidateSlugs = Array.from(
      new Set<string>([
        ...existingSeedSlugs,
        ...commonCrawlSlugs,
        ...githubSlugs,
        ...curatedSlugs,
        ...cachedSlugs,
      ]),
    );
    slugsToValidate = candidateSlugs.filter(slug => !cachedValidSlugs[slug]);

    for (let index = 0; index < slugsToValidate.length; index += VALIDATION_BATCH_SIZE) {
      const batch = slugsToValidate.slice(index, index + VALIDATION_BATCH_SIZE);
      const results = await Promise.all(batch.map(validateAshbySlug));

      for (const result of results) {
        if (result.companyName) {
          newlyValidatedSlugs[result.slug] = result.companyName;
        }
      }

      if (index + VALIDATION_BATCH_SIZE < slugsToValidate.length) {
        await sleep(VALIDATION_BATCH_DELAY_MS);
      }
    }
  }

  const validSlugCache = SHOULD_REFRESH_CACHE
    ? newlyValidatedSlugs
    : {
        ...cachedValidSlugs,
        ...newlyValidatedSlugs,
      };
  if (SHOULD_REFRESH_CACHE || Object.keys(newlyValidatedSlugs).length > 0) {
    await saveAshbyValidSlugCache(validSlugCache);
  }

  const validSlugEntries = candidateSlugs.reduce<Array<{ companyName: string; slug: string }>>(
    (entries, slug) => {
      const companyName = validSlugCache[slug];
      if (companyName) {
        entries.push({ companyName, slug });
      }

      return entries;
    },
    [],
  );

  const all: NormalizedJob[] = [];
  let companiesWithJobs = 0;

  for (let index = 0; index < validSlugEntries.length; index += SCRAPE_BATCH_SIZE) {
    const batch = validSlugEntries.slice(index, index + SCRAPE_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(({ slug, companyName }) => fetchCompany(slug, companyName)),
    );

    for (const jobs of results) {
      if (jobs.length > 0) {
        companiesWithJobs += 1;
      }

      all.push(...jobs);
    }

    if (index + SCRAPE_BATCH_SIZE < validSlugEntries.length) {
      await sleep(SCRAPE_BATCH_DELAY_MS);
    }
  }

  console.log(`  [${SOURCE}] Existing seed slugs: ${existingSeedSlugs.size}`);
  console.log(`  [${SOURCE}] Common Crawl discovered: ${commonCrawlSlugs.size}`);
  console.log(`  [${SOURCE}] GitHub discovered: ${githubSlugs.size}`);
  console.log(`  [${SOURCE}] Curated additions: ${curatedSlugs.size}`);
  console.log(`  [${SOURCE}] Cached valid slugs loaded: ${cachedSlugs.size}`);
  console.log(`  [${SOURCE}] Cached valid slugs reused: ${candidateSlugs.length - slugsToValidate.length}`);
  console.log(`  [${SOURCE}] Newly validated this run: ${Object.keys(newlyValidatedSlugs).length}`);
  console.log(`  [${SOURCE}] Total slugs attempted: ${candidateSlugs.length}`);
  console.log(`  [${SOURCE}] Valid slugs found: ${validSlugEntries.length}`);
  console.log(`  [${SOURCE}] Companies with jobs: ${companiesWithJobs}`);
  console.log(`  [${SOURCE}] Total jobs fetched: ${all.length}`);
  console.log(`  [${SOURCE}] Final count: ${all.length}`);

  return all;
}

async function runStandalone(): Promise<void> {
  const startedAt = Date.now();

  const jobs = await scrapeAshby();
  await uploadJobs(jobs);
  await deactivateStaleJobs(SOURCE, jobs.map(job => job.dedup_hash));

  const elapsedSeconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
  console.log(`  [${SOURCE}] Standalone run completed in ${elapsedSeconds}s`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runStandalone().catch((error) => {
    console.error(`  [${SOURCE}] Standalone run failed`, error);
    process.exit(1);
  });
}

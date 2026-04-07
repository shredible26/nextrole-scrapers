// Source: https://api.ashbyhq.com/posting-api/job-board/{slug}
// Fully public API — no auth, no key. Similar to Greenhouse.
// Strategy: fire all company fetches concurrently with a small stagger.

import { generateHash } from '../utils/dedup';
import { inferRoles, inferRemote, inferExperienceLevel, NormalizedJob } from '../utils/normalize';

// Non-US location signals — skip these to keep the feed US-focused
const NON_US_LOCATION_SIGNALS = [
  'india', 'bangalore', 'hyderabad', 'mumbai', 'chennai', 'pune',
  'berlin', 'london', 'toronto', 'montreal', 'sydney', 'singapore',
  'dublin', 'amsterdam', 'paris', 'tokyo', 'beijing', 'shanghai',
  ' uk', ' uk,', 'united kingdom', 'canada', 'australia',
  'germany', 'france', 'netherlands', 'ireland', 'mexico',
  'brazil', 'argentina', 'colombia', 'chile',
];

/**
 * Returns true if the location signals a non-US office.
 * Keeps jobs that are US-based, remote, or have no clear location signal.
 */
function isNonUsLocation(location: string): boolean {
  if (!location) return false;
  const lower = location.toLowerCase();
  if (lower.includes('remote') || lower.includes('united states') || lower.includes('usa')) {
    return false;
  }
  return NON_US_LOCATION_SIGNALS.some(signal => lower.includes(signal));
}

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

async function fetchCompany(slug: string, companyName: string): Promise<NormalizedJob[]> {
  try {
    const res = await fetch(
      `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return [];

    const data = await res.json();
    const jobs: any[] = data.jobs ?? [];

    const normalized: NormalizedJob[] = [];
    for (const job of jobs) {
      // Skip part-time and contract roles
      if (job.employmentType === 'PartTime' || job.employmentType === 'Contract') continue;

      const description = job.descriptionPlain ?? '';
      const level = inferExperienceLevel(job.title ?? '', description);
      if (level === null) continue;

      const location: string = job.location ?? 'Remote';

      // Skip non-US locations
      if (isNonUsLocation(location)) continue;
      const remote: boolean = job.isRemote === true || job.workplaceType === 'Remote' || inferRemote(location);
      const { min, max } = parseSalary(job.compensation?.scrapeableCompensationSalarySummary);

      normalized.push({
        source: 'ashby',
        source_id: job.id,
        title: job.title,
        company: companyName,
        location,
        remote,
        url: job.jobUrl ?? '',
        description: description || undefined,
        salary_min: min,
        salary_max: max,
        experience_level: level,
        roles: inferRoles(job.title),
        posted_at: job.publishedAt ?? undefined,
        dedup_hash: generateHash(companyName, job.title, location),
      });
    }

    if (normalized.length > 0) {
      console.log(`    [ashby] ${companyName}: ${normalized.length} jobs`);
    }
    return normalized;
  } catch {
    return [];
  }
}

export async function scrapeAshby(): Promise<NormalizedJob[]> {
  const slugs = Object.entries(COMPANIES);
  const all: NormalizedJob[] = [];

  const results = await Promise.allSettled(
    slugs.map(async ([slug, name], i) => {
      await sleep(i * 50); // 50ms stagger
      return fetchCompany(slug, name);
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    }
  }

  return all;
}

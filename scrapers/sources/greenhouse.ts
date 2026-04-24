// Source: https://boards-api.greenhouse.io/v1/boards/{company}/jobs?content=true
// Fully public API — no auth, no key. Hundreds of tech companies use Greenhouse.
// Strategy: fire all company fetches concurrently; silently skip 404/500s.

import { pathToFileURL } from 'node:url';

import { generateHash } from '../utils/dedup';
import {
  finalizeNormalizedJob,
  inferRoles,
  inferRemote,
  inferExperienceLevel,
  NormalizedJob,
} from '../utils/normalize';
import { deactivateStaleJobs, uploadJobs } from '../utils/upload';

const stripHtml = (html: string): string => html.replace(/<[^>]*>/g, ' ');
const SOURCE = 'greenhouse';
const REQUEST_TIMEOUT_MS = 15_000;
const BOARD_TIMEOUT_MS = 5_000;
const BATCH_SIZE = 10;
const DELAY_MS = 200;
const MAX_FETCH_ATTEMPTS = 3;
const RETRYABLE_STATUS_CODES = new Set([0, 429, 500, 502, 503, 504]);
const USER_AGENT = 'NextRole Job Aggregator (+https://nextrole-phi.vercel.app)';

const BASE_GREENHOUSE_COMPANIES = [
  // Big Tech & FAANG-adjacent
  'google', 'meta', 'apple', 'netflix', 'spotify', 'twitter',
  'pinterest', 'snap', 'reddit', 'quora', 'medium',

  // Fintech
  'stripe', 'brex', 'ramp', 'plaid', 'robinhood', 'coinbase',
  'chime', 'affirm', 'marqeta', 'carta', 'mercury', 'deel',
  'rippling', 'gusto', 'justworks', 'lattice', 'remote',
  'adyen', 'navan', 'airbase', 'modern-treasury', 'column',
  'unit', 'treasury-prime', 'rho',
  'melio', 'tipalti', 'bill', 'expensify', 'divvy',
  'jeeves', 'parafin', 'capchase', 'clearco', 'pipe',
  'stytch', 'socure', 'alloy', 'sardine', 'unit21',
  'persona', 'middesk', 'onfido', 'jumio', 'idemia',

  // AI / ML Companies
  'openai', 'anthropic', 'cohere', 'scale-ai', 'weights-biases',
  'together', 'modal', 'replicate', 'runway', 'stability-ai',
  'perplexity', 'character', 'inflection', 'adept', 'imbue',
  'gradient', 'huggingface', 'labelbox', 'scale',
  'snorkel', 'aquarium', 'humanloop', 'brainlox',
  'dust', 'fixie', 'langchain', 'llamaindex',
  'vectara', 'weaviate', 'pinecone', 'chroma',
  'anyscale', 'ray', 'dstack', 'beam',
  'banana', 'cerebrium', 'baseten', 'modelbit',

  // Dev Tools / Infrastructure
  'vercel', 'netlify', 'render', 'railway',
  'hashicorp', 'pulumi', 'ansible', 'chef',
  'datadog', 'newrelic', 'honeycomb', 'observe',
  'pagerduty', 'incident-io', 'firehydrant', 'blameless',
  'sentry', 'rollbar', 'bugsnag', 'logrocket', 'highlight',
  'retool', 'airplane', 'internal', 'tooljet', 'appsmith',
  'postman', 'apigee', 'kong', 'tyk',
  'github', 'gitlab', 'linear', 'shortcut', 'height', 'plane',
  'figma', 'framer', 'webflow', 'bubble', 'adalo',
  'dbt', 'fivetran', 'airbyte', 'hightouch', 'census',
  'amplitude', 'mixpanel', 'segment', 'heap', 'fullstory',
  'posthog', 'june', 'koala', 'pendo', 'appcues',
  'launchdarkly', 'flagsmith', 'growthbook', 'statsig',
  'percy', 'chromatic', 'lost-pixel',
  'clerk', 'auth0', 'okta', 'jumpcloud',
  'doppler', 'infisical', 'vault',
  'grafana', 'influxdata', 'timescale',
  'mongodb', 'redis', 'cockroachdb', 'yugabyte',
  'planetscale', 'neon', 'xata', 'turso',
  'upstash', 'convex', 'fauna',

  // SaaS / Productivity
  'notion', 'coda', 'airtable', 'smartsheet', 'monday',
  'asana', 'clickup', 'todoist', 'ticktick',
  'slack', 'discord', 'loom', 'miro', 'mural', 'excalidraw',
  'zoom', 'calendly', 'doodle', 'reclaim', 'clockwise',
  'hubspot', 'salesloft', 'outreach', 'apollo', 'clay',
  'gong', 'chorus', 'wingman', 'clari',
  'zendesk', 'intercom', 'freshdesk', 'front', 'helpscout',
  'drift', 'qualified', 'chili-piper',
  'twilio', 'sendgrid', 'mailchimp', 'klaviyo', 'iterable',
  'braze', 'onesignal', 'airship', 'pushwoosh',
  'contentful', 'sanity', 'strapi', 'directus',
  'cloudinary', 'imgix', 'uploadcare',

  // Security / Compliance
  'crowdstrike', 'sentinelone', 'lacework', 'orca', 'wiz',
  'snyk', 'veracode', 'checkmarx', 'sonarqube', 'semgrep',
  'vanta', 'drata', 'secureframe', 'thoropass', 'laika',
  'zscaler', 'netskope', 'cato-networks', 'palo-alto-networks',
  'abnormal', 'proofpoint', 'mimecast', 'cofense',
  'cobalt', 'synack', 'bugcrowd', 'hackerone',

  // Data / Analytics / BI
  'snowflake', 'databricks', 'confluent', 'starburst', 'dremio',
  'immuta', 'privacera', 'alation', 'atlan', 'data-catalog',
  'looker', 'metabase', 'mode', 'sigma', 'lightdash',
  'hex', 'deepnote', 'observable', 'evidence',
  'monte-carlo', 'great-expectations', 'soda', 'acceldata',
  'mozart-data', 'y42', 'portable',

  // Cloud / Networking
  'cloudflare', 'fastly', 'akamai', 'bunny', 'section',
  'wasabi', 'backblaze', 'storj',
  'tailscale', 'twingate', 'ngrok', 'bore',

  // E-commerce / Retail / Logistics
  'shopify', 'bigcommerce', 'nacelle', 'elasticpath',
  'faire', 'ankorstore', 'orderchamp',
  'toast', 'lightspeed', 'revel',
  'doordash', 'instacart', 'gopuff', 'getir',
  'airbnb', 'vrbo', 'vacasa', 'evolve', 'owner',
  'flexport', 'stord', 'shipbob', 'shiphero',
  'project44', 'fourkites', 'samsara', 'motive',
  'transfix', 'loadsmart', 'convoy', 'uber-freight',

  // HealthTech / BioTech
  'oscar', 'devoted', 'cityblock', 'alignment',
  'hims', 'ro', 'keeps', 'hers', 'nurx', 'wheel',
  'tempus', 'flatiron', 'veeva', 'medidata', 'iqvia',
  'headspace', 'calm', 'betterhelp', 'talkspace', 'brightline',
  'zocdoc', 'doximity', 'athenahealth',
  'color', 'invitae', 'guardant', 'grail',
  'benchling', 'labguru', 'dotmatics',
  'recursion', 'insitro',

  // EdTech
  'duolingo', 'coursera', 'udemy', 'masterclass',
  'chegg', 'brilliant', 'outschool', 'synthesis',
  'instructure', 'powerschool', 'd2l',
  'codeacademy', 'scrimba', 'frontendmasters',

  // Climate / Energy / Sustainability
  'watershed', 'patch', 'persefoni', 'normative',
  'arcadia', 'voltus', 'leap', 'recurve', 'autogrid',
  'sunrun', 'sunnova', 'palmetto', 'solar-landscape',
  'redwood-materials', 'ascend-elements',
  'form-energy', 'ambri', 'eos-energy',
  'pachama', 'terrasos', 'vibrant-planet',
  'climateai', 'salient-predictions', 'tomorrow',

  // Defense / Aerospace / Robotics
  'anduril', 'palantir', 'shield-ai',
  'relativity-space', 'rocket-lab', 'astra', 'planet',
  'joby', 'wisk', 'archer', 'lilium', 'vertical',
  'boston-dynamics', 'agility', 'figure', 'apptronik',
  'locus-robotics', '6river', 'berkshire-grey',
  'pickle-robot', 'covariant', 'machina-labs',

  // Autonomous Vehicles
  'waymo', 'cruise', 'zoox', 'aurora', 'motional',
  'nuro', 'gatik', 'torc', 'embark', 'kodiak',
  'mobileye', 'aeye', 'innoviz', 'ouster',

  // Gaming / Entertainment / Media
  'roblox', 'unity', 'niantic', 'scopely', 'jam-city',
  'kabam', 'glu', 'zynga', 'playtika', 'king',
  'epic-games', 'riot-games', 'bungie', '2k',
  'twitch', 'mixer', 'streamlabs',

  // HR Tech / People Ops
  'leapsome', 'culture-amp', '15five', 'betterworks', 'reflektive',
  'greenhouse-software', 'lever-co', 'workable', 'ashby',
  'gem', 'fetcher', 'beamery', 'eightfold',
  'checkr', 'sterling', 'hireright',

  // Legal / RegTech
  'clio', 'mycase', 'filevine', 'litify',
  'lawmatics', 'smokeball', 'practicepanther',
  'ironclad', 'contractpodai', 'icertis', 'agiloft',

  // Real Estate / PropTech
  'opendoor', 'offerpad', 'homeward', 'orchard', 'flyhomes',
  'compass', 'side', 'real', 'fathom',
  'buildium', 'appfolio', 'yardi', 'mri',
  'costar', 'crexi', 'vts', 'hqo',

  // Insurance / Risk
  'lemonade', 'root', 'hippo', 'branch', 'clearcover',
  'next-insurance', 'coalition', 'at-bay',
  'pie-insurance', 'coterie', 'employers',

  // Marketing Tech / AdTech
  'the-trade-desk', 'magnite', 'pubmatic', 'criteo',
  'digitalocean', 'linode', 'vultr',
  'sprinklr', 'hootsuite', 'buffer', 'later',
  'semrush', 'ahrefs', 'moz', 'brightedge',
  'conductor', 'botify', 'searchmetrics',
];

// Verified Greenhouse slugs parsed from:
// - ambicuity/New-Grad-Jobs config.yml
// - SimplifyJobs/Summer2025-Internships listings.json
// - pittcsc/Summer2022-Internships README.md
const CURATED_GREENHOUSE_COMPANIES = [
  '10alabs', '10beauty', '10xgenomics', '1800contacts', '8451university',
  'abacusinsights', 'abdielcapital', 'abelsontaylor', 'accuweather',
  'acluinternships', 'ada18', 'adcouncil', 'aechelontechnology',
  'aevexaerospace', 'agencywithin', 'agilespaceindustries',
  'agwestfarmcredit', 'aircapture', 'alamarbiosciences', 'alarmcom',
  'align46', 'alku', 'aloyoga', 'ampsortation', 'andurilindustries',
  'antora', 'aperaaiinc', 'apexcompanies', 'appian',
  'appliedintuition', 'aquaticcapitalmanagement', 'arcboatcompany',
  'arcellx', 'arcesiumllc', 'archer56', 'armada', 'arvinas',
  'assuredguaranty', 'asteraearlycareer', 'asteraearlycareer2026',
  'astranis', 'athinkingape', 'atlassand', 'atlassp',
  'attainpartners', 'attentionarc', 'auctane', 'audaxgroup',
  'authenticbrandsgroup', 'avalabs', 'avepoint', 'awetomaton',
  'axios', 'axon', 'axontalentcommunity', 'axq', 'axs',
  'axsometherapeutics', 'aypapower', 'babelstreet',
  'baltimoreorioles', 'bamboohr17', 'bandwidth', 'baselayer',
  'beamtherapeutics', 'bedrockrobotics', 'betterhelpcom', 'bgeinc',
  'bgeinccampus', 'billiontoone', 'biomedrealty',
  'bitgointernships', 'blackedgecapital', 'blacksky', 'blockchain',
  'bloombergdotorg', 'bluelabsanalyticsinc', 'blueskyinnovators',
  'bluestaq', 'boomsupersonic', 'botauto', 'boxinc',
  'bracebridgecapital', 'brave', 'breezeairways', 'brevium',
  'businessolverinvitationonly', 'cadencesolutions', 'calyxo',
  'campusopportunities', 'capitalrx', 'capitaltg', 'carbondirect',
  'cartesiansystems', 'celestialai', 'cellsignalingtechnology79',
  'celonis', 'censys',
];

const ADDITIONAL_GREENHOUSE_COMPANIES = [
  'abnormalsecurity', 'affirm', 'airtable', 'alchemy',
  'algolia', 'amplitude', 'anduril', 'anthropic', 'asana',
  'benchling', 'brex', 'calm', 'carta', 'cerebral',
  'chainalysis', 'checkr', 'chime', 'chronosphere', 'circle',
  'circleci', 'cityblock', 'clickhouse', 'cloudflare',
  'cloudinary', 'cockroachlabs', 'coinbase', 'color',
  'column', 'contentful', 'coursera', 'cruise', 'cultureamp',
  'databricks', 'datadog', 'deel', 'devotedhealth', 'dialpad',
  'discord', 'dropbox', 'duolingo', 'elastic', 'epicgames',
  'faire', 'fastly', 'figma', 'fireblocks', 'fivetran',
  'flatironhealth', 'flexport', 'gemini', 'getaround',
  'gitlab', 'goat', 'grafanalabs', 'grammarly', 'gusto',
  'hashicorp', 'heap', 'himsandhers', 'honeycomb',
  'huntress', 'imply', 'instacart', 'intercom', 'jamcity',
  'justworks', 'khanaacademy', 'kraken', 'lattice',
  'launchdarkly', 'lever', 'lime', 'linkedin', 'locus',
  'lucidmotors', 'lyft', 'marqeta', 'mckinsey',
  'mercury', 'miro', 'mixpanel', 'moderntreasury',
  'mongodb', 'moveworks', 'mux', 'netlify', 'niantic',
  'noom', 'notion', 'nvidia', 'nuvei', 'okta',
  'openai', 'orcasecurity', 'pagerduty', 'palantir',
  'patreon', 'pave', 'persona', 'plaid', 'postman',
  'productboard', 'pulumi', 'quizlet', 'ramp', 'recharge',
  'reddit', 'redcanary', 'replit', 'retool', 'rippling',
  'robinhood', 'rockset', 'ro', 'runway', 'salesloft',
  'scaleai', 'segment', 'sentry', 'shipbob', 'shippo',
  'skydio', 'smartsheet', 'snyk', 'socure', 'sonder',
  'sourcegraph', 'splunk', 'squarespace', 'starburst',
  'stripe', 'superhuman', 'sysdig', 'tailscale', 'tekion',
  'temporal', 'thoughtspot', 'toast', 'transcarent',
  'tremendous', 'truework', 'twilio', 'typeform', 'uber',
  'unit', 'upstart', 'usertesting', 'vanta', 'verkada',
  'via', 'vidyard', 'vimeo', 'watershed', 'waymo',
  'webflow', 'wealthsimple', 'workato', 'xometry', 'yotpo',
  'zapier', 'zendesk', 'zipline', 'zola', 'zscaler',
  // More large companies on Greenhouse
  'airbnb', 'block', 'brainstation', 'brivo', 'cameo',
  'canva', 'census', 'clearbit', 'clubhouse', 'coda',
  'codepath', 'collibra', 'confluent', 'covariant',
  'cribl', 'dbtlabs', 'deepmind', 'demandbase',
  'descope', 'ditto', 'drata', 'driveway', 'dronedeploy',
  'duneanalytics', 'envoy', 'etsy', 'eventbrite',
  'everlaw', 'expensify', 'extend', 'featurebase',
  'finastra', 'flatfile', 'foursquare', 'front',
  'gem', 'gladly', 'glean', 'goldmansachs',
  'gong', 'growthbook', 'gtmhub', 'harness',
  'hasura', 'healthie', 'heap', 'hex',
  'hightouch', 'hopin', 'hunters', 'imeg',
  'incident', 'ironclad', 'jasper', 'jfrog',
  'jumpcloud', 'kandji', 'klaviyo', 'lob',
  'looker', 'loom', 'magic', 'mapbox',
  'medable', 'merge', 'metabase', 'mindstrong',
  'mixmax', 'modal', 'momentive', 'monograph',
  'monzo', 'mural', 'myndbend', 'mynd',
  'narrative', 'newfront', 'nexthink', 'niche',
  'northflank', 'nuvolo', 'o3world', 'openly',
  'orion', 'osaro', 'packback', 'pipe',
  'pitchbook', 'platform9', 'pomelocare',
  'prefect', 'primer', 'privy', 'proof',
  'propel', 'proposify', 'quantummetric',
  'readme', 'recurly', 'reform', 'render',
  'resilience', 'ridge', 'ritual', 'rootly',
  'robust', 'row', 'saama', 'scout',
  'seismic', 'sendbird', 'seso', 'silvus',
  'simplist', 'sisu', 'socure', 'softrams',
  'soundhound', 'spotio', 'stedi', 'stella',
  'stensul', 'streamlit', 'strongdm', 'subsplash',
  'sunbit', 'sunrun', 'supplyframe', 'suralink',
  'surescripts', 'switch', 'tacton', 'tango',
  'telemetry2u', 'terra', 'tesorio', 'thezebra',
  'thinkific', 'thrivemarket', 'tonal', 'transfix',
  'tuvahealth', 'twist', 'ujet', 'unison',
  'vendasta', 'vention', 'vero', 'verusen',
  'vidahealth', 'vigilant', 'vivid', 'volterra',
  'voxel51', 'vroom', 'wellthy', 'wex',
  'whistic', 'windfall', 'wingman', 'wisk',
  'wonolo', 'workrise', 'woven', 'yotpo',
  'zego', 'zira',
];

const GREENHOUSE_COMPANIES = Array.from(new Set([
  ...BASE_GREENHOUSE_COMPANIES,
  ...CURATED_GREENHOUSE_COMPANIES,
  ...ADDITIONAL_GREENHOUSE_COMPANIES,
]));

const TECH_KEYWORDS = [
  'engineer', 'developer', 'scientist', 'analyst', 'ml', 'ai', 'data',
  'software', 'backend', 'frontend', 'fullstack', 'full stack', 'product manager',
];

type GreenhouseJob = {
  absolute_url?: string;
  content?: string;
  id?: number | string;
  location?: {
    name?: string;
  };
  title?: string;
  updated_at?: string;
};

type GreenhouseBoardResponse = {
  content?: string;
  name?: string;
};

type GreenhouseJobsResponse = {
  company?: {
    name?: string;
  };
  jobs?: GreenhouseJob[];
};

type FetchJsonResult<T> = {
  data: T | null;
  status: number;
  timedOut: boolean;
};

function isTechRole(title: string): boolean {
  const lower = title.toLowerCase();
  return TECH_KEYWORDS.some(k => lower.includes(k));
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

async function fetchJsonWithTimeout<T>(
  url: string,
  timeoutMs: number,
): Promise<FetchJsonResult<T>> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return { data: null, status: res.status, timedOut: false };
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return { data: null, status: res.status, timedOut: false };
    }

    return {
      data: (await res.json()) as T,
      status: res.status,
      timedOut: false,
    };
  } catch (error) {
    return {
      data: null,
      status: 0,
      timedOut: isTimeoutError(error),
    };
  }
}

async function validateGreenhouseBoard(
  company: string,
): Promise<{ companyName: string | null; status: number; timedOut: boolean }> {
  const result = await fetchJsonWithTimeout<GreenhouseBoardResponse>(
    `https://boards-api.greenhouse.io/v1/boards/${company}`,
    BOARD_TIMEOUT_MS,
  );

  return {
    companyName: result.data?.name?.trim() || null,
    status: result.status,
    timedOut: result.timedOut,
  };
}

async function fetchCompany(company: string): Promise<NormalizedJob[]> {
  console.log(`  [${SOURCE}] Starting company: ${company}`);

  const boardValidation = await validateGreenhouseBoard(company);
  if (boardValidation.status !== 200) {
    console.log(
      `  [${SOURCE}] ${company}: board validation failed with status=${boardValidation.status}` +
        (boardValidation.timedOut ? ' timeout=true' : ''),
    );
    console.log(`  [${SOURCE}] Skipping company ${company} due to board validation error`);
    return [];
  }

  console.log(`  [${SOURCE}] ${company}: board validation succeeded with status=200`);

  const urls = [
    `https://boards-api.greenhouse.io/v1/boards/${company}/jobs?content=true`,
    `https://boards-api.greenhouse.io/v1/boards/${company}/jobs`,
  ];

  for (const url of urls) {
    const isFallback = !url.includes('content=true');

    for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
      const result = await fetchJsonWithTimeout<GreenhouseJobsResponse>(
        url,
        REQUEST_TIMEOUT_MS,
      );

      console.log(
        `  [${SOURCE}] ${company}: jobs fetch ${isFallback ? '(fallback) ' : ''}` +
          `attempt ${attempt}/${MAX_FETCH_ATTEMPTS} status=${result.status}` +
          (result.timedOut ? ' timeout=true' : ''),
      );

      if (result.status === 200 && result.data) {
        const jobs = result.data.jobs ?? [];
        const normalized: NormalizedJob[] = [];

        for (const job of jobs) {
          if (!isTechRole(job.title ?? '')) continue;
          const plainContent = stripHtml(job.content ?? '');
          const level = inferExperienceLevel(job.title ?? '', plainContent);
          if (level === null) continue;

          const location = job.location?.name ?? '';
          const companyName =
            result.data.company?.name?.trim() ||
            boardValidation.companyName ||
            company;

          normalized.push(finalizeNormalizedJob({
            source: SOURCE,
            source_id: String(job.id),
            title: job.title ?? '',
            company: companyName,
            location,
            remote: inferRemote(location),
            url: job.absolute_url ?? '',
            description: plainContent || undefined,
            experience_level: level,
            roles: inferRoles(job.title ?? ''),
            posted_at: job.updated_at ?? undefined,
            dedup_hash: generateHash(companyName, job.title ?? '', location),
          }));
        }

        console.log(
          `  [${SOURCE}] ${company}: jobs fetch succeeded with status=200; ` +
            `raw=${jobs.length}; normalized=${normalized.length}`,
        );

        return normalized;
      }

      if (!RETRYABLE_STATUS_CODES.has(result.status) || attempt === MAX_FETCH_ATTEMPTS) {
        break;
      }

      const backoffMs = 500 * (2 ** (attempt - 1));
      console.log(
        `  [${SOURCE}] ${company}: retrying after ${backoffMs}ms due to status=${result.status}`,
      );
      await sleep(backoffMs);
    }

    if (!isFallback) {
      console.log(`  [${SOURCE}] ${company}: switching to fallback jobs endpoint after repeated failure`);
    }
  }

  console.log(`  [${SOURCE}] Skipping company ${company} due to repeated fetch errors`);
  return [];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function scrapeGreenhouse(): Promise<NormalizedJob[]> {
  const all: NormalizedJob[] = [];

  console.log(`  [${SOURCE}] Starting scrape across ${GREENHOUSE_COMPANIES.length} companies`);

  for (let i = 0; i < GREENHOUSE_COMPANIES.length; i += BATCH_SIZE) {
    const batch = GREENHOUSE_COMPANIES.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(fetchCompany));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        all.push(...result.value);
        continue;
      }

      console.log(`  [${SOURCE}] Skipping company due to batch error: ${String(result.reason)}`);
    }

    console.log(
      `  [${SOURCE}] Processed ${Math.min(i + BATCH_SIZE, GREENHOUSE_COMPANIES.length)}/${GREENHOUSE_COMPANIES.length} companies; jobs=${all.length}`,
    );

    if (i + BATCH_SIZE < GREENHOUSE_COMPANIES.length) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`  [${SOURCE}] Final count: ${all.length}`);
  return all;
}

async function runStandalone(): Promise<void> {
  const startedAt = Date.now();

  const jobs = await scrapeGreenhouse();
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

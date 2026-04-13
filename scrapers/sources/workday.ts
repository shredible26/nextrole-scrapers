// Source: Workday ATS — used by thousands of large companies.
// Each company exposes a consistent JSON endpoint at:
//   POST https://{company}.{wdVersion}.myworkdayjobs.com/wday/cxs/{company}/{career-site}/jobs
// No API key required. Returns JSON directly.
// Different companies use different subdomain versions (wd1–wd12, wd100, wd501).

import { generateHash } from '../utils/dedup';
import { isNonUsLocation } from '../utils/location';
import { inferRoles, inferRemote, inferExperienceLevel, NormalizedJob } from '../utils/normalize';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Workday-specific senior/sales title signals not caught by inferExperienceLevel
const WORKDAY_TITLE_EXCLUSIONS = [
  'lead ',
  ' lead',
  'principal',
  'named account',
  'account executive',
  'account manager',
  'vice president',
  'vp ',
  ' vp,',
  'director',
  'head of',
  'chief',
  'president',
  'partner',
  'managing director',
  'solution architect',
  'solutions architect',
  'distinguished',
  'fellow',
];

/**
 * Returns true if the job title contains a Workday-specific senior/sales signal.
 * Special case: 'consultant' is only excluded when NOT preceded by 'associate' or 'junior'.
 */
function isWorkdaySeniorTitle(title: string): boolean {
  const lower = ' ' + title.toLowerCase() + ' ';

  // Check the general exclusion list
  if (WORKDAY_TITLE_EXCLUSIONS.some(k => lower.includes(k))) return true;

  // Consultant check — skip unless prefixed with associate/junior
  if (lower.includes('consultant')) {
    const hasJuniorPrefix =
      lower.includes('associate consultant') ||
      lower.includes('junior consultant');
    if (!hasJuniorPrefix) return true;
  }

  return false;
}

/**
 * Construct a full Workday apply URL from the job object.
 *
 * Correct public-facing format (confirmed from CrowdStrike, Nvidia, etc.):
 *   https://{company}.{wdVersion}.myworkdayjobs.com/{careerSite}{externalPath}
 *
 * externalPath from the API looks like: /job/USA---Remote/Title-Slug_R12345
 * There is NO /en-US/ in the public-facing URL — /en-US/ only appears in
 * some internal API paths, not in the actual job page URLs.
 */
function buildWorkdayUrl(
  company: string,
  wdVersion: string,
  careerSite: string,
  job: WorkdayJob,
): string {
  // Prefer explicit full URLs from API if available
  if (job.externalUrl && job.externalUrl.startsWith('http') && !job.externalUrl.includes('invalid-url')) {
    return job.externalUrl;
  }
  if (job.jobPostingUrl && job.jobPostingUrl.startsWith('http') && !job.jobPostingUrl.includes('invalid-url')) {
    return job.jobPostingUrl;
  }

  const path = job.externalPath ?? '';

  // externalPath from Workday API looks like: /job/Location/Title_ID
  // Full URL = https://{company}.{wdVersion}.myworkdayjobs.com/{careerSite}{externalPath}
  // NOTE: NO /en-US/ prefix in the public URL
  if (path.startsWith('/job/')) {
    return `https://${company}.${wdVersion}.myworkdayjobs.com/${careerSite}${path}`;
  }

  // If externalPath includes /en-US/ already, strip it
  if (path.includes('/en-US/')) {
    const withoutLocale = path.replace('/en-US/', '/');
    return `https://${company}.${wdVersion}.myworkdayjobs.com/${careerSite}${withoutLocale}`;
  }

  // If path starts with / but isn't /job/, still try it
  if (path.startsWith('/')) {
    return `https://${company}.${wdVersion}.myworkdayjobs.com/${careerSite}${path}`;
  }

  // Last resort — link to company career page
  return `https://${company}.${wdVersion}.myworkdayjobs.com/en-US/${careerSite}`;
}

function isValidWorkdayUrl(url: string): boolean {
  return (
    url.includes('myworkdayjobs.com') &&
    url.includes('/job/') &&
    !url.includes('invalid-url') &&
    !url.includes('community.workday.com')
  );
}

const WORKDAY_TECH_COMPANIES = new Set([
  'nvidia', 'intel', 'salesforce', 'crowdstrike', 'marvell', 'draftkings',
  'workiva', 'amazon', 'microsoft', 'apple', 'meta', 'google', 'ibm',
  'oracle', 'sap', 'adobe', 'qualcomm', 'amd', 'broadcom', 'ti',
  'analog', 'xilinx', 'vmware', 'workday', 'servicenow', 'splunk',
  'paloaltonetworks', 'fortinet', 'netapp', 'purestorage', 'nutanix',
  'elastic', 'mongodb', 'cloudera', 'dynatrace', 'informatica',
  'teradata', 'f5', 'juniper', 'arista', 'commvault', 'verint',
  'opentext', 'tibco', 'solarwinds', 'uber', 'lyft', 'airbnb',
  'doordash', 'instacart', 'atlassian', 'dropbox', 'box', 'zendesk',
  'hubspot', 'twilio', 'cloudflare', 'databricks', 'snowflake',
  'palantir', 'veeva', 'guidewire', 'paylocity', 'adp', 'paychex',
  'medallia', 'qualtrics', 'sprinklr', 'meltwater', 'okta', 'zscaler',
  'pagerduty', 'sumo-logic', 'tableau', 'microstrategy', 'nuance',
  'talend', 'qlik', 'motorolasolutions',
  'cisco', 'accenture', 'deloitte', 'ge', 'boeing', 'lockheedmartin',
  'raytheon', 'northropgrumman', 'abbott', 'medtronic', 'jnj', 'merck',
  'lilly', 'honeywell', 'siemens', 'fiserv', 'broadridge',
]);

const PROTECTED_TECH_TITLE_PATTERNS = [
  /\bsoftware\b.*\b(?:engineer|developer)\b/,
  /\bsoftware development engineer\b/,
  /\bdata\b.*\b(?:scientist|analyst|engineer)\b/,
  /\bmachine learning\b.*\b(?:engineer|scientist|researcher|developer|analyst)\b/,
  /\bartificial intelligence\b.*\b(?:engineer|scientist|researcher|developer|analyst)\b/,
  /\bai\b.*\b(?:engineer|scientist|researcher|developer|analyst)\b/,
  /\bml\b.*\b(?:engineer|scientist|researcher|developer|analyst)\b/,
  /\bproduct\b.*\b(?:manager|analyst)\b/,
  /\bsecurity\b.*\b(?:engineer|analyst)\b/,
  /\bcyber(?:security)?\b.*\b(?:engineer|analyst)\b/,
  /\bsystems?\b.*\b(?:engineer|analyst)\b/,
  /\bcloud engineer\b/,
  /\bdevops\b/,
  /\bsre\b/,
  /\bsite reliability\b/,
  /\bplatform engineer\b/,
  /\bbusiness analyst\b/,
  /\bquantitative analyst\b/,
  /\bquant\b.*\b(?:analyst|developer|researcher|engineer)\b/,
  /\bit\b.*\b(?:engineer|analyst)\b/,
];

const SOFTWARE_CONTEXT_PATTERNS = [
  'software',
  'data',
  'machine learning',
  'artificial intelligence',
  ' ai ',
  ' ai,',
  ' ai/',
  ' ai-',
  ' ml ',
  'ml engineer',
  'security',
  'cyber',
  'cloud',
  'devops',
  'sre',
  'site reliability',
  'platform',
  'systems',
  'network',
  'it ',
  'it-',
];

const NON_TECH_PATTERNS = [
  'relationship banker', 'retail banker', 'personal banker',
  'associate banker', 'banker', 'bank teller', 'teller',
  'loan officer', 'mortgage', 'financial advisor', 'wealth advisor',
  'financial planner', 'insurance agent', 'insurance advisor',
  'sales manager', 'sales director', 'sales executive',
  'account executive', 'account manager', 'named account',
  'retail associate', 'store associate', 'store manager',
  'cashier', 'customer service representative',
  'supply chain coordinator', 'logistics coordinator',
  'warehouse associate', 'delivery driver', 'truck driver',
  'registered nurse', 'nurse practitioner', 'nursing',
  'physician', 'medical assistant', 'pharmacy technician',
  'teacher', 'professor', 'adjunct instructor',
  'bookkeeper', 'payroll specialist', 'hr generalist',
  'hr coordinator', 'human resources coordinator',
  'marketing coordinator', 'marketing specialist',
  'graphic designer', 'visual designer',
  'apprenticeship', 'apprentice',
  'paralegal', 'legal assistant',
  'real estate agent', 'property manager',
  'facilities coordinator', 'maintenance technician',
  'food service', 'chef', 'cook', 'barista',
  'marine', 'mate', 'nautical', 'vessel', 'maritime',
  'portfolio marketing', 'brand manager', 'marketing manager',
  'neurosurgical', 'surgical', 'clinical', 'medical device sales',
  'business development', 'm&a', 'mergers and acquisitions',
  'field sales', 'territory manager', 'account executive',
  'supply chain', 'supply chain manager', 'procurement manager', 'buyer',
  'hr manager', 'human resources manager', 'talent acquisition',
  'legal counsel', 'attorney', 'paralegal', 'compliance officer',
  'financial advisor', 'wealth advisor', 'insurance agent',
  'loan officer', 'mortgage', 'underwriter', 'actuary',
  'physical therapist', 'occupational therapist', 'speech therapist',
  'pharmacist', 'pharmacy', 'dental', 'optometrist',
  'electrician', 'plumber', 'hvac', 'mechanic', 'technician',
  'welder', 'machinist', 'forklift', 'warehouse',
  'driver', 'delivery', 'logistics coordinator',
  'chef', 'cook', 'restaurant', 'hospitality',
  'teacher', 'instructor', 'professor', 'tutor',
  'social worker', 'counselor', 'therapist',
  'security guard', 'loss prevention',
  'real estate', 'property manager',
  'administrative assistant', 'receptionist', 'office manager',
  'scheduling coordinator', 'commodity analyst', 'customs',
  'bindery', 'litho', 'recommerce', 'resale', 'liquidation',
  'risk manager', 'risk event', 'risk analyst',
  'portfolio marketing', 'marketing manager', 'brand manager',
  'vaccines', 'vaccine', 'immunology', 'oncology',
  'business manager', 'business development manager',
  'sales manager', 'sales representative', 'sales executive',
  'account manager', 'account executive', 'account director',
  'territory', 'regional manager', 'district manager',
  'operations improvement', 'operational excellence',
  'quality control', 'diagnostic', 'assay', 'laboratory', 'lab scientist',
  'marine', 'maritime', 'nautical',
  'tax', 'audit', 'accounting',
  'communications manager', 'pr manager', 'public relations',
];

function isProtectedTechTitle(title: string): boolean {
  const t = title.toLowerCase();
  return PROTECTED_TECH_TITLE_PATTERNS.some(pattern => pattern.test(t));
}

function isSoftwareContext(title: string): boolean {
  const padded = ` ${title.toLowerCase()} `;
  return SOFTWARE_CONTEXT_PATTERNS.some(pattern => padded.includes(pattern));
}

function isTechCompany(company: string): boolean {
  return WORKDAY_TECH_COMPANIES.has(company.toLowerCase());
}

const WORKDAY_COMPANY_LABELS: Record<string, string> = {
  athenahealth: 'athenahealth',
  bdx: 'BD',
  biibhr: 'Biogen',
  bostondynamics: 'Boston Dynamics',
  bristolmyerssquibb: 'Bristol Myers Squibb',
  caci: 'CACI',
  cae: 'CAE',
  clarioclinical: 'Clario',
  dxctechnology: 'DXC Technology',
  geaerospace: 'GE Aerospace',
  gehc: 'GE HealthCare',
  globalhr: 'RTX',
  gsk: 'GSK',
  healthcare: 'Solventum',
  kohls: "Kohl's",
  lytx: 'Lytx',
  mufgub: 'MUFG',
  nxp: 'NXP',
  paypal: 'PayPal',
  shi: 'SHI',
  tmobile: 'T-Mobile',
  troweprice: 'T. Rowe Price',
  vrtx: 'Vertex Pharmaceuticals',
};

function formatWorkdayCompanyName(company: string): string {
  return WORKDAY_COMPANY_LABELS[company] ?? company.charAt(0).toUpperCase() + company.slice(1);
}

function extractWorkdaySourceId(
  company: string,
  title: string,
  location: string,
  posting: WorkdayJob,
): string {
  const bulletFieldId = posting.bulletFields
    ?.map(field => field.trim())
    .find(field => /^[A-Z]{1,6}\d{4,}$/i.test(field));
  const pathId = posting.externalPath?.match(/_([A-Za-z0-9-]+)$/)?.[1];
  const stableFallback = `${company}:${title.toLowerCase().trim()}:${location.toLowerCase().trim()}`;

  return posting.jobPostingId ?? bulletFieldId ?? pathId ?? stableFallback;
}

function isNonTechRole(title: string, company: string): boolean {
  const t = title.toLowerCase();

  if (isProtectedTechTitle(t)) return false;

  if (
    t.includes('process engineer') &&
    !/\b(?:software|data)\s+process engineer\b/.test(t)
  ) {
    return true;
  }

  if (t.includes('quality assurance') && !isSoftwareContext(t)) {
    return true;
  }

  if (t.includes('field engineer') && !isSoftwareContext(t)) {
    return true;
  }

  if (t.includes('financial analyst') && !isTechCompany(company)) {
    return true;
  }

  return NON_TECH_PATTERNS.some(p => t.includes(p));
}

function hasNonLatinCharacters(text: string): boolean {
  return /[\u3000-\u9FFF\uAC00-\uD7AF\u0600-\u06FF\u0400-\u04FF]/.test(text);
}

const SEARCH_TERMS = [
  'software engineer',
  'data scientist',
  'machine learning',
  'data analyst',
  'software developer',
  'data engineer',
  'entry level',
  'new grad',
  'associate engineer',
  'junior engineer',
  'early career',
  'technology analyst',
  'software engineer i',
  'systems engineer',
  'devops engineer',
  'cloud engineer',
  'product manager',
  'business analyst',
  'quantitative analyst',
];

// Workday subdomain versions to try in order
const WD_VERSIONS = ['wd1', 'wd2', 'wd3', 'wd4', 'wd5', 'wd6', 'wd7', 'wd8', 'wd10', 'wd12', 'wd100', 'wd501'];

export const WORKDAY_COMPANIES: [string, string][] = [
  // Live-verified with real POST responses returning HTTP 200
  ['amgen', 'careers'],
  ['abbott', 'abbottcareers2'],
  ['argonne', 'Argonne_Careers'],
  ['astrazeneca', 'careers'],
  ['athenahealth', 'external'],
  ['bakerhughes', 'bakerhughes'],
  ['baxter', 'baxter'],
  ['bdx', 'EXTERNAL_CAREER_SITE_USA'],
  ['biibhr', 'external'],
  ['bmo', 'external'],
  ['bostondynamics', 'Boston_Dynamics'],
  ['bristolmyerssquibb', 'BMS'],
  ['caci', 'External'],
  ['capitalone', 'Capital_One'],
  ['cae', 'career'],
  ['cigna', 'cignacareers'],
  ['cisco', 'Cisco_Careers'],
  ['clarioclinical', 'clarioclinical_careers'],
  ['commvault', 'commvault'],
  ['crowdstrike', 'crowdstrikecareers'],
  ['danaher', 'DanaherJobs'],
  ['draftkings', 'DraftKings'],
  ['dxctechnology', 'DXCJobs'],
  ['geaerospace', 'GE_ExternalSite'],
  ['gehc', 'GEHC_ExternalSite'],
  ['gilead', 'gileadcareers'],
  ['globalhr', 'REC_RTX_Ext_Gateway'],
  ['gsk', 'gskcareers'],
  ['healthcare', 'Search'],
  ['intel', 'external'],
  ['iqvia', 'iqvia'],
  ['jll', 'jllcareers'],
  ['keybank', 'External_Career_Site'],
  ['kohls', 'kohlscareers'],
  ['leidos', 'external'],
  ['lytx', 'Lytx'],
  ['mars', 'External'],
  ['manulife', 'MFCJH_Jobs'],
  ['marvell', 'marvellcareers'],
  ['mastercard', 'CorporateCareers'],
  ['medtronic', 'medtroniccareers'],
  ['micron', 'external'],
  ['mitre', 'mitre'],
  ['mksinst', 'MKSCareersUniversity'],
  ['motorolasolutions', 'careers'],
  ['mufgub', 'MUFG-Careers'],
  ['neurocrine', 'Neurocrinecareers'],
  ['nvidia', 'NVIDIAExternalCareerSite'],
  ['nxp', 'careers'],
  ['paypal', 'jobs'],
  ['pfizer', 'pfizercareers'],
  ['pnc', 'external'],
  ['prudential', 'prudential'],
  ['pwc', 'US_Entry_Level_Careers'],
  ['qualcomm', 'external'],
  ['quickenloans', 'rocket_careers'],
  ['regeneron', 'Careers'],
  ['regeneron', 'careers'],
  ['relx', 'relx'],
  ['relx', 'ElsevierJobs'],
  ['salesforce', 'External_Career_Site'],
  ['sanofi', 'sanoficareers'],
  ['shell', 'shellcareers'],
  ['shi', 'shicareers'],
  ['shipt', 'Shipt_External'],
  ['sprinklr', 'careers'],
  ['target', 'targetcareers'],
  ['tmobile', 'External'],
  ['transunion', 'TransUnion'],
  ['travelers', 'external'],
  ['trimble', 'TrimbleCareers'],
  ['troweprice', 'TRowePrice'],
  ['vanguard', 'vanguard_External'],
  ['visa', 'visa'],
  ['vrtx', 'Vertex_Careers'],
  ['workday', 'Workday_Early_Career'],
  ['zendesk', 'zendesk'],
  ['zoom', 'zoom'],
];

const WORKDAY_BATCH_SIZE = 25;
const WORKDAY_REQUEST_TIMEOUT_MS = 25_000;
const WORKDAY_SKIP_RUNS = 3;
const WORKDAY_DEAD_CACHE_PATH = join(process.cwd(), 'scrapers', 'cache', 'workday-dead.json');

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function loadWorkdayDeadCache(): Promise<WorkdayDeadCache> {
  try {
    const raw = await readFile(WORKDAY_DEAD_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, Partial<WorkdayDeadCacheEntry>>;

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => value && typeof value === 'object')
        .map(([company, value]) => [
          company,
          {
            zeroCount: Math.max(0, Math.trunc(value.zeroCount ?? 0)),
            lastAttempt: typeof value.lastAttempt === 'string' ? value.lastAttempt : undefined,
            wdVersion: typeof value.wdVersion === 'string' ? value.wdVersion : undefined,
            slug: typeof value.slug === 'string' ? value.slug : undefined,
            knownTargets: Object.fromEntries(
              Object.entries(value.knownTargets ?? {})
                .filter(
                  ([, target]) =>
                    target &&
                    typeof target.wdVersion === 'string' &&
                    typeof target.slug === 'string',
                )
                .map(([careerSite, target]) => [
                  careerSite,
                  {
                    wdVersion: target.wdVersion,
                    slug: target.slug,
                  },
                ]),
            ),
          },
        ]),
    );
  } catch {
    return {};
  }
}

function compactWorkdayDeadCache(cache: WorkdayDeadCache): WorkdayDeadCache {
  return Object.fromEntries(
    Object.entries(cache).filter(
      ([, entry]) =>
        entry.zeroCount > 0 ||
        Object.keys(entry.knownTargets).length > 0 ||
        (typeof entry.wdVersion === 'string' && typeof entry.slug === 'string'),
    ),
  );
}

async function saveWorkdayDeadCache(cache: WorkdayDeadCache): Promise<void> {
  await mkdir(join(process.cwd(), 'scrapers', 'cache'), { recursive: true });
  await writeFile(
    WORKDAY_DEAD_CACHE_PATH,
    `${JSON.stringify(compactWorkdayDeadCache(cache), null, 2)}\n`,
  );
}

function groupWorkdayCompanies(): Array<{ company: string; careerSites: string[] }> {
  const grouped = new Map<string, Set<string>>();

  for (const [company, careerSite] of WORKDAY_COMPANIES) {
    if (!grouped.has(company)) {
      grouped.set(company, new Set<string>());
    }
    grouped.get(company)?.add(careerSite);
  }

  return Array.from(grouped, ([company, careerSites]) => ({
    company,
    careerSites: Array.from(careerSites),
  }));
}

/**
 * Workday returns human-readable strings like "Posted 30+ Days Ago" or "Posted Today".
 * Convert to approximate ISO dates; return undefined when unparseable.
 */
function parseWorkdayDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  const now = Date.now();
  if (s.includes('today') || s.includes('just posted')) {
    return new Date(now).toISOString();
  }
  const daysAgo = s.match(/(\d+)\+?\s*day/);
  if (daysAgo) {
    return new Date(now - parseInt(daysAgo[1]) * 86_400_000).toISOString();
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

interface WorkdayJob {
  title: string;
  externalPath: string;
  externalUrl?: string;
  jobPostingUrl?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
  jobPostingId?: string;
}

interface WorkdayResponse {
  jobPostings?: WorkdayJob[];
  total?: number;
}

type WorkdayFetchResult = {
  data: WorkdayResponse | null;
  timedOut: boolean;
  hadNon200Status: boolean;
};

type WorkdayResolvedAttempt = {
  jobs: WorkdayJob[];
  wdVersion: string;
  slug: string;
};

export type WorkdayKnownTarget = {
  wdVersion: string;
  slug: string;
};

type WorkdayAttemptState = {
  result: WorkdayResolvedAttempt | null;
  hadSuccessfulResponse: boolean;
  hadTimeout: boolean;
  hadNon200Status: boolean;
};

type WorkdayScrapeStats = {
  uniqueFetched: number;
  filteredNonUs: number;
  filteredNonTech: number;
};

export type WorkdayDeadCacheEntry = {
  zeroCount: number;
  lastAttempt?: string;
  wdVersion?: string;
  slug?: string;
  knownTargets: Record<string, WorkdayKnownTarget>;
};

type WorkdayDeadCache = Record<string, WorkdayDeadCacheEntry>;
type PersistKnownWorkdayTarget = (
  company: string,
  careerSite: string,
  target: WorkdayKnownTarget,
) => Promise<void>;

type CompanyScrapeResult = {
  jobs: NormalizedJob[];
  stats: WorkdayScrapeStats;
  rawJobsCount: number;
  hadSuccessfulResponse: boolean;
  hadTimeout: boolean;
  hadNon200Status: boolean;
};

type CompanyGroupScrapeResult = {
  company: string;
  jobs: NormalizedJob[];
  stats: WorkdayScrapeStats;
  rawJobsCount: number;
  hadSuccessfulResponse: boolean;
  hadTimeout: boolean;
  hadNon200Status: boolean;
};

function createEmptyWorkdayStats(): WorkdayScrapeStats {
  return {
    uniqueFetched: 0,
    filteredNonUs: 0,
    filteredNonTech: 0,
  };
}

function isUsefulWorkdaySampleLocation(location?: string): boolean {
  if (!location || /^\d+\s+locations?$/i.test(location)) return false;

  return (
    /\b(?:united states|usa|virtual us|remote)\b/i.test(location) ||
    /\bUS,\b/.test(location) ||
    /,\s?[A-Z]{2}(?:\b|,|\s|$)/.test(location)
  );
}

export const WORKDAY_KNOWN_TARGETS: Record<string, WorkdayKnownTarget> = {
  'amgen|careers': { wdVersion: 'wd1', slug: 'careers' },
  'abbott|abbottcareers2': { wdVersion: 'wd5', slug: 'abbottcareers2' },
  'argonne|Argonne_Careers': { wdVersion: 'wd1', slug: 'Argonne_Careers' },
  'astrazeneca|careers': { wdVersion: 'wd3', slug: 'careers' },
  'athenahealth|external': { wdVersion: 'wd1', slug: 'external' },
  'bakerhughes|bakerhughes': { wdVersion: 'wd5', slug: 'bakerhughes' },
  'baxter|baxter': { wdVersion: 'wd1', slug: 'baxter' },
  'bdx|EXTERNAL_CAREER_SITE_USA': { wdVersion: 'wd1', slug: 'EXTERNAL_CAREER_SITE_USA' },
  'biibhr|external': { wdVersion: 'wd3', slug: 'external' },
  'bmo|external': { wdVersion: 'wd3', slug: 'external' },
  'bostondynamics|Boston_Dynamics': { wdVersion: 'wd1', slug: 'Boston_Dynamics' },
  'bristolmyerssquibb|BMS': { wdVersion: 'wd5', slug: 'BMS' },
  'caci|External': { wdVersion: 'wd1', slug: 'External' },
  'capitalone|Capital_One': { wdVersion: 'wd12', slug: 'Capital_One' },
  'cae|career': { wdVersion: 'wd3', slug: 'career' },
  'cigna|cignacareers': { wdVersion: 'wd5', slug: 'cignacareers' },
  'cisco|Cisco_Careers': { wdVersion: 'wd5', slug: 'Cisco_Careers' },
  'clarioclinical|clarioclinical_careers': { wdVersion: 'wd1', slug: 'clarioclinical_careers' },
  'commvault|commvault': { wdVersion: 'wd1', slug: 'commvault' },
  'crowdstrike|crowdstrikecareers': { wdVersion: 'wd5', slug: 'crowdstrikecareers' },
  'danaher|DanaherJobs': { wdVersion: 'wd1', slug: 'DanaherJobs' },
  'draftkings|DraftKings': { wdVersion: 'wd1', slug: 'DraftKings' },
  'dxctechnology|DXCJobs': { wdVersion: 'wd1', slug: 'DXCJobs' },
  'geaerospace|GE_ExternalSite': { wdVersion: 'wd5', slug: 'GE_ExternalSite' },
  'gehc|GEHC_ExternalSite': { wdVersion: 'wd5', slug: 'GEHC_ExternalSite' },
  'gilead|gileadcareers': { wdVersion: 'wd1', slug: 'gileadcareers' },
  'globalhr|REC_RTX_Ext_Gateway': { wdVersion: 'wd5', slug: 'REC_RTX_Ext_Gateway' },
  'gsk|gskcareers': { wdVersion: 'wd5', slug: 'gskcareers' },
  'healthcare|Search': { wdVersion: 'wd1', slug: 'Search' },
  'intel|external': { wdVersion: 'wd1', slug: 'external' },
  'iqvia|iqvia': { wdVersion: 'wd1', slug: 'iqvia' },
  'jll|jllcareers': { wdVersion: 'wd1', slug: 'jllcareers' },
  'keybank|External_Career_Site': { wdVersion: 'wd5', slug: 'External_Career_Site' },
  'kohls|kohlscareers': { wdVersion: 'wd1', slug: 'kohlscareers' },
  'leidos|external': { wdVersion: 'wd5', slug: 'external' },
  'lytx|Lytx': { wdVersion: 'wd1', slug: 'Lytx' },
  'mars|External': { wdVersion: 'wd3', slug: 'External' },
  'manulife|MFCJH_Jobs': { wdVersion: 'wd3', slug: 'MFCJH_Jobs' },
  'marvell|marvellcareers': { wdVersion: 'wd1', slug: 'marvellcareers' },
  'mastercard|CorporateCareers': { wdVersion: 'wd1', slug: 'CorporateCareers' },
  'medtronic|medtroniccareers': { wdVersion: 'wd1', slug: 'medtroniccareers' },
  'micron|external': { wdVersion: 'wd1', slug: 'external' },
  'mitre|mitre': { wdVersion: 'wd5', slug: 'mitre' },
  'mksinst|MKSCareersUniversity': { wdVersion: 'wd1', slug: 'MKSCareersUniversity' },
  'motorolasolutions|careers': { wdVersion: 'wd5', slug: 'careers' },
  'mufgub|MUFG-Careers': { wdVersion: 'wd3', slug: 'MUFG-Careers' },
  'neurocrine|Neurocrinecareers': { wdVersion: 'wd5', slug: 'Neurocrinecareers' },
  'nvidia|NVIDIAExternalCareerSite': { wdVersion: 'wd5', slug: 'NVIDIAExternalCareerSite' },
  'nxp|careers': { wdVersion: 'wd3', slug: 'careers' },
  'paypal|jobs': { wdVersion: 'wd1', slug: 'jobs' },
  'pfizer|pfizercareers': { wdVersion: 'wd1', slug: 'pfizercareers' },
  'pnc|external': { wdVersion: 'wd5', slug: 'external' },
  'prudential|prudential': { wdVersion: 'wd3', slug: 'prudential' },
  'pwc|US_Entry_Level_Careers': { wdVersion: 'wd3', slug: 'US_Entry_Level_Careers' },
  'qualcomm|external': { wdVersion: 'wd12', slug: 'external' },
  'quickenloans|rocket_careers': { wdVersion: 'wd5', slug: 'rocket_careers' },
  'regeneron|Careers': { wdVersion: 'wd1', slug: 'Careers' },
  'regeneron|careers': { wdVersion: 'wd1', slug: 'careers' },
  'relx|relx': { wdVersion: 'wd3', slug: 'relx' },
  'relx|ElsevierJobs': { wdVersion: 'wd3', slug: 'ElsevierJobs' },
  'salesforce|External_Career_Site': { wdVersion: 'wd12', slug: 'External_Career_Site' },
  'sanofi|sanoficareers': { wdVersion: 'wd3', slug: 'sanoficareers' },
  'shell|shellcareers': { wdVersion: 'wd3', slug: 'shellcareers' },
  'shi|shicareers': { wdVersion: 'wd12', slug: 'shicareers' },
  'shipt|Shipt_External': { wdVersion: 'wd1', slug: 'Shipt_External' },
  'sprinklr|careers': { wdVersion: 'wd1', slug: 'careers' },
  'target|targetcareers': { wdVersion: 'wd5', slug: 'targetcareers' },
  'tmobile|External': { wdVersion: 'wd1', slug: 'External' },
  'transunion|TransUnion': { wdVersion: 'wd5', slug: 'TransUnion' },
  'travelers|external': { wdVersion: 'wd5', slug: 'external' },
  'trimble|TrimbleCareers': { wdVersion: 'wd1', slug: 'TrimbleCareers' },
  'troweprice|TRowePrice': { wdVersion: 'wd5', slug: 'TRowePrice' },
  'vanguard|vanguard_External': { wdVersion: 'wd5', slug: 'vanguard_External' },
  'visa|visa': { wdVersion: 'wd5', slug: 'visa' },
  'vrtx|Vertex_Careers': { wdVersion: 'wd501', slug: 'Vertex_Careers' },
  'workday|Workday_Early_Career': { wdVersion: 'wd5', slug: 'Workday_Early_Career' },
  'zendesk|zendesk': { wdVersion: 'wd1', slug: 'zendesk' },
  'zoom|zoom': { wdVersion: 'wd5', slug: 'zoom' },
};

function setKnownWorkdayTarget(
  company: string,
  careerSite: string,
  target: WorkdayKnownTarget,
): void {
  WORKDAY_KNOWN_TARGETS[`${company}|${careerSite}`] = target;
}

function getOrCreateWorkdayDeadCacheEntry(
  cache: WorkdayDeadCache,
  company: string,
): WorkdayDeadCacheEntry {
  if (!cache[company]) {
    cache[company] = {
      zeroCount: 0,
      lastAttempt: undefined,
      knownTargets: {},
    };
  }

  return cache[company];
}

function applyCachedWorkdayTargets(cache: WorkdayDeadCache): void {
  const careerSitesByCompany = new Map(
    groupWorkdayCompanies().map(group => [group.company, group.careerSites] as const),
  );

  for (const [company, entry] of Object.entries(cache)) {
    if (entry.wdVersion && entry.slug) {
      const careerSites = careerSitesByCompany.get(company) ?? [];
      const inferredCareerSite =
        careerSites.find(careerSite => careerSite === entry.slug) ??
        (careerSites.length === 1 ? careerSites[0] : undefined);

      if (inferredCareerSite) {
        setKnownWorkdayTarget(company, inferredCareerSite, {
          wdVersion: entry.wdVersion,
          slug: entry.slug,
        });
      }
    }

    for (const [careerSite, target] of Object.entries(entry.knownTargets)) {
      setKnownWorkdayTarget(company, careerSite, target);
    }
  }
}

function rememberWorkdayTarget(
  cache: WorkdayDeadCache,
  company: string,
  careerSite: string,
  target: WorkdayKnownTarget,
): boolean {
  const current = getKnownWorkdayTarget(company, careerSite);
  const entry = getOrCreateWorkdayDeadCacheEntry(cache, company);
  const cachedTarget = entry.knownTargets[careerSite];
  const cachedEntryWdVersion = entry.wdVersion;
  const cachedEntrySlug = entry.slug;

  setKnownWorkdayTarget(company, careerSite, target);
  entry.knownTargets[careerSite] = target;
  entry.wdVersion = target.wdVersion;
  entry.slug = target.slug;

  return (
    current?.wdVersion !== target.wdVersion ||
    current?.slug !== target.slug ||
    cachedTarget?.wdVersion !== target.wdVersion ||
    cachedTarget?.slug !== target.slug ||
    cachedEntryWdVersion !== target.wdVersion ||
    cachedEntrySlug !== target.slug
  );
}

function getKnownWorkdayTarget(
  company: string,
  careerSite: string,
): WorkdayKnownTarget | null {
  return WORKDAY_KNOWN_TARGETS[`${company}|${careerSite}`] ?? null;
}

const WORKDAY_SAMPLE_TITLE_SIGNALS = [
  'software',
  'developer',
  'engineer',
  'data',
  'machine learning',
  'ml ',
  ' ai',
  'artificial intelligence',
  'devops',
  'cloud',
  'security',
  'systems',
  'technical',
  'quantitative',
  'quant ',
];

function isUsefulWorkdaySampleJob(job: NormalizedJob): boolean {
  const title = job.title.toLowerCase();
  return (
    isUsefulWorkdaySampleLocation(job.location) &&
    WORKDAY_SAMPLE_TITLE_SIGNALS.some(signal => title.includes(signal))
  );
}

/**
 * Build slug variations to try for a given company + career site.
 */
function slugVariations(company: string, careerSite: string): string[] {
  const unique = new Set<string>();
  const add = (s: string) => unique.add(s);

  add(careerSite);
  add(`${careerSite}_External`);
  add('External_Career_Site');
  add('externalcareers');
  add('careers');
  add('Careers');
  add('external');
  add('External');
  add(`${company}careers`);

  return Array.from(unique);
}

async function fetchWorkdayResponse(
  company: string,
  url: string,
  searchText: string,
): Promise<WorkdayFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WORKDAY_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 20, offset: 0, searchText }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { data: null, timedOut: false, hadNon200Status: true };
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return { data: null, timedOut: false, hadNon200Status: false };
    }

    const data = (await res.json()) as WorkdayResponse;
    if (!Array.isArray(data.jobPostings)) {
      return { data: null, timedOut: false, hadNon200Status: false };
    }

    return { data, timedOut: false, hadNon200Status: false };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn(`  [workday] timeout: ${company}`);
      return { data: null, timedOut: true, hadNon200Status: false };
    }

    return { data: null, timedOut: false, hadNon200Status: false };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Try all (wdVersion, slug) combinations until one returns HTTP 200 with valid JSON
 * containing a jobPostings array. Returns the jobs plus the working (wdVersion, slug).
 * Times out each attempt after 25 seconds.
 */
async function tryWorkdayCompany(
  company: string,
  careerSite: string,
  searchText: string,
): Promise<WorkdayAttemptState> {
  const slugs = slugVariations(company, careerSite);
  let hadSuccessfulResponse = false;
  let hadTimeout = false;
  let hadNon200Status = false;

  for (const slug of slugs) {
    const attempts = await Promise.all(
      WD_VERSIONS.map(async wdVersion => {
        const url = `https://${company}.${wdVersion}.myworkdayjobs.com/wday/cxs/${company}/${slug}/jobs`;
        const response = await fetchWorkdayResponse(company, url, searchText);
        return { wdVersion, response };
      }),
    );

    for (const { wdVersion, response } of attempts) {
      hadTimeout ||= response.timedOut;
      hadNon200Status ||= response.hadNon200Status;

      if (!response.data) {
        continue;
      }

      hadSuccessfulResponse = true;
      return {
        result: { jobs: response.data.jobPostings ?? [], wdVersion, slug },
        hadSuccessfulResponse,
        hadTimeout,
        hadNon200Status,
      };
    }
  }

  return { result: null, hadSuccessfulResponse, hadTimeout, hadNon200Status };
}

async function scrapeCompany(
  company: string,
  careerSite: string,
  persistKnownTarget: PersistKnownWorkdayTarget,
): Promise<CompanyScrapeResult> {
  const seen = new Set<string>();
  const seenFetched = new Set<string>();
  const jobs: NormalizedJob[] = [];
  const stats = createEmptyWorkdayStats();
  let rawJobsCount = 0;
  let hadSuccessfulResponse = false;
  let hadTimeout = false;
  let hadNon200Status = false;
  let persistedKnownTarget = false;

  // Discover which (wdVersion, slug) pair works using the first search term
  let foundVersion: string | null = null;
  let foundSlug: string | null = null;
  const knownTarget = getKnownWorkdayTarget(company, careerSite);

  for (const term of SEARCH_TERMS) {
    let result: WorkdayResolvedAttempt | null = null;

    if (foundVersion && foundSlug) {
      // Re-use the working combination for subsequent search terms
      const url = `https://${company}.${foundVersion}.myworkdayjobs.com/wday/cxs/${company}/${foundSlug}/jobs`;
      const response = await fetchWorkdayResponse(company, url, term);
      hadTimeout ||= response.timedOut;
      hadNon200Status ||= response.hadNon200Status;

      if (response.data) {
        hadSuccessfulResponse = true;
        result = {
          jobs: response.data.jobPostings ?? [],
          wdVersion: foundVersion,
          slug: foundSlug,
        };
      }
    } else if (knownTarget) {
      const url = `https://${company}.${knownTarget.wdVersion}.myworkdayjobs.com/wday/cxs/${company}/${knownTarget.slug}/jobs`;
      const response = await fetchWorkdayResponse(company, url, term);
      hadTimeout ||= response.timedOut;
      hadNon200Status ||= response.hadNon200Status;

      if (response.data) {
        hadSuccessfulResponse = true;
        foundVersion = knownTarget.wdVersion;
        foundSlug = knownTarget.slug;
        result = {
          jobs: response.data.jobPostings ?? [],
          wdVersion: foundVersion,
          slug: foundSlug,
        };
      }
    }

    if (!result) {
      const attempt = await tryWorkdayCompany(company, careerSite, term);
      hadSuccessfulResponse ||= attempt.hadSuccessfulResponse;
      hadTimeout ||= attempt.hadTimeout;
      hadNon200Status ||= attempt.hadNon200Status;
      result = attempt.result;

      if (result) {
        foundVersion = result.wdVersion;
        foundSlug = result.slug;
      }
    }

    if (!result) continue;

    const { jobs: postings, wdVersion, slug } = result;
    rawJobsCount += postings.length;

    if (!persistedKnownTarget) {
      await persistKnownTarget(company, careerSite, { wdVersion, slug });
      persistedKnownTarget = true;
    }

    for (const posting of postings) {
      const title = posting.title ?? '';
      const location = posting.locationsText ?? '';
      const externalPath = posting.externalPath ?? '';
      const hash = generateHash(company, title, location);
      const isFirstSeenPosting = !seenFetched.has(hash);

      if (isFirstSeenPosting) {
        seenFetched.add(hash);
        stats.uniqueFetched += 1;
      }

      const level = inferExperienceLevel(title);
      if (level === null) continue;

      // Workday-specific: skip senior/sales titles not caught by inferExperienceLevel
      if (isWorkdaySeniorTitle(title)) continue;

      // Skip non-US locations
      if (isNonUsLocation(location)) {
        if (isFirstSeenPosting) stats.filteredNonUs += 1;
        continue;
      }

      // Skip non-Latin characters in title or location (international postings)
      if (hasNonLatinCharacters(title) || hasNonLatinCharacters(location)) continue;

      // Skip non-tech roles that slip through (banking, nursing, retail, etc.)
      if (isNonTechRole(title, company)) {
        if (isFirstSeenPosting) stats.filteredNonTech += 1;
        continue;
      }

      // Build full URL from the posting object
      const url = buildWorkdayUrl(company, wdVersion, slug, posting);

      // Skip jobs with invalid/unresolvable Workday URLs
      if (!isValidWorkdayUrl(url)) continue;

      if (seen.has(hash)) continue;
      seen.add(hash);

      jobs.push({
        source: 'workday',
        source_id: extractWorkdaySourceId(company, title, location, posting),
        title,
        company: formatWorkdayCompanyName(company),
        location,
        remote: inferRemote(location),
        url,
        description: posting.bulletFields?.join(' ') ?? undefined,
        experience_level: level,
        roles: inferRoles(title),
        posted_at: parseWorkdayDate(posting.postedOn),
        dedup_hash: hash,
      });
    }

    await delay(100);
  }

  if (jobs.length > 0) {
    console.log(`  [workday] ${company} (${foundVersion}/${foundSlug}): ${jobs.length} jobs`);
  }

  return { jobs, stats, rawJobsCount, hadSuccessfulResponse, hadTimeout, hadNon200Status };
}

async function scrapeCompanyGroup(
  company: string,
  careerSites: string[],
  persistKnownTarget: PersistKnownWorkdayTarget,
): Promise<CompanyGroupScrapeResult> {
  const dedupedJobs = new Map<string, NormalizedJob>();
  const stats = createEmptyWorkdayStats();
  let rawJobsCount = 0;
  let hadSuccessfulResponse = false;
  let hadTimeout = false;
  let hadNon200Status = false;

  for (const careerSite of careerSites) {
    const result = await scrapeCompany(company, careerSite, persistKnownTarget);
    rawJobsCount += result.rawJobsCount;
    hadSuccessfulResponse ||= result.hadSuccessfulResponse;
    hadTimeout ||= result.hadTimeout;
    hadNon200Status ||= result.hadNon200Status;
    stats.uniqueFetched += result.stats.uniqueFetched;
    stats.filteredNonUs += result.stats.filteredNonUs;
    stats.filteredNonTech += result.stats.filteredNonTech;

    for (const job of result.jobs) {
      dedupedJobs.set(job.dedup_hash, job);
    }
  }

  return {
    company,
    jobs: Array.from(dedupedJobs.values()),
    stats,
    rawJobsCount,
    hadSuccessfulResponse,
    hadTimeout,
    hadNon200Status,
  };
}

export async function scrapeWorkday(): Promise<NormalizedJob[]> {
  const today = new Date().toISOString().slice(0, 10);
  const deadCache = await loadWorkdayDeadCache();
  applyCachedWorkdayTargets(deadCache);
  const companyGroups = groupWorkdayCompanies();
  const companiesToAttempt: Array<{ company: string; careerSites: string[] }> = [];
  let skippedFromCache = 0;

  const persistKnownTarget: PersistKnownWorkdayTarget = async (company, careerSite, target) => {
    const changed = rememberWorkdayTarget(deadCache, company, careerSite, target);
    if (!changed) return;
    try {
      await Promise.race([
        saveWorkdayDeadCache(deadCache),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('cache write timeout')), 5000),
        ),
      ]);
    } catch {
      // Cache write failed or timed out — not fatal
    }
  };

  for (const group of companyGroups) {
    const cached = deadCache[group.company];
    if (cached && cached.zeroCount > 0) {
      skippedFromCache += 1;
      cached.zeroCount = Math.max(0, cached.zeroCount - 1);
      continue;
    }

    companiesToAttempt.push(group);
  }

  const all: NormalizedJob[] = [];
  const stats = createEmptyWorkdayStats();
  let companiesWithJobs = 0;
  let timedOutCompanies = 0;

  for (let i = 0; i < companiesToAttempt.length; i += WORKDAY_BATCH_SIZE) {
    const batch = companiesToAttempt.slice(i, i + WORKDAY_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(group => scrapeCompanyGroup(group.company, group.careerSites, persistKnownTarget)),
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;

      all.push(...result.value.jobs);
      stats.uniqueFetched += result.value.stats.uniqueFetched;
      stats.filteredNonUs += result.value.stats.filteredNonUs;
      stats.filteredNonTech += result.value.stats.filteredNonTech;

      const cacheEntry = getOrCreateWorkdayDeadCacheEntry(deadCache, result.value.company);
      cacheEntry.lastAttempt = today;

      if (result.value.jobs.length > 0) {
        companiesWithJobs += 1;
        cacheEntry.zeroCount = 0;
      } else if (result.value.hadTimeout) {
        cacheEntry.zeroCount = 0;
      } else if (result.value.rawJobsCount > 0) {
        cacheEntry.zeroCount = 0;
      } else if (
        result.value.hadNon200Status &&
        !result.value.hadSuccessfulResponse
      ) {
        cacheEntry.zeroCount = WORKDAY_SKIP_RUNS;
      } else {
        cacheEntry.zeroCount = 0;
      }

      if (result.value.hadTimeout) {
        timedOutCompanies += 1;
      }
    }
  }

  try {
    await Promise.race([
      saveWorkdayDeadCache(deadCache),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('final cache write timeout')), 10000),
      ),
    ]);
  } catch {
    console.warn('  [workday] Cache write timed out — skipping');
  }

  console.log(`  [workday] Cache skipped: ${skippedFromCache} companies`);
  console.log(`  [workday] Attempted: ${companiesToAttempt.length} companies`);
  console.log(`  [workday] Companies with jobs: ${companiesWithJobs}`);
  console.log(`  [workday] Timed out: ${timedOutCompanies} companies`);
  console.log(`  [workday] Total unique postings fetched: ${stats.uniqueFetched}`);
  console.log(`  [workday] Filtered out non-US location: ${stats.filteredNonUs}`);
  console.log(`  [workday] Filtered out non-tech role: ${stats.filteredNonTech}`);
  console.log(`  [workday] Kept jobs after filters: ${all.length}`);

  const sampleJobs = all
    .filter(isUsefulWorkdaySampleJob)
    .slice(0, 5);

  const fallbackSampleJobs = all
    .filter(job => isUsefulWorkdaySampleLocation(job.location))
    .slice(0, 5);

  (sampleJobs.length > 0 ? sampleJobs : fallbackSampleJobs.length > 0 ? fallbackSampleJobs : all.slice(0, 5))
    .forEach((job, index) => {
    console.log(`  [workday] Sample ${index + 1}: ${job.title} | ${job.location ?? 'Unknown'}`);
    });

  return all;
}

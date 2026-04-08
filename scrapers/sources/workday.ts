// Source: Workday ATS — used by thousands of large companies.
// Each company exposes a consistent JSON endpoint at:
//   POST https://{company}.{wdVersion}.myworkdayjobs.com/wday/cxs/{company}/{career-site}/jobs
// No API key required. Returns JSON directly.
// Different companies use different subdomain versions (wd1–wd12, wd100).

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
const WD_VERSIONS = ['wd1', 'wd2', 'wd3', 'wd4', 'wd5', 'wd6', 'wd7', 'wd8', 'wd10', 'wd12', 'wd100'];

const WORKDAY_COMPANIES: [string, string][] = [
  // Already verified working from previous runs
  ['nvidia', 'NVIDIAExternalCareerSite'],
  ['visa', 'visa'],
  ['intel', 'external'],
  ['salesforce', 'External_Career_Site'],
  ['capitalone', 'Capital_One'],
  ['cigna', 'cignacareers'],
  ['crowdstrike', 'crowdstrikecareers'],
  ['pfizer', 'pfizercareers'],
  ['leidos', 'external'],
  ['micron', 'external'],
  ['astrazeneca', 'careers'],
  ['sanofi', 'sanoficareers'],
  ['bmo', 'external'],
  ['prudential', 'prudential'],
  ['marvell', 'marvellcareers'],
  ['baxter', 'baxter'],
  ['mars', 'External'],
  ['target', 'Target'],
  ['disney', 'Disney'],
  ['pwc', 'US_Entry_Level_Careers'],
  ['pwc', 'pwc'],

  // Newly verified from real job URLs
  ['draftkings', 'DraftKings'],
  ['quickenloans', 'rocket_careers'],
  ['motorolasolutions', 'careers'],
  ['transunion', 'TransUnion'],
  ['relx', 'ElsevierJobs'],
  ['relx', 'relx'],
  ['argonne', 'Argonne_Careers'],
  ['mksinst', 'MKSCareersUniversity'],
  ['jll', 'jllcareers'],
  ['workiva', 'careers'],
  ['mastercard', 'CorporateCareers'],

  // Big Tech
  ['amazon', 'Amazon_Jobs'],
  ['amazon', 'AmazonJobs'],
  ['microsoft', 'microsoftcareers'],
  ['apple', 'apple'],
  ['meta', 'Meta'],
  ['google', 'Google'],
  ['ibm', 'ibm'],
  ['oracle', 'oracle'],
  ['sap', 'SAP'],
  ['adobe', 'adobe'],
  ['qualcomm', 'qualcomm'],
  ['amd', 'AMD'],
  ['broadcom', 'External_Career_Site'],
  ['ti', 'TICareers'],
  ['analog', 'analogdevices'],
  ['xilinx', 'xilinx'],
  ['vmware', 'VMware'],

  // Enterprise Software
  ['workday', 'workdaycareers'],
  ['workday', 'Workday_Early_Career'],
  ['servicenow', 'servicenow'],
  ['splunk', 'splunk'],
  ['paloaltonetworks', 'External_Career_Site'],
  ['fortinet', 'fortinet'],
  ['netapp', 'netapp'],
  ['purestorage', 'purestorage'],
  ['nutanix', 'nutanix'],
  ['elastic', 'elastic'],
  ['mongodb', 'mongodb'],
  ['cloudera', 'cloudera'],
  ['dynatrace', 'dynatrace'],
  ['informatica', 'informatica'],
  ['teradata', 'teradata'],
  ['f5', 'f5'],
  ['juniper', 'juniper'],
  ['arista', 'arista'],
  ['commvault', 'commvault'],
  ['verint', 'verint'],
  ['opentext', 'opentext'],
  ['tibco', 'tibco'],
  ['solarwinds', 'solarwinds'],

  // Finance / Banking
  ['jpmorganchase', 'jpmorganchase'],
  ['goldmansachs', 'goldmansachs'],
  ['morganstanley', 'morganstanley'],
  ['bankofamerica', 'bankofamerica'],
  ['wellsfargo', 'wellsfargo'],
  ['citi', 'citi'],
  ['blackrock', 'blackrock'],
  ['fidelity', 'fidelitycareers'],
  ['schwab', 'schwab'],
  ['paypal', 'paypal'],
  ['mastercard', 'mastercard'],
  ['americanexpress', 'americanexpress'],
  ['discover', 'discover'],
  ['synchrony', 'synchrony'],
  ['ally', 'ally'],
  ['usbank', 'usbank'],
  ['pnc', 'pnc'],
  ['regions', 'regions'],
  ['truist', 'truist'],
  ['vanguard', 'vanguard'],
  ['tiaa', 'tiaa'],
  ['nuveen', 'nuveen'],
  ['invesco', 'invesco'],
  ['pimco', 'pimco'],
  ['principal', 'principal'],
  ['nationwide', 'nationwide'],
  ['progressive', 'progressive'],
  ['travelers', 'travelers'],
  ['keybank', 'key'],
  ['citizens', 'citizensbank'],
  ['huntington', 'huntington'],
  ['comerica', 'comerica'],
  ['stifel', 'stifel'],
  ['tdbank', 'tdbank'],
  ['franklintempletonin', 'fti'],
  ['tdameritrade', 'careers'],
  ['etrade', 'careers'],
  ['mckinsey', 'mckinsey'],
  ['bcg', 'bcg'],
  ['bain', 'bain'],

  // Insurance
  ['lincolnfinancial', 'lincolnfinancial'],
  ['lincoln', 'lincolnfinancial'],
  ['metlife', 'metlife'],
  ['unum', 'unum'],
  ['sunlife', 'sunlife'],
  ['manulife', 'manulife'],
  ['aetna', 'aetna'],
  ['anthem', 'anthem'],
  ['cna', 'cna'],
  ['markel', 'markel'],

  // Healthcare / Pharma
  ['jnj', 'jnj'],
  ['abbvie', 'abbvie'],
  ['merck', 'merck'],
  ['lilly', 'lilly'],
  ['bms', 'bms'],
  ['gsk', 'gsk'],
  ['novartis', 'novartis'],
  ['roche', 'roche'],
  ['takeda', 'takeda'],
  ['boehringeringelheim', 'careers'],
  ['boehringer', 'careers'],
  ['medtronic', 'medtronic'],
  ['stryker', 'stryker'],
  ['becton', 'bd'],
  ['edwards', 'edwards'],
  ['danaher', 'danaher'],
  ['thermofisher', 'thermofisher'],
  ['illumina', 'illumina'],
  ['unitedhealth', 'uhg'],
  ['elevancehealth', 'elevancehealth'],
  ['humana', 'humana'],
  ['cvs', 'cvs'],
  ['mckesson', 'mckesson'],
  ['cardinal', 'cardinalhealth'],
  ['cerner', 'cerner'],
  ['athenahealth', 'athenahealth'],
  ['zimmer', 'zimmerbiomet'],
  ['hologic', 'hologic'],
  ['amerisource', 'amerisourcebergen'],
  ['allscripts', 'allscripts'],
  ['optum', 'uhg'],
  ['regeneron', 'careers'],
  ['biogen', 'careers'],
  ['gilead', 'careers'],
  ['amgen', 'careers'],
  ['vertex', 'careers'],
  ['alexion', 'careers'],
  ['ucb', 'careers'],
  ['astellas', 'careers'],

  // Consulting / Professional Services
  ['deloitte', 'dttcareers'],
  ['kpmg', 'kpmg'],
  ['ey', 'ey'],
  ['accenture', 'accenturecareers'],
  ['booz', 'bah'],
  ['saic', 'saic'],
  ['caci', 'caci'],
  ['cognizant', 'cognizant'],
  ['infosys', 'infosys'],
  ['capgemini', 'capgemini'],
  ['dxc', 'dxc'],
  ['gartner', 'gartner'],
  ['iqvia', 'iqvia'],
  ['wipro', 'wipro'],
  ['hcltech', 'hcltech'],
  ['unisys', 'unisys'],

  // Aerospace / Defense
  ['boeing', 'boeing'],
  ['lockheedmartin', 'lockheedmartin'],
  ['northropgrumman', 'northropgrumman'],
  ['rtx', 'rtx'],
  ['ge', 'gecareers'],
  ['ge', 'geaerospace'],
  ['ge', 'gehealthcare'],
  ['gehealthcare', 'gehealthcare'],
  ['geaerospace', 'geaerospace'],
  ['l3harris', 'l3harris'],
  ['baesystems', 'baesystems'],
  ['textron', 'textron'],
  ['collins', 'collinsaerospace'],
  ['honeywell', 'honeywell'],
  ['parker', 'parker'],
  ['emerson', 'emerson'],
  ['eaton', 'eaton'],
  ['curtisswright', 'curtisswright'],

  // Auto / EV / Manufacturing
  ['gm', 'General_Motors'],
  ['ford', 'ford'],
  ['stellantis', 'stellantis'],
  ['toyota', 'toyota'],
  ['honda', 'honda'],
  ['bmw', 'bmw'],
  ['volvo', 'volvo'],
  ['caterpillar', 'caterpillar'],
  ['deere', 'deere'],
  ['cummins', 'cummins'],
  ['aptiv', 'aptiv'],
  ['borgwarner', 'borgwarner'],
  ['rockwellautomation', 'rockwellautomation'],
  ['3m', '3M'],
  ['siemens', 'siemens'],
  ['abb', 'abb'],
  ['schneider', 'schneiderelectric'],
  ['ppg', 'ppg'],
  ['sherwinwilliams', 'sherwinwilliams'],
  ['roper', 'roper'],
  ['ametek', 'ametek'],
  ['xylem', 'xylem'],
  ['idex', 'idex'],
  ['graco', 'graco'],
  ['nordson', 'nordson'],
  ['dover', 'dover'],
  ['illinois', 'itw'],
  ['pentair', 'pentair'],
  ['flowserve', 'flowserve'],

  // Retail / Consumer
  ['walmart', 'walmart'],
  ['homedepot', 'homedepot'],
  ['lowes', 'lowes'],
  ['costco', 'costco'],
  ['kroger', 'kroger'],
  ['albertsons', 'albertsons'],
  ['nike', 'nike'],
  ['gap', 'gap'],
  ['nordstrom', 'nordstrom'],
  ['kohls', 'kohls'],
  ['tjx', 'tjx'],
  ['bestbuy', 'bestbuy'],
  ['autozone', 'autozone'],
  ['carmax', 'carmax'],
  ['pvh', 'pvh'],
  ['hanesbrands', 'hanesbrands'],
  ['hyvee', 'hyvee'],

  // Media / Telecom
  ['comcast', 'comcast'],
  ['verizon', 'verizon'],
  ['att', 'att'],
  ['tmobile', 'tmobile'],
  ['charter', 'charter'],
  ['lumen', 'lumen'],
  ['nbcuniversal', 'nbcuniversal'],
  ['paramount', 'paramount'],
  ['fox', 'fox'],
  ['discovery', 'discovery'],
  ['amcnetworks', 'amcnetworks'],
  ['iheartmedia', 'iheartmedia'],

  // Tech / Software
  ['uber', 'uber'],
  ['lyft', 'lyft'],
  ['airbnb', 'airbnb'],
  ['doordash', 'doordash'],
  ['instacart', 'instacart'],
  ['atlassian', 'atlassian'],
  ['dropbox', 'dropbox'],
  ['box', 'box'],
  ['zendesk', 'zendesk'],
  ['hubspot', 'hubspot'],
  ['twilio', 'twilio'],
  ['cloudflare', 'cloudflare'],
  ['databricks', 'databricks'],
  ['snowflake', 'snowflake'],
  ['palantir', 'palantir'],
  ['veeva', 'veeva'],
  ['guidewire', 'guidewire'],
  ['paylocity', 'paylocity'],
  ['adp', 'adp'],
  ['paychex', 'paychex'],
  ['ceridian', 'ceridian'],
  ['medallia', 'medallia'],
  ['qualtrics', 'qualtrics'],
  ['sprinklr', 'sprinklr'],
  ['meltwater', 'meltwater'],
  ['okta', 'okta'],
  ['zscaler', 'zscaler'],
  ['pagerduty', 'pagerduty'],
  ['sumo-logic', 'careers'],
  ['tableau', 'careers'],
  ['microstrategy', 'careers'],
  ['nuance', 'nuance'],
  ['talend', 'careers'],
  ['qlik', 'careers'],
  ['philips', 'philips'],
  ['symantec', 'careers'],

  // Energy / Utilities
  ['exxonmobil', 'exxonmobil'],
  ['chevron', 'chevron'],
  ['conocophillips', 'conocophillips'],
  ['shell', 'shell'],
  ['bp', 'bp'],
  ['halliburton', 'halliburton'],
  ['schlumberger', 'slb'],
  ['bakerhughes', 'bakerhughes'],
  ['baker', 'bakerhughes'],
  ['nexteraenergy', 'nexteraenergy'],
  ['duke-energy', 'duke'],
  ['dominion', 'dominionenergy'],
  ['southern', 'southerncompany'],
  ['exelon', 'exelon'],
  ['eversource', 'eversource'],
  ['firstenergy', 'firstenergy'],
  ['ameren', 'ameren'],
  ['entergy', 'entergy'],
  ['sempra', 'sempra'],
  ['dte', 'dte'],
  ['cms', 'cmsenergy'],
  ['alliant', 'alliantenergy'],
  ['avangrid', 'avangrid'],
  ['centerpoint', 'centerpointenergy'],
  ['atmos', 'atmosenergy'],

  // Additional verified targets

  // Finance & Banking
  ['jpmorgan', 'jpmc'],
  ['bofa', 'bankofamerica'],
  ['wellsfargo', 'wellsfargojobs'],
  ['citigroup', 'citi'],
  ['fidelity', 'fidelity'],
  ['hartford', 'thehartford'],
  ['voya', 'voya'],

  // Tech & Software
  ['datadog', 'datadog'],
  ['confluent', 'confluent'],
  ['hashicorp', 'hashicorp'],
  ['gitlab', 'gitlab'],
  ['docusign', 'docusign'],
  ['coupa', 'coupa'],
  ['zuora', 'zuora'],
  ['momentive', 'momentive'],
  ['mixpanel', 'mixpanel'],
  ['amplitude', 'amplitude'],
  ['braze', 'braze'],
  ['iterable', 'iterable'],
  ['klaviyo', 'klaviyo'],
  ['sendgrid', 'sendgrid'],
  ['fastly', 'fastly'],
  ['qualys', 'qualys'],
  ['rapid7', 'rapid7'],
  ['tenable', 'tenable'],
  ['carbonblack', 'carbonblack'],
  ['tanium', 'tanium'],
  ['illumio', 'illumio'],
  ['lacework', 'lacework'],
  ['samsara', 'samsara'],
  ['verkada', 'verkada'],
  ['coreweave', 'coreweave'],
  ['together', 'together'],
  ['anyscale', 'anyscale'],
  ['groq', 'groq'],
  ['cerebras', 'cerebras'],

  // Healthcare & Biotech
  ['centene', 'centene'],
  ['molina', 'molina'],
  ['davita', 'davita'],
  ['hca', 'hca'],
  ['teladoc', 'teladoc'],
  ['veracyte', 'veracyte'],
  ['bectondickinson', 'bd'],
  ['edgewell', 'edgewell'],
  ['genentech', 'genentech'],
  ['regeneron', 'regeneron'],
  ['biogen', 'biogen'],
  ['gilead', 'gilead'],
  ['bms', 'bristolmyerssquibb'],
  ['jnj', 'jnjcareers'],

  // Defense & Aerospace
  ['raytheon', 'rtx'],
  ['generalatomics', 'ga'],
  ['boozallen', 'boozallen'],
  ['mitre', 'mitre'],
  ['anduril', 'anduril'],
  ['spacex', 'spacex'],

  // Consulting & Professional Services
  ['deloitte', 'deloitte'],
  ['accenture', 'accenturefederal'],
  ['oliver-wyman', 'oliverwyman'],
  ['slalom', 'slalom'],
  ['nttdata', 'nttdata'],
  ['hcl', 'hcl'],

  // Retail & Consumer
  ['lowes', 'Lowes'],

  // Telecom & Media
  ['dish', 'dish'],
  ['nbc', 'nbcuniversal'],
  ['warnerbros', 'warnerbros'],
  ['sony', 'sonycareers'],

  // Energy & Utilities
  ['exxon', 'exxonmobil'],
  ['ge', 'ge'],
];

const WORKDAY_BATCH_SIZE = 25;
const WORKDAY_REQUEST_TIMEOUT_MS = 8_000;
const WORKDAY_SKIP_RUNS = 3;
const WORKDAY_DEAD_CACHE_PATH = join(process.cwd(), 'scrapers', 'cache', 'workday-dead.json');

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function loadWorkdayDeadCache(): Promise<WorkdayDeadCache> {
  try {
    const raw = await readFile(WORKDAY_DEAD_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, Partial<WorkdayDeadCacheEntry>>;

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value?.zeroCount === 'number')
        .map(([company, value]) => [
          company,
          {
            zeroCount: Math.max(0, Math.trunc(value.zeroCount ?? 0)),
            lastAttempt: typeof value.lastAttempt === 'string' ? value.lastAttempt : '',
          },
        ]),
    );
  } catch {
    return {};
  }
}

async function saveWorkdayDeadCache(cache: WorkdayDeadCache): Promise<void> {
  await mkdir(join(process.cwd(), 'scrapers', 'cache'), { recursive: true });
  await writeFile(WORKDAY_DEAD_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
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
};

type WorkdayResolvedAttempt = {
  jobs: WorkdayJob[];
  wdVersion: string;
  slug: string;
};

type WorkdayKnownTarget = {
  wdVersion: string;
  slug: string;
};

type WorkdayAttemptState = {
  result: WorkdayResolvedAttempt | null;
  hadSuccessfulResponse: boolean;
  hadTimeout: boolean;
};

type WorkdayScrapeStats = {
  uniqueFetched: number;
  filteredNonUs: number;
  filteredNonTech: number;
};

type WorkdayDeadCacheEntry = {
  zeroCount: number;
  lastAttempt: string;
};

type WorkdayDeadCache = Record<string, WorkdayDeadCacheEntry>;

type CompanyScrapeResult = {
  jobs: NormalizedJob[];
  stats: WorkdayScrapeStats;
  hadSuccessfulResponse: boolean;
  hadTimeout: boolean;
};

type CompanyGroupScrapeResult = {
  company: string;
  jobs: NormalizedJob[];
  stats: WorkdayScrapeStats;
  hadSuccessfulResponse: boolean;
  hadTimeout: boolean;
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

const WORKDAY_KNOWN_TARGETS: Record<string, WorkdayKnownTarget> = {
  'argonne|Argonne_Careers': { wdVersion: 'wd1', slug: 'Argonne_Careers' },
  'astrazeneca|careers': { wdVersion: 'wd3', slug: 'careers' },
  'baxter|baxter': { wdVersion: 'wd1', slug: 'baxter' },
  'bmo|external': { wdVersion: 'wd3', slug: 'external' },
  'capitalone|Capital_One': { wdVersion: 'wd12', slug: 'Capital_One' },
  'cigna|cignacareers': { wdVersion: 'wd5', slug: 'cignacareers' },
  'crowdstrike|crowdstrikecareers': { wdVersion: 'wd5', slug: 'crowdstrikecareers' },
  'draftkings|DraftKings': { wdVersion: 'wd1', slug: 'DraftKings' },
  'intel|external': { wdVersion: 'wd1', slug: 'external' },
  'jll|jllcareers': { wdVersion: 'wd1', slug: 'jllcareers' },
  'leidos|external': { wdVersion: 'wd5', slug: 'external' },
  'marvell|marvellcareers': { wdVersion: 'wd1', slug: 'marvellcareers' },
  'mars|External': { wdVersion: 'wd3', slug: 'External' },
  'mastercard|CorporateCareers': { wdVersion: 'wd1', slug: 'CorporateCareers' },
  'medtronic|medtronic': { wdVersion: 'wd1', slug: 'medtroniccareers' },
  'micron|external': { wdVersion: 'wd1', slug: 'external' },
  'mksinst|MKSCareersUniversity': { wdVersion: 'wd1', slug: 'MKSCareersUniversity' },
  'motorolasolutions|careers': { wdVersion: 'wd5', slug: 'careers' },
  'nvidia|NVIDIAExternalCareerSite': { wdVersion: 'wd5', slug: 'NVIDIAExternalCareerSite' },
  'pfizer|pfizercareers': { wdVersion: 'wd1', slug: 'pfizercareers' },
  'prudential|prudential': { wdVersion: 'wd3', slug: 'prudential' },
  'pwc|US_Entry_Level_Careers': { wdVersion: 'wd3', slug: 'US_Entry_Level_Careers' },
  'quickenloans|rocket_careers': { wdVersion: 'wd5', slug: 'rocket_careers' },
  'relx|ElsevierJobs': { wdVersion: 'wd3', slug: 'ElsevierJobs' },
  'relx|relx': { wdVersion: 'wd3', slug: 'relx' },
  'salesforce|External_Career_Site': { wdVersion: 'wd12', slug: 'External_Career_Site' },
  'sanofi|sanoficareers': { wdVersion: 'wd3', slug: 'sanoficareers' },
  'target|Target': { wdVersion: 'wd5', slug: 'targetcareers' },
  'transunion|TransUnion': { wdVersion: 'wd5', slug: 'TransUnion' },
  'visa|visa': { wdVersion: 'wd5', slug: 'visa' },
  'abbvie|abbvie': { wdVersion: 'wd5', slug: 'abbvie' },
  'accenture|accenturefederal': { wdVersion: 'wd5', slug: 'accenturefederal' },
  'airbnb|airbnb': { wdVersion: 'wd5', slug: 'airbnb' },
  'americanexpress|americanexpress': { wdVersion: 'wd5', slug: 'americanexpress' },
  'amplitude|amplitude': { wdVersion: 'wd5', slug: 'amplitude' },
  'anduril|anduril': { wdVersion: 'wd1', slug: 'anduril' },
  'anthem|anthem': { wdVersion: 'wd5', slug: 'anthem' },
  'anyscale|anyscale': { wdVersion: 'wd1', slug: 'anyscale' },
  'atlassian|atlassian': { wdVersion: 'wd5', slug: 'atlassian' },
  'att|att': { wdVersion: 'wd5', slug: 'att' },
  'baesystems|baesystems': { wdVersion: 'wd5', slug: 'baesystems' },
  'bain|bain': { wdVersion: 'wd5', slug: 'bain' },
  'bcg|bcg': { wdVersion: 'wd5', slug: 'bcg' },
  'bectondickinson|bd': { wdVersion: 'wd5', slug: 'bd' },
  'bestbuy|bestbuy': { wdVersion: 'wd5', slug: 'bestbuy' },
  'biogen|biogen': { wdVersion: 'wd5', slug: 'biogen' },
  'blackrock|blackrock': { wdVersion: 'wd5', slug: 'blackrock' },
  'bms|bristolmyerssquibb': { wdVersion: 'wd5', slug: 'bristolmyerssquibb' },
  'boeing|boeing': { wdVersion: 'wd5', slug: 'boeing' },
  'bofa|bankofamerica': { wdVersion: 'wd1', slug: 'bankofamerica' },
  'boozallen|boozallen': { wdVersion: 'wd5', slug: 'boozallen' },
  'braze|braze': { wdVersion: 'wd5', slug: 'braze' },
  'carbonblack|carbonblack': { wdVersion: 'wd1', slug: 'carbonblack' },
  'centene|centene': { wdVersion: 'wd5', slug: 'centene' },
  'cerebras|cerebras': { wdVersion: 'wd1', slug: 'cerebras' },
  'charter|charter': { wdVersion: 'wd5', slug: 'charter' },
  'chevron|chevron': { wdVersion: 'wd5', slug: 'chevron' },
  'citigroup|citi': { wdVersion: 'wd5', slug: 'citi' },
  'cloudflare|cloudflare': { wdVersion: 'wd5', slug: 'cloudflare' },
  'cognizant|cognizant': { wdVersion: 'wd5', slug: 'cognizant' },
  'comcast|comcast': { wdVersion: 'wd5', slug: 'comcast' },
  'confluent|confluent': { wdVersion: 'wd5', slug: 'confluent' },
  'conocophillips|conocophillips': { wdVersion: 'wd5', slug: 'conocophillips' },
  'coreweave|coreweave': { wdVersion: 'wd1', slug: 'coreweave' },
  'costco|costco': { wdVersion: 'wd1', slug: 'costco' },
  'coupa|coupa': { wdVersion: 'wd5', slug: 'coupa' },
  'cvs|cvs': { wdVersion: 'wd5', slug: 'cvs' },
  'datadog|datadog': { wdVersion: 'wd5', slug: 'datadog' },
  'davita|davita': { wdVersion: 'wd1', slug: 'davita' },
  'deloitte|deloitte': { wdVersion: 'wd5', slug: 'deloitte' },
  'dish|dish': { wdVersion: 'wd1', slug: 'dish' },
  'docusign|docusign': { wdVersion: 'wd5', slug: 'docusign' },
  'duke-energy|duke': { wdVersion: 'wd1', slug: 'duke' },
  'eaton|eaton': { wdVersion: 'wd5', slug: 'eaton' },
  'edgewell|edgewell': { wdVersion: 'wd1', slug: 'edgewell' },
  'elevancehealth|elevancehealth': { wdVersion: 'wd5', slug: 'elevancehealth' },
  'emerson|emerson': { wdVersion: 'wd5', slug: 'emerson' },
  'exxon|exxonmobil': { wdVersion: 'wd5', slug: 'exxonmobil' },
  'ey|ey': { wdVersion: 'wd5', slug: 'ey' },
  'fastly|fastly': { wdVersion: 'wd5', slug: 'fastly' },
  'fidelity|fidelity': { wdVersion: 'wd1', slug: 'fidelity' },
  'ge|ge': { wdVersion: 'wd5', slug: 'ge' },
  'genentech|genentech': { wdVersion: 'wd5', slug: 'genentech' },
  'generalatomics|ga': { wdVersion: 'wd1', slug: 'ga' },
  'gilead|gilead': { wdVersion: 'wd5', slug: 'gilead' },
  'gitlab|gitlab': { wdVersion: 'wd5', slug: 'gitlab' },
  'goldmansachs|goldmansachs': { wdVersion: 'wd5', slug: 'goldmansachs' },
  'groq|groq': { wdVersion: 'wd1', slug: 'groq' },
  'halliburton|halliburton': { wdVersion: 'wd5', slug: 'halliburton' },
  'hartford|thehartford': { wdVersion: 'wd5', slug: 'thehartford' },
  'hashicorp|hashicorp': { wdVersion: 'wd5', slug: 'hashicorp' },
  'hca|hca': { wdVersion: 'wd5', slug: 'hca' },
  'hcl|hcl': { wdVersion: 'wd1', slug: 'hcl' },
  'hologic|hologic': { wdVersion: 'wd1', slug: 'hologic' },
  'homedepot|homedepot': { wdVersion: 'wd5', slug: 'homedepot' },
  'honeywell|honeywell': { wdVersion: 'wd5', slug: 'honeywell' },
  'hubspot|hubspot': { wdVersion: 'wd5', slug: 'hubspot' },
  'humana|humana': { wdVersion: 'wd5', slug: 'humana' },
  'illumina|illumina': { wdVersion: 'wd5', slug: 'illumina' },
  'illumio|illumio': { wdVersion: 'wd1', slug: 'illumio' },
  'infosys|infosys': { wdVersion: 'wd5', slug: 'infosys' },
  'iterable|iterable': { wdVersion: 'wd1', slug: 'iterable' },
  'jnj|jnjcareers': { wdVersion: 'wd5', slug: 'jnjcareers' },
  'jpmorgan|jpmc': { wdVersion: 'wd5', slug: 'jpmc' },
  'klaviyo|klaviyo': { wdVersion: 'wd5', slug: 'klaviyo' },
  'kohls|kohls': { wdVersion: 'wd1', slug: 'kohls' },
  'kpmg|kpmg': { wdVersion: 'wd5', slug: 'kpmg' },
  'kroger|kroger': { wdVersion: 'wd5', slug: 'kroger' },
  'l3harris|l3harris': { wdVersion: 'wd5', slug: 'l3harris' },
  'lacework|lacework': { wdVersion: 'wd1', slug: 'lacework' },
  'lilly|lilly': { wdVersion: 'wd5', slug: 'lilly' },
  'lincolnfinancial|lincolnfinancial': { wdVersion: 'wd5', slug: 'lincolnfinancial' },
  'lowes|Lowes': { wdVersion: 'wd5', slug: 'Lowes' },
  'lyft|lyft': { wdVersion: 'wd5', slug: 'lyft' },
  'mckinsey|mckinsey': { wdVersion: 'wd5', slug: 'mckinsey' },
  'medallia|medallia': { wdVersion: 'wd5', slug: 'medallia' },
  'merck|merck': { wdVersion: 'wd5', slug: 'merck' },
  'mitre|mitre': { wdVersion: 'wd5', slug: 'mitre' },
  'mixpanel|mixpanel': { wdVersion: 'wd1', slug: 'mixpanel' },
  'molina|molina': { wdVersion: 'wd1', slug: 'molina' },
  'momentive|momentive': { wdVersion: 'wd1', slug: 'momentive' },
  'morganstanley|morganstanley': { wdVersion: 'wd5', slug: 'morganstanley' },
  'nationwide|nationwide': { wdVersion: 'wd5', slug: 'nationwide' },
  'nbc|nbcuniversal': { wdVersion: 'wd5', slug: 'nbcuniversal' },
  'nexteraenergy|nexteraenergy': { wdVersion: 'wd5', slug: 'nexteraenergy' },
  'nordstrom|nordstrom': { wdVersion: 'wd5', slug: 'nordstrom' },
  'northropgrumman|northropgrumman': { wdVersion: 'wd5', slug: 'northropgrumman' },
  'nttdata|nttdata': { wdVersion: 'wd5', slug: 'nttdata' },
  'okta|okta': { wdVersion: 'wd5', slug: 'okta' },
  'oliver-wyman|oliverwyman': { wdVersion: 'wd1', slug: 'oliverwyman' },
  'palantir|palantir': { wdVersion: 'wd5', slug: 'palantir' },
  'paramount|paramount': { wdVersion: 'wd5', slug: 'paramount' },
  'pnc|pnc': { wdVersion: 'wd5', slug: 'pnc' },
  'principal|principal': { wdVersion: 'wd5', slug: 'principal' },
  'progressive|progressive': { wdVersion: 'wd1', slug: 'progressive' },
  'qualtrics|qualtrics': { wdVersion: 'wd5', slug: 'qualtrics' },
  'qualys|qualys': { wdVersion: 'wd1', slug: 'qualys' },
  'rapid7|rapid7': { wdVersion: 'wd1', slug: 'rapid7' },
  'raytheon|rtx': { wdVersion: 'wd5', slug: 'rtx' },
  'regeneron|regeneron': { wdVersion: 'wd5', slug: 'regeneron' },
  'saic|saic': { wdVersion: 'wd5', slug: 'saic' },
  'samsara|samsara': { wdVersion: 'wd5', slug: 'samsara' },
  'schlumberger|slb': { wdVersion: 'wd5', slug: 'slb' },
  'schwab|schwab': { wdVersion: 'wd5', slug: 'schwab' },
  'sendgrid|sendgrid': { wdVersion: 'wd1', slug: 'sendgrid' },
  'siemens|siemens': { wdVersion: 'wd5', slug: 'siemens' },
  'slalom|slalom': { wdVersion: 'wd5', slug: 'slalom' },
  'sony|sonycareers': { wdVersion: 'wd5', slug: 'sonycareers' },
  'spacex|spacex': { wdVersion: 'wd1', slug: 'spacex' },
  'sprinklr|sprinklr': { wdVersion: 'wd5', slug: 'sprinklr' },
  'tanium|tanium': { wdVersion: 'wd1', slug: 'tanium' },
  'teladoc|teladoc': { wdVersion: 'wd1', slug: 'teladoc' },
  'tenable|tenable': { wdVersion: 'wd5', slug: 'tenable' },
  'tmobile|tmobile': { wdVersion: 'wd5', slug: 'tmobile' },
  'together|together': { wdVersion: 'wd1', slug: 'together' },
  'travelers|travelers': { wdVersion: 'wd5', slug: 'travelers' },
  'twilio|twilio': { wdVersion: 'wd5', slug: 'twilio' },
  'unitedhealth|uhg': { wdVersion: 'wd5', slug: 'uhg' },
  'usbank|usbank': { wdVersion: 'wd1', slug: 'usbank' },
  'veeva|veeva': { wdVersion: 'wd5', slug: 'veeva' },
  'veracyte|veracyte': { wdVersion: 'wd1', slug: 'veracyte' },
  'verizon|verizon': { wdVersion: 'wd5', slug: 'verizon' },
  'verkada|verkada': { wdVersion: 'wd1', slug: 'verkada' },
  'voya|voya': { wdVersion: 'wd1', slug: 'voya' },
  'walmart|walmart': { wdVersion: 'wd5', slug: 'walmart' },
  'warnerbros|warnerbros': { wdVersion: 'wd5', slug: 'warnerbros' },
  'wellsfargo|wellsfargojobs': { wdVersion: 'wd5', slug: 'wellsfargojobs' },
  'wipro|wipro': { wdVersion: 'wd5', slug: 'wipro' },
  'zendesk|zendesk': { wdVersion: 'wd5', slug: 'zendesk' },
  'zimmer|zimmerbiomet': { wdVersion: 'wd5', slug: 'zimmerbiomet' },
  'zscaler|zscaler': { wdVersion: 'wd5', slug: 'zscaler' },
  'zuora|zuora': { wdVersion: 'wd1', slug: 'zuora' },
};

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
      return { data: null, timedOut: false };
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return { data: null, timedOut: false };
    }

    const data = (await res.json()) as WorkdayResponse;
    if (!Array.isArray(data.jobPostings)) {
      return { data: null, timedOut: false };
    }

    return { data, timedOut: false };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn(`  [workday] timeout: ${company}`);
      return { data: null, timedOut: true };
    }

    return { data: null, timedOut: false };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Try all (wdVersion, slug) combinations until one returns HTTP 200 with valid JSON
 * containing a jobPostings array. Returns the jobs plus the working (wdVersion, slug).
 * Times out each attempt after 8 seconds.
 */
async function tryWorkdayCompany(
  company: string,
  careerSite: string,
  searchText: string,
): Promise<WorkdayAttemptState> {
  const slugs = slugVariations(company, careerSite);
  let hadSuccessfulResponse = false;
  let hadTimeout = false;

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

      if (!response.data) {
        continue;
      }

      hadSuccessfulResponse = true;
      return {
        result: { jobs: response.data.jobPostings ?? [], wdVersion, slug },
        hadSuccessfulResponse,
        hadTimeout,
      };
    }
  }

  return { result: null, hadSuccessfulResponse, hadTimeout };
}

async function scrapeCompany(
  company: string,
  careerSite: string,
): Promise<CompanyScrapeResult> {
  const seen = new Set<string>();
  const seenFetched = new Set<string>();
  const jobs: NormalizedJob[] = [];
  const stats = createEmptyWorkdayStats();
  let hadSuccessfulResponse = false;
  let hadTimeout = false;

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
      result = attempt.result;

      if (result) {
        foundVersion = result.wdVersion;
        foundSlug = result.slug;
      }
    }

    if (!result) continue;

    const { jobs: postings, wdVersion, slug } = result;

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
        company: company.charAt(0).toUpperCase() + company.slice(1),
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

  return { jobs, stats, hadSuccessfulResponse, hadTimeout };
}

async function scrapeCompanyGroup(
  company: string,
  careerSites: string[],
): Promise<CompanyGroupScrapeResult> {
  const dedupedJobs = new Map<string, NormalizedJob>();
  const stats = createEmptyWorkdayStats();
  let hadSuccessfulResponse = false;
  let hadTimeout = false;

  for (const careerSite of careerSites) {
    const result = await scrapeCompany(company, careerSite);
    hadSuccessfulResponse ||= result.hadSuccessfulResponse;
    hadTimeout ||= result.hadTimeout;
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
    hadSuccessfulResponse,
    hadTimeout,
  };
}

export async function scrapeWorkday(): Promise<NormalizedJob[]> {
  const today = new Date().toISOString().slice(0, 10);
  const deadCache = await loadWorkdayDeadCache();
  const nextDeadCache: WorkdayDeadCache = {};
  const companyGroups = groupWorkdayCompanies();
  const companiesToAttempt: Array<{ company: string; careerSites: string[] }> = [];
  let skippedFromCache = 0;

  for (const group of companyGroups) {
    const cached = deadCache[group.company];
    if (cached && cached.zeroCount > 0) {
      skippedFromCache += 1;
      nextDeadCache[group.company] = {
        zeroCount: Math.max(0, cached.zeroCount - 1),
        lastAttempt: cached.lastAttempt,
      };
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
      batch.map(group => scrapeCompanyGroup(group.company, group.careerSites)),
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;

      all.push(...result.value.jobs);
      stats.uniqueFetched += result.value.stats.uniqueFetched;
      stats.filteredNonUs += result.value.stats.filteredNonUs;
      stats.filteredNonTech += result.value.stats.filteredNonTech;

      if (result.value.jobs.length > 0) {
        companiesWithJobs += 1;
      } else if (result.value.hadSuccessfulResponse || !result.value.hadTimeout) {
        nextDeadCache[result.value.company] = {
          zeroCount: WORKDAY_SKIP_RUNS,
          lastAttempt: today,
        };
      }

      if (result.value.hadTimeout) {
        timedOutCompanies += 1;
      }
    }
  }

  await saveWorkdayDeadCache(nextDeadCache);

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

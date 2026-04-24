import { generateHash } from './dedup';
import { isNonUsLocation } from './location';

export type ExperienceLevel = 'new_grad' | 'entry_level' | 'internship';
export const ROLE_VALUES = [
  'swe',
  'ds',
  'ml',
  'ai',
  'analyst',
  'pm',
  'security',
  'devops',
  'consulting',
  'finance',
] as const;
export type Role = (typeof ROLE_VALUES)[number];
export const TARGET_ROLE_VALUES = ['swe', 'ds', 'ml', 'ai', 'analyst', 'pm'] as const;

export type NormalizedJob = {
  source: string;
  source_id?: string;
  title: string;
  company: string;
  location?: string;
  remote: boolean;
  is_usa: boolean;
  url: string;
  description?: string;
  salary_min?: number;
  salary_max?: number;
  experience_level: ExperienceLevel;
  roles: Role[];
  posted_at?: string;
  dedup_hash: string;
};

export type NormalizeJobInput = {
  source: string;
  sourceId?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  remote?: boolean | null;
  url?: string | null;
  description?: string | null;
  postedAt?: string | Date | null;
  roles?: Role[] | null;
  roleText?: string | null;
  experienceText?: string | null;
};

type UsaLocationInput = {
  location?: string | null;
  remote?: boolean | null;
};

const US_STATE_ABBREVIATIONS = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA',
  'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME',
  'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM',
  'NV', 'NY', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX',
  'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY',
] as const;

const US_STATE_NAMES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado',
  'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho',
  'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana',
  'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota',
  'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York',
  'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
  'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
  'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington',
  'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia',
] as const;

const US_BARE_CITY_CODES = [
  'SF', 'NYC', 'LA', 'DC', 'ATL', 'BOS', 'SEA', 'CHI',
  'PHX', 'DEN', 'AUS', 'MIA', 'PDX', 'DFW', 'SLC',
] as const;

const MAJOR_US_CITY_NAMES = [
  'New York', 'Los Angeles', 'San Francisco', 'Chicago', 'Seattle', 'Boston',
  'Austin', 'Denver', 'Atlanta', 'Miami', 'Phoenix', 'Dallas', 'Houston',
  'San Jose', 'San Diego', 'Portland', 'Nashville', 'Minneapolis', 'Detroit',
  'Philadelphia', 'Charlotte', 'Washington', 'Las Vegas', 'Salt Lake City',
  'Sacramento', 'Pittsburgh', 'Baltimore', 'Cincinnati', 'Columbus',
  'Cleveland', 'Indianapolis', 'Kansas City', 'St. Louis', 'Tampa', 'Orlando',
  'Raleigh', 'Richmond', 'Louisville', 'Memphis', 'Milwaukee', 'Albuquerque',
  'Tucson', 'Fresno', 'Mesa', 'Omaha', 'Colorado Springs', 'Reno',
  'Henderson', 'Buffalo', 'Fort Worth', 'El Paso', 'Arlington', 'Irvine',
  'Madison', 'Durham', 'Lubbock', 'Baton Rouge', 'Fremont', 'Gilbert',
  'Birmingham', 'Rochester', 'Spokane', 'Des Moines', 'Tacoma', 'Glendale',
  'Akron', 'Knoxville', 'Providence', 'Grand Rapids', 'Chattanooga',
  'Fort Lauderdale', 'Santa Clara', 'Sunnyvale', 'Bellevue', 'Redmond',
  'Menlo Park', 'Palo Alto', 'Mountain View', 'Cupertino', 'Santa Monica',
  'Burbank', 'Pasadena', 'Scottsdale', 'Tempe', 'Chandler', 'Roseville',
  'Huntsville', 'Fayetteville', 'Gainesville', 'Tallahassee', 'Jacksonville',
  'Anchorage', 'Honolulu', 'Lafayette', 'Stennis',
] as const;

const US_SPECIAL_LOCATION_TERMS = ['AFB', 'Naval', 'Pentagon', 'Quantico', 'Langley'] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const US_STATE_ABBREVIATION_RE = new RegExp(
  `,\\s*(?:${US_STATE_ABBREVIATIONS.join('|')})(?=\\b|\\s|,|$)`,
  'i',
);

const US_STATE_NAME_RE = new RegExp(
  `\\b(?:${US_STATE_NAMES.map(escapeRegex).join('|')})\\b`,
  'i',
);

const US_BARE_CITY_CODE_RE = new RegExp(
  `(?:^|[^a-z])(?:${US_BARE_CITY_CODES.join('|')})(?:[^a-z]|$)`,
  'i',
);

const US_COUNTRY_RE = /\b(?:united states|usa)\b|\bu\.s\.a?\.?(?=\s|,|$)/i;
const WORKDAY_MULTI_LOCATION_RE = /\b\d+\s+locations?\b/i;
const WORKDAY_US_CITY_RE = /\bUS,\s*[^,]+/i;
const WORKDAY_STATE_CITY_RE = new RegExp(
  `\\b(?:${US_STATE_ABBREVIATIONS.join('|')})-[A-Z0-9][A-Z0-9 -]*-\\d+\\b`,
  'i',
);
const PERTH_WA_RE = /\bperth,\s*wa\b/i;

export function isUsaLocation(job: UsaLocationInput): boolean {
  if (job.remote === true) return true;

  const location = job.location?.trim();
  if (!location) return true;
  if (PERTH_WA_RE.test(location)) return false;

  const lower = location.toLowerCase();

  if (US_COUNTRY_RE.test(location)) return true;
  if (US_STATE_ABBREVIATION_RE.test(location)) return true;
  if (US_BARE_CITY_CODE_RE.test(location)) return true;
  if (MAJOR_US_CITY_NAMES.some(city => lower.includes(city.toLowerCase()))) return true;
  if (US_SPECIAL_LOCATION_TERMS.some(term => lower.includes(term.toLowerCase()))) return true;
  if (WORKDAY_MULTI_LOCATION_RE.test(location)) return true;
  if (WORKDAY_US_CITY_RE.test(location)) return true;
  if (WORKDAY_STATE_CITY_RE.test(location)) return true;
  if (US_STATE_NAME_RE.test(location)) return true;

  return false;
}

export function finalizeNormalizedJob(job: Omit<NormalizedJob, 'is_usa'>): NormalizedJob {
  return {
    ...job,
    is_usa: isUsaLocation(job),
  };
}

// ---------------------------------------------------------------------------
// ROLE KEYWORDS
// ---------------------------------------------------------------------------

const ROLE_KEYWORDS: Record<Role, string[]> = {
  swe: [
    // Core titles
    'software engineer', 'software engineering', 'software developer', 'software programmer',
    'software eng', 'software engg', 'software development engineer', 'software design engineer',
    'swe', 'sde', 'se i', 'sde i', 'swe i', 'engineer i', 'engineer 1',
    'product engineer', 'product software engineer', 'product software developer',
    'computer engineer', 'computer scientist',
    'graduate software engineer', 'new grad software', 'software new grad',
    'associate software engineer', 'associate software developer',
    'software engineering intern', 'swe intern', 'sde intern',
    'engineer, software', 'developer, software',
    // Full stack
    'full stack', 'fullstack', 'full-stack',
    // Frontend
    'frontend', 'front end', 'front-end',
    'ui engineer', 'ui developer', 'ux engineer',
    'web developer', 'web engineer', 'web programmer',
    'javascript developer', 'react developer', 'angular developer',
    'vue developer', 'node developer', 'typescript developer',
    // Backend
    'backend', 'back end', 'back-end',
    'api developer', 'api engineer',
    'java developer', 'python developer', 'golang developer',
    'go developer', 'ruby developer', 'c++ developer', 'c# developer',
    'php developer', '.net developer', 'scala developer', 'rust developer',
    // Systems / Platform / Infra (non-DevOps)
    'systems engineer', 'systems developer', 'systems programmer',
    'systems software', 'systems software engineer', 'systems software developer',
    'operating systems', 'distributed systems', 'distributed systems engineer',
    'software/platform', 'platform software', 'platform software engineer',
    'backend platform engineer', 'infrastructure software engineer',
    'application developer', 'application engineer', 'applications engineer',
    'application software', 'software application',
    'internal tools engineer', 'developer productivity engineer',
    'tools engineer', 'developer tools', 'developer experience', 'dx engineer',
    'tooling engineer', 'integrations engineer', 'integration engineer',
    'integration developer', 'integration software',
    'microservices engineer', 'microservices developer',
    // Mobile
    'mobile engineer', 'mobile developer', 'mobile software',
    'ios engineer', 'ios developer', 'ios software',
    'android engineer', 'android developer', 'android software',
    'react native', 'flutter developer', 'swift developer', 'kotlin developer',
    // Embedded / Hardware
    'embedded engineer', 'embedded software', 'embedded systems', 'embedded developer',
    'firmware engineer', 'firmware developer', 'firmware software',
    'hardware engineer', 'hardware developer',
    'fpga engineer', 'fpga developer',
    'rtos engineer', 'bare metal', 'low level engineer',
    'kernel developer', 'kernel engineer', 'driver developer',
    'protocol engineer', 'rf engineer', 'radio frequency engineer',
    'photonics engineer', 'optical engineer',
    // Specialized engineering
    'simulation engineer', 'robotics engineer', 'robotics software',
    'visualization engineer', 'graphics engineer', 'graphics programmer',
    'rendering engineer', 'shader engineer',
    'game engineer', 'game developer', 'gameplay engineer', 'engine developer',
    'compiler engineer', 'programming language',
    'numerical methods', 'scientific computing',
    'storage engineer', 'database engineer',
    'growth engineer', 'platform engineer', 'infrastructure engineer',
    'reliability engineer', 'site reliability', 'sre',
    'performance engineer', 'capacity engineer',
    'forward deployed engineer', 'field engineer',
    'build engineer', 'release engineer',
    'spacecraft software', 'avionics software', 'flight software',
    'vehicle software', 'vehicle software engineer',
    'api software', 'api software engineer',
    // QA / Testing
    'qa engineer', 'quality engineer', 'quality assurance',
    'test engineer', 'sdet', 'software test', 'software quality',
    'automation engineer', 'test automation',
    // Solutions / Implementation
    'solutions engineer', 'solutions developer',
    'implementation engineer', 'implementation developer',
    'technical support engineer', 'support engineer',
    // Catch-all architect (non-senior)
    'software architect',
    // TPM (technical, not consulting)
    'technical program manager', 'tpm',
  ],
  ds: [
    // Core data science
    'data scientist', 'data science', 'data science analyst',
    'staff data scientist', 'junior data scientist', 'associate data scientist',
    'quantitative data scientist', 'analytics scientist',
    'experimentation scientist', 'measurement scientist',
    // Research science
    'research scientist', 'applied scientist', 'applied research scientist',
    'research engineer', 'applied researcher',
    'computational scientist', 'computational researcher',
    'causal inference scientist', 'causal inference engineer',
    // Data engineering
    'data engineer', 'staff data engineer', 'data engineering',
    'data science intern', 'data engineer intern',
    'analytics engineer', 'analytics engineering', 'analytics intern',
    'data platform engineer', 'data infrastructure',
    'etl developer', 'etl engineer', 'pipeline engineer',
    'data pipeline', 'data warehouse', 'data lake',
    'database analyst', 'database developer', 'sql developer', 'sql engineer',
    'hadoop engineer', 'spark engineer', 'kafka engineer',
    'ml data engineer', 'machine learning data',
    // Statistics
    'statistician', 'statistical analyst', 'statistical researcher',
    'biostatistician', 'econometrician', 'econometrics analyst',
    // Quant research (overlap with finance but data-heavy)
    'quantitative researcher', 'quant researcher',
    'quantitative scientist', 'decision scientist',
    'operations research analyst', 'operations research engineer',
    // Other data
    'data modeler', 'data architect', 'data solutions',
    'reporting engineer', 'bi engineer', 'bi developer',
    'business intelligence', 'reporting analyst', 'reporting specialist',
    'insights analyst', 'strategy analyst',
    'business intelligence engineer', 'business intelligence developer',
    'experimentation analyst', 'measurement analyst',
    'dashboard analyst', 'data reporting',
    'data quality analyst', 'master data analyst',
    'spatial analyst', 'geospatial analyst', 'gis analyst', 'gis developer',
  ],
  ml: [
    // Core ML
    'machine learning', 'machine learning intern', 'ml engineer', 'ml developer', 'ml intern',
    'applied machine learning engineer', 'applied ml engineer', 'applied ml intern',
    'mlops', 'ml ops', 'ml platform', 'ml platform engineer',
    'ml infrastructure', 'ml infrastructure engineer',
    'machine learning platform', 'ai engineer', 'ai/ml',
    'ml systems', 'ml systems engineer', 'ml research', 'ml scientist',
    // Model / training
    'model engineer', 'model developer', 'training engineer', 'model training engineer',
    'training infrastructure', 'inference engineer', 'model deployment',
    'model serving', 'model serving engineer', 'serving engineer',
    'feature store engineer',
    // Recommendation / ranking / search
    'recommendation engineer', 'recommendation scientist',
    'recommendation systems',
    'ranking engineer', 'ranking scientist',
    'search engineer', 'search scientist', 'search relevance',
    // CV / NLP / Speech
    'computer vision', 'cv engineer', 'cv scientist',
    'vision engineer', 'vision scientist',
    'nlp engineer', 'nlp scientist', 'nlp developer',
    'natural language processing', 'natural language understanding',
    'speech engineer', 'speech scientist', 'speech recognition',
    'audio engineer', 'audio ml',
    'vision-language', 'text-to-image', 'text-to-speech',
    'multimodal engineer', 'multimodal researcher',
    // Autonomous / Robotics ML
    'perception engineer', 'perception scientist',
    'autonomous', 'autonomy engineer', 'autonomy scientist',
    'self-driving', 'slam engineer',
    'robotics learning engineer', 'autonomous systems ml',
    // Other ML specializations
    'deep learning', 'trustworthy ai', 'responsible ai', 'ai safety engineer',
    'anomaly detection', 'forecasting engineer', 'time series engineer',
    'signal processing engineer', 'feature engineer', 'feature platform',
    'synthetic data engineer', 'data annotation engineer', 'gpu engineer',
  ],
  ai: [
    // Core AI
    'ai engineer', 'ai developer', 'ai scientist',
    'artificial intelligence', 'artificial intelligence intern',
    'ai researcher', 'ai research', 'ai intern', 'ai/ml intern',
    'ai infrastructure', 'ai platform',
    'ai systems', 'ai solutions',
    // Deep learning
    'deep learning', 'neural network',
    // LLM / GenAI
    'llm', 'large language model', 'llm engineer', 'language model engineer',
    'generative ai', 'generative ai engineer', 'gen ai', 'genai', 'genai engineer',
    'foundation model', 'foundation model engineer', 'model adaptation engineer',
    'fine-tuning engineer', 'finetuning engineer',
    'transformer', 'diffusion model', 'multimodal',
    'synthetic data engineer', 'data curation engineer',
    'knowledge graph', 'ontology engineer', 'embeddings engineer',
    // Agents / Prompting
    'ai agent', 'agentic', 'agent engineer', 'agentic ai engineer',
    'prompt engineer', 'prompt engineering', 'prompt designer',
    // Reinforcement learning
    'reinforcement learning', 'rl engineer', 'rl researcher',
    'rlhf trainer', 'rlhf engineer', 'rlhf researcher',
    // Evaluation / safety / alignment
    'ai evaluator', 'model evaluator', 'llm evaluator', 'response evaluator',
    'ai trainer', 'ai rater', 'human-in-the-loop trainer',
    'ai red teamer', 'ai red team', 'adversarial ml engineer',
    'ai safety', 'ai safety researcher', 'ai alignment', 'alignment researcher',
    'model alignment engineer', 'model quality engineer', 'ai quality engineer',
    // AI applications
    'conversational ai engineer', 'chatbot engineer', 'chatbot developer',
    'reasoning engineer', 'reasoning researcher',
    'ai automation', 'intelligent automation',
    'virtual assistant engineer', 'virtual assistant developer',
    // Combined labels
    'ai/ml', 'ml/ai',
    // AI architect
    'ai architect', 'ai technical',
  ],
  analyst: [
    // Data / BI
    'data analyst', 'data analytics',
    'business analyst', 'business analysis',
    'business intelligence analyst', 'bi analyst',
    'analytics analyst', 'analytics associate',
    'insights analyst', 'reporting analyst', 'reporting specialist',
    'dashboard analyst', 'data reporting',
    'database analyst', 'data quality analyst', 'measurement analyst',
    'analyst intern', 'data analyst intern', 'business analyst intern',
    'junior analyst', 'associate analyst',
    // Product analytics
    'product analyst', 'growth analyst', 'marketing analyst',
    'consumer insights', 'customer insights', 'customer analytics',
    'market research analyst',
    // Operations
    'operations analyst', 'ops analyst',
    'operational analyst', 'process analyst',
    'supply chain analyst', 'logistics analyst',
    'supply chain data', 'logistics data',
    'pricing analyst', 'revenue analyst',
    // Systems / IT
    'systems analyst', 'it analyst',
    'functional analyst', 'web analyst', 'digital analyst',
    'seo analyst', 'sem analyst',
    'technology analyst', 'technical analyst',
    // Strategy
    'strategy analyst', 'strategic analyst',
    'corporate strategy', 'business strategy analyst',
    // Finance adjacent (non-quant)
    'financial analyst', 'fp&a analyst', 'fpa analyst',
    'market analyst', 'risk analyst', 'compliance analyst',
    'fraud analyst', 'content analyst', 'quality analyst',
    'corporate finance analyst', 'investment analyst',
    'research analyst', 'equity research analyst',
    'credit analyst', 'loan analyst',
    'economic analyst', 'economist',
    // Policy / program
    'policy analyst', 'program analyst',
    'intelligence analyst', 'research associate',
    'trust and safety', 'healthcare analyst',
    'clinical data analyst', 'clinical analyst',
    'real estate analyst', 'asset analyst',
    'workforce analyst', 'people analytics', 'hr analyst', 'people data',
    'ux researcher', 'user researcher', 'ux research',
    'environmental analyst', 'sustainability analyst',
    'media analyst', 'advertising analyst',
    // Catch-all with word boundary guard
    ' analyst',
  ],
  pm: [
    // Core PM
    'product manager', 'product management',
    'associate product manager', 'associate pm', 'apm',
    'product analyst', 'product operations', 'product specialist',
    'growth product manager', 'growth pm',
    'consumer product manager', 'enterprise product manager',
    'rotational product manager', 'rpm',
    // Technical PM
    'technical product manager', 'technical pm',
    'technical program manager', 'tpm',
    'platform product manager', 'platform pm',
    // Program management (non-TPM)
    'program manager', 'associate program manager',
    // Product owner
    'product owner', 'product strategy',
    'product lead', 'product development manager',
    // Intern variants
    'product intern', 'product management intern', 'product manager intern',
    'pm intern', 'apm intern',
    // Catch-all
    ' pm ',
  ],
  security: [
    // Core security titles
    'security engineer', 'security developer', 'security analyst',
    'security researcher', 'security scientist',
    'security specialist', 'security associate',
    'security administrator', 'security operations',
    // Cyber prefix (space and hyphen variants)
    'cybersecurity', 'cyber security', 'cyber-security',
    'cybersecurity engineer', 'cybersecurity analyst',
    'cybersecurity specialist', 'cybersecurity researcher',
    // Information security
    'information security', 'infosec',
    'information security analyst', 'information security engineer',
    'information security specialist',
    // Network security
    'network security', 'network security engineer',
    'network security analyst',
    // Application / Product security
    'application security', 'appsec', 'app security',
    'product security', 'software security',
    'web application security', 'security software engineer',
    // Cloud security
    'cloud security', 'cloud security engineer', 'cloud security analyst',
    // DevSecOps
    'devsecops', 'dev sec ops',
    // SOC / Operations
    'soc analyst', 'soc engineer',
    'security operations center', 'threat analyst',
    'incident response', 'incident responder',
    'security incident', 'security automation engineer',
    'security intern', 'cybersecurity intern', 'security engineer intern',
    // Penetration testing
    'penetration tester', 'penetration testing', 'pen tester', 'pen test',
    'ethical hacker', 'red team', 'blue team', 'purple team',
    'ai red teamer',
    // Vulnerability / Risk
    'vulnerability', 'vulnerability analyst', 'vulnerability engineer',
    'vulnerability researcher',
    'risk analyst', 'risk engineer', 'risk management engineer',
    'security risk', 'fraud engineer', 'anti-fraud engineer',
    // Identity / Access
    'identity engineer', 'iam engineer', 'identity and access',
    'access management', 'zero trust', 'zero trust engineer',
    'endpoint security', 'endpoint engineer', 'endpoint analyst',
    // Cryptography / Privacy
    'cryptography', 'cryptographic engineer',
    'privacy engineer', 'privacy analyst',
    'trust and safety engineer', 'trust and safety analyst',
    // Compliance / GRC
    'compliance engineer', 'compliance analyst',
    'grc analyst', 'governance risk',
    // Digital forensics
    'digital forensics', 'forensic analyst', 'forensics engineer',
    'malware analyst', 'threat intelligence',
    'reverse engineer', 'reverse engineering',
    'threat hunter', 'threat hunting',
    // Catch-all
    'cyber analyst', 'cyber engineer',
  ],
  devops: [
    // Core DevOps
    'devops', 'dev ops', 'devops engineer', 'devops developer',
    'devops associate', 'associate devops',
    'junior devops', 'junior devops engineer',
    'devops intern', 'platform intern', 'cloud intern', 'infrastructure intern',
    // SRE
    'site reliability', 'sre', 'reliability engineer',
    'site reliability engineer',
    // Platform / Infra
    'platform engineer', 'platform developer',
    'infrastructure engineer', 'infrastructure developer',
    'infrastructure as code', 'iac engineer',
    'terraform engineer', 'ansible engineer', 'puppet engineer', 'chef engineer',
    // Cloud operations
    'cloud engineer', 'cloud developer', 'cloud operations',
    'cloud infrastructure', 'cloud devops',
    'aws engineer', 'azure engineer', 'gcp engineer',
    'cloud practitioner',
    'cloud support engineer', 'cloud support associate',
    'cloud systems administrator', 'cloud administrator',
    // Systems administration
    'systems administrator', 'sysadmin', 'sys admin',
    'systems reliability', 'linux engineer',
    'linux administrator', 'linux systems',
    'virtualization engineer', 'vmware engineer',
    // Network / IT ops
    'network engineer', 'network administrator', 'network developer',
    'network operations', 'it operations', 'it infrastructure',
    'technical operations', 'tech ops',
    // Database administration
    'database administrator', 'dba', 'database engineer',
    // Automation / CI/CD
    'automation engineer', 'build and release', 'release manager',
    'ci/cd engineer', 'cicd engineer', 'pipeline engineer',
    // Containers / Kubernetes
    'kubernetes engineer', 'k8s engineer',
    'container engineer', 'docker engineer',
    // Monitoring / observability
    'observability engineer', 'monitoring engineer', 'chaos engineer',
    // DevSecOps (also in security — intentional overlap)
    'devsecops',
    // Cloud-native / GitOps
    'cloud native', 'gitops', 'platform operations',
    'service mesh engineer', 'istio engineer',
    // Storage / compute
    'storage engineer', 'compute engineer',
    'backup engineer', 'disaster recovery engineer',
    // MLOps (overlap with ml — intentional)
    'mlops', 'dataops',
  ],
  consulting: [
    // Generic consulting
    'consultant', 'consulting',
    'consulting intern', 'consultant intern', 'strategy intern',
    'junior consultant', 'entry consultant',
    'technology consultant', 'tech consultant',
    'it consultant', 'it consulting',
    // Management / Strategy consulting
    'management consultant', 'strategy consultant',
    'business consultant', 'business consulting',
    'strategy consulting',
    // Digital / transformation
    'digital transformation', 'digital consultant',
    'change management', 'organizational consultant',
    // Firm-specific entry-level titles
    'business analyst consultant',
    'analyst consultant',
    'associate consultant',
    'consulting analyst',
    'technology analyst', 'technology associate',
    'business technology analyst',
    'consulting associate',
    'associate program',
    // Implementation / solutions consulting
    'implementation consultant', 'implementation specialist',
    'solutions consultant', 'solutions specialist',
    'erp consultant', 'sap consultant', 'oracle consultant',
    'salesforce consultant', 'salesforce developer',
    'servicenow consultant', 'workday consultant',
    // Advisory
    'advisory analyst', 'advisory associate', 'advisory consultant',
    'risk advisory', 'risk consultant',
    'financial advisory', 'deals analyst',
    // Specific firm program names
    'systems integration', 'si consultant',
    'enterprise solutions', 'enterprise consultant',
    'client services analyst',
    // Big 4 specific
    'deloitte analyst', 'pwc analyst', 'kpmg analyst', 'ey analyst',
    // Human capital / people
    'human capital', 'workforce consultant',
    'organizational design',
  ],
  finance: [
    // Quantitative roles
    'quantitative analyst', 'quant analyst',
    'quantitative researcher', 'quant researcher',
    'quantitative developer', 'quant developer',
    'quantitative trader', 'quant trader',
    'quantitative engineer', 'quant engineer',
    'quantitative strategist', 'quant strategist',
    'quantitative associate', 'quant intern', 'junior quant',
    // Trading
    'algorithmic trading', 'algorithmic trading engineer',
    'algo trading', 'algo trader',
    'electronic trading', 'systematic trading',
    'trading analyst', 'trading associate', 'trading developer',
    'trading intern', 'execution trader', 'junior trader', 'derivatives analyst',
    // Financial engineering / strats
    'financial engineer', 'financial engineering', 'financial software engineer',
    'strats', 'digital strats', 'multi asset',
    'structured products', 'fixed income analyst',
    'rates analyst', 'credit analyst', 'fx analyst',
    'investment banking analyst', 'investment banking intern',
    // Investment / research
    'investment analyst', 'equity research', 'credit research',
    'portfolio analyst', 'portfolio associate',
    'asset management analyst', 'wealth management analyst',
    'hedge fund analyst', 'private equity analyst',
    // Risk
    'risk analyst', 'risk associate', 'risk engineer',
    'market risk', 'credit risk', 'operational risk',
    'model risk', 'risk modeling',
    // Fintech / finance tech
    'fintech', 'financial technology',
    'payments engineer', 'payments analyst',
    'banking technology', 'capital markets technology',
    'blockchain developer', 'smart contract developer', 'web3 developer', 'defi engineer',
    'crypto analyst', 'crypto engineer', 'cryptocurrency analyst',
    // Treasury / Corporate Finance
    'treasury analyst', 'corporate finance analyst', 'finance intern',
    'fp&a', 'fpa analyst', 'financial planning',
    // Actuarial
    'actuarial analyst', 'actuary', 'actuarial associate',
    'actuarial science',
    // Accounting (from jobright_accounting)
    'staff accountant', 'accounting analyst',
    'audit associate', 'audit analyst', 'external audit',
    'internal audit', 'tax analyst', 'tax associate',
    'controller', 'accounting associate', 'summer analyst',
  ],
};

// ---------------------------------------------------------------------------
// TECH TITLE SIGNAL PATTERNS (used as ML fallback for inferRoles)
// ---------------------------------------------------------------------------

const TECH_TITLE_SIGNAL_PATTERNS = [
  /\bengineer\b/i,
  /\bdeveloper\b/i,
  /\bscientist\b/i,
  /\barchitect\b/i,
  /\bdevops\b/i,
  /\bsre\b/i,
  /\bplatform\b/i,
  /\bbackend\b/i,
  /\bfrontend\b/i,
  /\bfullstack\b/i,
  /\bfull.?stack\b/i,
  /\bmachine.?learning\b/i,
  /\bsoftware\b/i,
  /\bcloud\b/i,
  /\bsecurity\b/i,
  /\binfrastructure\b/i,
  /\b(ml|ai|nlp|swe|sde|sdet|tpm)\b/i,
  /\bproduct.?manager\b/i,
  /\bprogram.?manager\b/i,
  /\btechnical\b/i,
  /\bsystems\b/i,
  /\bdata\b/i,
  /\bquant(itative)?\b/i,
  /\banalytics\b/i,
  /\bautomation\b/i,
  /\bembedded\b/i,
  /\bfirmware\b/i,
  /\brobotic\b/i,
  /\bcybersecurity\b/i,
  /\bnetwork(ing)?\b/i,
  /\bmobile\b/i,
  /\bios\b/i,
  /\bandroid\b/i,
  /\bgame\b/i,
  /\bgraphics\b/i,
  /\bsimulation\b/i,
  /\bcompiler\b/i,
  /\bvirtualization\b/i,
  /\btelemetry\b/i,
  /\bstorage\b/i,
  /\bcompute\b/i,
  /\bnetwork\b/i,
] as const;

// ---------------------------------------------------------------------------
// ROLE ALIASES (for normalizing externally-supplied role strings)
// ---------------------------------------------------------------------------

const ROLE_ALIASES: Record<string, Role> = {
  swe: 'swe',
  ds: 'ds',
  ml: 'ml',
  ai: 'ai',
  analyst: 'analyst',
  pm: 'pm',
  security: 'security',
  devops: 'devops',
  consulting: 'consulting',
  finance: 'finance',
};

const TARGET_ROLE_KEYWORDS: Record<(typeof TARGET_ROLE_VALUES)[number], string[]> = {
  swe: [
    'software engineer', 'software engineering', 'software developer',
    'software development engineer', 'software programmer', 'software eng',
    'developer', 'swe', 'sde',
    'product engineer', 'computer engineer',
    'frontend engineer', 'frontend developer', 'front end engineer', 'front-end engineer',
    'backend engineer', 'backend developer', 'back end engineer', 'back-end engineer',
    'full stack engineer', 'full stack developer', 'fullstack engineer', 'fullstack developer',
    'web engineer', 'web developer',
    'mobile engineer', 'mobile developer', 'ios engineer', 'ios developer',
    'android engineer', 'android developer',
    'application engineer', 'application developer',
    'platform software', 'platform software engineer',
    'distributed systems engineer', 'systems software engineer',
    'internal tools engineer', 'microservices engineer',
    'api engineer', 'api developer', 'api software engineer',
    'software engineering intern', 'graduate software engineer',
  ],
  ds: [
    'data scientist', 'data science', 'data engineer', 'analytics engineer',
    'data analyst', 'business intelligence', 'bi analyst', 'bi engineer',
    'research scientist', 'applied scientist', 'applied research scientist',
    'data science analyst', 'analytics scientist',
    'decision scientist', 'quantitative analyst', 'quant analyst',
    'operations research analyst', 'data science intern',
    'database analyst', 'sql developer', 'geospatial analyst',
  ],
  ml: [
    'machine learning', 'ml engineer', 'ml scientist', 'ml researcher',
    'ml developer', 'deep learning', 'nlp engineer', 'nlp scientist',
    'machine learning intern', 'applied machine learning engineer',
    'ml platform engineer', 'ml systems engineer',
    'computer vision', 'cv engineer', 'cv scientist',
    'model serving engineer', 'feature store engineer',
    'multimodal engineer', 'text-to-image', 'mlops',
  ],
  ai: [
    'artificial intelligence', 'ai engineer', 'ai scientist', 'ai researcher',
    'llm', 'large language model', 'generative ai', 'genai', 'gen ai',
    'ai intern', 'artificial intelligence intern',
    'generative ai engineer', 'llm engineer', 'foundation model',
    'foundation model engineer', 'prompt engineer', 'prompt designer',
    'agent engineer', 'ai safety', 'conversational ai engineer',
    'reasoning engineer', 'embeddings engineer', 'ai/ml', 'ml/ai',
  ],
  analyst: [
    'data analyst', 'business analyst', 'business intelligence analyst',
    'bi analyst', 'analytics analyst', 'product analyst', 'technical analyst',
    'technology analyst', 'research analyst', 'strategy analyst', 'operations analyst',
    'dashboard analyst', 'reporting specialist', 'healthcare analyst',
    'workforce analyst', 'ux researcher', 'customer insights',
  ],
  pm: [
    'product manager', 'product management', 'associate product manager',
    'apm', 'technical product manager', 'product analyst',
    'product management intern', 'product manager intern',
    'rotational product manager', 'rpm', 'growth product manager',
    'platform pm', 'product strategy', 'associate program manager',
  ],
};

export function normalizeRoleValue(role: string): Role | null {
  return ROLE_ALIASES[role.trim().toLowerCase()] ?? null;
}

export function normalizeRoles(roles: readonly string[] | null | undefined): Role[] {
  if (!roles?.length) return [];
  const normalizedRoles = roles
    .map(role => normalizeRoleValue(role))
    .filter((role): role is Role => role !== null);
  return Array.from(new Set(normalizedRoles));
}

export function inferTargetRoles(text: string): Role[] {
  const lower = text.toLowerCase();

  return TARGET_ROLE_VALUES
    .filter(role => TARGET_ROLE_KEYWORDS[role].some(keyword => lower.includes(keyword)));
}

// ---------------------------------------------------------------------------
// EXPERIENCE LEVEL KEYWORDS
// ---------------------------------------------------------------------------

const EXCLUSION_KEYWORDS = [
  // Seniority — standalone word guards via space padding
  'senior ', ' senior', 'sr. ', 'sr ',
  // Staff / Principal / Distinguished
  'staff engineer', 'staff software', 'staff data', 'staff ml', 'staff machine',
  'staff product', 'staff analyst', 'staff developer',
  'senior staff', 'senior principal',
  'principal engineer', 'principal software', 'principal data', 'principal ml',
  'principal scientist', 'principal architect', 'principal analyst',
  'distinguished engineer', 'distinguished scientist', 'distinguished member',
  'senior member of technical staff', '\\bsmts\\b',
  'technical fellow', 'google fellow', 'ieee fellow',
  // Management / Leadership
  'engineering manager', 'manager, software', 'manager of engineering', 'manager of software',
  'engineering director', 'director of engineering',
  'director of software', 'director of data', 'director of ml',
  'director of product', 'director of analytics',
  'group manager', 'area manager', 'engagement manager',
  'vp of engineering', 'vp of software', 'vice president',
  'head of engineering', 'head of software', 'head of data',
  'head of product', 'head of ml', 'head of ai',
  // Lead titles
  'lead engineer', 'lead developer', 'lead scientist',
  'lead software', 'lead architect',
  'tech lead', 'technical lead', 'senior technical',
  // Mid-level numbered patterns (II / 2 / III / 3 / IV / 4+)
  'software engineer ii', 'software engineer 2',
  'software engineer iii', 'software engineer 3',
  'swe ii', 'swe 2', 'sde ii', 'sde 2', 'sde iii', 'sde 3',
  'engineer ii', 'engineer 2', 'engineer iii', 'engineer 3',
  'engineer iv', 'engineer 4', 'engineer v', 'engineer 5',
  'developer ii', 'developer 2', 'developer iii', 'developer 3',
  'developer iv', 'developer 4',
  'scientist ii', 'scientist 2', 'scientist iii', 'scientist 3',
  'analyst ii', 'analyst 2', 'analyst iii', 'analyst 3',
  'software development engineer ii', 'software development engineer 2',
  'mts ii', 'mts 2',
  'specialist ii', 'specialist 2', 'specialist iii', 'specialist 3',
  // L-level (Google style)
  ' l4 ', ' l5 ', ' l6 ', ' l7 ', ' l8 ',
  // E-level (Meta style)
  ' e4 ', ' e5 ', ' e6 ', ' e7 ',
  // P / M / G levels
  ' p2 ', ' p3 ', ' p4 ', ' p5 ',
  ' m1 ', ' m2 ',
  ' g7+ ', ' g8+ ',
  // Generic mid-level phrasing
  'mid-level', 'mid level', 'midlevel',
  '3+ years', '4+ years', '5+ years', '6+ years', '7+ years', '8+ years',
  '10+ years', '12+ years', '15+ years',
  // Senior associate (finance / consulting)
  'senior associate',
  // Architects (usually 5+ YOE)
  'enterprise architect', 'solutions architect', 'senior solutions architect',
  // Other senior IC
  'senior product manager', 'senior pm',
  'senior data scientist', 'senior data science',
  'senior data analyst', 'senior data engineer',
  'senior machine learning', 'senior ml',
  'senior software engineer', 'senior software developer',
  'senior backend', 'senior frontend', 'senior full stack',
  'senior devops', 'senior sre', 'senior platform',
  'senior security', 'senior cloud', 'senior mobile',
  'senior ios', 'senior android', 'senior embedded',
  'senior research', 'senior applied',
  'senior analytics', 'senior business analyst',
  'senior consultant', 'managing consultant', 'manager consultant',
  'principal consultant',
  'senior quant', 'managing director', 'vp ',
  ' md ', 'director of',
  'postdoc', 'post-doc', 'postdoctoral',
  'senior technical program',
];

const INTERNSHIP_KEYWORDS = [
  'intern ', ' intern', 'internship', 'interns,',
  'co-op', 'coop', 'co op', 'co-operative',
  'fall co-op', 'spring co-op', 'engineering co-op', 'software engineering co-op',
  'co-op student', 'cooperative education student', 'coop student',
  'summer 2025', 'summer 2026', 'summer 2027',
  'summer intern', 'summer analyst',
  'fall 2025', 'fall 2026', 'winter 2026',
  'winter intern',
  'spring 2026', 'spring 2027',
  'january 2026', 'may 2026', 'june 2026', 'july 2026',
  'august 2026', 'september 2026', 'january 2027',
  '2025 intern', '2026 intern', '2027 intern',
  'software engineering intern', 'software engineer, internship', 'intern - software engineer',
  'vehicle software engineering intern',
  'swe intern', 'sde intern', 'ai/ml intern', 'data science intern',
  'security intern', 'design intern',
  'student developer', 'student engineer', 'student researcher',
  'student analyst', 'student scientist', 'student programmer',
  'student fellow', 'undergraduate fellow',
  'undergrad researcher', 'undergraduate researcher',
  'phd intern', 'doctoral intern', 'graduate intern', 'research intern', 'software intern',
  'engineering intern', 'data intern', 'product intern',
  'ml intern', 'ai intern', 'pm intern',
  'intern program', 'internship program', 'internship rotation',
  'university intern', 'rotational intern',
  'practicum', 'extern', 'externship',
  'apprentice', 'apprenticeship',
  'part-time student', 'part time student',
  'werkstudent', // German internship term common in EU companies
];

const NEW_GRAD_KEYWORDS = [
  // Explicit new grad signals
  'new grad', 'new graduate', 'new-grad', 'new-graduate',
  'new college grad', 'new college graduate', 'new college hire',
  'college grad', 'college graduate', 'college hire',
  'university grad', 'university graduate', 'university new grad', 'university grad hire',
  'campus hire', 'campus recruit', 'campus entry',
  'campus recruiting',
  'early career', 'early-career', 'early professional', 'early-professional',
  'university hire', 'university recruiting',
  'graduate program', 'graduate leadership', 'graduate rotational',
  'rotational program', 'rotation program',
  'phd graduate', 'ms graduate', 'bachelor graduate',
  'grad hire', 'hire program',
  'graduate scheme', // UK term
  '2023 grad', '2024 grad', '2025 grad', '2026 grad', '2027 grad',
  '2023 graduate', '2024 graduate', '2025 graduate', '2026 graduate', '2027 graduate',
  'class of 2023', 'class of 2024', 'class of 2025', 'class of 2026', 'class of 2027',
  'recently graduated', 'fresh graduate', 'fresher',
  'bachelor new grad', 'masters new grad',
  // Level I patterns (company-specific new grad level naming)
  'software engineer i', 'software engineer i ',
  'software engineer 1', 'software engineer 1 ',
  'sde i', 'sde i ', 'sde1', 'sde 1',
  'swe i', 'swe i ', 'swe1', 'swe 1',
  'se i ',
  'software development engineer i', 'software development engineer 1',
  'engineer i ', 'engineer 1 ', 'engineer level i', 'engineer level 1',
  'developer i ', 'developer 1 ',
  'analyst i ', 'analyst 1 ',
  'scientist i ', 'scientist 1 ',
  'pm 1 ', 'apm 1',
  'level 1', 'level i',
  'ic1', 'ic2',
  // Junior signals
  'junior ', 'jr. ', 'jr ',
  // Associate signals (specific enough to avoid false positives)
  'associate software engineer', 'associate swe', 'associate sde',
  'associate data engineer', 'associate data scientist', 'associate data analyst',
  'associate machine learning', 'associate ml engineer',
  'associate developer', 'associate product manager',
  'associate analyst', 'associate scientist', 'associate researcher',
  'associate engineer', 'entry engineer',
  // Company-specific new grad patterns
  'graduate software engineer', 'graduate engineer',
  'new grad software', 'new grad engineer', 'new grad data',
  'new grad ml', 'new grad swe', 'new grad sde',
  'software engineer new grad', 'software ai engineer new grad',
  '2025 new grad', '2026 new grad', '2025 start', '2026 start',
  'summer 2026 new grad', 'winter 2026 new grad',
  // FAANG level patterns
  'l3 software', 'l3 engineer',   // Google L3
  'e3 engineer', 'e3 software',   // Meta E3
  'l3 ', 'e3 ',
  // Named programs that are always new grad
  'edp ', 'yfir',
  'leap program', 'ignite program', 'spark program',
  'launch program', 'ascend program', 'propel program',
  'associate program', 'analyst program', 'engineer program', 'developer program',
  'technology analyst program', 'technology analyst 20',
  'technology analyst 2025', 'technology analyst 2026',
  'it analyst 20', 'software analyst 20',
  'americas technology full-time analyst',
  'technology full-time analyst',
  'quant researcher new', 'quant developer new',
  'new college grad 2025', 'new college grad 2026', 'new college grad 2027',
  'student to professional', 'campus to career',
  'early career engineer', 'early career developer',
  'early career software', 'early career data',
  // Boundary-safe short forms
  '\\bng(?:\\b|,|-)',
  '\\bl1\\b', '\\bl2\\b', '\\bl3\\b',
];

const ENTRY_LEVEL_KEYWORDS = [
  // Explicit entry level labels
  'entry level', 'entry-level', 'entrylevel',
  'entry level software', 'entry level engineer', 'entry level developer',
  'entry level data', 'entry level analyst',
  // Experience range patterns
  '0-1 year', '0-2 year', '0-3 year',
  '0 to 1 year', '0 to 2 year', '0 to 3 year',
  '0-1 years experience', '0-2 years experience', '0-3 years experience',
  '1-2 year', '1-3 year', '1 to 2 year', '1 to 3 year',
  'up to 1 year', 'up to 2 years', 'up to 3 years',
  'less than 1 year', 'less than 2 years', 'less than 3 years',
  'no experience required', 'no prior experience',
  // Recent grad signals
  'recent graduate', 'recent grad', 'recently graduated',
  'bs/ms', 'b.s./m.s.', 'bachelor\'s or master\'s',
  // Finance/consulting analyst programs (entry level)
  'full-time analyst', 'fulltime analyst', 'analyst program', 'engineer program',
  'technology analyst', 'software analyst',
  // Other entry level signals
  'campus entry-level', 'campus entry level',
  'emerging talent', 'emerging engineer', 'emerging professional',
  'software engineer early career',
  'early career opportunity', 'early professional', 'early-professional',
  'associate engineer', 'associate developer',
  'fresh graduate', 'fresher',
  // Graduation signals
  '2025 graduates', '2026 graduates', '2027 graduates',
  'graduating in 2025', 'graduating in 2026', 'graduating in 2027',
  'graduating students', 'graduating seniors',
  'bachelor\'s degree required', 'bachelor degree required',
];

// Signals found in job *descriptions* that strongly indicate a new grad role.
// NOTE: intentionally conservative — no bare 'bachelor' here to avoid false positives
// on senior roles that mention degree requirements.
const NEW_GRAD_DESC_KEYWORDS = [
  // Graduation year signals
  'graduating in 2025', 'graduating in 2026', 'graduating in 2027',
  'graduate of 2025', 'graduate of 2026', 'graduate of 2027',
  'class of 2025', 'class of 2026', 'class of 2027',
  'graduating december 2025', 'graduating may 2026',
  'graduating december 2026', 'graduating may 2027',
  'planning on graduating in 2026', 'planning on graduating in 2027',
  'expected graduation', 'anticipated graduation',
  'degree candidate', 'bachelor\'s degree candidate',
  'final year student', 'final-year student',
  // Experience range signals (0–2 years maps to new grad in context)
  '0-1 year', '0-2 year', '0 to 1 year', '0 to 2 year',
  '0-1 years', '0-3 years',
  // Explicit new grad language
  'recent graduate', 'recent grad', 'new graduate', 'new grad',
  'recent graduates encouraged', 'first full-time role',
  'limited prior professional experience',
  // No-experience signals
  'no prior experience required', 'no experience required',
  'no experience necessary', 'no prior work experience',
  // Recruiting program signals
  'campus recruit', 'university recruit', 'college recruit',
  // Start-year signals
  '2025 start', '2026 start', '2027 start',
  // Program / career stage signals
  'early career', 'rotational program', 'graduate program',
  'graduate scheme', 'training program', 'rotational engineer', 'new hire program',
  // Degree completion signals
  'must have completed degree', 'completed degree by',
  'eligible to work full-time after graduation',
  'this should be your final internship',
];

// Signals in descriptions that rescue an otherwise excluded title.
// This intentionally returns entry_level rather than new_grad because the title
// still carries senior wording, but the role is clearly junior-targeted.
const EXCLUDED_TITLE_RESCUE_KEYWORDS = [
  'new grad', 'new graduate', 'recent graduate', 'recent grad',
  'no experience', 'no prior experience',
  'bachelor', 'bs/ms', 'b.s.', 'b.s ',
  'degree candidate', 'student',
  '0-2', '0-3', '0 to 2', '0 to 3',
  '0-2 years', '0-3 years', '0 to 2 years', '0 to 3 years',
  'no experience required',
  'will train', 'training provided',
  'entry level', 'entry-level',
  'early career', 'early-career',
  'class of 2025', 'class of 2026',
  'university graduate', 'college graduate', 'fresh graduate',
];

const STRICT_TITLE_EXCLUSION_PATTERNS = [
  /\bsenior\b/i,
  /\bsr\.?\b/i,
  /\bstaff\b/i,
  /\bprincipal\b/i,
  /\blead\b/i,
  /\bmanager\b/i,
  /\bdirector\b/i,
  /\bhead\b/i,
  /\bchief\b/i,
  /\bvice president\b/i,
  /\bvp\b/i,
  /\btechnical fellow\b/i,
  /\bgoogle fellow\b/i,
  /\bpost-?doc(?:toral)?\b/i,
  /\bexperienced\b/i,
  /\bmid(?:-|\s)?level\b/i,
  /\bexpert\b/i,
  /\barchitect\b/i,
  /\blevel\s*[3-9]\b/i,
  /\biii\b/i,
  /\biv\b/i,
  /\bii\b/i,
];

const EARLY_CAREER_RESCUE_PATTERNS = [
  /\bnew grad/i,
  /\bentry(?:-|\s)?level/i,
  /\brecent grad/i,
  /\brecent graduate/i,
  /\bearly(?:-|\s)?career/i,
  /\bearly(?:-|\s)?professional/i,
  /\bjunior\b/i,
  /\bassociate\b/i,
  /\bapm\b/i,
  /\bintern(?:ship)?\b/i,
  /\bco(?:-|\s)?op\b/i,
  /\bapprentice(?:ship)?\b/i,
  /\brotational\b/i,
  /\brpm\b/i,
  /\bpm\s*1\b/i,
  /\b0\s*(?:-|to)\s*1\b/i,
  /\b0\s*(?:-|to)\s*2\b/i,
  /\b0\s*(?:-|to)\s*3\b/i,
  /\b1\s*(?:-|to)\s*2\b/i,
];

const DISALLOWED_EXPERIENCE_PATTERNS = [
  /\b2\+\s*years?\s+(?:of\s+)?experience\b/i,
  /\b(?:minimum|at least|over|more than)?\s*3\+?\s+years?\s+(?:of\s+)?experience\b/i,
  /\b(?:minimum|at least|over|more than)?\s*4\+?\s+years?\s+(?:of\s+)?experience\b/i,
  /\b(?:minimum|at least|over|more than)?\s*5\+?\s+years?\s+(?:of\s+)?experience\b/i,
  /\b(?:minimum|at least|over|more than)?\s*6\+?\s+years?\s+(?:of\s+)?experience\b/i,
  /\b(?:minimum|at least|over|more than)?\s*7\+?\s+years?\s+(?:of\s+)?experience\b/i,
  /\b(?:minimum|at least|over|more than)?\s*8\+?\s+years?\s+(?:of\s+)?experience\b/i,
  /\b(?:minimum|at least|over|more than)?\s*9\+?\s+years?\s+(?:of\s+)?experience\b/i,
  /\b(?:minimum|at least|over|more than)?\s*10\+?\s+years?\s+(?:of\s+)?experience\b/i,
  /\b(?:minimum|at least|over|more than)?\s*12\+?\s+years?\s+(?:of\s+)?experience\b/i,
  /\b(?:minimum|at least|over|more than)?\s*15\+?\s+years?\s+(?:of\s+)?experience\b/i,
  /\bminimum\s+3\s+years?\b/i,
  /\bminimum\s+4\s+years?\b/i,
  /\bminimum\s+5\s+years?\b/i,
  /\b3\s*(?:-|to)\s*5\s+years?\s+(?:of\s+)?experience\b/i,
  /\b4\s*(?:-|to)\s*6\s+years?\s+(?:of\s+)?experience\b/i,
  /\b5\s*(?:-|to)\s*7\s+years?\s+(?:of\s+)?experience\b/i,
];

// ---------------------------------------------------------------------------
// CORE FUNCTIONS
// ---------------------------------------------------------------------------

function matchesKeyword(text: string, keyword: string): boolean {
  if (keyword.includes('\\b')) {
    return new RegExp(keyword, 'i').test(text);
  }
  return text.includes(keyword);
}

/**
 * Returns true when the title matches any exclusion keyword (senior/leadership roles).
 * Keywords containing `\b` are treated as regex patterns; all others are matched
 * against a space-padded copy of the title for implicit word-boundary safety.
 */
function isExcluded(title: string): boolean {
  const padded = ' ' + title.toLowerCase() + ' ';
  return EXCLUSION_KEYWORDS.some(keyword => matchesKeyword(padded, keyword));
}

/**
 * Returns true when the job title contains a recognizable tech signal.
 * Used as a fallback in inferRoles() when no keyword match is found.
 */
export function hasTechTitleSignal(title: string): boolean {
  return TECH_TITLE_SIGNAL_PATTERNS.some(pattern => pattern.test(title));
}

/**
 * Infer role tags from a job title.
 *
 * Primary: keyword matching against ROLE_KEYWORDS.
 * Fallback (ML-style heuristic): if no keyword matched but the title has a
 * recognizable tech signal (via TECH_TITLE_SIGNAL_PATTERNS), tag as ['swe']
 * so the job is never invisible in the filtered feed.
 */
export function inferRoles(title: string): Role[] {
  const lower = title.toLowerCase();
  const NEGATIVE_SWE_PATTERNS = [
    /\bhardware engineer\b/i,
    /\bmechanical engineer\b/i,
    /\bpcb design engineer\b/i,
    /\belectrical(?:\s+controls)? engineer\b/i,
    /\bcivil engineer\b/i,
    /\bchemical engineer\b/i,
    /\baerospace engineer\b/i,
    /\bpropulsion engineer\b/i,
    /\bfield service engineer\b/i,
    /\bmanufacturing engineer\b/i,
    /\bindustrial engineer\b/i,
    /\bcontrols engineer\b/i,
    /\bhvac engineer\b/i,
    /\bstructural engineer\b/i,
  ] as const;
  const STRONG_SWE_OVERRIDE_PATTERNS = [
    /\bsoftware\b/i,
    /\bfront(?:\s|-)?end\b/i,
    /\bback(?:\s|-)?end\b/i,
    /\bfull.?stack\b/i,
    /\bweb\s+dev(?:eloper|elopment)?\b/i,
    /\bmobile\b/i,
    /\bios\b/i,
    /\bandroid\b/i,
    /\bfirmware\b/i,
    /\bembedded(?:\s+software)?\b/i,
    /\bdevops\b/i,
    /\bcloud\b/i,
    /\bplatform engineer\b/i,
    /\bsite reliability\b/i,
    /\bsre\b/i,
    /\bml engineer\b/i,
    /\bai engineer\b/i,
    /\bdata engineer\b/i,
    /\bcomputer vision\b/i,
    /\bnlp\b/i,
    /\bmachine learning\b/i,
  ] as const;
  const shouldExcludeSwe =
    NEGATIVE_SWE_PATTERNS.some(pattern => pattern.test(title))
    && !STRONG_SWE_OVERRIDE_PATTERNS.some(pattern => pattern.test(title));

  const matched = (Object.entries(ROLE_KEYWORDS) as [Role, string[]][])
    .filter(([, keywords]) => keywords.some(k => lower.includes(k)))
    .map(([role]) => role);
  const filteredMatched = shouldExcludeSwe
    ? matched.filter(role => role !== 'swe')
    : matched;

  // Fallback: title has a tech signal but no keyword matched — default to swe
  // so the job still appears in filtered views rather than disappearing.
  if (filteredMatched.length === 0 && hasTechTitleSignal(title) && !shouldExcludeSwe) {
    return ['swe'];
  }

  return filteredMatched;
}

export function inferRemote(location?: string): boolean {
  if (!location) return false;
  return ['remote', 'anywhere', 'distributed', 'work from home', 'wfh']
    .some(k => location.toLowerCase().includes(k));
}

function normalizePostedAtValue(value?: string | Date | null): string | undefined {
  if (!value) return undefined;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    return value.toISOString();
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;

  return parsed.toISOString();
}

function passesEarlyCareerFilter(title: string, content?: string): boolean {
  const text = content ?? '';
  const hasEarlyCareerRescue =
    EARLY_CAREER_RESCUE_PATTERNS.some(pattern => pattern.test(title)) ||
    EARLY_CAREER_RESCUE_PATTERNS.some(pattern => pattern.test(text));

  if (!hasEarlyCareerRescue && STRICT_TITLE_EXCLUSION_PATTERNS.some(pattern => pattern.test(title))) {
    return false;
  }

  if (!hasEarlyCareerRescue && DISALLOWED_EXPERIENCE_PATTERNS.some(pattern => pattern.test(text))) {
    return false;
  }

  return true;
}

/**
 * Shared normalizer for source scrapers that already know the canonical job
 * fields but want consistent trimming, location filtering, role inference,
 * experience inference, remote detection, and dedup hashing.
 */
export function normalizeJob(input: NormalizeJobInput): NormalizedJob | null {
  const title = input.title?.trim();
  const company = input.company?.trim();
  const url = input.url?.trim();
  const location = input.location?.trim() || undefined;
  const description = input.description?.trim() || undefined;
  const remote = input.remote === true || inferRemote(location);

  if (!title || !company || !url) return null;
  if (location && isNonUsLocation(location) && !isUsaLocation({ location, remote })) return null;
  if (!passesEarlyCareerFilter(title, input.experienceText ?? description)) return null;

  const experienceLevel = inferExperienceLevel(title, input.experienceText ?? description);
  if (experienceLevel === null) return null;

  const roles = input.roles?.length
    ? normalizeRoles(input.roles)
    : inferRoles(input.roleText ?? title);

  return finalizeNormalizedJob({
    source: input.source,
    source_id: input.sourceId?.trim() || undefined,
    title,
    company,
    location,
    remote,
    url,
    description,
    experience_level: experienceLevel,
    roles,
    posted_at: normalizePostedAtValue(input.postedAt),
    dedup_hash: generateHash(company, title, location ?? ''),
  });
}

/**
 * Infer the experience level from a job title (and optional description).
 * Returns null when the role is clearly senior — callers should skip those jobs.
 *
 * Check order: exclusion → excluded-title rescue → internship → new_grad
 *              (title) → new_grad (desc) → entry_level (title or desc) →
 *              default entry_level.
 *
 * Default behaviour: when no explicit seniority signal is found, returns
 * 'entry_level' so that Greenhouse/Lever/Ashby postings without explicit level
 * markers are still included in the feed.
 */
export function inferExperienceLevel(
  title: string,
  content?: string,
): ExperienceLevel | null {
  const t = title.toLowerCase();
  const paddedTitle = ' ' + t + ' ';
  const c = (content ?? '').toLowerCase();

  // 1. Exclusion check — drop senior / management / mid-level roles.
  if (isExcluded(t)) {
    if (c && EXCLUDED_TITLE_RESCUE_KEYWORDS.some(keyword => c.includes(keyword))) {
      return 'entry_level';
    }
    return null;
  }

  // 2. Internship signals in title.
  if (INTERNSHIP_KEYWORDS.some(k => t.includes(k))) return 'internship';

  // 3. New grad signals in title.
  if (NEW_GRAD_KEYWORDS.some(keyword => matchesKeyword(paddedTitle, keyword))) {
    return 'new_grad';
  }

  // 3b. New grad signals in description (conservative list — no bare 'bachelor').
  if (c && NEW_GRAD_DESC_KEYWORDS.some(k => c.includes(k))) return 'new_grad';

  // 4. Entry-level signals in title or description.
  if (ENTRY_LEVEL_KEYWORDS.some(k => t.includes(k) || c.includes(k))) {
    return 'entry_level';
  }

  // 5. Default: keep as entry_level.
  // Curated boards (Greenhouse, Lever, Ashby) typically omit explicit level
  // markers on legitimate junior postings — defaulting to entry_level is correct.
  return 'entry_level';
}

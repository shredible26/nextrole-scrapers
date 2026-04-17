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

export type NormalizedJob = {
  source: string;
  source_id?: string;
  title: string;
  company: string;
  location?: string;
  remote: boolean;
  url: string;
  description?: string;
  salary_min?: number;
  salary_max?: number;
  experience_level: ExperienceLevel;
  roles: Role[];
  posted_at?: string;
  dedup_hash: string;
};

// ---------------------------------------------------------------------------
// ROLE KEYWORDS
// ---------------------------------------------------------------------------

const ROLE_KEYWORDS: Record<Role, string[]> = {
  swe: [
    // Core titles
    'software engineer', 'software developer', 'software programmer',
    'swe', 'sde', 'sde i', 'swe i',
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
    'systems software', 'operating systems',
    'software/platform', 'platform software',
    'application developer', 'application engineer', 'applications engineer',
    'application software', 'software application',
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
    'rtos engineer', 'bare metal',
    // Specialized engineering
    'simulation engineer', 'robotics engineer', 'robotics software',
    'graphics engineer', 'rendering engineer', 'shader engineer',
    'game engineer', 'game developer', 'gameplay engineer', 'engine developer',
    'compiler engineer', 'programming language',
    'distributed systems', 'storage engineer', 'database engineer',
    'growth engineer', 'platform engineer', 'infrastructure engineer',
    'reliability engineer', 'site reliability', 'sre',
    'tools engineer', 'developer tools', 'developer experience', 'dx engineer',
    'tooling engineer', 'forward deployed engineer', 'field engineer',
    'build engineer', 'release engineer',
    // QA / Testing
    'qa engineer', 'quality engineer', 'quality assurance',
    'test engineer', 'sdet', 'software test', 'software quality',
    'automation engineer', 'test automation',
    // Solutions / Implementation
    'solutions engineer', 'solutions developer',
    'implementation engineer', 'implementation developer',
    'integration engineer', 'integration developer',
    'technical support engineer', 'support engineer',
    // Catch-all architect (non-senior)
    'software architect',
    // TPM (technical, not consulting)
    'technical program manager', 'tpm',
  ],
  ds: [
    // Core data science
    'data scientist', 'data science',
    'staff data scientist',
    // Research science
    'research scientist', 'applied scientist', 'applied research scientist',
    'research engineer', 'applied researcher',
    'computational scientist', 'computational researcher',
    // Data engineering
    'data engineer', 'data engineering',
    'analytics engineer', 'analytics engineering',
    'data platform engineer', 'data infrastructure',
    'etl developer', 'etl engineer', 'pipeline engineer',
    'data pipeline', 'data warehouse', 'data lake',
    // Statistics
    'statistician', 'statistical analyst', 'statistical researcher',
    'biostatistician', 'econometrician',
    // Quant research (overlap with finance but data-heavy)
    'quantitative researcher', 'quant researcher',
    'quantitative scientist', 'computational researcher',
    'decision scientist',
    // Other data
    'data modeler', 'data architect', 'data solutions',
    'reporting engineer', 'bi engineer', 'bi developer',
    'business intelligence', 'reporting analyst',
    'insights analyst', 'strategy analyst',
    'business intelligence engineer', 'business intelligence developer',
  ],
  ml: [
    // Core ML
    'machine learning', 'ml engineer', 'ml developer',
    'mlops', 'ml ops', 'ml platform', 'ml infrastructure',
    'machine learning platform', 'ai engineer', 'ai/ml',
    'ml systems', 'ml research', 'ml scientist',
    // Model / training
    'model engineer', 'model developer', 'training engineer',
    'inference engineer', 'model deployment',
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
    // Autonomous / Robotics ML
    'perception engineer', 'perception scientist',
    'autonomous', 'autonomy engineer', 'autonomy scientist',
    'self-driving', 'slam engineer',
    // Other ML specializations
    'deep learning',
    'anomaly detection', 'forecasting engineer',
    'feature engineer', 'feature platform',
  ],
  ai: [
    // Core AI
    'ai engineer', 'ai developer', 'ai scientist',
    'artificial intelligence',
    'ai researcher', 'ai research',
    'ai infrastructure', 'ai platform',
    'ai systems', 'ai solutions',
    // Deep learning
    'deep learning', 'neural network',
    // LLM / GenAI
    'llm', 'large language model',
    'generative ai', 'gen ai', 'genai',
    'foundation model', 'transformer',
    'diffusion model', 'multimodal',
    // Agents / Prompting
    'ai agent', 'agentic', 'agent engineer',
    'prompt engineer', 'prompt engineering',
    // Reinforcement learning
    'reinforcement learning', 'rl engineer', 'rl researcher',
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
    'insights analyst', 'reporting analyst',
    // Product analytics
    'product analyst', 'growth analyst', 'marketing analyst',
    'consumer insights', 'market research analyst',
    // Operations
    'operations analyst', 'ops analyst',
    'operational analyst', 'process analyst',
    'supply chain analyst', 'logistics analyst',
    'pricing analyst', 'revenue analyst',
    // Systems / IT
    'systems analyst', 'it analyst',
    'functional analyst',
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
    // Policy / program
    'policy analyst', 'program analyst',
    'intelligence analyst', 'research associate',
    'trust and safety',
    // Catch-all with word boundary guard
    ' analyst',
  ],
  pm: [
    // Core PM
    'product manager', 'product management',
    'associate product manager', 'associate pm', 'apm',
    'product analyst', 'product operations', 'product specialist',
    // Technical PM
    'technical product manager', 'technical pm',
    'technical program manager', 'tpm',
    'platform product manager',
    // Program management (non-TPM)
    'program manager',
    // Product owner
    'product owner',
    'product lead',
    // Intern variants
    'product intern', 'pm intern', 'apm intern',
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
    'web application security',
    // Cloud security
    'cloud security', 'cloud security engineer',
    // DevSecOps
    'devsecops', 'dev sec ops',
    // SOC / Operations
    'soc analyst', 'soc engineer',
    'security operations center', 'threat analyst',
    'incident response', 'incident responder',
    'security incident',
    // Penetration testing
    'penetration tester', 'penetration testing', 'pen tester', 'pen test',
    'ethical hacker', 'red team', 'blue team', 'purple team',
    // Vulnerability / Risk
    'vulnerability', 'vulnerability analyst', 'vulnerability engineer',
    'vulnerability researcher',
    'risk analyst', 'risk engineer', 'risk management engineer',
    'security risk',
    // Identity / Access
    'identity engineer', 'iam engineer', 'identity and access',
    'access management',
    // Cryptography / Privacy
    'cryptography', 'cryptographic engineer',
    'privacy engineer', 'trust and safety engineer',
    // Compliance / GRC
    'compliance engineer', 'compliance analyst',
    'grc analyst', 'governance risk',
    // Digital forensics
    'digital forensics', 'forensic analyst', 'forensics engineer',
    'malware analyst', 'threat intelligence',
    // Catch-all
    'cyber analyst', 'cyber engineer',
  ],
  devops: [
    // Core DevOps
    'devops', 'dev ops', 'devops engineer', 'devops developer',
    'devops associate', 'junior devops',
    // SRE
    'site reliability', 'sre', 'reliability engineer',
    'site reliability engineer',
    // Platform / Infra
    'platform engineer', 'platform developer',
    'infrastructure engineer', 'infrastructure developer',
    'infrastructure as code', 'iac engineer',
    // Cloud operations
    'cloud engineer', 'cloud developer', 'cloud operations',
    'cloud infrastructure', 'cloud devops',
    'aws engineer', 'azure engineer', 'gcp engineer',
    'cloud support engineer', 'cloud support associate',
    'cloud systems administrator', 'cloud administrator',
    // Systems administration
    'systems administrator', 'sysadmin', 'sys admin',
    'systems reliability',
    // Network / IT ops
    'network engineer', 'network administrator', 'network developer',
    'network operations', 'it operations', 'it infrastructure',
    // Database administration
    'database administrator', 'dba', 'database engineer',
    // Automation / CI/CD
    'automation engineer', 'build and release', 'release manager',
    'ci/cd engineer', 'cicd engineer', 'pipeline engineer',
    // Containers / Kubernetes
    'kubernetes engineer', 'k8s engineer',
    'container engineer', 'docker engineer',
    // Monitoring / observability
    'observability engineer', 'monitoring engineer',
    // DevSecOps (also in security — intentional overlap)
    'devsecops',
    // Cloud-native / GitOps
    'cloud native', 'gitops', 'platform operations',
    // Storage / compute
    'storage engineer', 'compute engineer',
    // MLOps (overlap with ml — intentional)
    'mlops', 'dataops',
  ],
  consulting: [
    // Generic consulting
    'consultant', 'consulting',
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
    'technology analyst',
    'consulting associate',
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
    'quantitative associate',
    // Trading
    'algorithmic trading', 'algo trading', 'algo trader',
    'electronic trading', 'systematic trading',
    'trading analyst', 'trading associate', 'trading developer',
    'execution trader', 'derivatives analyst',
    // Financial engineering / strats
    'financial engineer', 'financial engineering',
    'strats', 'digital strats', 'multi asset',
    'structured products', 'fixed income analyst',
    'rates analyst', 'credit analyst', 'fx analyst',
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
    // Treasury / Corporate Finance
    'treasury analyst', 'corporate finance analyst',
    'fp&a', 'fpa analyst', 'financial planning',
    // Actuarial
    'actuarial analyst', 'actuary', 'actuarial associate',
    'actuarial science',
    // Accounting (from jobright_accounting)
    'staff accountant', 'accounting analyst',
    'audit associate', 'audit analyst', 'external audit',
    'internal audit', 'tax analyst', 'tax associate',
    'controller', 'accounting associate',
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

// ---------------------------------------------------------------------------
// EXPERIENCE LEVEL KEYWORDS
// ---------------------------------------------------------------------------

const EXCLUSION_KEYWORDS = [
  // Seniority — standalone word guards via space padding
  'senior ', ' senior', 'sr. ', 'sr ',
  // Staff / Principal / Distinguished
  'staff engineer', 'staff software', 'staff data', 'staff ml', 'staff machine',
  'staff product', 'staff analyst', 'staff developer',
  'principal engineer', 'principal software', 'principal data', 'principal ml',
  'principal scientist', 'principal architect', 'principal analyst',
  'distinguished engineer', 'distinguished scientist',
  ' fellow,', 'google fellow', 'ieee fellow',
  // Management / Leadership
  'engineering manager', 'engineering director', 'director of engineering',
  'director of software', 'director of data', 'director of ml',
  'director of product', 'director of analytics',
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
  // L-level (Google style)
  ' l4 ', ' l5 ', ' l6 ', ' l7 ', ' l8 ',
  // E-level (Meta style)
  ' e4 ', ' e5 ', ' e6 ', ' e7 ',
  // Generic mid-level phrasing
  'mid-level', 'mid level', 'midlevel',
  '3+ years', '4+ years', '5+ years', '6+ years', '7+ years', '8+ years', '10+ years',
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
  'principal consultant', 'engagement manager',
  'senior quant', 'managing director', 'vice president', 'vp ',
  ' md ', 'director of',
  'senior technical program',
];

const INTERNSHIP_KEYWORDS = [
  'intern ', ' intern', 'internship', 'interns,',
  'co-op', 'coop', 'co op', 'co-operative',
  'summer 2025', 'summer 2026', 'summer 2027',
  'fall 2025', 'fall 2026', 'winter 2026',
  'spring 2026', 'spring 2027',
  'student developer', 'student engineer', 'student researcher',
  'student analyst', 'student scientist',
  'undergrad researcher', 'undergraduate researcher',
  'phd intern', 'research intern', 'software intern',
  'engineering intern', 'data intern', 'product intern',
  'ml intern', 'ai intern', 'pm intern',
  'part-time student', 'part time student',
  'werkstudent', // German internship term common in EU companies
];

const NEW_GRAD_KEYWORDS = [
  // Explicit new grad signals
  'new grad', 'new graduate', 'new-grad', 'new-graduate',
  'new college grad', 'new college graduate',
  'college grad', 'college graduate',
  'university grad', 'university graduate',
  'campus hire', 'campus recruit', 'campus entry',
  'campus recruiting',
  'early career', 'early-career',
  'university hire', 'university recruiting',
  'graduate program', 'graduate leadership', 'graduate rotational',
  'rotational program', 'rotation program',
  'phd graduate', 'ms graduate', 'bachelor graduate',
  'grad hire', 'hire program',
  'graduate scheme', // UK term
  '2025 grad', '2026 grad', '2025 graduate', '2026 graduate',
  '2027 grad', '2027 graduate',
  'class of 2025', 'class of 2026', 'class of 2027',
  // Level I patterns (company-specific new grad level naming)
  'software engineer i', 'software engineer i ',
  'software engineer 1', 'software engineer 1 ',
  'sde i', 'sde i ', 'sde1', 'sde 1',
  'swe i', 'swe i ', 'swe1', 'swe 1',
  'software development engineer i', 'software development engineer 1',
  'engineer i ', 'engineer 1 ',
  'developer i ', 'developer 1 ',
  'analyst i ', 'analyst 1 ',
  'scientist i ', 'scientist 1 ',
  'level 1', 'level i',
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
  'new grad software', 'new grad engineer', 'new grad data',
  'new grad ml', 'new grad swe', 'new grad sde',
  'software engineer new grad', 'software ai engineer new grad',
  '2025 new grad', '2026 new grad', '2025 start', '2026 start',
  // FAANG level patterns
  'l3 software', 'l3 engineer',   // Google L3
  'e3 engineer', 'e3 software',   // Meta E3
  // Named programs that are always new grad
  'edp ', 'yfir',
  'leap program', 'ignite program', 'spark program',
  'launch program', 'ascend program', 'propel program',
  'technology analyst program', 'technology analyst 20',
  'it analyst 20', 'software analyst 20',
  'americas technology full-time analyst',
  'technology full-time analyst',
  'quant researcher new', 'quant developer new',
  'new college grad 2025', 'new college grad 2026', 'new college grad 2027',
  'early career engineer', 'early career developer',
  'early career software', 'early career data',
  // Boundary-safe short forms
  '\\bng(?:\\b|,|-)',
  '\\bl1\\b', '\\bl2\\b', '\\bl3\\b',
  '\\bmts\\b',
];

const ENTRY_LEVEL_KEYWORDS = [
  // Explicit entry level labels
  'entry level', 'entry-level', 'entrylevel',
  'entry level software', 'entry level engineer', 'entry level developer',
  'entry level data', 'entry level analyst',
  // Experience range patterns
  '0-1 year', '0-2 year', '0-3 year',
  '0 to 1 year', '0 to 2 year', '0 to 3 year',
  '1-2 year', '1-3 year', '1 to 2 year', '1 to 3 year',
  'up to 2 years', 'up to 3 years',
  'less than 2 years', 'less than 3 years',
  'no experience required', 'no prior experience',
  // Recent grad signals
  'recent graduate', 'recent grad', 'recently graduated',
  'bs/ms', 'b.s./m.s.', 'bachelor\'s or master\'s',
  // Finance/consulting analyst programs (entry level)
  'full-time analyst', 'fulltime analyst', 'analyst program',
  'technology analyst', 'software analyst',
  // Other entry level signals
  'campus entry-level', 'campus entry level',
  'emerging talent', 'emerging engineer',
  'software engineer early career',
  'early career opportunity',
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
  // Experience range signals (0–2 years maps to new grad in context)
  '0-1 year', '0-2 year', '0 to 1 year', '0 to 2 year',
  // Explicit new grad language
  'recent graduate', 'recent grad', 'new graduate', 'new grad',
  // No-experience signals
  'no prior experience required', 'no experience required',
  // Recruiting program signals
  'campus recruit', 'university recruit', 'college recruit',
  // Start-year signals
  '2025 start', '2026 start', '2027 start',
  // Program / career stage signals
  'early career', 'rotational program', 'graduate program',
  'graduate scheme',
];

// Signals in descriptions that rescue an otherwise excluded title.
// This intentionally returns entry_level rather than new_grad because the title
// still carries senior wording, but the role is clearly junior-targeted.
const EXCLUDED_TITLE_RESCUE_KEYWORDS = [
  'new grad', 'new graduate', 'recent graduate', 'recent grad',
  'bachelor', 'bs/ms', 'b.s.', 'b.s ',
  '0-2 years', '0-3 years', '0 to 2 years', '0 to 3 years',
  'no experience required',
  'entry level', 'entry-level',
  'early career', 'early-career',
  'class of 2025', 'class of 2026',
  'university graduate', 'college graduate', 'fresh graduate',
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

  const matched = (Object.entries(ROLE_KEYWORDS) as [Role, string[]][])
    .filter(([, keywords]) => keywords.some(k => lower.includes(k)))
    .map(([role]) => role);

  // Fallback: title has a tech signal but no keyword matched — default to swe
  // so the job still appears in filtered views rather than disappearing.
  if (matched.length === 0 && hasTechTitleSignal(title)) {
    return ['swe'];
  }

  return matched;
}

export function inferRemote(location?: string): boolean {
  if (!location) return false;
  return ['remote', 'anywhere', 'distributed', 'work from home', 'wfh']
    .some(k => location.toLowerCase().includes(k));
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

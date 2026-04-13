export type ExperienceLevel = 'new_grad' | 'entry_level' | 'internship';
export const ROLE_VALUES = ['swe', 'ds', 'ml', 'ai', 'analyst', 'pm'] as const;
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
    'software engineer', 'software developer', 'swe', 'sde',
    'full stack', 'fullstack', 'full-stack',
    'backend', 'back end', 'back-end',
    'frontend', 'front end', 'front-end',
    'web developer', 'web engineer',
    'systems engineer', 'systems developer',
    'platform engineer', 'infrastructure engineer',
    'site reliability', 'sre', 'devops', 'dev ops',
    'cloud engineer', 'cloud developer',
    'solutions engineer', 'implementation engineer',
    'integration engineer', 'applications engineer',
    'application developer', 'application engineer',
    'mobile engineer', 'mobile developer',
    'ios engineer', 'ios developer',
    'android engineer', 'android developer',
    'embedded engineer', 'embedded software', 'embedded systems',
    'firmware engineer', 'firmware developer',
    'hardware engineer', 'hardware developer',
    'simulation engineer', 'robotics engineer', 'robotics developer',
    'computer vision engineer',
    'graphics engineer', 'game engineer', 'game developer',
    'security engineer', 'cybersecurity engineer', 'cyber engineer',
    'network engineer', 'network developer', 'wireless engineer',
    'software quality', 'qa engineer', 'quality engineer',
    'test engineer', 'sdet', 'automation engineer',
    'release engineer', 'build engineer',
    'tools engineer', 'developer tools',
    'technical program manager', 'tpm',
    'software architect',
    'software intern', 'engineering intern',
  ],
  ds: [
    'data scientist', 'data science',
    'research scientist', 'applied scientist',
    'quantitative researcher', 'quant researcher',
    'data engineer', 'data platform engineer',
    'analytics engineer', 'data infrastructure',
    'statistician', 'statistical analyst',
    'data intern', 'data science intern',
  ],
  ml: [
    'machine learning', 'ml engineer', 'mlops', 'ml ops',
    'ml platform', 'ml infrastructure',
    'model engineer', 'training engineer',
    'recommendation engineer', 'ranking engineer',
    'search engineer', 'search scientist',
    'computer vision', 'nlp engineer',
    'natural language processing',
    'speech engineer', 'speech scientist',
    'perception engineer', 'autonomous', 'autonomy engineer',
  ],
  ai: [
    'ai engineer', 'artificial intelligence',
    'deep learning', 'llm', 'generative ai',
    'gen ai', 'foundation model',
    'ai researcher', 'ai scientist',
    'reinforcement learning', 'rl engineer',
    'ai/ml', 'ml/ai',
    'large language model',
  ],
  analyst: [
    'data analyst', 'business analyst',
    'business intelligence', 'bi analyst', 'bi developer',
    'analytics analyst', 'product analyst',
    'financial analyst', 'strategy analyst',
    'operations analyst', 'systems analyst',
    'quantitative analyst', 'quant analyst',
    'market analyst', 'marketing analyst',
    'risk analyst', 'compliance analyst',
    'pricing analyst', 'supply chain analyst',
    'it analyst', 'technology analyst',
    'program analyst', 'policy analyst',
    'research analyst', 'intelligence analyst',
    'insights analyst', 'reporting analyst',
    // catch-all — space-padded to prevent false matches like "psychoanalyst"
    ' analyst',
  ],
  pm: [
    'product manager', 'product management',
    ' pm ', 'associate pm', 'apm ',
    'technical product manager', 'technical pm',
    'program manager',
    'product owner',
    'product intern', 'pm intern',
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
  'distinguished engineer', 'distinguished scientist', 'fellow',
  // Management / Leadership
  'engineering manager', 'engineering director', 'director of engineering',
  'director of software', 'director of data', 'director of ml',
  'director of product', 'director of analytics',
  'vp of engineering', 'vp of software', 'vice president',
  'head of engineering', 'head of software', 'head of data',
  'head of product', 'head of ml', 'head of ai',
  // Lead titles
  'lead engineer', 'lead developer', 'lead scientist',
  'lead analyst', 'lead software', 'lead data', 'lead ml',
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
  'early career', 'early-career',
  'university hire', 'university recruiting',
  'graduate program', 'graduate leadership', 'graduate rotational',
  'rotational program', 'rotation program',
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
  // Junior signals
  'junior ', 'jr. ', 'jr ',
  // Associate signals (specific enough to avoid false positives)
  'associate software engineer', 'associate swe', 'associate sde',
  'associate data engineer', 'associate data scientist', 'associate data analyst',
  'associate machine learning', 'associate ml engineer',
  'associate developer', 'associate product manager',
  'associate analyst', 'associate scientist', 'associate researcher',
  'associate engineer',
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

// ---------------------------------------------------------------------------
// CORE FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Returns true when the title matches any exclusion keyword (senior/leadership roles).
 * Keywords containing `\b` are treated as regex patterns; all others are matched
 * against a space-padded copy of the title for implicit word-boundary safety.
 */
function isExcluded(title: string): boolean {
  const padded = ' ' + title.toLowerCase() + ' ';
  return EXCLUSION_KEYWORDS.some(k => {
    if (k.includes('\\b')) {
      return new RegExp(k, 'i').test(padded);
    }
    return padded.includes(k);
  });
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
 * Check order: exclusion → internship → new_grad (title) → new_grad (desc) →
 *              entry_level (title or desc) → default entry_level.
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
  const c = (content ?? '').toLowerCase();

  // 1. Exclusion check — drop senior / management / mid-level roles.
  if (isExcluded(t)) return null;

  // 2. Internship signals in title.
  if (INTERNSHIP_KEYWORDS.some(k => t.includes(k))) return 'internship';

  // 3. New grad signals in title.
  if (NEW_GRAD_KEYWORDS.some(k => t.includes(k))) return 'new_grad';

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
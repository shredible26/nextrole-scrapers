export type ExperienceLevel = 'new_grad' | 'entry_level' | 'internship';
export type Role = 'SWE' | 'DS' | 'ML' | 'AI' | 'Analyst' | 'PM';

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

const ROLE_KEYWORDS: Record<Role, string[]> = {
  SWE:     ['software engineer', 'software developer', 'swe', 'full stack',
             'fullstack', 'backend', 'frontend', 'web developer'],
  DS:      ['data scientist', 'data science'],
  ML:      ['machine learning', 'ml engineer', 'mlops'],
  AI:      ['ai engineer', 'artificial intelligence', 'deep learning', 'llm'],
  Analyst: ['data analyst', 'business analyst', 'analyst', 'business intelligence'],
  PM:      ['product manager', 'product management', ' pm '],
};

const TECH_TITLE_SIGNAL_PATTERNS = [
  /\bengineer\b/i,
  /\bdeveloper\b/i,
  /\bscientist\b/i,
  /\banalyst\b/i,
  /\barchitect\b/i,
  /\bdevops\b/i,
  /\bsre\b/i,
  /\bplatform\b/i,
  /\bbackend\b/i,
  /\bfrontend\b/i,
  /\bfullstack\b/i,
  /\bfull stack\b/i,
  /\bmachine learning\b/i,
  /\bdata\b/i,
  /\bsoftware\b/i,
  /\bcloud\b/i,
  /\bsecurity\b/i,
  /\binfrastructure\b/i,
  /\bml\b/i,
  /\bai\b/i,
  /\bproduct manager\b/i,
  /\bprogram manager\b/i,
  /\btechnical\b/i,
  /\bit\b/i,
  /\bsystems\b/i,
] as const;

export function inferRoles(title: string): Role[] {
  const lower = title.toLowerCase();
  return (Object.entries(ROLE_KEYWORDS) as [Role, string[]][])
    .filter(([, keywords]) => keywords.some(k => lower.includes(k)))
    .map(([role]) => role);
}

export function inferRemote(location?: string): boolean {
  if (!location) return false;
  return ['remote', 'anywhere', 'distributed', 'work from home', 'wfh']
    .some(k => location.toLowerCase().includes(k));
}

export function hasTechTitleSignal(title: string): boolean {
  return TECH_TITLE_SIGNAL_PATTERNS.some(pattern => pattern.test(title));
}

const EXCLUSION_KEYWORDS = [
  // Seniority levels - must be standalone words or at start
  'senior ', ' senior', 'sr. ', 'sr ', '\\bsr\\b',
  'staff engineer', 'staff software', 'staff data', 'staff ml', 'staff machine',
  'principal engineer', 'principal software', 'principal data', 'principal ml',
  'principal scientist', 'principal architect',
  'distinguished engineer', 'distinguished scientist', 'fellow',
  // Management
  'engineering manager', 'engineering director', 'director of engineering',
  'director of software', 'director of data', 'director of ml',
  'vp of engineering', 'vp of software', 'vice president',
  'head of engineering', 'head of software', 'head of data', 'head of product',
  // Mid-level signals that indicate NOT entry level
  'software engineer ii', 'software engineer 2', 'swe ii', 'swe 2',
  'sde ii', 'sde 2', 'sde iii', 'sde 3',
  'software engineer iii', 'software engineer 3',
  'engineer ii', 'engineer 2', 'engineer iii', 'engineer 3',
  // Senior individual contributors
  'tech lead', 'technical lead', 'senior technical',
  // Other senior patterns
  'senior solutions architect', 'enterprise architect',
  'senior product manager', 'senior pm', 'senior product manager', 'senior pm',
  'senior data scientist', 'senior data science', 'senior data analyst', 'senior data analyst',
  'senior machine learning engineer', 'senior machine learning', 'senior machine learning engineer', 'senior machine learning',
  'senior software engineer', 'senior software developer', 'senior software developer', 'senior software developer',
  'senior backend engineer', 'senior backend developer', 'senior backend developer', 'senior backend developer',
  'senior frontend engineer', 'senior frontend developer', 'senior frontend developer', 'senior frontend developer',
  'senior full stack engineer', 'senior full stack developer', 'senior full stack developer', 'senior full stack developer',
  'senior devops engineer', 'senior devops developer', 'senior devops developer', 'senior devops developer',
];

const INTERNSHIP_KEYWORDS = [
  'intern ', ' intern', 'internship', 'co-op', 'coop', 'co op',
  'summer 2025', 'summer 2026', 'summer 2027',
  'fall 2025', 'fall 2026', 'spring 2026', 'spring 2027',
  'student developer', 'student engineer', 'student researcher',
  'undergrad researcher', 'undergraduate researcher',
  'phd intern', 'research intern', 'software intern',
];

const NEW_GRAD_KEYWORDS = [
  // Explicit new grad signals
  'new grad', 'new graduate', 'new-grad', 'new-graduate',
  'new college grad', 'new college graduate', 'college grad', 'college graduate',
  'university grad', 'university graduate',
  'campus hire', 'campus recruit', 'campus entry',
  'early career', 'early-career',
  'university hire', 'university recruiting',
  'graduate program', 'graduate leadership', 'graduate rotational',
  'rotational program', 'rotation program',
  '2025 grad', '2026 grad', '2025 graduate', '2026 graduate',
  'class of 2025', 'class of 2026',
  // Numbered levels that map to new grad at specific companies
  'software engineer i', 'software engineer i ', // Amazon SDE I, etc
  'software engineer 1', // General pattern
  'sde i', 'sde i ', 'sde1',
  'swe i', 'swe i ', 'swe1',
  'software development engineer i', 'software development engineer 1',
  'engineer i ', 'engineer 1 ', // trailing space to avoid "engineer iii"
  'developer i ', 'developer 1 ',
  'analyst i ', 'analyst 1 ',
  'scientist i ', 'scientist 1 ',
  // Junior signals
  'junior ', 'jr. ', 'jr ',
  // Associate signals (careful — "associate" alone is too broad)
  'associate software engineer', 'associate swe', 'associate sde',
  'associate data engineer', 'associate data scientist', 'associate data analyst',
  'associate machine learning', 'associate ml engineer',
  'associate developer', 'associate product manager',
  'associate analyst', 'associate scientist', 'associate researcher',
  'associate engineer', // general
  // Company-specific new grad patterns found in real postings
  'software ai engineer new grad',
  'software engineer new grad',
  'new grad software',
  'new grad engineer',
  'new grad data',
  'new grad ml',
  'new grad swe',
  'new grad sde',
  '2025 start', '2026 start',
  '2025 new grad', '2026 new grad',
  // FAANG-adjacent title patterns that signal new grad
  'l3 software', // Google L3
  'e3 engineer', // Meta E3
  // Program names that are always new grad
  'yfir', // year one rotational
  'edp ', // engineering development program (GE, etc)
  'leap program', 'ignite program', 'spark program', 'launch program',
  'ascend program', 'propel program',
  'technology analyst program', 'technology analyst 20',
  'it analyst 20', 'software analyst 20',
  'americas technology full-time analyst',
  'technology full-time analyst',
  'quant researcher new', 'quant developer new',
  // Misc common patterns
  'software engineer, hardware tools', // nvidia new grad pattern
  'new college grad 2025', 'new college grad 2026',
  'early career engineer', 'early career developer',
  'early career software', 'early career data',
];

const ENTRY_LEVEL_KEYWORDS = [
  // Explicit entry level labels
  'entry level', 'entry-level', 'entrylevel',
  'entry level software', 'entry level engineer', 'entry level developer',
  'entry level data', 'entry level analyst',
  // Experience ranges that indicate entry level
  '0-1 year', '0-2 year', '0-3 year',
  '0 to 1 year', '0 to 2 year', '0 to 3 year',
  '1-2 year', '1-3 year', '1 to 2 year', '1 to 3 year',
  'up to 2 years', 'up to 3 years',
  'less than 2 years', 'less than 3 years',
  'no experience required', 'no prior experience',
  // Recent grad signals (slightly different from new grad — implies recently graduated)
  'recent graduate', 'recent grad', 'recently graduated',
  'bachelor\'s required', 'bs required', 'bs/ms',
  'bachelor\'s or master\'s',
  // Analyst programs at finance/consulting that are entry level
  'full-time analyst', 'fulltime analyst', 'analyst program',
  'technology analyst', 'software analyst',
  // Other entry level signals
  'campus entry-level', 'campus entry level',
  'emerging talent', 'emerging engineer',
  'software engineer early career',
  'early career opportunity',
  'fresh graduate', 'fresher',
  // Education-completion signals
  '2025 graduates', '2026 graduates',
  'graduating in 2025', 'graduating in 2026',
  'graduating students', 'graduating seniors',
  'bachelor\'s degree required', 'bachelor degree required',
];

// Signals found in job *descriptions* (not titles) that strongly indicate a new grad role.
// When any of these appear in the description, we upgrade the classification to new_grad,
// unless the title already triggered an exclusion (seniority check comes first).
const NEW_GRAD_DESC_KEYWORDS = [
  // Graduation year signals
  'graduating in 2025', 'graduating in 2026', 'graduating in 2027',
  'graduate of 2025', 'graduate of 2026',
  'class of 2025', 'class of 2026',
  // Education signals
  'bachelor', 'bs/ms', 'b.s./m.s.',
  // Experience range signals (0–2 years maps to new grad in context)
  '0-1 year', '0-2 year', '0 to 1', '0 to 2',
  // Explicit new grad language
  'recent graduate', 'recent grad', 'new graduate', 'new grad',
  // No-experience signals
  'no prior experience', 'no experience required',
  // Recruiting program signals
  'campus recruit', 'university recruit', 'college recruit',
  // Start-year signals
  '2025 start', '2026 start',
  // Program / career stage signals
  'early career', 'rotational program', 'graduate program',
];

/**
 * Returns true when the title matches any exclusion keyword (senior/leadership roles).
 * Keywords that contain `\b` are treated as regex patterns; all others are matched
 * against a space-padded copy of the title for implicit word-boundary safety.
 */
function isExcluded(title: string): boolean {
  // Pad with spaces so leading/trailing-space keywords act as word boundaries.
  const padded = ' ' + title + ' ';
  return EXCLUSION_KEYWORDS.some(k => {
    if (k.includes('\\b')) {
      return new RegExp(k, 'i').test(padded);
    }
    return padded.includes(k);
  });
}

/**
 * Infer the experience level from a job title (and optional description).
 * Returns null when the role is clearly senior — callers should skip those jobs.
 *
 * Check order: exclusion → internship → new_grad → entry_level → default entry_level.
 *
 * Default behaviour: when no explicit seniority signal is found, returns
 * 'entry_level' so that Greenhouse/Lever postings without explicit level markers
 * are still included in the feed.
 */
export function inferExperienceLevel(
  title: string,
  content?: string,
): ExperienceLevel | null {
  const t = title.toLowerCase();
  const c = (content ?? '').toLowerCase();

  // 1. Exclusion — senior / management / mid-level roles are filtered out.
  if (isExcluded(t)) return null;

  // 2. Internship signals in title.
  if (INTERNSHIP_KEYWORDS.some(k => t.includes(k))) return 'internship';

  // 3. New grad signals in title.
  if (NEW_GRAD_KEYWORDS.some(k => t.includes(k))) return 'new_grad';

  // 3b. New grad signals in description — upgrade to new_grad.
  //     Exclusion (step 1) already prevents senior titles from reaching this point.
  if (c && NEW_GRAD_DESC_KEYWORDS.some(k => c.includes(k))) return 'new_grad';

  // 4. Entry-level signals in title or description.
  if (ENTRY_LEVEL_KEYWORDS.some(k => t.includes(k) || c.includes(k))) {
    return 'entry_level';
  }

  // 5. Default: keep the job as entry_level.
  // Curated boards (Greenhouse/Lever) typically omit explicit level markers
  // on legitimate junior postings.
  return 'entry_level';
}

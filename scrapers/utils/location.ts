const NON_US_LOCATION_SIGNALS = [
  'canada', 'mexico', 'uk', 'united kingdom', 'india', 'china',
  'japan', 'korea', 'singapore', 'australia', 'germany', 'france',
  'spain', 'italy', 'netherlands', 'poland', 'brazil', 'argentina',
  'colombia', 'chile', 'peru', 'israel', 'turkey', 'ukraine',
  'russia', 'pakistan', 'bangladesh', 'philippines', 'indonesia',
  'malaysia', 'thailand', 'vietnam', 'taiwan', 'hong kong',
  'palestine',
  'new zealand', 'sweden', 'norway', 'denmark', 'finland',
  'switzerland', 'austria', 'belgium', 'portugal', 'czech',
  'romania', 'hungary', 'bulgaria', 'croatia', 'serbia',
  'egypt', 'nigeria', 'south africa', 'kenya', 'ghana',
  'uae', 'dubai', 'saudi arabia', 'qatar', 'kuwait',
  'd.f.', 'del.', 'miguel hidalgo', 'ciudad de mexico',
  'cdmx', 'guadalajara', 'monterrey', 'puebla', 'tijuana',
  'eagle - d.f', 'eagle - df',
  'toronto', 'vancouver', 'montreal', 'calgary', 'ottawa',
  'winnipeg', 'edmonton', 'quebec', 'ontario', 'british columbia',
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad',
  'pune', 'chennai', 'kolkata', 'noida', 'gurugram', 'gurgaon',
  'london', 'paris', 'berlin', 'amsterdam', 'dublin', 'lyon',
  'stockholm', 'copenhagen', 'oslo', 'zurich', 'geneva',
  'sydney', 'melbourne', 'auckland', 'tokyo', 'osaka',
  'beijing', 'shanghai', 'shenzhen', 'seoul', 'taipei',
  'jakarta', 'kuala lumpur', 'bangkok', 'manila', 'ho chi minh',
  'tel aviv', 'istanbul', 'moscow', 'warsaw', 'prague',
  'budapest', 'bucharest', 'sofia', 'zagreb', 'belgrade',
  'cairo', 'lagos', 'nairobi', 'johannesburg', 'accra',
  'abu dhabi', 'riyadh', 'doha', 'rawabi',
  'penang',
];

const CANADIAN_PROVINCE_ABBREVIATION_RE = /(?:^|,\s)(?:ab|bc|mb|nb|nl|ns|nt|nu|on|pe|qc|sk|yt)(?=, |$)/i;

export function isNonUsLocation(location: string): boolean {
  if (!location) return false;

  const lower = location.toLowerCase();
  const matchesNonUsSignal = (value: string) =>
    NON_US_LOCATION_SIGNALS.some(signal => value.includes(signal)) ||
    CANADIAN_PROVINCE_ABBREVIATION_RE.test(value);

  const separatorIndex = lower.indexOf(' - ');
  if (separatorIndex !== -1) {
    const suffix = lower.slice(separatorIndex + 3).trim();
    if (matchesNonUsSignal(suffix)) return true;
  }

  if (matchesNonUsSignal(lower)) return true;
  if (lower.includes('united states') || lower.includes('usa')) return false;
  if (lower.includes('remote')) return false;

  return false;
}

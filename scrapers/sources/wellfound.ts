import type { NormalizedJob } from '../utils/normalize';

const SOURCE = 'wellfound';

// Wellfound is currently challenge-gating both the public pages and the internal
// search endpoints from this environment. Keep the source explicit and cheap
// until we have a verified non-residential bypass.
export async function scrapeWellfound(): Promise<NormalizedJob[]> {
  console.warn(`[${SOURCE}] Blocked by DataDome — skipping`);
  return [];
}

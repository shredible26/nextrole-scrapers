/**
 * One-time cleanup script: deactivate jobs from non-curated sources that are
 * now classified as senior/excluded by the updated inferExperienceLevel logic.
 *
 * Sources covered (NOT pittcsc or simplify_internships — those are pre-curated):
 *   greenhouse, lever, adzuna, jobspy_indeed, arbeitnow, remoteok, themuse
 *
 * Run:  pnpm run cleanup
 */

import { createClient } from '@supabase/supabase-js';
import { inferExperienceLevel } from './utils/normalize';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SOURCES = [
  'greenhouse',
  'lever',
  'adzuna',
  'jobspy_indeed',
  'arbeitnow',
  'remoteok',
  'themuse',
] as const;

const BATCH_SIZE = 500;

interface JobRow {
  id: string;
  title: string;
  description: string | null;
  source: string;
}

async function fetchAllActive(source: string): Promise<JobRow[]> {
  const rows: JobRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, title, description, source')
      .eq('source', source)
      .eq('is_active', true)
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error(`  ✗ Failed to fetch ${source} at offset ${offset}:`, error.message);
      break;
    }

    if (!data || data.length === 0) break;
    rows.push(...(data as JobRow[]));
    if (data.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  return rows;
}

async function deactivateBatch(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from('jobs')
    .update({ is_active: false })
    .in('id', ids);
  if (error) {
    console.error('  ✗ Deactivate batch failed:', error.message);
  }
}

async function cleanupSource(source: string): Promise<void> {
  console.log(`\n📡 ${source} — fetching active jobs...`);
  const jobs = await fetchAllActive(source);
  console.log(`  → ${jobs.length} active jobs found`);

  const toDeactivate: string[] = [];

  for (const job of jobs) {
    const level = inferExperienceLevel(job.title, job.description ?? undefined);
    if (level === null) {
      toDeactivate.push(job.id);
    }
  }

  console.log(`  → ${toDeactivate.length} jobs flagged as senior/excluded`);

  // Deactivate in sub-batches to stay within Supabase IN() limits
  const SUB_BATCH = 200;
  for (let i = 0; i < toDeactivate.length; i += SUB_BATCH) {
    await deactivateBatch(toDeactivate.slice(i, i + SUB_BATCH));
  }

  if (toDeactivate.length > 0) {
    console.log(`  ✓ Deactivated ${toDeactivate.length} stale senior jobs from ${source}`);
  } else {
    console.log(`  ✓ Nothing to deactivate for ${source}`);
  }
}

async function run() {
  console.log(`\n🧹 Senior role cleanup — ${new Date().toISOString()}\n`);

  let grandTotal = 0;

  for (const source of SOURCES) {
    const before = grandTotal;
    await cleanupSource(source);
    // re-read the count from the last source pass
    // (we already accumulated toDeactivate counts in cleanupSource logs)
    void before; // suppress unused-var lint
  }

  console.log('\n✅ Cleanup complete.\n');
}

run().catch(err => {
  console.error('Fatal cleanup error:', err);
  process.exit(1);
});

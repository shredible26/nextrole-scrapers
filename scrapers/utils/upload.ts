import { createClient } from '@supabase/supabase-js';
import { NormalizedJob } from './normalize';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY! // service key — bypasses RLS
);

const UPSERT_CHUNK_SIZE = 100;
const SUPABASE_RETRY_ATTEMPTS = 4;

type ExistingJobRow = {
  id: string;
  dedup_hash: string;
  source: string;
  is_active: boolean;
};

export type UploadStats = {
  attempted: number;
  inserted: number;
  updated: number;
  upserted: number;
  preservedConflicts: number;
};

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function runSupabaseWithRetry<T>(
  label: string,
  fn: () => PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= SUPABASE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const { data, error } = await fn();
      if (!error) return data;
      lastError = new Error(error.message);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < SUPABASE_RETRY_ATTEMPTS) {
      await delay(200 * attempt);
    }
  }

  throw new Error(`${label}: ${lastError?.message ?? 'unknown error'}`);
}

export async function uploadJobs(jobs: NormalizedJob[]): Promise<UploadStats> {
  const uniqueJobs = Array.from(
    new Map(jobs.map(job => [`${job.source}::${job.dedup_hash}`, job])).values(),
  );

  const stats: UploadStats = {
    attempted: uniqueJobs.length,
    inserted: 0,
    updated: 0,
    upserted: 0,
    preservedConflicts: 0,
  };

  if (uniqueJobs.length === 0) return stats;

  for (const jobChunk of chunk(uniqueJobs, UPSERT_CHUNK_SIZE)) {
    const dedupHashes = [...new Set(jobChunk.map(job => job.dedup_hash))];
    const existingRows = await runSupabaseWithRetry<ExistingJobRow[] | null>(
      'Supabase existing-row lookup failed',
      () =>
        supabase
          .from('jobs')
          .select('id, dedup_hash, source, is_active')
          .in('dedup_hash', dedupHashes),
    );

    const existingByHash = new Map<string, ExistingJobRow>(
      (existingRows ?? []).map(row => [row.dedup_hash, row as ExistingJobRow]),
    );
    const rowsToInsert = new Map<string, NormalizedJob & { is_active: boolean }>();
    const rowsToUpdate = new Map<string, NormalizedJob & { id: string; is_active: boolean }>();

    for (const job of jobChunk) {
      const payload = { ...job, is_active: true };
      const existing = existingByHash.get(job.dedup_hash);

      if (!existing) {
        rowsToInsert.set(job.dedup_hash, payload);
        continue;
      }

      if (existing.source === job.source) {
        rowsToUpdate.set(existing.id, { id: existing.id, ...payload });
        continue;
      }

      stats.preservedConflicts += 1;
    }

    if (rowsToUpdate.size > 0) {
      const updatedRows = await runSupabaseWithRetry<Array<{ id: string }> | null>(
        'Supabase update-upsert failed',
        () =>
          supabase
            .from('jobs')
            .upsert([...rowsToUpdate.values()], { onConflict: 'id' })
            .select('id'),
      );
      stats.updated += updatedRows?.length ?? rowsToUpdate.size;
    }

    if (rowsToInsert.size > 0) {
      const insertedRows = await runSupabaseWithRetry<Array<{ id: string }> | null>(
        'Supabase insert-upsert failed',
        () =>
          supabase
            .from('jobs')
            .upsert([...rowsToInsert.values()], { onConflict: 'dedup_hash', ignoreDuplicates: true })
            .select('id'),
      );
      stats.inserted += insertedRows?.length ?? rowsToInsert.size;
    }
  }

  stats.upserted = stats.inserted + stats.updated;

  console.log(
    `  ✓ Upserted ${stats.upserted} jobs (${stats.inserted} inserted, ${stats.updated} updated)` +
      (stats.preservedConflicts > 0
        ? `; preserved ${stats.preservedConflicts} cross-source duplicates`
        : ''),
  );

  return stats;
}

export async function deactivateStaleJobs(
  sourceName: string,
  activeHashes: string[]
): Promise<number> {
  if (activeHashes.length === 0) return 0;

  // Fetch all currently-active jobs for this source
  let existingJobs: Array<{ id: string; dedup_hash: string }> | null = null;
  try {
    existingJobs = await runSupabaseWithRetry<Array<{ id: string; dedup_hash: string }> | null>(
      `Stale job fetch failed for ${sourceName}`,
      () =>
        supabase
          .from('jobs')
          .select('id, dedup_hash')
          .eq('source', sourceName)
          .eq('is_active', true),
    );
  } catch (error) {
    console.warn(`  ⚠ Stale job fetch failed for ${sourceName}:`, (error as Error).message);
    return 0;
  }

  const activeHashSet = new Set(activeHashes);
  const staleIds = (existingJobs ?? [])
    .filter(job => !activeHashSet.has(job.dedup_hash))
    .map(job => job.id);

  if (staleIds.length === 0) return 0;

  // Chunk to avoid hitting Supabase's IN-clause limits
  const CHUNK_SIZE = 500;
  for (let i = 0; i < staleIds.length; i += CHUNK_SIZE) {
    const staleChunk = staleIds.slice(i, i + CHUNK_SIZE);
    try {
      await runSupabaseWithRetry(
        `Stale cleanup chunk failed for ${sourceName}`,
        () =>
          supabase
            .from('jobs')
            .update({ is_active: false })
            .in('id', staleChunk),
      );
    } catch (error) {
      console.warn(`  ⚠ Stale cleanup chunk failed for ${sourceName}:`, (error as Error).message);
    }
  }

  console.log(`  ↩ Deactivated ${staleIds.length} stale jobs for ${sourceName}`);
  return staleIds.length;
}

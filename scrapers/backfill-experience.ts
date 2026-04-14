import { createClient } from '@supabase/supabase-js';
import { inferExperienceLevel } from './utils/normalize';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const FETCH_BATCH_SIZE = 1000;
const UPDATE_BATCH_SIZE = 500;
const RETRY_ATTEMPTS = 3;

type JobRow = {
  id: string;
  title: string | null;
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(
  label: string,
  fn: () => PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      const { data, error } = await fn();
      if (!error) {
        return data;
      }

      lastError = new Error(error.message);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < RETRY_ATTEMPTS) {
      await sleep(250 * attempt);
    }
  }

  throw new Error(`${label}: ${lastError?.message ?? 'unknown error'}`);
}

async function fetchActiveJobPage(offset: number): Promise<JobRow[]> {
  const data = await withRetry<JobRow[] | null>(
    `fetch batch ${offset}-${offset + FETCH_BATCH_SIZE - 1} failed`,
    () =>
      supabase
        .from('jobs')
        .select('id, title')
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(offset, offset + FETCH_BATCH_SIZE - 1),
  );

  return (data ?? []) as JobRow[];
}

async function deactivateJobBatch(ids: string[], batchNumber: number): Promise<number> {
  const data = await withRetry<Array<{ id: string }> | null>(
    `update batch ${batchNumber} failed`,
    () =>
      supabase
        .from('jobs')
        .update({ is_active: false })
        .eq('is_active', true)
        .in('id', ids)
        .select('id'),
  );

  return data?.length ?? 0;
}

async function main() {
  const idsToDeactivate: string[] = [];
  let offset = 0;
  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalDeactivated = 0;
  let totalFetchErrors = 0;
  let totalUpdateErrors = 0;

  try {
    while (true) {
      let page: JobRow[];

      try {
        page = await fetchActiveJobPage(offset);
      } catch (error) {
        totalFetchErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[fetch ${offset}-${offset + FETCH_BATCH_SIZE - 1}] ${message}`);
        offset += FETCH_BATCH_SIZE;
        continue;
      }

      if (page.length === 0) {
        break;
      }

      for (const job of page) {
        const level = inferExperienceLevel(job.title ?? '');
        if (level === null) {
          idsToDeactivate.push(job.id);
          continue;
        }

        totalSkipped += 1;
      }

      totalProcessed += page.length;

      if (totalProcessed % 1000 === 0) {
        console.log(
          `Processed ${totalProcessed} rows so far: ${idsToDeactivate.length} marked for deactivation, ${totalSkipped} skipped`,
        );
      }

      if (page.length < FETCH_BATCH_SIZE) {
        break;
      }

      offset += FETCH_BATCH_SIZE;
    }

    // Range pagination over a filtered set can skip rows if updates happen during scanning,
    // so updates run only after the full active snapshot has been inspected.
    for (let index = 0; index < idsToDeactivate.length; index += UPDATE_BATCH_SIZE) {
      const batch = idsToDeactivate.slice(index, index + UPDATE_BATCH_SIZE);
      const batchNumber = Math.floor(index / UPDATE_BATCH_SIZE) + 1;

      try {
        const deactivated = await deactivateJobBatch(batch, batchNumber);
        totalDeactivated += deactivated;
        console.log(
          `[update batch ${batchNumber}] deactivated ${deactivated}/${batch.length} rows`,
        );
      } catch (error) {
        totalUpdateErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[update batch ${batchNumber}] ${message}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error('Fatal backfill error:', message);
    process.exit(1);
  }

  console.log(`Total processed: ${totalProcessed}`);
  console.log(`Total deactivated: ${totalDeactivated}`);
  console.log(`Total skipped: ${totalSkipped}`);

  if (totalFetchErrors > 0 || totalUpdateErrors > 0) {
    console.log(`Fetch batch errors: ${totalFetchErrors}`);
    console.log(`Update batch errors: ${totalUpdateErrors}`);
  }
}

void main();

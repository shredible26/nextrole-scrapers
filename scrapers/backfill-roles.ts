import { createClient } from '@supabase/supabase-js';
import { inferRoles, type Role } from './utils/normalize';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const FETCH_BATCH_SIZE = 1000;
const UPDATE_BATCH_SIZE = 500;
const UPDATE_CONCURRENCY = 25;
const RETRY_ATTEMPTS = 3;

type JobRow = {
  id: string;
  title: string | null;
  roles: string[] | null;
};

type RoleUpdate = {
  id: string;
  roles: Role[];
};

type UpdateBatchResult = {
  updated: number;
  failed: number;
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
      if (!error) return data;
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

function rolesEqual(existing: readonly string[] | null, next: readonly string[]): boolean {
  if (!existing) return false;
  return existing.length === next.length && existing.every((value, index) => value === next[index]);
}

async function fetchJobPage(offset: number): Promise<JobRow[]> {
  const data = await withRetry<JobRow[] | null>(
    `fetch batch ${offset}-${offset + FETCH_BATCH_SIZE - 1} failed`,
    () =>
      supabase
        .from('jobs')
        .select('id, title, roles')
        .order('id', { ascending: true })
        .range(offset, offset + FETCH_BATCH_SIZE - 1),
  );

  return (data ?? []) as JobRow[];
}

async function updateRoleRow(row: RoleUpdate): Promise<void> {
  await withRetry(
    `update failed for ${row.id}`,
    () =>
      supabase
        .from('jobs')
        .update({ roles: row.roles })
        .eq('id', row.id),
  );
}

async function updateRoleBatch(batch: RoleUpdate[], batchLabel: string): Promise<UpdateBatchResult> {
  let updated = 0;
  const failures: string[] = [];

  for (let index = 0; index < batch.length; index += UPDATE_CONCURRENCY) {
    const window = batch.slice(index, index + UPDATE_CONCURRENCY);
    const results = await Promise.allSettled(window.map(async row => {
      await updateRoleRow(row);
      return row.id;
    }));

    for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
      const result = results[resultIndex];
      if (result.status === 'fulfilled') {
        updated += 1;
        continue;
      }

      const rowId = window[resultIndex]?.id ?? 'unknown-id';
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(`${rowId}: ${reason}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `[${batchLabel}] failed updates: ${failures.length}/${batch.length}\n${failures.join('\n')}`,
    );
  }

  return {
    updated,
    failed: failures.length,
  };
}

async function main() {
  try {
    let offset = 0;
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalFailedUpdates = 0;
    let totalFetchErrors = 0;

    while (true) {
      let page: JobRow[];

      try {
        page = await fetchJobPage(offset);
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

      totalProcessed += page.length;

      const changedRows: RoleUpdate[] = [];
      for (const job of page) {
        const nextRoles = inferRoles(job.title ?? '');
        if (rolesEqual(job.roles, nextRoles)) {
          totalSkipped += 1;
          continue;
        }

        changedRows.push({
          id: job.id,
          roles: nextRoles,
        });
      }

      for (let index = 0; index < changedRows.length; index += UPDATE_BATCH_SIZE) {
        const batch = changedRows.slice(index, index + UPDATE_BATCH_SIZE);
        const batchNumber = Math.floor(index / UPDATE_BATCH_SIZE) + 1;
        const batchLabel = `update offset ${offset} batch ${batchNumber}`;

        try {
          const result = await updateRoleBatch(batch, batchLabel);
          totalUpdated += result.updated;
          totalFailedUpdates += result.failed;
        } catch (error) {
          totalFailedUpdates += batch.length;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[${batchLabel}] unexpected batch error: ${message}`);
        }
      }

      if (totalProcessed % 1000 === 0) {
        console.log(
          `Processed ${totalProcessed} rows so far: ${totalUpdated} updated, ${totalSkipped} skipped, ${totalFailedUpdates} failed updates`,
        );
      }

      if (page.length < FETCH_BATCH_SIZE) {
        break;
      }

      offset += FETCH_BATCH_SIZE;
    }

    console.log(`Total rows processed: ${totalProcessed}`);
    console.log(`Total rows updated: ${totalUpdated}`);
    console.log(`Total skipped: ${totalSkipped}`);
    console.log(`Total failed updates: ${totalFailedUpdates}`);
    console.log(`Total fetch errors: ${totalFetchErrors}`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error('Fatal backfill error:', message);
    process.exit(1);
  }
}

void main();

import { createClient } from '@supabase/supabase-js';
import { NormalizedJob } from './normalize';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY! // service key — bypasses RLS
);

const UPSERT_CHUNK_SIZE = 100;
const SUPABASE_RETRY_ATTEMPTS = 4;
const EMBEDDING_FETCH_CHUNK_SIZE = 500;
const EMBEDDING_BATCH_SIZE = 100;
const EMBEDDING_UPDATE_CONCURRENCY = 20;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_MAX_JOBS = 5_000;
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_REQUEST_TIMEOUT_MS = 60_000;
const DEACTIVATION_QUERY_TIMEOUT_MS = 15_000;
const DEACTIVATION_FETCH_CHUNK_SIZE = 1000;
const DEACTIVATION_UPDATE_CHUNK_SIZE = 500;

type ExistingJobRow = {
  id: string;
  dedup_hash: string;
  source: string;
  is_active: boolean;
};

type SupabaseError = {
  code?: string;
  message: string;
};

type InsertedJobRow = {
  id: string;
  dedup_hash: string;
};

type ActiveJobHashRow = {
  id: string;
  dedup_hash: string;
};

type JobEmbeddingSourceRow = {
  id: string;
  title: string | null;
  description: string | null;
};

type EmbeddingRowUpdate = {
  id: string;
  embedding: number[];
};

type OpenAIEmbeddingResponse = {
  data?: Array<{
    index: number;
    embedding: number[];
  }>;
  error?: {
    message?: string;
  };
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
  fn: () => PromiseLike<{ data: T; error: SupabaseError | null }>,
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildEmbeddingInput(job: JobEmbeddingSourceRow): string {
  const title = normalizeWhitespace(job.title ?? '');
  const description = normalizeWhitespace(job.description ?? '').slice(0, 500);
  return `${title} ${description}`.trim();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function normalizeDedupHash(value: string): string {
  return value.trim().toLowerCase();
}

async function fetchActiveJobHashesForSource(
  sourceName: string,
): Promise<{ rows: ActiveJobHashRow[]; pagesFetched: number }> {
  const rows: ActiveJobHashRow[] = [];
  let pagesFetched = 0;

  for (let offset = 0; ; offset += DEACTIVATION_FETCH_CHUNK_SIZE) {
    const page =
      (await runSupabaseWithRetry<ActiveJobHashRow[] | null>(
        `Supabase deactivation fetch failed for ${sourceName} at offset ${offset}`,
        () =>
          supabase
            .from('jobs')
            .select('id, dedup_hash')
            .eq('source', sourceName)
            .eq('is_active', true)
            .order('id', { ascending: true })
            .range(offset, offset + DEACTIVATION_FETCH_CHUNK_SIZE - 1)
            .abortSignal(AbortSignal.timeout(DEACTIVATION_QUERY_TIMEOUT_MS)),
      )) ?? [];

    if (page.length === 0) {
      break;
    }

    pagesFetched += 1;
    rows.push(...page);

    if (page.length < DEACTIVATION_FETCH_CHUNK_SIZE) {
      break;
    }
  }

  return { rows, pagesFetched };
}

export async function countActiveJobsForSource(
  sourceName: string,
  timeoutMs = DEACTIVATION_QUERY_TIMEOUT_MS,
): Promise<number> {
  const { count, error } = await supabase
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('source', sourceName)
    .eq('is_active', true)
    .abortSignal(AbortSignal.timeout(timeoutMs));

  if (error) {
    throw new Error(error.message);
  }

  return count ?? 0;
}

async function callEmbeddingsApi(inputs: string[], apiKey: string): Promise<number[][]> {
  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
    signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS),
  });

  const responseText = await response.text();
  let payload: OpenAIEmbeddingResponse | null = null;

  if (responseText) {
    try {
      payload = JSON.parse(responseText) as OpenAIEmbeddingResponse;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ??
      responseText.slice(0, 500) ??
      `Embeddings request failed with status ${response.status}`;
    throw new Error(message);
  }

  const data = payload?.data;
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new Error(
      `Unexpected embeddings response: expected ${inputs.length} vectors, received ${data?.length ?? 0}`,
    );
  }

  const embeddings = [...data]
    .sort((left, right) => left.index - right.index)
    .map(item => item.embedding);

  for (const embedding of embeddings) {
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Unexpected embedding dimensions: expected ${EMBEDDING_DIMENSIONS}, received ${embedding?.length ?? 0}`,
      );
    }
  }

  return embeddings;
}

async function callEmbeddingsApiWithSingleRetry(
  inputs: string[],
  apiKey: string,
): Promise<number[][]> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await callEmbeddingsApi(inputs, apiKey);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < 2) {
        await delay(200);
      }
    }
  }

  throw lastError ?? new Error('Embeddings request failed');
}

async function updateEmbeddingBatch(rows: EmbeddingRowUpdate[]): Promise<number> {
  let embedded = 0;

  for (let index = 0; index < rows.length; index += EMBEDDING_UPDATE_CONCURRENCY) {
    const window = rows.slice(index, index + EMBEDDING_UPDATE_CONCURRENCY);
    const results = await Promise.allSettled(
      window.map(row =>
        runSupabaseWithRetry(
          `Failed to update embedding for job ${row.id}`,
          () =>
            supabase
              .from('jobs')
              .update({ embedding: row.embedding })
              .eq('id', row.id),
        ),
      ),
    );

    for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
      const result = results[resultIndex];
      if (result.status === 'fulfilled') {
        embedded += 1;
        continue;
      }

      const rowId = window[resultIndex]?.id ?? 'unknown-id';
      throw new Error(`Failed to write embedding for ${rowId}: ${getErrorMessage(result.reason)}`);
    }
  }

  return embedded;
}

export async function embedNewJobs(jobIds: string[]): Promise<void> {
  const uniqueJobIds = Array.from(new Set(jobIds));

  if (uniqueJobIds.length === 0) {
    console.log('  ⚡ Embedded 0 new jobs');
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('  ⚠ OPENAI_API_KEY is not set; skipping new job embeddings');
    return;
  }

  const limitedJobIds =
    uniqueJobIds.length > EMBEDDING_MAX_JOBS
      ? uniqueJobIds.slice(0, EMBEDDING_MAX_JOBS)
      : uniqueJobIds;

  if (uniqueJobIds.length > EMBEDDING_MAX_JOBS) {
    console.warn(
      `  ⚠ Embedding helper received ${uniqueJobIds.length} jobs; embedding only the first ${EMBEDDING_MAX_JOBS}`,
    );
  }

  try {
    const jobsToEmbed: JobEmbeddingSourceRow[] = [];

    for (const idChunk of chunk(limitedJobIds, EMBEDDING_FETCH_CHUNK_SIZE)) {
      const rows = await runSupabaseWithRetry<JobEmbeddingSourceRow[] | null>(
        'Supabase embedding fetch failed',
        () =>
          supabase
            .from('jobs')
            .select('id, title, description')
            .in('id', idChunk),
      );

      jobsToEmbed.push(...(rows ?? []));
    }

    if (jobsToEmbed.length === 0) {
      console.log('  ⚡ Embedded 0 new jobs');
      return;
    }

    let embeddedCount = 0;

    for (const batch of chunk(jobsToEmbed, EMBEDDING_BATCH_SIZE)) {
      const embeddings = await callEmbeddingsApiWithSingleRetry(
        batch.map(job => buildEmbeddingInput(job)),
        apiKey,
      );

      embeddedCount += await updateEmbeddingBatch(
        batch.map((job, index) => ({
          id: job.id,
          embedding: embeddings[index]!,
        })),
      );
    }

    console.log(`  ⚡ Embedded ${embeddedCount} new jobs`);
  } catch (error) {
    console.error('  ⚠ Failed to embed new jobs:', getErrorMessage(error));
  }
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
  const newlyInsertedIds: string[] = [];

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
      const insertedRows = await runSupabaseWithRetry<InsertedJobRow[] | null>(
        'Supabase insert-upsert failed',
        () =>
          supabase
            .from('jobs')
            .upsert([...rowsToInsert.values()], { onConflict: 'dedup_hash', ignoreDuplicates: true })
            .select('id, dedup_hash'),
      );
      const resolvedInsertedRows =
        insertedRows ??
        (await runSupabaseWithRetry<InsertedJobRow[] | null>(
          'Supabase inserted-row lookup failed',
          () =>
            supabase
              .from('jobs')
              .select('id, dedup_hash')
              .in('dedup_hash', [...rowsToInsert.keys()]),
        )) ??
        [];

      stats.inserted += resolvedInsertedRows.length || rowsToInsert.size;
      newlyInsertedIds.push(...resolvedInsertedRows.map(row => row.id));
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
  const freshHashes = Array.from(
    new Set(
      activeHashes
        .map(normalizeDedupHash)
        .filter(Boolean),
    ),
  );
  const freshCount = freshHashes.length;

  console.log(`[${sourceName}] Starting deactivation check...`);

  let activeCount = 0;
  try {
    activeCount = await countActiveJobsForSource(sourceName);
  } catch (error) {
    console.warn(
      `[${sourceName}] ⚠ Deactivation count query failed: ${getErrorMessage(error)}. Skipping source.`,
    );
    return 0;
  }

  console.log(`[${sourceName}] ${activeCount} active jobs in DB, ${freshCount} scraped this run`);

  let existingJobs: ActiveJobHashRow[] = [];
  let pagesFetched = 0;
  try {
    const fetchResult = await fetchActiveJobHashesForSource(sourceName);
    existingJobs = fetchResult.rows;
    pagesFetched = fetchResult.pagesFetched;
  } catch (error) {
    console.warn(
      `[${sourceName}] ⚠ Deactivation fetch query failed: ${getErrorMessage(error)}. Skipping source.`,
    );
    return 0;
  }

  if (existingJobs.length === 0 && activeCount > 0) {
    console.warn(
      `[${sourceName}] ⚠ Deactivation fetched 0 active hashes despite ${activeCount} active jobs in DB. Skipping source.`,
    );
    return 0;
  }

  if (existingJobs.length !== activeCount) {
    console.warn(
      `[${sourceName}] ⚠ Deactivation fetched ${existingJobs.length} active hashes across ${pagesFetched} page(s), but count query reported ${activeCount}. Continuing with fetched rows.`,
    );
  } else {
    console.log(
      `[${sourceName}] Fetched ${existingJobs.length} active hashes across ${pagesFetched} page(s) for diffing`,
    );
  }

  const activeHashSet = new Set(freshHashes);
  // Dry-run sanity check:
  // activeCount=8,610 and freshCount=6,796 should fetch all 8,610 rows across paginated
  // requests and surface 1,814 stale hashes here before any safety guard can short-circuit.
  const staleHashes = Array.from(
    new Set(
      existingJobs
        .filter(job => !activeHashSet.has(normalizeDedupHash(job.dedup_hash)))
        .map(job => job.dedup_hash),
    ),
  );
  const staleCount = staleHashes.length;

  console.log(
    `[${sourceName}] Diff result before safeguards: ${staleCount} stale hashes (${existingJobs.length} active DB hashes vs ${freshCount} scraped hashes)`,
  );

  if (freshCount === 0) {
    console.warn(
      `[${sourceName}] ⚠ Skipping deactivation — ${freshCount} fresh jobs vs ${activeCount} active. Threshold not met, preserving existing jobs.`,
    );
    return 0;
  }

  if (activeCount > 100 && freshCount < activeCount * 0.5) {
    console.warn(
      `[${sourceName}] ⚠ Skipping deactivation — ${freshCount} fresh jobs vs ${activeCount} active. Threshold not met, preserving existing jobs.`,
    );
    return 0;
  }

  if (activeCount > 0 && staleCount > activeCount * 0.8) {
    console.warn(
      `[${sourceName}] ⚠ Skipping deactivation — computed ${staleCount} stale hashes out of ${activeCount} active jobs (>80%). Preserving existing jobs.`,
    );
    return 0;
  }

  if (staleCount === 0 && activeCount > freshCount) {
    console.warn(
      `[${sourceName}] ⚠ Diff produced 0 stale hashes despite ${activeCount} active jobs and only ${freshCount} fresh hashes. Preserving existing jobs because the diff is inconsistent.`,
    );
    return 0;
  }

  if (staleCount === 0) {
    console.log(`[${sourceName}] ✓ No stale jobs`);
    return 0;
  }

  console.log(
    `[${sourceName}] Deactivating ${staleCount} stale jobs in chunks of ${DEACTIVATION_UPDATE_CHUNK_SIZE}...`,
  );

  let deactivatedCount = 0;
  for (let i = 0; i < staleHashes.length; i += DEACTIVATION_UPDATE_CHUNK_SIZE) {
    const staleChunk = staleHashes.slice(i, i + DEACTIVATION_UPDATE_CHUNK_SIZE);

    try {
      await runSupabaseWithRetry<null>(
        `Supabase deactivation update failed for ${sourceName}`,
        () =>
          supabase
            .from('jobs')
            .update({ is_active: false })
            .eq('source', sourceName)
            .eq('is_active', true)
            .in('dedup_hash', staleChunk)
            .abortSignal(AbortSignal.timeout(DEACTIVATION_QUERY_TIMEOUT_MS)),
      );
    } catch (error) {
      console.warn(
        `[${sourceName}] ⚠ Deactivation update query failed: ${getErrorMessage(error)}. Skipping source.`,
      );
      return deactivatedCount;
    }

    deactivatedCount += staleChunk.length;
  }

  console.log(`[${sourceName}] ✓ Deactivated ${deactivatedCount} stale jobs`);
  return deactivatedCount;
}

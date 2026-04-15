import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const FETCH_PAGE_SIZE = 500;
const EMBEDDING_BATCH_SIZE = 100;
const UPDATE_CONCURRENCY = 20;
const API_BATCH_DELAY_MS = 200;
const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const REQUEST_TIMEOUT_MS = 60_000;
const SUPABASE_RETRY_ATTEMPTS = 3;
const AVERAGE_TOKENS_PER_JOB = 300;
const MAX_ESTIMATED_TOKENS = 30_000_000;
const COST_PER_MILLION_TOKENS_USD = 0.02;
const PROGRESS_LOG_INTERVAL = 500;
const US_LIKE_LOCATION_MARKERS = [
  'united states',
  ', usa',
  'remote',
  ', ca',
  ', ny',
  ', tx',
  ', wa',
  ', ma',
  ', il',
  ', ga',
  ', co',
  ', fl',
  ', va',
  ', pa',
  ', nc',
  ', az',
  ', or',
  ', mn',
  ', mi',
  ', oh',
] as const;

type CliOptions = {
  dryRun: boolean;
  force: boolean;
  limit: number | null;
};

type SupabaseError = {
  code?: string;
  message: string;
};

type JobRow = {
  id: string;
  title: string | null;
  description: string | null;
  location: string | null;
};

type JobToEmbed = {
  id: string;
  input: string;
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
  usage?: {
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

type UpdateBatchResult = {
  updated: number;
  failed: number;
};

type EmbeddingBatchResult = {
  embeddings: number[][];
  totalTokens: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;
  let force = false;
  let limit: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--force') {
      force = true;
      continue;
    }

    if (arg === '--limit' || arg.startsWith('--limit=')) {
      const rawValue = arg === '--limit' ? argv[index + 1] : arg.slice('--limit='.length);
      if (!rawValue) {
        throw new Error('Expected a numeric value after --limit');
      }

      if (arg === '--limit') {
        index += 1;
      }

      const parsedLimit = Number.parseInt(rawValue, 10);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        throw new Error(`Invalid --limit value: ${rawValue}`);
      }

      limit = parsedLimit;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    dryRun,
    force,
    limit,
  };
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function estimateUsdCost(totalTokens: number): number {
  return (totalTokens / 1_000_000) * COST_PER_MILLION_TOKENS_USD;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: 6,
  }).format(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildEmbeddingInput(job: JobRow): string {
  const title = normalizeWhitespace(job.title ?? '');
  const description = normalizeWhitespace(job.description ?? '').slice(0, 500);
  return `${title} ${description}`.trim();
}

function isUsLikeLocation(location: string | null): boolean {
  if (location === null || location === '') {
    return true;
  }

  const normalizedLocation = location.toLowerCase();
  return US_LIKE_LOCATION_MARKERS.some(marker => normalizedLocation.includes(marker));
}

function formatBatchLabel(batchNumber: number, totalBatches: number): string {
  return `batch ${batchNumber}/${totalBatches}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isMissingEmbeddingColumnError(error: SupabaseError | null): boolean {
  if (!error) {
    return false;
  }

  return error.code === '42703' && error.message.includes('jobs.embedding');
}

async function withSupabaseRetry<T>(
  label: string,
  fn: () => PromiseLike<{ data: T; error: SupabaseError | null; count?: number | null }>,
): Promise<{ data: T; count: number | null | undefined }> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= SUPABASE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const { data, error, count } = await fn();
      if (!error) {
        return { data, count };
      }

      if (isMissingEmbeddingColumnError(error)) {
        throw new Error(
          'jobs.embedding does not exist yet. Apply supabase/migrations/006_embeddings.sql before running this script.',
        );
      }

      lastError = new Error(error.message || 'unknown error');
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < SUPABASE_RETRY_ATTEMPTS) {
      await sleep(250 * attempt);
    }
  }

  throw new Error(`${label}: ${lastError?.message ?? 'unknown error'}`);
}

async function ensureEmbeddingColumnExists(): Promise<void> {
  await withSupabaseRetry<Array<{ id: string; embedding: number[] | null }> | null>(
    'Failed to verify jobs.embedding',
    () =>
      supabase
        .from('jobs')
        .select('id, embedding')
        .limit(1),
  );
}

async function countTargetJobs(): Promise<number> {
  await ensureEmbeddingColumnExists();

  const { count } = await withSupabaseRetry<Array<{ id: string }> | null>(
    'Failed to count jobs without embeddings',
    () =>
      supabase
        .from('jobs')
        .select('id', { count: 'exact', head: true })
        .is('embedding', null),
  );

  return count ?? 0;
}

async function fetchPaginatedJobGroup(
  label: string,
  buildPageQuery: (
    offset: number,
    pageSize: number,
  ) => PromiseLike<{ data: JobRow[] | null; error: SupabaseError | null; count?: number | null }>,
  jobs: JobToEmbed[],
  seenJobIds: Set<string>,
  includeJob: (job: JobRow) => boolean = () => true,
): Promise<void> {
  for (let offset = 0; ; offset += FETCH_PAGE_SIZE) {
    const pageSize = FETCH_PAGE_SIZE;
    const { data } = await withSupabaseRetry<JobRow[] | null>(
      `Failed to fetch ${label} jobs ${offset}-${offset + pageSize - 1}`,
      () => buildPageQuery(offset, pageSize),
    );

    const page = (data ?? []) as JobRow[];

    for (const job of page) {
      if (!includeJob(job) || seenJobIds.has(job.id)) {
        continue;
      }

      seenJobIds.add(job.id);
      jobs.push({
        id: job.id,
        input: buildEmbeddingInput(job),
      });
    }

    if (page.length < pageSize) {
      break;
    }
  }
}

async function fetchTargetJobs(): Promise<JobToEmbed[]> {
  const jobs: JobToEmbed[] = [];
  const seenJobIds = new Set<string>();

  await fetchPaginatedJobGroup(
    'priority new_grad US-like',
    (offset, pageSize) =>
      supabase
        .from('jobs')
        .select('id, title, description, location')
        .eq('is_active', true)
        .eq('experience_level', 'new_grad')
        .is('embedding', null)
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1),
    jobs,
    seenJobIds,
    job => isUsLikeLocation(job.location),
  );

  await fetchPaginatedJobGroup(
    'priority entry_level US-like',
    (offset, pageSize) =>
      supabase
        .from('jobs')
        .select('id, title, description, location')
        .eq('is_active', true)
        .eq('experience_level', 'entry_level')
        .is('embedding', null)
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1),
    jobs,
    seenJobIds,
    job => isUsLikeLocation(job.location),
  );

  await fetchPaginatedJobGroup(
    'fallback',
    (offset, pageSize) =>
      supabase
        .from('jobs')
        .select('id, title, description, location')
        .is('embedding', null)
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1),
    jobs,
    seenJobIds,
  );

  return jobs;
}

async function callEmbeddingsApi(inputs: string[]): Promise<EmbeddingBatchResult> {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY must be set unless you are using --dry-run');
  }

  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

  return {
    embeddings,
    totalTokens: payload?.usage?.total_tokens ?? 0,
  };
}

async function embedBatchWithSingleRetry(
  batch: JobToEmbed[],
  batchLabel: string,
): Promise<EmbeddingBatchResult | null> {
  const inputs = batch.map(job => job.input);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await callEmbeddingsApi(inputs);
    } catch (error) {
      const message = getErrorMessage(error);

      if (attempt === 1) {
        console.warn(`[${batchLabel}] embeddings request failed, retrying once: ${message}`);
        await sleep(API_BATCH_DELAY_MS);
        continue;
      }

      console.error(
        `[${batchLabel}] embeddings request failed twice, skipping ${batch.length} jobs: ${message}`,
      );
      return null;
    }
  }

  return null;
}

async function updateEmbeddingRow(row: EmbeddingRowUpdate): Promise<void> {
  await withSupabaseRetry(
    `Failed to update embedding for job ${row.id}`,
    () =>
      supabase
        .from('jobs')
        .update({ embedding: row.embedding })
        .eq('id', row.id),
  );
}

async function updateEmbeddingBatch(
  rows: EmbeddingRowUpdate[],
  batchLabel: string,
): Promise<UpdateBatchResult> {
  let updated = 0;
  let failed = 0;

  for (let index = 0; index < rows.length; index += UPDATE_CONCURRENCY) {
    const window = rows.slice(index, index + UPDATE_CONCURRENCY);
    const results = await Promise.allSettled(window.map(row => updateEmbeddingRow(row)));

    for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
      const result = results[resultIndex];
      if (result.status === 'fulfilled') {
        updated += 1;
        continue;
      }

      failed += 1;
      const rowId = window[resultIndex]?.id ?? 'unknown-id';
      console.error(`[${batchLabel}] failed to write embedding for ${rowId}: ${getErrorMessage(result.reason)}`);
    }
  }

  return { updated, failed };
}

function logEstimate(totalAvailable: number, totalToProcess: number, options: CliOptions): void {
  const estimatedTokens = totalToProcess * AVERAGE_TOKENS_PER_JOB;
  const estimatedCost = estimateUsdCost(estimatedTokens);
  const suffix =
    options.limit === null
      ? 'all jobs in prioritized order'
      : `${formatInteger(totalToProcess)} jobs due to --limit ${options.limit}`;

  console.log(
    `Found ${formatInteger(totalAvailable)} jobs with null embeddings; processing ${suffix}.`,
  );
  console.log(
    `Estimated usage: ${formatInteger(estimatedTokens)} tokens, about ${formatUsd(estimatedCost)} at ${formatUsd(COST_PER_MILLION_TOKENS_USD)} per 1M tokens.`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const totalAvailable = await countTargetJobs();
  const totalToProcess = options.limit === null
    ? totalAvailable
    : Math.min(totalAvailable, options.limit);
  const estimatedTokens = totalToProcess * AVERAGE_TOKENS_PER_JOB;

  logEstimate(totalAvailable, totalToProcess, options);

  if (totalToProcess === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (options.dryRun) {
    console.log('Dry run complete. No API calls were made and no database rows were updated.');
    return;
  }

  if (estimatedTokens > MAX_ESTIMATED_TOKENS && !options.force) {
    throw new Error(
      `Estimated usage is ${formatInteger(estimatedTokens)} tokens, above the hard cap of ${formatInteger(MAX_ESTIMATED_TOKENS)}. Re-run with --force to continue.`,
    );
  }

  // Collect the target set up front so range pagination does not skip rows as embeddings are written.
  const prioritizedJobs = await fetchTargetJobs();
  const jobs = prioritizedJobs.slice(0, totalToProcess);

  if (jobs.length === 0) {
    console.log('No jobs were returned from Supabase after the initial count. Nothing to do.');
    return;
  }

  if (jobs.length !== totalToProcess) {
    console.warn(
      `Expected to process ${formatInteger(totalToProcess)} jobs but fetched ${formatInteger(jobs.length)} after prioritization. Continuing with the fetched snapshot.`,
    );
  }

  let processed = 0;
  let embedded = 0;
  let skipped = 0;
  let totalTokensUsed = 0;
  let failedWrites = 0;
  const totalBatches = Math.ceil(jobs.length / EMBEDDING_BATCH_SIZE);

  for (let index = 0; index < jobs.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = jobs.slice(index, index + EMBEDDING_BATCH_SIZE);
    const batchNumber = Math.floor(index / EMBEDDING_BATCH_SIZE) + 1;
    const batchLabel = formatBatchLabel(batchNumber, totalBatches);
    const embeddingResult = await embedBatchWithSingleRetry(batch, batchLabel);

    if (!embeddingResult) {
      skipped += batch.length;
      processed += batch.length;
    } else {
      totalTokensUsed += embeddingResult.totalTokens;
      const rows: EmbeddingRowUpdate[] = batch.map((job, batchIndex) => ({
        id: job.id,
        embedding: embeddingResult.embeddings[batchIndex]!,
      }));
      const updateResult = await updateEmbeddingBatch(rows, batchLabel);
      embedded += updateResult.updated;
      failedWrites += updateResult.failed;
      skipped += updateResult.failed;
      processed += batch.length;
    }

    if (processed % PROGRESS_LOG_INTERVAL === 0 || processed === jobs.length) {
      console.log(
        `Processed ${formatInteger(processed)} / ${formatInteger(jobs.length)} jobs, ~${formatUsd(estimateUsdCost(totalTokensUsed))} spent so far`,
      );
    }

    if (index + EMBEDDING_BATCH_SIZE < jobs.length) {
      await sleep(API_BATCH_DELAY_MS);
    }
  }

  console.log(`Jobs embedded: ${formatInteger(embedded)}`);
  console.log(`Jobs skipped: ${formatInteger(skipped)}`);
  console.log(`Total tokens used: ${formatInteger(totalTokensUsed)}`);
  console.log(`Total cost: ${formatUsd(estimateUsdCost(totalTokensUsed))}`);

  if (failedWrites > 0 || skipped > 0) {
    process.exitCode = 1;
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

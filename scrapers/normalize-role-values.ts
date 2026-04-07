import { createClient } from '@supabase/supabase-js';
import { normalizeRoleValue, type Role } from './utils/normalize';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const PAGE_SIZE = 1000;
const UPDATE_CHUNK_SIZE = 50;

type JobRow = {
  id: string;
  roles: string[] | null;
};

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function canonicalizeRoles(rawRoles: readonly string[]): Role[] | null {
  const canonicalRoles: Role[] = [];

  for (const rawRole of rawRoles) {
    const role = normalizeRoleValue(rawRole);
    if (!role) {
      return null;
    }

    if (!canonicalRoles.includes(role)) {
      canonicalRoles.push(role);
    }
  }

  return canonicalRoles;
}

async function fetchRolePage(offset: number): Promise<JobRow[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, roles')
    .not('roles', 'is', null)
    .order('id', { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);

  if (error) {
    throw new Error(`Failed to fetch jobs page at offset ${offset}: ${error.message}`);
  }

  return (data ?? []) as JobRow[];
}

async function updateRoleChunk(rows: Array<{ id: string; roles: Role[] }>) {
  if (rows.length === 0) return;

  await Promise.all(
    rows.map(async row => {
      const { error } = await supabase
        .from('jobs')
        .update({ roles: row.roles })
        .eq('id', row.id);

      if (error) {
        throw new Error(`Failed to update ${row.id}: ${error.message}`);
      }
    }),
  );
}

async function main() {
  let offset = 0;
  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  let skippedUnknown = 0;

  while (true) {
    const page = await fetchRolePage(offset);
    if (page.length === 0) break;

    scanned += page.length;
    const updates: Array<{ id: string; roles: Role[] }> = [];

    for (const row of page) {
      const rawRoles = row.roles ?? [];
      const canonicalRoles = canonicalizeRoles(rawRoles);

      if (!canonicalRoles) {
        skippedUnknown += 1;
        console.warn(`Skipping ${row.id}: unexpected role value in ${JSON.stringify(rawRoles)}`);
        continue;
      }

      if (arraysEqual(rawRoles, canonicalRoles)) {
        unchanged += 1;
        continue;
      }

      updates.push({ id: row.id, roles: canonicalRoles });
    }

    for (let index = 0; index < updates.length; index += UPDATE_CHUNK_SIZE) {
      const chunk = updates.slice(index, index + UPDATE_CHUNK_SIZE);
      await updateRoleChunk(chunk);
      updated += chunk.length;
    }

    console.log(
      `Processed ${scanned} rows so far: ${updated} updated, ${unchanged} unchanged, ${skippedUnknown} skipped`,
    );

    offset += PAGE_SIZE;
  }

  console.log(
    `Role normalization complete: ${scanned} scanned, ${updated} updated, ${unchanged} unchanged, ${skippedUnknown} skipped`,
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

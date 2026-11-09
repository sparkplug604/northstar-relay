import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

export async function migrateRelay(pool: Pool, directory = resolve(process.cwd(), 'packages/relay-storage-postgres/migrations')): Promise<readonly string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('northstar-relay-migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS public.relay_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort()) {
      const sql = await readFile(resolve(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT checksum FROM public.relay_migrations WHERE name=$1', [name]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Migration checksum changed: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.relay_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
        await client.query('COMMIT');
        applied.push(name);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('northstar-relay-migrations'))");
    client.release();
  }
}

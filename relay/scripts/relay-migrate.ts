import { Pool } from 'pg';
import { migrateRelay } from '../packages/relay-storage-postgres/src/index.js';

const databaseUrl = process.env.RELAY_MIGRATION_DATABASE_URL;
if (!databaseUrl) throw new Error('Set RELAY_MIGRATION_DATABASE_URL to the migration-owner connection');
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try { const files = await migrateRelay(pool); process.stdout.write(`Relay migrations applied: ${files.length}\n`); }
finally { await pool.end(); }

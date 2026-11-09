import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import type { Job } from '@northstar/relay-domain';
import { migrateRelay } from '../packages/relay-storage-postgres/src/index.js';

const databaseUrl = process.env.RELAY_TEST_DATABASE_URL;
describe('Relay job migration and database guardrails', { skip: !databaseUrl }, () => {
  const databaseName = `relay_job_migration_${randomBytes(6).toString('hex')}`;
  const url = new URL(databaseUrl ?? 'postgres://localhost/unused'); url.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: url.toString() });
  const tenantId = randomUUID(), branchId = randomUUID(), personId = randomUUID(), jobId = randomUUID();
  const inactivePersonId = randomUUID(), inactiveJobId = randomUUID();
  const originalMigrations = resolve('packages/relay-storage-postgres/migrations');
  let initialMigrationResult: readonly string[];

  async function restricted<T>(tenant: string, operation: (client: PoolClient) => Promise<T>, commit = false): Promise<T> {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN'); transactionOpen = true;
      await client.query('SET LOCAL ROLE relay_runtime');
      await client.query("SELECT set_config('relay.tenant_id',$1,true)", [tenant]);
      const result = await operation(client);
      if (commit) { await client.query('COMMIT'); transactionOpen = false; }
      return result;
    } finally { if (transactionOpen) await client.query('ROLLBACK'); client.release(); }
  }

  before(async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    try { await admin.query(`CREATE DATABASE "${databaseName}"`); } finally { await admin.end(); }
    const legacyDirectory = await mkdtemp(join(tmpdir(), 'relay-legacy-migrations-'));
    for (const name of ['001_relay.sql', '002_intake_and_capabilities.sql', '003_on_call_policy_versions.sql']) {
      await copyFile(join(originalMigrations, name), join(legacyDirectory, name));
    }
    assert.equal((await migrateRelay(pool, legacyDirectory)).length, 3);
    assert.equal((await pool.query("SELECT to_regclass('relay.jobs') AS jobs")).rows[0].jobs, null);
    await pool.query("INSERT INTO relay.organizations(id,name) VALUES($1,'Synthetic legacy organization')", [tenantId]);
    await pool.query("INSERT INTO relay.branches(tenant_id,id,name,timezone) VALUES($1,$2,'Legacy branch','America/Vancouver')", [tenantId, branchId]);
    for (const person of [{ id: personId, active: true }, { id: inactivePersonId, active: false }]) {
      await pool.query("INSERT INTO relay.people(id,email,display_name,password_hash,active) VALUES($1,$2,'Legacy owner','unused',$3)", [person.id, `${person.id}@example.invalid`, person.active]);
      await pool.query("INSERT INTO relay.memberships(tenant_id,person_id,branch_id,role) VALUES($1,$2,$3,'on_call_responder')", [tenantId, person.id, branchId]);
    }
    await restricted(tenantId, async (client) => {
      for (const legacy of [{ id: jobId, owner: personId }, { id: inactiveJobId, owner: inactivePersonId }]) {
        // A genuine old-schema row: no new application store or job hook is used.
        const snapshot = {
          tenantId, branchId, commitmentId: legacy.id, workOrderId: legacy.id, commitmentType: 'acknowledge_work_order',
          status: 'closed', version: 7, ownerRecipientId: legacy.owner,
          recipients: [{ recipientId: legacy.owner, personId: legacy.owner, displayName: 'Legacy owner', contactMethodId: `contact:${legacy.owner}` }],
          workOrder: { externalId: `LEGACY-${legacy.id}`, sourceKind: 'manual', sourceMessageId: `source:${legacy.id}`, customerReference: 'Legacy customer', priority: 'urgent', sourceReceivedAt: '2026-09-01T12:00:00.000Z' },
          createdAt: '2026-09-01T12:00:00.000Z', acknowledgedAt: '2026-09-01T12:01:00.000Z',
          fulfilledAt: '2026-09-01T12:02:00.000Z', closedAt: '2026-09-01T12:03:00.000Z',
        };
        await client.query(`INSERT INTO relay.commitments(tenant_id,branch_id,commitment_id,work_order_id,external_id,source_kind,source_message_id,status,version,snapshot,note)
          VALUES($1,$2,$3,$3,$4,'manual',$5,'closed',7,$6,'Original work description')`,
        [tenantId, branchId, legacy.id, snapshot.workOrder.externalId, snapshot.workOrder.sourceMessageId, snapshot]);
      }
    }, true);
    initialMigrationResult = await migrateRelay(pool, originalMigrations);
    await restricted(tenantId, async (client) => {
      await client.query(`INSERT INTO relay.job_milestones(tenant_id,job_id,id,status,due_at,snapshot)
        VALUES($1,$2,'migration-milestone','open',clock_timestamp(),'{}')`, [tenantId, jobId]);
      await client.query(`INSERT INTO relay.job_commands(tenant_id,command_id,job_id,request_digest,outcome)
        VALUES($1,'migration-command',$2,'fixture','{}')`, [tenantId, jobId]);
    }, true);
  });
  after(async () => { await pool.end(); });

  it('backfills closed handoffs as requested jobs without inventing work completion', async () => {
    assert.ok(initialMigrationResult.includes('004_jobs.sql'));
    assert.ok(initialMigrationResult.includes('005_standalone_jobs.sql'));
    await restricted(tenantId, async (client) => {
      const job = (await client.query('SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND id=$2', [tenantId, jobId])).rows[0].snapshot as Job;
      assert.equal(job.status, 'requested'); assert.equal(job.version, 1);
      assert.equal(job.acknowledgementId, jobId); assert.equal(job.description, 'Original work description');
      assert.equal(job.assigneeId, personId); assert.equal(job.completedAt, null); assert.equal(job.completionReportedAt, null);
      assert.equal(job.customerReference, 'Legacy customer');
      const inactive = (await client.query('SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND id=$2', [tenantId, inactiveJobId])).rows[0].snapshot as Job;
      assert.equal(inactive.assigneeId, null);
      const event = (await client.query('SELECT envelope FROM relay.job_events WHERE tenant_id=$1 AND job_id=$2', [tenantId, jobId])).rows[0].envelope;
      assert.equal(event.kind, 'job_created'); assert.equal(event.details.backfilled, true);
      assert.equal((await client.query('SELECT status,version FROM relay.commitments WHERE tenant_id=$1 AND commitment_id=$2', [tenantId, jobId])).rows[0].status, 'closed');
    });
  });

  it('is a repeat-safe additive migration', async () => {
    assert.deepEqual(await migrateRelay(pool, originalMigrations), []);
    await restricted(tenantId, async (client) => {
      assert.equal((await client.query('SELECT count(*)::integer AS count FROM relay.jobs WHERE tenant_id=$1', [tenantId])).rows[0].count, 2);
      assert.equal((await client.query('SELECT count(*)::integer AS count FROM relay.job_events WHERE tenant_id=$1', [tenantId])).rows[0].count, 2);
    });
  });

  it('forces tenant isolation on all four new tables under the runtime role', async () => {
    const tables = ['jobs', 'job_milestones', 'job_events', 'job_commands'];
    await restricted(tenantId, async (client) => {
      for (const table of tables) assert.ok((await client.query(`SELECT 1 FROM relay.${table}`)).rowCount! > 0, table);
    });
    await restricted(`different-${randomUUID()}`, async (client) => {
      for (const table of tables) assert.equal((await client.query(`SELECT 1 FROM relay.${table}`)).rowCount, 0, table);
    });
    const policies = (await pool.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relnamespace='relay'::regnamespace AND relname=ANY($1::text[])`, [tables])).rows;
    assert.equal(policies.length, 4);
    for (const policy of policies) assert.ok(policy.relrowsecurity && policy.relforcerowsecurity, policy.relname);
  });

  it('denies runtime updates and deletes of job events and idempotency history', async () => {
    for (const table of ['job_events', 'job_commands']) {
      for (const verb of ['UPDATE', 'DELETE']) {
        await assert.rejects(() => restricted(tenantId, (client) => client.query(verb === 'UPDATE'
          ? `UPDATE relay.${table} SET tenant_id=tenant_id WHERE tenant_id=$1`
          : `DELETE FROM relay.${table} WHERE tenant_id=$1`, [tenantId])), /permission denied|append-only/);
      }
    }
  });
  it('isolates technician profiles and preserves planning command history under the runtime role',async()=>{
    await restricted(tenantId,async client=>{
      await client.query("INSERT INTO relay.technician_planning(tenant_id,person_id,branch_id,version,profile) VALUES($1,$2,$3,1,'{}')",[tenantId,personId,branchId]);
      await client.query("INSERT INTO relay.planning_commands(tenant_id,command_id,request_digest,outcome) VALUES($1,'planning-test','digest','{}')",[tenantId]);
    },true);
    await restricted('different-'+randomUUID(),async client=>{
      for(const table of ['technician_planning','planning_commands']){
        assert.equal((await client.query('SELECT 1 FROM relay.'+table)).rowCount,0);
      }
    });
    await assert.rejects(()=>restricted('different-'+randomUUID(),client=>client.query(
      "INSERT INTO relay.technician_planning(tenant_id,person_id,branch_id,version,profile) VALUES($1,$2,$3,2,'{}')",
      [tenantId,personId,branchId])),/row-level security/);
    await assert.rejects(()=>restricted(tenantId,client=>client.query(
      "UPDATE relay.planning_commands SET request_digest='changed'")),/permission denied|append-only/);
  });

});

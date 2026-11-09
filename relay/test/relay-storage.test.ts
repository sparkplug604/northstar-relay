import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import type { RelayCommand, RelayCommitment } from '@northstar/relay-domain';
import { migrateRelay, RelayPostgresStore } from '../packages/relay-storage-postgres/src/index.js';
import { resolveOnCallRecipients } from '../apps/api/src/relay/schedules.js';
import { createWorkOrder, type RelaySourceActor } from '../apps/api/src/relay/work-orders.js';

const databaseUrl = process.env.RELAY_TEST_DATABASE_URL;
describe('Relay PostgreSQL durability and tenant isolation', { skip: !databaseUrl }, () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const store = new RelayPostgresStore(pool);
  const tenantId = `storage-${randomUUID()}`;
  const branchId = randomUUID();
  const personId = randomUUID();
  before(async () => {
    await migrateRelay(pool);
    await pool.query('INSERT INTO relay.organizations(id,name) VALUES($1,$2)', [tenantId, 'Storage integration test']);
    await pool.query('INSERT INTO relay.branches(tenant_id,id,name,timezone) VALUES($1,$2,$3,$4)', [tenantId, branchId, 'Test branch', 'America/Vancouver']);
    await pool.query('INSERT INTO relay.people(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [personId, `${personId}@example.invalid`, 'Test recipient', 'unused']);
    await pool.query("INSERT INTO relay.memberships(tenant_id,person_id,branch_id,role) VALUES($1,$2,$3,'on_call_responder')", [tenantId, personId, branchId]);
    await store.tenantTx(tenantId, async (client) => { await client.query("INSERT INTO relay.contacts(tenant_id,person_id,phone,phone_verified_at) VALUES($1,$2,'+16045550123',clock_timestamp())", [tenantId, personId]); });
  });
  after(async () => pool.end());

  function create(id = randomUUID(), externalId = randomUUID()): Extract<RelayCommand, { type: 'create_commitment' }> {
    const now = Date.now();
    return {
      type: 'create_commitment', commandId: randomUUID(), tenantId, commitmentId: id, branchId, workOrderId: id,
      actorId: 'integration-worker', actorRole: 'system', occurredAt: new Date(now).toISOString(), correlationId: randomUUID(),
      activatesAt: new Date(now - 120000).toISOString(), dueAt: new Date(now - 60000).toISOString(),
      workOrder: { externalId, sourceKind: 'manual', sourceMessageId: randomUUID(), customerReference: 'Test store', priority: 'P1', sourceReceivedAt: new Date(now - 120000).toISOString() },
      recipients: [{ recipientId: personId, personId, displayName: 'Test recipient', contactMethodId: `contact:${personId}` }],
      policy: { policyId: 'test', version: 1, name: 'Test policy', steps: [{ stepId: 'first', offsetSeconds: 0, recipientIds: [personId], channels: ['voice'], terminal: true }] },
    };
  }
  async function active(command = create()): Promise<RelayCommitment> {
    const created = await store.applyCommand(command); assert.equal(created.status, 'accepted'); assert.ok(created.state);
    const result = await store.applyCommand({ ...command, type: 'activate_commitment', expectedVersion: created.state.version, expectedDueAt: created.state.dueAt, expectedActivatesAt: created.state.activatesAt, commandId: randomUUID() });
    assert.equal(result.status, 'accepted'); assert.ok(result.state); return result.state;
  }
  it('stores the exact original outcome and rejects changed intent using the same key', async () => {
    const command = create();
    const first = await store.applyCommand(command, 'intent-a');
    const replay = await store.applyCommand({ ...command, occurredAt: '2000-01-01T00:00:00Z' }, 'intent-a');
    assert.deepEqual(replay, first);
    await assert.rejects(() => store.applyCommand(command, 'intent-b'), /different input/);
    const anotherConnection = new RelayPostgresStore(new Pool({ connectionString: databaseUrl }));
    assert.deepEqual(await anotherConnection.getCommitment(tenantId, command.commitmentId), first.state);
    await anotherConnection.close();
  });
  it('persists both breach and ownership events under one late acknowledgement command', async () => {
    let state = await active();
    const scheduled = await store.applyCommand({ type: 'schedule_escalation_step', commandId: randomUUID(), tenantId, commitmentId: state.commitmentId, actorId: 'worker', actorRole: 'system', occurredAt: await store.now(), correlationId: randomUUID(), expectedVersion: state.version, expectedStepIndex: state.nextStepIndex, expectedScheduledAt: state.nextEscalationAt! });
    assert.equal(scheduled.status, 'accepted'); assert.ok(scheduled.state); state = scheduled.state;
    const attemptId = await store.tenantTx(tenantId, async (client) => (await client.query('SELECT attempt_id FROM relay.attempts WHERE tenant_id=$1 AND commitment_id=$2', [tenantId, state.commitmentId])).rows[0].attempt_id as string);
    const key = randomUUID();
    const acknowledged = await store.applyCommand({ type: 'acknowledge_commitment', commandId: key, tenantId, commitmentId: state.commitmentId, actorId: personId, actorRole: 'on_call_responder', occurredAt: '2000-01-01T00:00:00Z', correlationId: key, ownerRecipientId: personId, mechanism: 'web', attemptId });
    assert.equal(acknowledged.status, 'accepted'); assert.ok(acknowledged.state?.breachedAt);
    assert.equal(acknowledged.events.length, 2);
    assert.equal(acknowledged.state.ownerRecipientId, personId);
    const rows = await store.tenantTx(tenantId, async (client) => (await client.query('SELECT * FROM relay.events WHERE tenant_id=$1 AND command_id=$2', [tenantId, key])).rows);
    assert.equal(rows.length, 2);
  });
  it('enforces source work-order uniqueness when two creates race', async () => {
    const externalId = randomUUID();
    const results = await Promise.allSettled([store.applyCommand(create(randomUUID(), externalId)), store.applyCommand(create(randomUUID(), externalId))]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  });
  it('enforces tenant filtering under the restricted runtime role', async () => {
    const command = create(); await store.applyCommand(command);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE relay_runtime');
      await client.query("SELECT set_config('relay.tenant_id',$1,true)", [`different-${randomUUID()}`]);
      const rows = await client.query('SELECT commitment_id FROM relay.commitments WHERE commitment_id=$1', [command.commitmentId]);
      assert.equal(rows.rowCount, 0);
      await assert.rejects(() => client.query('INSERT INTO relay.audit(tenant_id,actor_id,action) VALUES($1,$2,$3)', [tenantId, personId, 'forbidden']), /row-level security/);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('blocks a restored tenant once cancellation is tombstoned', async () => {
    const cancelledTenant = `cancelled-${randomUUID()}`;
    await pool.query("INSERT INTO relay.deletion_tombstones(tenant_id,cancelled_at,backup_delete_by) VALUES($1,clock_timestamp(),clock_timestamp()+interval '1 day')", [cancelledTenant]);
    await assert.rejects(() => store.tenantTx(cancelledTenant, async () => true), /no longer active/);
  });
  it('resolves branch-local weekly windows across DST and gives dated overrides precedence', async () => {
    const ruleId = randomUUID(); const overrideId = randomUUID();
    await store.tenantTx(tenantId, async (client) => {
      await client.query("INSERT INTO relay.weekly_on_call_rules(tenant_id,branch_id,id,weekday,start_time,end_time,recipient_ids) VALUES($1,$2,$3,0,'01:00','02:00',$4)", [tenantId, branchId, ruleId, JSON.stringify([personId])]);
      const firstHour = await resolveOnCallRecipients(client, tenantId, branchId, [], '2026-11-01T08:30:00Z');
      const repeatedHour = await resolveOnCallRecipients(client, tenantId, branchId, [], '2026-11-01T09:30:00Z');
      assert.equal(firstHour.routingSource, `weekly:${ruleId}`); assert.equal(repeatedHour.routingSource, `weekly:${ruleId}`);
      await client.query('INSERT INTO relay.on_call_overrides(tenant_id,branch_id,id,starts_at,ends_at,recipient_ids,reason) VALUES($1,$2,$3,$4,$5,$6,$7)', [tenantId, branchId, overrideId, '2026-11-01T09:00:00Z', '2026-11-01T10:00:00Z', JSON.stringify([personId]), 'DST test override']);
      assert.equal((await resolveOnCallRecipients(client, tenantId, branchId, [], '2026-11-01T09:30:00Z')).routingSource, `override:${overrideId}`);
      assert.equal((await resolveOnCallRecipients(client, tenantId, branchId, [personId], '2026-11-01T11:00:00Z')).routingSource, 'fallback');
    });
  });
  it('attributes overdue automated intake to its source and atomically persists the immediate fallback attempts', async () => {
    const connectionId = randomUUID();
    const actor: RelaySourceActor = { kind: 'source_connection', tenantId, branchId, connectionId };
    await store.tenantTx(tenantId, async (client) => {
      await client.query('INSERT INTO relay.settings(tenant_id,branch_id,recipient_ids) VALUES($1,$2,$3)', [tenantId, branchId, JSON.stringify([personId])]);
      await client.query('INSERT INTO relay.source_connections(tenant_id,branch_id,id,name,token_hash) VALUES($1,$2,$3,$4,$5)', [tenantId, branchId, connectionId, 'Test email source', randomUUID()]);
    });
    const now = Date.now(); const key = randomUUID();
    const input = { branchId, externalId: randomUUID(), customerReference: 'Late source test', priority: 'P1', dueAt: new Date(now - 1800000).toISOString(), sourceReceivedAt: new Date(now - 600000).toISOString(), sourceKind: 'email' as const, sourceMessageId: randomUUID() };
    const result = await createWorkOrder(store, actor, input, key);
    assert.equal(result.commitment.status, 'breached'); assert.equal(result.commitment.ownerRecipientId, null);
    assert.equal(result.commitment.dueAt, input.dueAt);
    assert.equal(result.commitment.workOrder.sourceReceivedAt, input.sourceReceivedAt);
    assert.deepEqual(result.commitment.scheduledStepIndexes, [0]);
    const persisted = await store.tenantTx(tenantId, async (client) => ({
      events: (await client.query('SELECT envelope FROM relay.events WHERE tenant_id=$1 AND commitment_id=$2 ORDER BY aggregate_version', [tenantId, result.commitment.commitmentId])).rows,
      attempts: (await client.query('SELECT status,person_id FROM relay.attempts WHERE tenant_id=$1 AND commitment_id=$2', [tenantId, result.commitment.commitmentId])).rows,
      audit: (await client.query('SELECT actor_id FROM relay.audit WHERE tenant_id=$1 AND details->>\'commandId\'=$2', [tenantId, key])).rows,
    }));
    assert.equal(persisted.events.length, 4); assert.equal(persisted.attempts[0]?.status, 'pending');
    assert.ok(persisted.events.every((row) => row.envelope.actorId === `source:${connectionId}` && row.envelope.actorRole === 'system'));
    assert.equal(persisted.audit[0]?.actor_id, `source:${connectionId}`);
    assert.deepEqual(await createWorkOrder(store, actor, input, key), result);
    const originalApply = store.applyCommand.bind(store);
    store.applyCommand = async (...args) => {
      await store.tenantTx(tenantId, async (client) => { await client.query('UPDATE relay.source_connections SET active=false WHERE tenant_id=$1 AND id=$2', [tenantId, connectionId]); });
      return originalApply(...args);
    };
    try {
      await assert.rejects(() => createWorkOrder(store, actor, { ...input, externalId: randomUUID() }, randomUUID()), /inactive or does not belong/);
    } finally { store.applyCommand = originalApply; }
    await assert.rejects(() => createWorkOrder(store, actor, input, key), /inactive or does not belong/);
  });
});

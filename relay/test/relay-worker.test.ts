import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RelayEngine } from "../apps/worker/src/relay-engine.js";
import { actionTokenHash, DefiniteDeliveryFailure, RelaySimulatedProvider, type RelayDelivery, type RelayProvider } from "../packages/relay-adapters/src/twilio.js";
import { createRelayStore, type RelayPostgresStore } from "../packages/relay-storage-postgres/src/store.js";
import { migrateRelay } from "../packages/relay-storage-postgres/src/migrate.js";
import type { RelayCommand, RelayCommitment } from "../packages/relay-domain/src/index.js";

function requireAccepted(result: Awaited<ReturnType<RelayPostgresStore["applyCommand"]>>): RelayCommitment {
  assert.equal(result.status, "accepted");
  return result.state!;
}

async function fixture(store: RelayPostgresStore, stepCount = 1, overdue = false) {
  const tenantId = `worker-${randomUUID()}`;
  const branchId = "main";
  const commitmentId = randomUUID();
  const personIds = [randomUUID(), randomUUID()];
  await store.pool.query("INSERT INTO relay.organizations(id,name) VALUES($1,'Worker test')", [tenantId]);
  await store.pool.query("INSERT INTO relay.branches(tenant_id,id,name,timezone) VALUES($1,$2,'Test branch','America/Vancouver')", [tenantId, branchId]);
  for (const [index, personId] of personIds.entries()) {
    await store.pool.query("INSERT INTO relay.people(id,email,display_name,password_hash) VALUES($1,$2,$3,'test-only-no-login')", [personId, `${personId}@example.invalid`, `Test ${index}`]);
    await store.pool.query("INSERT INTO relay.memberships(tenant_id,person_id,branch_id,role) VALUES($1,$2,$3,'on_call_responder')", [tenantId, personId, branchId]);
    await store.tenantTx(tenantId, client => client.query("INSERT INTO relay.contacts(tenant_id,person_id,phone,phone_verified_at) VALUES($1,$2,$3,clock_timestamp())", [tenantId, personId, `+1604555010${index}`]));
  }
  const now = Date.parse(await store.now());
  const activatesAt = new Date(now - 5_000).toISOString();
  const dueAt = new Date(now + (overdue ? -1_000 : 600_000)).toISOString();
  const metadata = (commandId: string) => ({ commandId, tenantId, commitmentId, actorId: "test-worker", actorRole: "system" as const, occurredAt: new Date().toISOString(), correlationId: "worker-test" });
  const command: RelayCommand = {
    ...metadata(`create-${commitmentId}`), type: "create_commitment", branchId, workOrderId: randomUUID(), activatesAt, dueAt,
    workOrder: { externalId: commitmentId, sourceKind: "manual", sourceMessageId: randomUUID(), customerReference: "fixture", priority: "emergency", sourceReceivedAt: activatesAt },
    recipients: personIds.map((personId, index) => ({ recipientId: `recipient-${index}`, personId, displayName: `Test ${index}`, contactMethodId: personId })),
    policy: { policyId: "test-policy", version: 1, name: "Worker test", steps: Array.from({ length: stepCount }, (_, index) => ({ stepId: `step-${index}`, offsetSeconds: index, recipientIds: [`recipient-${index}`], channels: ["voice" as const], terminal: index === stepCount - 1 })) },
  };
  await store.applyCommand(command);
  return { tenantId, branchId, commitmentId, personIds, metadata };
}

async function pendingAttempt(store: RelayPostgresStore, item: Awaited<ReturnType<typeof fixture>>) {
  let state = (await store.getCommitment(item.tenantId, item.commitmentId))!;
  state = requireAccepted(await store.applyCommand({ ...item.metadata(`activate-${randomUUID()}`), type: "activate_commitment", expectedVersion: state.version, expectedDueAt: state.dueAt, expectedActivatesAt: state.activatesAt }));
  await store.applyCommand({ ...item.metadata(`step-${randomUUID()}`), type: "schedule_escalation_step", expectedVersion: state.version, expectedStepIndex: state.nextStepIndex, expectedScheduledAt: state.nextEscalationAt! });
  return store.tenantTx(item.tenantId, async client => (await client.query("SELECT * FROM relay.attempts WHERE tenant_id=$1 AND commitment_id=$2", [item.tenantId, item.commitmentId])).rows[0]!);
}

async function attempts(store: RelayPostgresStore, item: Awaited<ReturnType<typeof fixture>>) {
  return store.tenantTx(item.tenantId, async client => (await client.query("SELECT * FROM relay.attempts WHERE tenant_id=$1 AND commitment_id=$2 ORDER BY step_index", [item.tenantId, item.commitmentId])).rows);
}

test("Relay worker rejects invalid lease/retry configuration without contacting a provider", () => {
  const store = {} as RelayPostgresStore;
  const provider = new RelaySimulatedProvider();
  assert.throws(() => new RelayEngine(store, provider, { retryLimit: 0 }));
  assert.throws(() => new RelayEngine(store, provider, { leaseSeconds: 1, sendTimeoutMilliseconds: 1000 }));
  assert.equal(provider.sent.length, 0);
});

const databaseUrl = process.env.RELAY_TEST_DATABASE_URL;
test("Relay worker PostgreSQL recovery and dispatch", { skip: !databaseUrl }, async t => {
  const store = createRelayStore(databaseUrl!);
  t.after(() => store.close());
  await migrateRelay(store.pool);

  await t.test("activation, ordered due steps and breach survive delayed processing", async () => {
    const item = await fixture(store, 2, true);
    const provider = new RelaySimulatedProvider();
    const engine = new RelayEngine(store, provider, { tenantIds: [item.tenantId] });
    await engine.runCycle();
    const state = (await store.getCommitment(item.tenantId, item.commitmentId))!;
    assert.equal(state.status, "breached");
    assert.deepEqual(state.scheduledStepIndexes, [0, 1]);
    const events = await store.tenantTx(item.tenantId, async client => (await client.query("SELECT event_type FROM relay.events WHERE tenant_id=$1 AND commitment_id=$2 ORDER BY aggregate_version", [item.tenantId, item.commitmentId])).rows);
    assert.deepEqual(events.map(row => row.event_type), ["commitment_created", "commitment_activated", "escalation_step_scheduled", "escalation_step_scheduled", "commitment_breached"]);
    const rows = await attempts(store, item);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.status === "submitted"));
    for (const row of rows) {
      const delivery = provider.sent.find(sent => sent.attemptId === row.attempt_id)!;
      assert.equal(row.acknowledgement_token_hash, actionTokenHash(delivery.actionToken));
      assert.ok(row.acknowledgement_expires_at instanceof Date);
      assert.ok(!JSON.stringify(row).includes(delivery.actionToken));
    }
    const count = provider.sent.length;
    await engine.runCycle();
    assert.equal(provider.sent.length, count);
  });

  await t.test("expired leased work is reclaimed; expired sending is uncertain and never blindly retried", async () => {
    const safe = await fixture(store);
    const uncertain = await fixture(store);
    await pendingAttempt(store, safe);
    await pendingAttempt(store, uncertain);
    await store.tenantTx(safe.tenantId, client => client.query("UPDATE relay.attempts SET status='leased',lease_token='old-lease',lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [safe.tenantId]));
    await store.tenantTx(uncertain.tenantId, client => client.query("UPDATE relay.attempts SET status='sending',attempts=1,lease_token='lost-sender',lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [uncertain.tenantId]));
    const provider = new RelaySimulatedProvider();
    const engine = new RelayEngine(store, provider, { tenantIds: [safe.tenantId, uncertain.tenantId] });
    await engine.runCycle();
    assert.equal((await attempts(store, safe))[0]!.status, "submitted");
    assert.equal((await attempts(store, uncertain))[0]!.status, "uncertain");
    await engine.runCycle();
    assert.equal(provider.sent.filter(delivery => delivery.attemptId === (provider.sent[0]?.attemptId)).length, 1);
  });

  await t.test("overlapping cycles on one engine are skipped", async () => {
    const item = await fixture(store);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider: RelayProvider = { async send(delivery) { entered(); await gate; return { reference: `overlap:${delivery.attemptId}`, simulated: true }; } };
    const engine = new RelayEngine(store, provider, { tenantIds: [item.tenantId] });
    const first = engine.runCycle();
    await started;
    assert.equal((await engine.runCycle()).skippedOverlap, true);
    release();
    await first;
    assert.equal((await attempts(store, item))[0]!.attempts, 1);
  });

  await t.test("a bounded batch serves tenants round-robin and rechecks timers between sends", async () => {
    const first = await fixture(store, 2);
    const second = await fixture(store, 2);
    const provider = new RelaySimulatedProvider();
    const engine = new RelayEngine(store, provider, { tenantIds: [first.tenantId, second.tenantId], batchSize: 2 });
    const result = await engine.runCycle();
    assert.equal(result.attemptsClaimed, 2);
    assert.equal((await attempts(store, first)).filter(row => row.status === 'submitted').length, 1);
    assert.equal((await attempts(store, second)).filter(row => row.status === 'submitted').length, 1);
    await engine.runCycle();
    assert.equal((await attempts(store, first)).filter(row => row.status === 'submitted').length, 2);
    assert.equal((await attempts(store, second)).filter(row => row.status === 'submitted').length, 2);
  });

  await t.test("fast web ownership does not discard the eventual provider reference", async () => {
    const item = await fixture(store);
    const reference = `fast-ack:${randomUUID()}`;
    const provider: RelayProvider = { async send(delivery) {
      await store.applyCommand({ ...item.metadata(randomUUID()), actorId: item.personIds[0]!, actorRole: 'on_call_responder', type: 'acknowledge_commitment', ownerRecipientId: 'recipient-0', mechanism: 'web', attemptId: delivery.attemptId });
      return {reference, simulated:true};
    } };
    await new RelayEngine(store, provider, { tenantIds: [item.tenantId] }).runCycle();
    const row = (await attempts(store,item))[0]!;
    assert.equal(row.status,'acknowledged');
    assert.equal(row.provider_reference,reference);
  });

  await t.test("two independent worker engines submit each attempt once", async () => {
    const item = await fixture(store);
    const provider = new RelaySimulatedProvider();
    await Promise.all([new RelayEngine(store, provider, { tenantIds: [item.tenantId] }).runCycle(), new RelayEngine(store, provider, { tenantIds: [item.tenantId] }).runCycle()]);
    const row = (await attempts(store, item))[0]!;
    assert.equal(provider.sent.filter(delivery => delivery.attemptId === row.attempt_id).length, 1);
    assert.equal(row.attempts, 1);
  });

  await t.test("acknowledgement cancels an existing lease before submission", async () => {
    const item = await fixture(store);
    const attempt = await pendingAttempt(store, item);
    await store.tenantTx(item.tenantId, client => client.query("UPDATE relay.attempts SET status='leased',lease_token='waiting',lease_expires_at=clock_timestamp()+interval '1 second' WHERE tenant_id=$1", [item.tenantId]));
    await store.applyCommand({ ...item.metadata("owner"), actorRole: "on_call_responder", actorId: item.personIds[0]!, type: "acknowledge_commitment", ownerRecipientId: "recipient-0", mechanism: "web", attemptId: attempt.attempt_id as string });
    const provider = new RelaySimulatedProvider();
    await new RelayEngine(store, provider, { tenantIds: [item.tenantId] }).runCycle();
    assert.equal((await attempts(store, item))[0]!.status, "acknowledged");
    assert.equal(provider.sent.length, 0);
  });

  await t.test("changed or unverified phone suppresses queued delivery", async () => {
    const item = await fixture(store);
    const attempt = await pendingAttempt(store, item);
    await store.tenantTx(item.tenantId, client => client.query("UPDATE relay.contacts SET phone='+16045550999',phone_verified_at=NULL WHERE tenant_id=$1", [item.tenantId]));
    const provider = new RelaySimulatedProvider();
    await new RelayEngine(store, provider, { tenantIds: [item.tenantId] }).runCycle();
    assert.equal((await attempts(store, item))[0]!.status, "cancelled");
    assert.ok(!provider.sent.some(delivery => delivery.attemptId === attempt.attempt_id));
  });

  await t.test("uncertain primary submission does not stop the independent fallback step", async () => {
    const item = await fixture(store, 2);
    const sent: RelayDelivery[] = [];
    const provider: RelayProvider = { async send(delivery) { sent.push(delivery); if (delivery.destination.endsWith("00")) throw new Error("transport disconnected after possible submission"); return { reference: `fallback:${delivery.attemptId}`, simulated: true }; } };
    await new RelayEngine(store, provider, { tenantIds: [item.tenantId] }).runCycle();
    assert.deepEqual((await attempts(store, item)).map(row => row.status), ["uncertain", "submitted"]);
    assert.equal(sent.length, 2);
  });

  await t.test("definite failures retry only to the configured bound", async () => {
    const item = await fixture(store);
    let sends = 0;
    const provider: RelayProvider = { async send() { sends += 1; throw new DefiniteDeliveryFailure("provider_rejected_429"); } };
    const engine = new RelayEngine(store, provider, { retryLimit: 2, tenantIds: [item.tenantId] });
    await engine.runCycle();
    assert.equal((await attempts(store, item))[0]!.status, "failed");
    await store.tenantTx(item.tenantId, client => client.query("UPDATE relay.attempts SET available_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [item.tenantId]));
    await engine.runCycle();
    assert.equal((await attempts(store, item))[0]!.status, "exhausted");
    await engine.runCycle();
    assert.equal(sends, 2);
  });

  await t.test("provider timeout becomes uncertain without a second submission", async () => {
    const item = await fixture(store);
    let sends = 0;
    const provider: RelayProvider = { send() { sends += 1; return new Promise(() => {}); } };
    const engine = new RelayEngine(store, provider, { sendTimeoutMilliseconds: 20, tenantIds: [item.tenantId] });
    await engine.runCycle();
    assert.equal((await attempts(store, item))[0]!.status, "uncertain");
    await engine.runCycle();
    assert.equal(sends, 1);
  });

  await t.test("a late sender cannot overwrite a recovered sending lease", async () => {
    const item = await fixture(store);
    const recoverProvider = new RelaySimulatedProvider();
    const recovery = new RelayEngine(store, recoverProvider, { tenantIds: [item.tenantId] });
    const provider: RelayProvider = { async send(delivery) {
      await store.tenantTx(item.tenantId, client => client.query("UPDATE relay.attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND attempt_id=$2", [item.tenantId, delivery.attemptId]));
      await recovery.runCycle();
      return { reference: `late:${delivery.attemptId}`, simulated: true };
    } };
    const result = await new RelayEngine(store, provider, { tenantIds: [item.tenantId] }).runCycle();
    const row = (await attempts(store, item))[0]!;
    assert.equal(row.status, "uncertain");
    assert.equal(row.provider_reference, null);
    assert.equal(row.lease_token, null);
    assert.equal(result.notificationsSent, 0);
    assert.equal(recoverProvider.sent.length, 0);
  });
});

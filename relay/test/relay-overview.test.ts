import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { buildRelayApp } from '../apps/api/src/relay/app.js';
import { sha256, type RelayUserRole } from '../apps/api/src/relay/auth.js';
import { migrateRelay, RelayPostgresStore } from '../packages/relay-storage-postgres/src/index.js';

const sourceUrl = process.env.RELAY_TEST_DATABASE_URL;
const base = '/api/relay/v1';
const origin = 'http://127.0.0.1:4310';
type Actor = { id: string; headers: Record<string, string> };
type QueueResult = { items: { commitment: { commitmentId: string; tenantId: string; branchId: string; status: string; ownerRecipientId: string | null; workOrder: { externalId: string } }; note: string }[]; hasMore: boolean };
type Seed = { id: string; tenantId?: string; branchId?: string; status?: string; recipients?: string[]; owner?: string; overdue?: boolean; externalId?: string; customer?: string };

describe('Relay role-scoped overview and paginated queues with PostgreSQL', { skip: !sourceUrl }, () => {
  const dbName = `relay_overview_${randomBytes(6).toString('hex')}`;
  const connectionUrl = sourceUrl ? new URL(sourceUrl) : new URL('postgres://localhost/unused');
  connectionUrl.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: connectionUrl.toString() });
  const store = new RelayPostgresStore(pool);
  const tenantId = 'overview-tenant-a', otherTenant = 'overview-tenant-b';
  const branchId = 'branch-a', secondBranch = 'branch-b', foreignBranch = 'branch-foreign';
  let app: FastifyInstance;
  let admin: Actor, dispatcher: Actor, responder: Actor, peer: Actor, remote: Actor, foreignAdmin: Actor;

  async function actor(role: RelayUserRole, tenant = tenantId, branch = branchId, unverified = false, active = true): Promise<Actor> {
    const id = randomUUID(), token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
    await pool.query("INSERT INTO relay.people(id,email,display_name,password_hash,totp_confirmed,active) VALUES($1,$2,$3,'test-no-password-login',true,$4)", [id, `${id}@example.invalid`, role, active]);
    await pool.query('INSERT INTO relay.memberships(tenant_id,person_id,branch_id,role) VALUES($1,$2,$3,$4)', [tenant, id, branch, role]);
    await store.tenantTx(tenant, client => client.query("INSERT INTO relay.contacts(tenant_id,person_id,phone,phone_verified_at) VALUES($1,$2,$3,CASE WHEN $4 THEN NULL ELSE clock_timestamp() END)", [tenant, id, unverified ? null : '+16045550100', unverified]));
    await pool.query("INSERT INTO relay.sessions(token_hash,person_id,csrf_token,mfa_verified,expires_at) VALUES($1,$2,$3,true,clock_timestamp()+interval '1 hour')", [sha256(token), id, csrf]);
    return { id, headers: { origin, cookie: `northstar_relay_session=${token}`, 'x-csrf-token': csrf } };
  }

  async function seed(input: Seed) {
    const tenant = input.tenantId ?? tenantId, branch = input.branchId ?? branchId;
    const status = input.status ?? 'active';
    const createdAt = '2026-01-01T00:00:00.000Z';
    const dueAt = new Date(Date.now() + (input.overdue ? -86_400_000 : 86_400_000)).toISOString();
    const snapshot = {
      tenantId: tenant, commitmentId: input.id, workOrderId: input.id, branchId: branch, status, version: 1,
      createdAt, dueAt, acknowledgedAt: input.owner ? createdAt : null, breachedAt: status === 'breached' ? createdAt : null,
      ownerRecipientId: input.owner ?? null, nextEscalationAt: null, declinedRecipientIds: [],
      recipients: (input.recipients ?? [responder.id]).map(id => ({ recipientId: id, personId: id, displayName: 'Synthetic contact' })),
      workOrder: { externalId: input.externalId ?? input.id, customerReference: input.customer ?? 'Synthetic grocery', priority: 'normal', sourceKind: 'manual' },
      sourceAcceptance: { status: 'unknown', recordedAt: null, recordedBy: null },
    };
    await store.tenantTx(tenant, client => client.query(`INSERT INTO relay.commitments(tenant_id,branch_id,commitment_id,work_order_id,external_id,source_kind,source_message_id,status,version,snapshot,note,created_at)
      VALUES($1,$2,$3,$3,$4,'manual',$3,$5,1,$6,$7,$8)`, [tenant, branch, input.id, snapshot.workOrder.externalId, status, JSON.stringify(snapshot), `Note for ${input.id}`, createdAt]));
  }

  async function queue(who: Actor, query = 'view=open'): Promise<QueueResult> {
    const response = await app.inject({ method: 'GET', url: `${base}/work-orders?${query}`, headers: who.headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    return response.json();
  }
  const ids = (result: QueueResult) => result.items.map(item => item.commitment.commitmentId);

  before(async () => {
    const databaseAdmin = new Pool({ connectionString: sourceUrl, max: 1 });
    try { await databaseAdmin.query(`CREATE DATABASE "${dbName}"`); } finally { await databaseAdmin.end(); }
    await migrateRelay(pool);
    app = await buildRelayApp({ store, publicOrigin: origin, secureCookies: false, setupToken: undefined, authEncryptionKey: randomBytes(32).toString('base64') });
    await pool.query("INSERT INTO relay.organizations(id,name) VALUES($1,'Overview tenant A'),($2,'Overview tenant B')", [tenantId, otherTenant]);
    await pool.query("INSERT INTO relay.branches(tenant_id,id,name,timezone) VALUES($1,$2,'Branch A','America/Vancouver'),($1,$3,'Branch B','America/Toronto'),($4,$5,'Foreign branch','America/Vancouver')", [tenantId, branchId, secondBranch, otherTenant, foreignBranch]);
    admin = await actor('organization_admin');
    dispatcher = await actor('branch_dispatcher');
    responder = await actor('on_call_responder', tenantId, branchId, true);
    peer = await actor('on_call_responder');
    remote = await actor('on_call_responder', tenantId, secondBranch, true);
    foreignAdmin = await actor('organization_admin', otherTenant, foreignBranch, true);
    await actor('on_call_responder', tenantId, branchId, true, false);
    await store.tenantTx(tenantId, async client => {
      await client.query("INSERT INTO relay.settings(tenant_id,branch_id,recipient_ids) VALUES($1,$2,$3),($1,$4,'[]')", [tenantId, branchId, JSON.stringify([responder.id]), secondBranch]);
      await client.query(`INSERT INTO relay.intake(tenant_id,branch_id,id,connection_id,receipt_id,content_hash,candidate,status,raw_encrypted)
        VALUES($1,$2,'review-a','source-a','receipt-a','hash-a','{}','needs_review','synthetic'),
        ($1,$3,'review-b','source-b','receipt-b','hash-b','{}','needs_review','synthetic'),
        ($1,$2,'parsed-a','source-a','receipt-c','hash-c','{}','parsed','synthetic')`, [tenantId, branchId, secondBranch]);
    });
    await store.tenantTx(otherTenant, async client => {
      await client.query("INSERT INTO relay.settings(tenant_id,branch_id,recipient_ids) VALUES($1,$2,'[]')", [otherTenant, foreignBranch]);
      await client.query("INSERT INTO relay.intake(tenant_id,branch_id,id,connection_id,receipt_id,content_hash,candidate,status,raw_encrypted) VALUES($1,$2,'foreign-review','source','receipt','hash','{}','needs_review','synthetic')", [otherTenant, foreignBranch]);
    });
    await seed({ id: 'assigned-future', externalId: 'ORDER-100%_A', customer: 'Café Freezer' });
    await seed({ id: 'unowned-overdue', overdue: true, externalId: 'ORDER-100XXA' });
    await seed({ id: 'late-owned', status: 'breached', owner: responder.id, overdue: true });
    await seed({ id: 'dispatch-owned', status: 'owned', owner: dispatcher.id, recipients: [responder.id, dispatcher.id] });
    await seed({ id: 'other-assignment', recipients: [peer.id] });
    // Includes the local person in another branch to prove branch scope wins.
    await seed({ id: 'branch-b-overdue', branchId: secondBranch, recipients: [remote.id, responder.id], overdue: true });
    await seed({ id: 'foreign-open', tenantId: otherTenant, branchId: foreignBranch, recipients: [foreignAdmin.id, responder.id], overdue: true });
    for (let index = 0; index < 205; index++) await seed({ id: `history-${String(index).padStart(3, '0')}`, status: 'closed' });
    await seed({ id: 'handoff-done', status: 'fulfilled', owner: responder.id });
    await seed({ id: 'withdrawn', status: 'cancelled', recipients: [peer.id] });
    await seed({ id: 'branch-b-closed', branchId: secondBranch, status: 'closed', recipients: [remote.id, responder.id] });
    await seed({ id: 'foreign-closed', tenantId: otherTenant, branchId: foreignBranch, status: 'closed', recipients: [foreignAdmin.id, responder.id] });
  });
  after(async () => { await app?.close(); await pool.end(); });

  it('requires authentication for overview and both paged views', async () => {
    for (const path of ['/overview', '/work-orders?view=open', '/work-orders?view=history']) {
      const response = await app.inject({ method: 'GET', url: base + path, headers: { 'x-demo-user': responder.id } });
      assert.equal(response.statusCode, 401);
    }
  });

  it('counts complete permitted scope and never counts late ownership as overdue unowned work', async () => {
    const expected = [
      [admin, { open: 6, awaitingOwner: 4, overdue: 2, ownedByMe: 0, review: 2, unverifiedContacts: 2, missingFallback: 1 }],
      [dispatcher, { open: 5, awaitingOwner: 3, overdue: 1, ownedByMe: 1, review: 1, unverifiedContacts: 1, missingFallback: 0 }],
      [responder, { open: 4, awaitingOwner: 2, overdue: 1, ownedByMe: 1, review: 0, unverifiedContacts: 1, missingFallback: 0 }],
      [foreignAdmin, { open: 1, awaitingOwner: 1, overdue: 1, ownedByMe: 0, review: 1, unverifiedContacts: 1, missingFallback: 1 }],
    ] as const;
    for (const [who, counts] of expected) {
      const response = await app.inject({ method: 'GET', url: `${base}/overview`, headers: who.headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().counts, counts);
      assert.ok(Number.isFinite(Date.parse(response.json().asOf)));
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  });

  it('scopes open queues by tenant, administrator branch visibility, and responder assignment', async () => {
    assert.equal((await queue(admin)).items.length, 6);
    assert.equal((await queue(dispatcher)).items.length, 5);
    const assigned = await queue(responder);
    assert.deepEqual(new Set(ids(assigned)), new Set(['assigned-future', 'unowned-overdue', 'late-owned', 'dispatch-owned']));
    assert.ok(assigned.items.every(item => item.commitment.branchId === branchId && item.commitment.tenantId === tenantId));
    assert.deepEqual(ids(await queue(admin, `view=open&branchId=${secondBranch}`)), ['branch-b-overdue']);
    assert.deepEqual(ids(await queue(foreignAdmin)), ['foreign-open']);
  });

  it('paginates terminal history beyond 200 records without duplication or cross-scope records', async () => {
    for (const [who, total] of [[admin, 208], [dispatcher, 207], [responder, 206]] as const) {
      const pages = await Promise.all([0, 100, 200].map(offset => queue(who, `view=history&offset=${offset}`)));
      assert.deepEqual(pages.map(page => page.items.length), [100, 100, total - 200]);
      assert.deepEqual(pages.map(page => page.hasMore), [true, true, false]);
      const combined = pages.flatMap(page => page.items);
      assert.equal(new Set(combined.map(item => item.commitment.commitmentId)).size, total);
      assert.ok(combined.every(item => ['closed', 'fulfilled', 'cancelled'].includes(item.commitment.status)));
      assert.ok(combined.every(item => item.commitment.tenantId === tenantId));
      if (who !== admin) assert.ok(combined.every(item => item.commitment.branchId === branchId));
      assert.deepEqual(ids(await queue(who, 'view=history&offset=100')), ids(pages[1]!));
      assert.deepEqual(await queue(who, 'view=history&offset=1000'), { items: [], hasMore: false });
    }
    assert.deepEqual(ids(await queue(foreignAdmin, 'view=history')), ['foreign-closed']);
  });

  it('filters unowned, overdue and mine independently and searches the full server-side history', async () => {
    assert.deepEqual(new Set(ids(await queue(dispatcher, 'view=open&filter=unowned'))), new Set(['assigned-future', 'unowned-overdue', 'other-assignment']));
    assert.deepEqual(ids(await queue(responder, 'view=open&filter=overdue')), ['unowned-overdue']);
    assert.deepEqual(ids(await queue(responder, 'view=open&filter=mine')), ['late-owned']);
    assert.deepEqual(ids(await queue(dispatcher, 'view=open&filter=mine')), ['dispatch-owned']);
    assert.deepEqual(ids(await queue(admin, `view=open&filter=overdue&branchId=${secondBranch}`)), ['branch-b-overdue']);
    assert.deepEqual(ids(await queue(responder, 'view=history&search=history-204')), ['history-204']);
    assert.deepEqual(ids(await queue(admin, 'view=history&filter=mine')), []);
    assert.deepEqual(ids(await queue(responder, 'view=open&search=no-such-work')), []);
  });

  it('treats search wildcards literally, trims whitespace, and searches customer names case-insensitively', async () => {
    assert.deepEqual(ids(await queue(admin, `view=open&search=${encodeURIComponent('100%_A')}`)), ['assigned-future']);
    assert.deepEqual(ids(await queue(admin, `view=open&search=${encodeURIComponent('  café freezer  ')}`)), ['assigned-future']);
    assert.deepEqual(ids(await queue(responder, 'view=open&search=foreign')), []);
  });

  it('rejects invalid pagination, filter and view parameters', async () => {
    for (const query of ['view=invalid', 'view=', 'view=open&offset=-1', 'view=open&offset=1.5', 'view=open&offset=not-a-number', 'view=open&offset=100001', 'view=open&filter=invalid', 'view=open&branchId=', `view=open&search=${'x'.repeat(201)}`]) {
      const response = await app.inject({ method: 'GET', url: `${base}/work-orders?${query}`, headers: responder.headers });
      assert.equal(response.statusCode, 400, `${query}: ${response.body}`);
      assert.equal(response.json().error, 'invalid_request');
    }
  });

  it('denies explicit cross-branch access and prevents administrator cross-tenant branch leakage', async () => {
    for (const who of [dispatcher, responder]) for (const branch of [secondBranch, foreignBranch]) for (const view of ['open', 'history']) {
      const response = await app.inject({ method: 'GET', url: `${base}/work-orders?view=${view}&branchId=${branch}`, headers: who.headers });
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().error, 'branch_forbidden');
    }
    assert.deepEqual(await queue(admin, `view=open&branchId=${foreignBranch}`), { items: [], hasMore: false });
    assert.deepEqual(await queue(admin, `view=history&branchId=${foreignBranch}`), { items: [], hasMore: false });
  });
});

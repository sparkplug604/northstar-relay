import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import formbody from "@fastify/formbody";
import type { FastifyInstance } from "fastify";
import twilio from "twilio";
import { buildRelayApp } from "../apps/api/src/relay/app.js";
import { sha256 } from "../apps/api/src/relay/auth.js";
import { registerRelayIntegrations } from "../apps/api/src/relay-integrations.js";
import { registerRelayIntake } from "../apps/api/src/relay-intake.js";
import { RelayEngine } from "../apps/worker/src/relay-engine.js";
import { RelaySimulatedProvider, type RelayProvider, type RelayTwilioConfig } from "../packages/relay-adapters/src/index.js";
import { createRelayStore, migrateRelay, type RelayPostgresStore } from "../packages/relay-storage-postgres/src/index.js";

const origin = "https://relay-integration.example.invalid";
const syntheticConfig: RelayTwilioConfig = { accountSid: `AC${"a".repeat(32)}`, authToken: "only-a-synthetic-integration-signing-key", publicOrigin: origin, fromNumber: "+16045550199", allowedNumbers: ["+16045550100"] };
const base = "/api/relay/v1";
type Actor = { id: string; headers: Record<string, string> };
type Fixture = { tenantId: string; branchId: string; admin: Actor; responder: Actor };

async function fixture(store: RelayPostgresStore): Promise<Fixture> {
  const tenantId = `integration-${randomUUID()}`;
  const branchId = randomUUID();
  await store.pool.query("INSERT INTO relay.organizations(id,name) VALUES($1,'Integration fixture')", [tenantId]);
  await store.pool.query("INSERT INTO relay.branches(tenant_id,id,name,timezone) VALUES($1,$2,'Fixture branch','America/Vancouver')", [tenantId, branchId]);
  async function actor(role: "organization_admin" | "on_call_responder"): Promise<Actor> {
    const id = randomUUID(); const session = randomBytes(32).toString("hex"); const csrf = randomBytes(24).toString("hex");
    await store.pool.query("INSERT INTO relay.people(id,email,display_name,password_hash,totp_confirmed) VALUES($1,$2,$3,'fixture-no-password-login',true)", [id, `${id}@example.invalid`, role]);
    await store.pool.query("INSERT INTO relay.memberships(tenant_id,person_id,branch_id,role) VALUES($1,$2,$3,$4)", [tenantId, id, branchId, role]);
    await store.tenantTx(tenantId, client => client.query("INSERT INTO relay.contacts(tenant_id,person_id,phone,phone_verified_at) VALUES($1,$2,'+16045550100',clock_timestamp())", [tenantId, id]));
    await store.pool.query("INSERT INTO relay.sessions(token_hash,person_id,csrf_token,mfa_verified,expires_at) VALUES($1,$2,$3,true,clock_timestamp()+interval '1 hour')", [sha256(session), id, csrf]);
    return { id, headers: { origin, cookie: `northstar_relay_session=${session}`, "x-csrf-token": csrf } };
  }
  const admin = await actor("organization_admin"); const responder = await actor("on_call_responder");
  await store.tenantTx(tenantId, client => client.query("INSERT INTO relay.settings(tenant_id,branch_id,recipient_ids,interval_seconds,channels) VALUES($1,$2,$3,15,'[\"voice\"]')", [tenantId, branchId, JSON.stringify([responder.id])]));
  return { tenantId, branchId, admin, responder };
}

async function dispatched(app: FastifyInstance, store: RelayPostgresStore, item: Fixture, channel: "voice" | "sms" = "voice") {
  await store.tenantTx(item.tenantId, client => client.query("UPDATE relay.settings SET channels=$2 WHERE tenant_id=$1", [item.tenantId, JSON.stringify([channel])]));
  const response = await app.inject({ method: "POST", url: `${base}/work-orders`, headers: { ...item.admin.headers, "idempotency-key": randomUUID() }, payload: { branchId: item.branchId, externalId: randomUUID(), customerReference: "PRIVATE CUSTOMER", priority: "emergency", dueAt: new Date(Date.now() + 600_000).toISOString(), note: "PRIVATE SITE ADDRESS" } });
  assert.equal(response.statusCode, 201, response.body);
  const commitmentId = response.json().commitment.commitmentId as string;
  const provider = new RelaySimulatedProvider();
  await new RelayEngine(store, provider, { tenantIds: [item.tenantId] }).runCycle();
  const attempt = await store.tenantTx(item.tenantId, async client => (await client.query("SELECT * FROM relay.attempts WHERE tenant_id=$1 AND commitment_id=$2", [item.tenantId, commitmentId])).rows[0]!);
  const token = provider.sent.find(sent => sent.attemptId === attempt.attempt_id)!.actionToken;
  return { commitmentId, attemptId: String(attempt.attempt_id), token, phone: String(attempt.phone), channel };
}

async function sending(store: RelayPostgresStore, item: Fixture, attemptId: string) {
  await store.tenantTx(item.tenantId, client => client.query("UPDATE relay.attempts SET status='sending',provider_reference=NULL,lease_token='fixture-sending',lease_expires_at=clock_timestamp()+interval '1 minute' WHERE tenant_id=$1 AND attempt_id=$2", [item.tenantId, attemptId]));
}

function callback(app: FastifyInstance, path: string, fields: Record<string, string>, invalidSignature = false) {
  const signature = twilio.getExpectedTwilioSignature(syntheticConfig.authToken, origin + path, fields);
  return app.inject({ method: "POST", url: path, headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": invalidSignature ? "invalid" : signature }, payload: new URLSearchParams(fields).toString() });
}

function mail(externalId: string, recognized = true): string {
  return `From: dispatch@example.invalid\r\nTo: relay@example.invalid\r\nMessage-ID: <${externalId}@example.invalid>\r\n${recognized ? "X-Northstar-Template: relay-v1\r\n" : ""}Content-Type: text/plain\r\n\r\nWork-Order: ${externalId}\r\nCustomer: Test grocery\r\nPriority: Emergency\r\nDue-At: ${new Date(Date.now() + 600_000).toISOString()}\r\nSource-Received-At: ${new Date(Date.now() - 1_000).toISOString()}\r\nNote: Private intake details`;
}

const databaseUrl = process.env.RELAY_TEST_DATABASE_URL;
test("Relay capability, provider and intake integrations", { skip: !databaseUrl, concurrency: 1 }, async t => {
  const store = createRelayStore(databaseUrl!);
  t.after(() => store.close());
  await migrateRelay(store.pool);
  const authEncryptionKey = randomBytes(32).toString("base64");
  const config = { store, publicOrigin: origin, authEncryptionKey, secureCookies: false, localDevelopment: true, twilio: null, twilioConfig: syntheticConfig };
  const app = await buildRelayApp({ ...config, setupToken: undefined, providerMode: "simulated" });
  t.after(() => app.close());
  await app.register(formbody);
  await registerRelayIntegrations(app, config);
  await registerRelayIntake(app, config);
  await app.ready();

  await t.test("verification persists only a hash, locks after five wrong codes, and permits correct code once", async () => {
    const item = await fixture(store);
    await store.tenantTx(item.tenantId, client => client.query("UPDATE relay.contacts SET phone_verified_at=NULL WHERE tenant_id=$1", [item.tenantId]));
    const url = `${base}/people/${item.responder.id}/verification`;
    const start = await app.inject({ method: "POST", url: `${url}/start`, headers: item.responder.headers });
    assert.equal(start.statusCode, 200, start.body);
    const correct = start.json().developmentCode as string;
    const stored = await store.tenantTx(item.tenantId, async client => (await client.query("SELECT * FROM relay.contacts WHERE tenant_id=$1 AND person_id=$2", [item.tenantId, item.responder.id])).rows[0]!);
    assert.notEqual(stored.verification_token_hash, correct);
    const wrong = correct === "111111" ? "222222" : "111111";
    const failures = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: "POST", url: `${url}/confirm`, headers: item.responder.headers, payload: { code: wrong } })));
    assert.ok(failures.every(response => response.statusCode === 422));
    const locked = await app.inject({ method: "POST", url: `${url}/confirm`, headers: item.responder.headers, payload: { code: correct } });
    assert.equal(locked.statusCode, 422);
    const cooldown = await app.inject({ method: "POST", url: `${url}/start`, headers: item.responder.headers });
    assert.equal(cooldown.statusCode, 429);
    await store.tenantTx(item.tenantId, client => client.query("UPDATE relay.contacts SET verification_requested_at=clock_timestamp()-interval '2 minutes' WHERE tenant_id=$1 AND person_id=$2", [item.tenantId, item.responder.id]));
    const restart = await app.inject({ method: "POST", url: `${url}/start`, headers: item.responder.headers });
    const verified = await app.inject({ method: "POST", url: `${url}/confirm`, headers: item.responder.headers, payload: { code: restart.json().developmentCode } });
    assert.equal(verified.statusCode, 200, verified.body);
    const replay = await app.inject({ method: "POST", url: `${url}/confirm`, headers: item.responder.headers, payload: { code: restart.json().developmentCode } });
    assert.equal(replay.statusCode, 422);
  });

  await t.test("GET capability does not mutate ownership or reveal details; explicit POST owns once", async () => {
    const item = await fixture(store); const sent = await dispatched(app, store, item);
    const before = await store.getCommitment(item.tenantId, sent.commitmentId);
    const get = await app.inject({ method: "GET", url: `${base}/action/${sent.token}` });
    assert.equal(get.statusCode, 200, get.body); assert.equal(get.json().status, "available");
    assert.ok(!get.body.includes("PRIVATE"));
    assert.equal(get.headers["cache-control"], "no-store");
    assert.deepEqual(await store.getCommitment(item.tenantId, sent.commitmentId), before);
    const wrongOrigin = await app.inject({ method: "POST", url: `${base}/action/${sent.token}`, headers: { origin: "https://other.invalid", "idempotency-key": randomUUID() }, payload: { action: "acknowledge" } });
    assert.equal(wrongOrigin.statusCode, 403);
    const headers = { origin, "idempotency-key": randomUUID() };
    const accepted = await app.inject({ method: "POST", url: `${base}/action/${sent.token}`, headers, payload: { action: "acknowledge" } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal((await store.getCommitment(item.tenantId, sent.commitmentId))!.ownerRecipientId, item.responder.id);
    const duplicate = await app.inject({ method: "POST", url: `${base}/action/${sent.token}`, headers, payload: { action: "acknowledge" } });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.deepEqual(duplicate.json(), accepted.json());
  });

  await t.test("capability decline is explicit, and changed or expired contacts cannot claim", async () => {
    const item = await fixture(store); const sent = await dispatched(app, store, item);
    const declined = await app.inject({ method: "POST", url: `${base}/action/${sent.token}`, headers: { origin, "idempotency-key": randomUUID() }, payload: { action: "decline" } });
    assert.equal(declined.statusCode, 200, declined.body);
    assert.ok((await store.getCommitment(item.tenantId, sent.commitmentId))!.declinedRecipientIds.includes(item.responder.id));
    const second = await dispatched(app, store, item);
    await store.tenantTx(item.tenantId, client => client.query("UPDATE relay.attempts SET acknowledgement_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND attempt_id=$2", [item.tenantId, second.attemptId]));
    const expired = await app.inject({ method: "POST", url: `${base}/action/${second.token}`, headers: { origin, "idempotency-key": randomUUID() }, payload: { action: "acknowledge" } });
    assert.equal(expired.statusCode, 409);
    const third = await dispatched(app, store, item);
    await store.tenantTx(item.tenantId, client => client.query("UPDATE relay.contacts SET phone='+16045550101',phone_verified_at=NULL WHERE tenant_id=$1 AND person_id=$2", [item.tenantId, item.responder.id]));
    const changed = await app.inject({ method: "POST", url: `${base}/action/${third.token}`, headers: { origin, "idempotency-key": randomUUID() }, payload: { action: "acknowledge" } });
    assert.equal(changed.statusCode, 409);
  });

  await t.test("callbacks reject invalid signatures, account, destination, sender, SID and channel", async () => {
    const item = await fixture(store); const sent = await dispatched(app, store, item); await sending(store, item, sent.attemptId);
    const path = `${base}/providers/twilio/${sent.attemptId}/status`;
    const fields = { AccountSid: syntheticConfig.accountSid, CallSid: `CA${randomBytes(16).toString("hex")}`, To: sent.phone, From: syntheticConfig.fromNumber, CallStatus: "ringing" };
    assert.equal((await callback(app, path, fields, true)).statusCode, 403);
    for (const altered of [{ ...fields, AccountSid: `AC${"c".repeat(32)}` }, { ...fields, To: "+16045550101" }, { ...fields, From: "+16045550198" }, { ...fields, CallSid: "bad-sid" }]) assert.equal((await callback(app, path, altered)).statusCode, 403);
    const { CallSid: _unused, ...sms } = fields;
    assert.equal((await callback(app, path, { ...sms, MessageSid: `SM${"d".repeat(32)}` })).statusCode, 403);
    await store.tenantTx(item.tenantId, client => client.query("UPDATE relay.attempts SET provider_reference=$3 WHERE tenant_id=$1 AND attempt_id=$2", [item.tenantId, sent.attemptId, `CA${randomBytes(16).toString("hex")}`]));
    assert.equal((await callback(app, path, fields)).statusCode, 403);
  });

  await t.test("early callbacks bind a sending attempt; duplicate and out-of-order status never create ownership", async () => {
    const item = await fixture(store); const sent = await dispatched(app, store, item); await sending(store, item, sent.attemptId);
    const path = `${base}/providers/twilio/${sent.attemptId}/status`;
    const fields = { AccountSid: syntheticConfig.accountSid, CallSid: `CA${randomBytes(16).toString("hex")}`, To: sent.phone, From: syntheticConfig.fromNumber, CallStatus: "completed", SequenceNumber: "4" };
    assert.equal((await callback(app, path, fields)).statusCode, 204);
    assert.equal((await callback(app, path, fields)).statusCode, 204);
    assert.equal((await callback(app, path, { ...fields, CallStatus: "ringing", SequenceNumber: "1" })).statusCode, 204);
    const attempt = await store.tenantTx(item.tenantId, async client => (await client.query("SELECT status,provider_reference FROM relay.attempts WHERE tenant_id=$1 AND attempt_id=$2", [item.tenantId, sent.attemptId])).rows[0]!);
    assert.equal(attempt.status, "delivered"); assert.equal(attempt.provider_reference, fields.CallSid);
    assert.equal((await store.getCommitment(item.tenantId, sent.commitmentId))!.ownerRecipientId, null);
    const gathered = await callback(app, `${base}/providers/twilio/${sent.attemptId}/gather`, { ...fields, Digits: "1" });
    assert.equal(gathered.statusCode, 200, gathered.body); assert.match(gathered.body, /Responsibility recorded/);
    const duplicate = await callback(app, `${base}/providers/twilio/${sent.attemptId}/gather`, { ...fields, Digits: "1" });
    assert.equal(duplicate.body, gathered.body);
    assert.equal((await store.getCommitment(item.tenantId, sent.commitmentId))!.ownerRecipientId, item.responder.id);
  });

  await t.test("a gather callback cannot acknowledge an SMS attempt", async () => {
    const item = await fixture(store); const sent = await dispatched(app, store, item, "sms"); await sending(store, item, sent.attemptId);
    const response = await callback(app, `${base}/providers/twilio/${sent.attemptId}/gather`, { AccountSid: syntheticConfig.accountSid, MessageSid: `SM${randomBytes(16).toString("hex")}`, To: sent.phone, From: syntheticConfig.fromNumber, Digits: "1" });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal((await store.getCommitment(item.tenantId, sent.commitmentId))!.ownerRecipientId, null);
  });

  await t.test("an acknowledgement callback during provider submission wins over worker finalization", async () => {
    const item = await fixture(store);
    const created = await app.inject({ method: "POST", url: `${base}/work-orders`, headers: { ...item.admin.headers, "idempotency-key": randomUUID() }, payload: { branchId: item.branchId, externalId: randomUUID(), customerReference: "Fixture customer", priority: "Emergency", dueAt: new Date(Date.now() + 600_000).toISOString() } });
    assert.equal(created.statusCode, 201, created.body);
    const commitmentId = created.json().commitment.commitmentId as string;
    let attemptId = "";
    const callSid = `CA${randomBytes(16).toString("hex")}`;
    const provider: RelayProvider = { async send(delivery) {
      attemptId = delivery.attemptId;
      const early = await callback(app, `${base}/providers/twilio/${delivery.attemptId}/gather`, { AccountSid: syntheticConfig.accountSid, CallSid: callSid, To: delivery.destination, From: syntheticConfig.fromNumber, Digits: "1" });
      assert.equal(early.statusCode, 200, early.body);
      assert.match(early.body, /Responsibility recorded/);
      return { reference: callSid, simulated: true };
    } };
    await new RelayEngine(store, provider, { tenantIds: [item.tenantId] }).runCycle();
    assert.equal((await store.getCommitment(item.tenantId, commitmentId))!.ownerRecipientId, item.responder.id);
    const attempt = await store.tenantTx(item.tenantId, async client => (await client.query("SELECT status,provider_reference FROM relay.attempts WHERE tenant_id=$1 AND attempt_id=$2", [item.tenantId, attemptId])).rows[0]!);
    assert.equal(attempt.status, "acknowledged"); assert.equal(attempt.provider_reference, callSid);
  });

  await t.test("on-call administrators and dispatchers accept and decline by token and DTMF", async () => {
    for (const role of ["organization_admin", "branch_dispatcher"] as const) {
      const item = await fixture(store);
      const recipientId = role === "organization_admin" ? item.admin.id : item.responder.id;
      if (role === "branch_dispatcher") await store.pool.query("UPDATE relay.memberships SET role=$3 WHERE tenant_id=$1 AND person_id=$2", [item.tenantId, recipientId, role]);
      await store.tenantTx(item.tenantId, client => client.query("UPDATE relay.settings SET recipient_ids=$2 WHERE tenant_id=$1", [item.tenantId, JSON.stringify([recipientId])]));
      for (const mechanism of ["web", "dtmf"] as const) {
        for (const action of ["acknowledge", "decline"] as const) {
          const sent = await dispatched(app, store, item);
          if (mechanism === "dtmf") await sending(store, item, sent.attemptId);
          const response = mechanism === "web"
            ? await app.inject({ method: "POST", url: `${base}/action/${sent.token}`, headers: { origin, "idempotency-key": randomUUID() }, payload: { action } })
            : await callback(app, `${base}/providers/twilio/${sent.attemptId}/gather`, { AccountSid: syntheticConfig.accountSid, CallSid: `CA${randomBytes(16).toString("hex")}`, To: sent.phone, From: syntheticConfig.fromNumber, Digits: action === "acknowledge" ? "1" : "9" });
          assert.equal(response.statusCode, 200, response.body);
          const state = (await store.getCommitment(item.tenantId, sent.commitmentId))!;
          if (action === "acknowledge") assert.equal(state.ownerRecipientId, recipientId, response.body);
          else assert.ok(state.declinedRecipientIds.includes(recipientId), response.body);
        }
      }
    }
  });

  await t.test("recognized intake promotes once; unknown intake requires review; replay content is bound", async () => {
    const item = await fixture(store); const rawEmail = mail(randomUUID()); const key = randomUUID();
    const headers = { ...item.admin.headers, "idempotency-key": key };
    const response = await app.inject({ method: "POST", url: `${base}/intake`, headers, payload: { branchId: item.branchId, rawEmail } });
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().status, "promoted");
    const replay = await app.inject({ method: "POST", url: `${base}/intake`, headers, payload: { branchId: item.branchId, rawEmail } });
    assert.equal(replay.json().commitmentId, response.json().commitmentId);
    const conflict = await app.inject({ method: "POST", url: `${base}/intake`, headers, payload: { branchId: item.branchId, rawEmail: rawEmail + "\r\nchanged" } });
    assert.equal(conflict.statusCode, 409);
    const unknown = await app.inject({ method: "POST", url: `${base}/intake`, headers: { ...item.admin.headers, "idempotency-key": randomUUID() }, payload: { branchId: item.branchId, rawEmail: mail(randomUUID(), false) } });
    assert.equal(unknown.statusCode, 200, unknown.body); assert.equal(unknown.json().status, "needs_review"); assert.equal(unknown.json().commitmentId, null);
    const promote = await app.inject({ method: "POST", url: `${base}/intake/${unknown.json().id}/promote`, headers: { ...item.admin.headers, "idempotency-key": randomUUID() }, payload: unknown.json().fields });
    assert.equal(promote.statusCode, 200, promote.body); assert.equal(promote.json().status, "promoted");
    const stored = await store.tenantTx(item.tenantId, async client => (await client.query("SELECT raw_encrypted FROM relay.intake WHERE tenant_id=$1 AND id=$2", [item.tenantId, response.json().id])).rows[0]!);
    assert.ok(!stored.raw_encrypted.includes("Private intake details"));
  });

  await t.test('Inbox filters the full scoped queue before pagination and retains source-to-job links', async () => {
    const item=await fixture(store),other=await fixture(store);
    const received=await app.inject({method:'POST',url:`${base}/intake`,headers:{...item.admin.headers,'idempotency-key':randomUUID()},payload:{branchId:item.branchId,rawEmail:mail('OLDEST-REVIEW',false)}});
    assert.equal(received.statusCode,200,received.body);
    await store.tenantTx(item.tenantId,async client=>{
      await client.query("UPDATE relay.intake SET received_at=clock_timestamp()-interval '1 day' WHERE tenant_id=$1 AND id=$2",[item.tenantId,received.json().id]);
      await client.query(`INSERT INTO relay.intake(tenant_id,branch_id,id,connection_id,receipt_id,content_hash,candidate,status,raw_encrypted)
        SELECT $1,$2,'page-'||n,'pagination-fixture',n::text,'synthetic',
          jsonb_build_object('fields',jsonb_build_object('externalId','ROW-'||n),'reasons','[]'::jsonb,'provenance','{}'::jsonb,'parserVersion','fixture'),
          'needs_review','synthetic-not-real-email' FROM generate_series(1,201) n`,[item.tenantId,item.branchId]);
    });
    const get=(suffix:string,headers=item.admin.headers)=>app.inject({method:'GET',url:`${base}/intake${suffix}`,headers});
    const first=await get('?status=pending');
    assert.equal(first.statusCode,200,first.body);assert.equal(first.json().total,202);assert.equal(first.json().items.length,200);assert.equal(first.json().nextOffset,200);
    const second=await get('?status=pending&offset=200');
    assert.equal(second.json().total,202);assert.equal(second.json().items.length,2);assert.equal(second.json().hasMore,false);
    assert.ok(second.json().items.some((record:{id:string})=>record.id===received.json().id));
    const found=await get('?status=pending&search=oldest-review');
    assert.equal(found.json().total,1);assert.equal(found.json().items[0].id,received.json().id);assert.ok(found.json().items[0].provenance);assert.ok(found.json().items[0].receivedAt);
    assert.equal((await get('?status=pending&offset=1000')).json().total,202);
    assert.equal((await get('?status=pending',other.admin.headers)).json().total,0);
    assert.equal((await get('?status=not-a-status')).statusCode,400);
    assert.equal((await get('?offset=-1')).statusCode,400);
    const promoted=await app.inject({method:'POST',url:`${base}/intake/${received.json().id}/promote`,headers:{...item.admin.headers,'idempotency-key':randomUUID()},payload:received.json().fields});
    assert.equal(promoted.statusCode,200,promoted.body);
    const linked=(await get('?status=promoted')).json().items[0];assert.equal(linked.commitmentId,promoted.json().commitmentId);
    const job=await app.inject({method:'GET',url:`${base}/jobs/${linked.commitmentId}`,headers:item.admin.headers});assert.equal(job.statusCode,200,job.body);
    await store.pool.query("UPDATE relay.memberships SET role='branch_dispatcher' WHERE tenant_id=$1 AND person_id=$2",[item.tenantId,item.admin.id]);
    assert.equal((await get(`?branchId=${other.branchId}`)).statusCode,403);
  });

  await t.test("intake requires operator authority and a connection credential cannot choose another tenant", async () => {
    const item = await fixture(store); const other = await fixture(store);
    assert.equal((await app.inject({ method: "GET", url: `${base}/intake` })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: `${base}/intake`, headers: item.responder.headers })).statusCode, 403);
    const connection = await app.inject({ method: "POST", url: `${base}/intake/connections`, headers: { ...item.admin.headers, "idempotency-key": randomUUID() }, payload: { branchId: item.branchId, name: "Canadian test ingress" } });
    assert.equal(connection.statusCode, 200, connection.body);
    const inboundPath = `${base}/inbound/${connection.json().id}`;
    assert.equal((await app.inject({ method: "POST", url: inboundPath, payload: { receiptId: randomUUID(), rawEmail: mail(randomUUID()) } })).statusCode, 401);
    const received = await app.inject({ method: "POST", url: inboundPath, headers: { authorization: `Bearer ${connection.json().token}` }, payload: { receiptId: randomUUID(), rawEmail: mail(randomUUID()) } });
    assert.equal(received.statusCode, 200, received.body); assert.equal(received.json().branchId, item.branchId);
    assert.equal(received.json().status,'promoted');
    const sourceEvent=await store.tenantTx(item.tenantId,async client=>(await client.query("SELECT envelope FROM relay.events WHERE tenant_id=$1 AND commitment_id=$2 AND event_type='commitment_created'",[item.tenantId,received.json().commitmentId])).rows[0]!);
    assert.equal(sourceEvent.envelope.actorId,`source:${connection.json().id}`);
    assert.equal(sourceEvent.envelope.actorRole,'system');
    const unauthorized = await app.inject({ method: "POST", url: `${base}/intake/${received.json().id}/promote`, headers: { ...other.admin.headers, "idempotency-key": randomUUID() }, payload: received.json().fields });
    assert.equal(unauthorized.statusCode, 404);
    const injectedTenant = await app.inject({ method: "POST", url: inboundPath, headers: { authorization: `Bearer ${connection.json().token}` }, payload: { receiptId: randomUUID(), rawEmail: mail(randomUUID()), tenantId: other.tenantId } });
    assert.equal(injectedTenant.statusCode, 400);
  });

  await t.test("a rejected automatic promotion can be corrected without poisoning its durable command receipt", async () => {
    const item=await fixture(store);
    // Two recipients 15 seconds apart cannot fit this first future deadline.
    await store.tenantTx(item.tenantId,client=>client.query('UPDATE relay.settings SET recipient_ids=$2 WHERE tenant_id=$1',[item.tenantId,JSON.stringify([item.responder.id,item.admin.id])]));
    const rawEmail=mail(randomUUID()).replace(/Due-At: [^\r]+/,`Due-At: ${new Date(Date.now()+5_000).toISOString()}`);
    const received=await app.inject({method:'POST',url:`${base}/intake`,headers:{...item.admin.headers,'idempotency-key':randomUUID()},payload:{branchId:item.branchId,rawEmail}});
    assert.equal(received.statusCode,200,received.body);
    assert.equal(received.json().status,'needs_review');
    // Preserve source deadline; correct the routing policy instead of buying more time.
    await store.tenantTx(item.tenantId,client=>client.query('UPDATE relay.settings SET recipient_ids=$2 WHERE tenant_id=$1',[item.tenantId,JSON.stringify([item.responder.id])]));
    const headers={...item.admin.headers,'idempotency-key':randomUUID()};
    const promoted=await app.inject({method:'POST',url:`${base}/intake/${received.json().id}/promote`,headers,payload:received.json().fields});
    assert.equal(promoted.statusCode,200,promoted.body);
    assert.equal(promoted.json().status,'promoted');
    const replay=await app.inject({method:'POST',url:`${base}/intake/${received.json().id}/promote`,headers,payload:received.json().fields});
    assert.equal(replay.json().commitmentId,promoted.json().commitmentId);
    assert.equal(promoted.json().fields.dueAt,received.json().fields.dueAt);
  });

  await t.test("a cancelled organization cannot break active tenants' action or ingress lookups", async () => {
    const cancelledId = `000-cancelled-integration-${randomUUID()}`;
    await store.pool.query("INSERT INTO relay.organizations(id,name) VALUES($1,'Cancelled fixture')", [cancelledId]);
    await store.pool.query("INSERT INTO relay.deletion_tombstones(tenant_id,cancelled_at,backup_delete_by) VALUES($1,clock_timestamp(),clock_timestamp()+interval '29 days')", [cancelledId]);
    const item = await fixture(store); const sent = await dispatched(app, store, item);
    const available = await app.inject({ method: "GET", url: `${base}/action/${sent.token}` });
    assert.equal(available.statusCode, 200, available.body); assert.equal(available.json().status, "available");
    const connection = await app.inject({ method: "POST", url: `${base}/intake/connections`, headers: { ...item.admin.headers, "idempotency-key": randomUUID() }, payload: { branchId: item.branchId, name: "Active ingress" } });
    const received = await app.inject({ method: "POST", url: `${base}/inbound/${connection.json().id}`, headers: { authorization: `Bearer ${connection.json().token}` }, payload: { receiptId: randomUUID(), rawEmail: mail(randomUUID(), false) } });
    assert.equal(received.statusCode, 200, received.body);
  });
});

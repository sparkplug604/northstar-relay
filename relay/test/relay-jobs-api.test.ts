import assert from 'node:assert/strict';
import {DateTime} from 'luxon';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildRelayApp } from '../apps/api/src/relay/app.js';
import { bootstrapRelay, hashPassword } from '../apps/api/src/relay/auth.js';
import { migrateRelay, RelayPostgresStore } from '../packages/relay-storage-postgres/src/index.js';
import { newStandaloneJob } from '@northstar/relay-domain';

const databaseUrl = process.env.RELAY_TEST_DATABASE_URL;
describe('Relay jobs: independent lifecycle and commitments', { skip: !databaseUrl }, () => {
  const origin = 'http://127.0.0.1:4321';
  const dbName = `relay_jobs_${randomBytes(6).toString('hex')}`;
  const url = new URL(databaseUrl ?? 'postgres://localhost/unused'); url.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: url.toString() });
  const store = new RelayPostgresStore(pool);
  const password = randomBytes(24).toString('hex');
  let app: FastifyInstance;
  let tenantId: string, branchId: string, dispatcherId: string, responderId: string, outsiderId: string;
  type Headers = { origin: string; cookie: string; 'x-csrf-token': string };
  let dispatcher: Headers, responder: Headers, colleague: Headers, otherTenant: Headers, otherBranch: Headers;
  async function login(email: string): Promise<Headers> {
    const reply = await app.inject({ method: 'POST', url: '/api/relay/v1/auth/login', headers: { origin }, payload: { email, password } });
    assert.equal(reply.statusCode, 200, reply.body);
    return { origin, cookie: String(reply.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': reply.json().csrfToken };
  }
  async function person(name: string, memberBranch = branchId) {
    const id = randomUUID(), email = `${id}@example.invalid`;
    await pool.query('INSERT INTO relay.people(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [id, email, name, await hashPassword(password)]);
    await pool.query("INSERT INTO relay.memberships(tenant_id,person_id,branch_id,role) VALUES($1,$2,$3,'on_call_responder')", [tenantId, id, memberBranch]);
    return { id, headers: await login(email) };
  }
  before(async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${dbName}"`); await admin.end();
    await migrateRelay(pool);
    app = await buildRelayApp({ store, publicOrigin: origin, secureCookies: false, setupToken: undefined, authEncryptionKey: randomBytes(32).toString('base64'), providerMode: 'simulated' });
    const input = { organizationName: 'Synthetic jobs QA', branchName: 'Vancouver', timezone: 'America/Vancouver', displayName: 'Dispatch QA', email: 'dispatch-jobs@example.invalid', password };
    const boot = await bootstrapRelay(store, input);
    ({ tenantId, branchId, personId: dispatcherId } = boot);
    // Synthetic fixtures use real non-MFA dispatcher login; production auth is unchanged.
    await pool.query("UPDATE relay.memberships SET role='branch_dispatcher' WHERE tenant_id=$1", [tenantId]);
    dispatcher = await login(input.email);
    ({ id: responderId, headers: responder } = await person('Assigned responder'));
    ({ id: outsiderId, headers: colleague } = await person('Unassigned colleague'));
    const branch = randomUUID();
    await pool.query("INSERT INTO relay.branches(tenant_id,id,name,timezone) VALUES($1,$2,'Other branch','America/Toronto')", [tenantId, branch]);
    otherBranch = (await person('Other branch responder', branch)).headers;
    const otherTenantId = randomUUID(), otherBranchId = randomUUID(), otherPersonId = randomUUID();
    await pool.query("INSERT INTO relay.organizations(id,name) VALUES($1,'Unrelated tenant')", [otherTenantId]);
    await pool.query("INSERT INTO relay.branches(tenant_id,id,name,timezone) VALUES($1,$2,'Other company','America/Vancouver')", [otherTenantId, otherBranchId]);
    await pool.query("INSERT INTO relay.people(id,email,display_name,password_hash) VALUES($1,'other-jobs@example.invalid','Other dispatcher',$2)", [otherPersonId, await hashPassword(password)]);
    await pool.query("INSERT INTO relay.memberships(tenant_id,person_id,branch_id,role) VALUES($1,$2,$3,'branch_dispatcher')", [otherTenantId, otherPersonId, otherBranchId]);
    otherTenant = await login('other-jobs@example.invalid');
    const settings = await app.inject({ method: 'PUT', url: '/api/relay/v1/settings', headers: dispatcher, payload: { branchId, recipientIds: [responderId], intervalSeconds: 60, channels: ['voice'] } });
    assert.equal(settings.statusCode, 200, settings.body);
  });
  after(async () => { await app?.close(); await pool.end(); });

  async function detail(id: string, headers = dispatcher) {
    const reply = await app.inject({ method: 'GET', url: `/api/relay/v1/jobs/${id}`, headers });
    assert.equal(reply.statusCode, 200, reply.body);
    return reply.json();
  }
  async function create() {
    const reply = await app.inject({ method: 'POST', url: '/api/relay/v1/work-orders', headers: { ...dispatcher, 'idempotency-key': randomUUID() }, payload: { branchId, externalId: `JOB-${randomUUID()}`, customerReference: 'Synthetic freezer', priority: 'urgent', dueAt: new Date(Date.now() + 3_600_000).toISOString(), note: 'Synthetic data only' } });
    assert.equal(reply.statusCode, 201, reply.body);
    return detail(reply.json().commitment.commitmentId);
  }
  async function action(id: string, fields: Record<string, unknown>, headers = dispatcher, expectedVersion?: number, key = randomUUID()) {
    const version = expectedVersion ?? (await detail(id, headers)).job.version;
    return app.inject({ method: 'POST', url: `/api/relay/v1/jobs/${id}/actions`, headers: { ...headers, 'idempotency-key': key }, payload: { ...fields, expectedVersion: version } });
  }
  async function ok(id: string, fields: Record<string, unknown>, headers = dispatcher) {
    const reply = await action(id, fields, headers);
    assert.equal(reply.statusCode, 200, reply.body);
    return reply.json();
  }
  async function resolveAcknowledgement(id: string) {
    const c = (await detail(id)).acknowledgement;
    await store.applyCommand({ type: 'activate_commitment', commandId: randomUUID(), tenantId, commitmentId: id, actorId: 'test-worker', actorRole: 'system', occurredAt: await store.now(), correlationId: randomUUID(), expectedVersion: c.version, expectedDueAt: c.dueAt, expectedActivatesAt: c.activatesAt });
    const result = await app.inject({ method: 'POST', url: `/api/relay/v1/work-orders/${id}/actions`, headers: { ...dispatcher, 'idempotency-key': randomUUID() }, payload: { action: 'acknowledge', recipientId: responderId } });
    assert.equal(result.statusCode, 200, result.body);
  }

  it('finds openings for unscheduled work and approves a shared technician-and-time proposal atomically',async()=>{
    const tech=await person('Assignment conversation QA');
    const point={label:'Synthetic depot',latitude:49.26,longitude:-123.12};
    const monday=DateTime.now().setZone('America/Los_Angeles').startOf('week').plus({weeks:1}).set({hour:10});
    const serviceWindow={earliestStart:monday.toISO()!,completeBy:monday.set({hour:16}).toISO()!};
    const profile={timezone:'America/Los_Angeles',skills:['refrigeration'],
      workingHours:[{weekday:1,start:'08:00',end:'18:00'}],
      timeOff:[{start:monday.toISO()!,end:monday.plus({hours:1}).toISO()!}],base:point};
    const headers={...dispatcher,'idempotency-key':randomUUID()};
    const personPath='/api/relay/v1/technicians/'+tech.id+'/planning';
    const saved=await app.inject({method:'POST',url:personPath,headers,payload:{expectedVersion:0,profile}});
    assert.equal(saved.statusCode,200,saved.body);
    async function unscheduled(){
      const created=await app.inject({method:'POST',url:'/api/relay/v1/jobs',headers:{...dispatcher,'idempotency-key':randomUUID()},
        payload:{externalId:randomUUID(),customerReference:'Unscheduled cooler',branchId,priority:'high',serviceWindow}});
      assert.equal(created.statusCode,201,created.body);
      const id=created.json().job.id;
      await action(id,{action:'dispatch_details',site:point,estimatedMinutes:60,requiredSkills:['refrigeration']});
      return id as string;
    }
    const originalFetch=globalThis.fetch,originalRouter=process.env.RELAY_ROUTING_URL;
    process.env.RELAY_ROUTING_URL='http://127.0.0.1:19474';
    globalThis.fetch=async()=>new Response(JSON.stringify({code:'Ok',routes:[{duration:300}],waypoints:[{distance:0},{distance:0}]}));
    const post=(id:string,path:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:'/api/relay/v1/jobs/'+id+'/assignment/'+path,
      headers:{...dispatcher,'idempotency-key':randomUUID()},payload});
    const read=async(id:string)=>{
      const reply=await app.inject({method:'GET',url:'/api/relay/v1/jobs/'+id+'/assignment',headers:dispatcher});
      assert.equal(reply.statusCode,200,reply.body);return reply.json();
    };
    try{
      const id=await unscheduled(),state=await read(id);
      assert.equal(state.job.scheduledAt,null);
      const options=state.options.filter((option:{personId:string})=>option.personId===tech.id);
      assert.ok(options.length>=2);
      assert.ok(Date.parse(options[0].scheduledAt)>=monday.plus({hours:1,minutes:15}).toMillis());
      const propose=(revision:number,option:typeof options[number])=>post(id,'proposal',{revision,jobVersion:state.job.version,personId:tech.id,scheduledAt:option.scheduledAt,reason:'Matches client timing and skills'});
      const first=await propose(0,options[0]);
      assert.equal(first.statusCode,200,first.body);
      assert.equal((await propose(0,options[1])).statusCode,409);
      const alternative=await propose(1,options[1]);assert.equal(alternative.statusCode,200,alternative.body);
      assert.equal((await post(id,'approve',{revision:1})).statusCode,409);
      const approved=await post(id,'approve',{revision:2});assert.equal(approved.statusCode,200,approved.body);
      assert.equal(approved.json().job.assigneeId,tech.id);
      assert.equal(approved.json().job.scheduledAt,options[1].scheduledAt);
      assert.equal(approved.json().job.status,'scheduled');
      const replay=await post(id,'approve',{revision:2});assert.equal(replay.statusCode,200,replay.body);
      assert.equal((await detail(id)).events.filter((event:{kind:string})=>event.kind==='job_visit_assigned').length,1);
      assert.ok((await read(id)).receipt);

      const second=await unscheduled(),next=await read(second);
      const opening=next.options.find((option:{personId:string})=>option.personId===tech.id);
      assert.ok(opening);
      const proposed=await post(second,'proposal',{revision:0,jobVersion:next.job.version,personId:tech.id,scheduledAt:opening.scheduledAt,reason:'Fits the available window'});
      assert.equal(proposed.statusCode,200,proposed.body);
      const changed=await app.inject({method:'POST',url:personPath,headers:{...dispatcher,'idempotency-key':randomUUID()},
        payload:{expectedVersion:1,profile:{...profile,timeOff:[{start:serviceWindow.earliestStart,end:serviceWindow.completeBy}]}}});
      assert.equal(changed.statusCode,200,changed.body);
      const blocked=await post(second,'approve',{revision:1});
      assert.equal(blocked.statusCode,409,blocked.body);
      assert.equal((await detail(second)).job.scheduledAt,null);
      assert.equal((await detail(second)).job.assigneeId,null);

      await app.inject({method:'POST',url:personPath,headers:{...dispatcher,'idempotency-key':randomUUID()},
        payload:{expectedVersion:2,profile:{...profile,timeOff:[]}}});
      await action(second,{action:'dispatch_details',site:point,estimatedMinutes:60,requiredSkills:['refrigeration'],
        serviceWindow:{...serviceWindow,completeBy:DateTime.fromISO(opening.scheduledAt).plus({minutes:30}).toISO()}});
      assert.equal((await post(second,'approve',{revision:1})).statusCode,409);
      assert.equal((await detail(second)).job.assigneeId,null);
      const outside=await post(second,'proposal',{revision:1,jobVersion:(await detail(second)).job.version,personId:tech.id,
        scheduledAt:DateTime.fromISO(serviceWindow.completeBy).plus({hours:1}).toISO(),reason:'Beyond deadline'});
      assert.equal(outside.statusCode,409,outside.body);
    }finally{
      globalThis.fetch=originalFetch;
      if(originalRouter===undefined)delete process.env.RELAY_ROUTING_URL;else process.env.RELAY_ROUTING_URL=originalRouter;
    }
  });

  it('dispatch planning enforces role, branch, revision and idempotent profile saves',async()=>{
    const technician=await person('Planning QA');
    const path='/api/relay/v1/technicians/'+technician.id+'/planning';
    const profile={timezone:'America/Vancouver',skills:['Refrigeration'],workingHours:[{weekday:1,start:'08:00',end:'18:00'}],timeOff:[],
      base:{label:'Synthetic depot',latitude:49.26,longitude:-123.12}};
    const key=randomUUID(),payload={expectedVersion:0,profile};
    const save=(headers:Headers,body:Record<string,unknown>=payload,command=key)=>app.inject({method:'POST',url:path,headers:{...headers,'idempotency-key':command},payload:body});
    assert.equal((await save(responder)).statusCode,403);
    assert.equal((await save(otherTenant)).statusCode,404);
    assert.equal((await save(otherBranch)).statusCode,403);
    const saved=await save(dispatcher);assert.equal(saved.statusCode,200,saved.body);
    assert.deepEqual(saved.json().profile.skills,['refrigeration']);
    assert.equal(saved.json().version,1);
    assert.equal((await save(dispatcher)).statusCode,200);
    assert.equal((await save(dispatcher,payload,randomUUID())).statusCode,409);
    assert.equal((await save(dispatcher,{expectedVersion:1,profile:{...profile,timezone:'Mars/Crater'}},randomUUID())).statusCode,400);
    const list=await app.inject({method:'GET',url:'/api/relay/v1/technicians',headers:dispatcher});
    assert.ok(list.json().items.some((item:{personId:string})=>item.personId===technician.id));
  });

  it('checked assignment serializes overlapping bookings and rejects newly recorded time off',async()=>{
    const technician=await person('Availability QA');
    const point={label:'Synthetic depot',latitude:49.26,longitude:-123.12};
    const profile={timezone:'America/Vancouver',skills:['refrigeration'],workingHours:[{weekday:1,start:'08:00',end:'18:00'}],timeOff:[] as {start:string;end:string}[],base:point};
    const start=DateTime.now().setZone('America/Vancouver').startOf('week').plus({weeks:1}).set({hour:10}).toISO()!;
    const end=DateTime.fromISO(start).plus({hours:1}).toISO()!;
    const saved=await app.inject({method:'POST',url:'/api/relay/v1/technicians/'+technician.id+'/planning',
      headers:{...dispatcher,'idempotency-key':randomUUID()},payload:{expectedVersion:0,profile}});
    assert.equal(saved.statusCode,200,saved.body);
    async function makeJob(){
      const reply=await app.inject({method:'POST',url:'/api/relay/v1/jobs',headers:{...dispatcher,'idempotency-key':randomUUID()},
        payload:{branchId,externalId:randomUUID(),customerReference:'Planning QA cooler',priority:'normal'}});
      assert.equal(reply.statusCode,201,reply.body);
      const id=reply.json().job.id;
      await action(id,{action:'dispatch_details',site:point,estimatedMinutes:60,requiredSkills:['refrigeration']});
      await action(id,{action:'schedule',scheduledAt:start,note:'Synthetic planning test'});
      return (await detail(id)).job;
    }
    const jobs=await Promise.all([makeJob(),makeJob()]);
    const originalFetch=globalThis.fetch,originalRouter=process.env.RELAY_ROUTING_URL;
    process.env.RELAY_ROUTING_URL='http://127.0.0.1:19473';
    globalThis.fetch=async()=>new Response(JSON.stringify({code:'Ok',routes:[{duration:300}],waypoints:[{distance:0},{distance:0}]}));
    try{
      const keys=jobs.map(()=>randomUUID());
      const assign=(job:typeof jobs[number],key:string)=>app.inject({method:'POST',url:'/api/relay/v1/jobs/'+job.id+'/actions',
        headers:{...dispatcher,'idempotency-key':key},payload:{action:'assign',assigneeId:technician.id,checkAvailability:true,expectedVersion:job.version}});
      const replies=await Promise.all(jobs.map((job,index)=>assign(job,keys[index]!)));
      assert.deepEqual(replies.map(reply=>reply.statusCode).sort(),[200,409],replies.map(reply=>reply.body).join(' | '));
      const winner=replies.findIndex(reply=>reply.statusCode===200);
      const replay=await assign(jobs[winner],keys[winner]!);
      assert.equal(replay.statusCode,200,replay.body);
      const assigned=await detail(jobs[winner].id);
      assert.equal(assigned.events.filter((event:{kind:string})=>event.kind==='job_assigned').length,1);
      await action(jobs[winner].id,{action:'cancel',note:'Free the synthetic slot'});
      const loser=jobs[1-winner];
      const read=await app.inject({method:'GET',url:'/api/relay/v1/jobs/'+loser.id+'/technicians',headers:dispatcher});
      assert.equal(read.statusCode,200,read.body);
      assert.equal(read.json().candidates.find((item:{personId:string})=>item.personId===technician.id).status,'available');
      const off=await app.inject({method:'POST',url:'/api/relay/v1/technicians/'+technician.id+'/planning',
        headers:{...dispatcher,'idempotency-key':randomUUID()},payload:{expectedVersion:1,profile:{...profile,timeOff:[{start,end}]}}});
      assert.equal(off.statusCode,200,off.body);
      const rejected=await assign(loser,randomUUID());
      assert.equal(rejected.statusCode,409,rejected.body);
      assert.equal((await detail(loser.id)).job.assigneeId,null);
    }finally{
      globalThis.fetch=originalFetch;
      if(originalRouter===undefined)delete process.env.RELAY_ROUTING_URL;
      else process.env.RELAY_ROUTING_URL=originalRouter;
    }
  });

  it('creates a separate job atomically and does not treat a fulfilled handoff as actual completion', async () => {
    const initial = await create(), id = initial.job.id;
    assert.equal(initial.job.status, 'requested');
    assert.equal(initial.job.acknowledgementId, initial.acknowledgement.commitmentId);
    assert.equal(initial.job.completedAt, null);
    const ack = async (payload: Record<string, unknown>) => {
      const result = await app.inject({ method: 'POST', url: `/api/relay/v1/work-orders/${id}/actions`, headers: { ...dispatcher, 'idempotency-key': randomUUID() }, payload });
      assert.equal(result.statusCode, 200, result.body);
    };
    const c = initial.acknowledgement;
    await store.applyCommand({ type: 'activate_commitment', commandId: randomUUID(), tenantId, commitmentId: id, actorId: 'test-worker', actorRole: 'system', occurredAt: await store.now(), correlationId: randomUUID(), expectedVersion: c.version, expectedDueAt: c.dueAt, expectedActivatesAt: c.activatesAt });
    await ack({ action: 'acknowledge', recipientId: responderId });
    await ack({ action: 'source_acceptance', sourceStatus: 'not_required' });
    await ack({ action: 'fulfill' });
    await ack({ action: 'close', reason: 'Handoff only' });
    const current = await detail(id);
    assert.equal(current.acknowledgement.status, 'closed');
    assert.equal(current.job.status, 'requested');
    assert.equal(current.job.assigneeId, responderId);
    assert.equal(current.job.completedAt, null);
  });
  it('tracks delay, revised promises, work and independently confirmed completion', async () => {
    const initial = await create(), id = initial.job.id;
    await resolveAcknowledgement(id);
    await ok(id, { action: 'assign', assigneeId: responderId });
    await ok(id, { action: 'schedule', scheduledAt: new Date(Date.now() + 60_000).toISOString(), note: 'First visit' });
    const dueAt = new Date(Date.now() + 3_600_000).toISOString();
    let current = await ok(id, { action: 'add_milestone', title: 'Send ETA', ownerId: responderId, dueAt });
    const first = current.milestones[0].id;
    current = await ok(id, { action: 'add_milestone', title: 'Follow-up visit', ownerId: responderId, dueAt });
    const second = current.milestones.find((m: { id: string }) => m.id !== first).id;
    await ok(id, { action: 'start', note: 'Arrived at the site' }, responder);
    await ok(id, { action: 'block', note: 'Waiting for replacement compressor' }, responder);
    const newDueAt = new Date(Date.now() + 86_400_000).toISOString();
    current = await ok(id, { action: 'reschedule_milestone', milestoneId: second, dueAt: newDueAt, note: 'Supplier delivers tomorrow' }, responder);
    assert.equal(current.job.status, 'blocked');
    assert.match(JSON.stringify(current.events), /Supplier delivers tomorrow/);
    assert.ok(JSON.stringify(current.events).includes(dueAt), 'Old deadline must remain in history');
    assert.ok(JSON.stringify(current.events).includes(newDueAt), 'New deadline must be recorded');
    await ok(id, { action: 'resume', note: 'Replacement arrived; returning to site' }, responder);
    const premature = await action(id, { action: 'report_completion', note: 'Cannot finish while promises remain open' }, responder);
    assert.ok(premature.statusCode >= 400, premature.body);
    await ok(id, { action: 'complete_milestone', milestoneId: first, note: 'ETA sent' }, responder);
    await ok(id, { action: 'complete_milestone', milestoneId: second, note: 'Returned and installed compressor' }, responder);
    current = await ok(id, { action: 'report_completion', note: 'Compressor replaced. Temperature stable at -18 C.' }, responder);
    assert.equal(current.job.status, 'completion_reported');
    assert.equal(current.job.completedAt, null);
    assert.equal(current.job.completionReportedBy, responderId);
    assert.ok(Date.parse(current.job.completionReportedAt) <= Date.now());
    assert.equal((await action(id, { action: 'confirm_completion', note: 'Self approval not permitted' }, responder)).statusCode, 403);
    current = await ok(id, { action: 'confirm_completion', note: 'Reviewed service report and confirmed with site manager' });
    assert.equal(current.job.status, 'completed');
    assert.equal(current.job.completedBy, dispatcherId);
    assert.ok(Date.parse(current.job.completedAt) >= Date.parse(current.job.completionReportedAt));
    assert.equal(current.job.openMilestoneCount, 0);
    assert.deepEqual((await detail(id)).job, current.job, 'Completion survives a fresh read');
    const history = await app.inject({ method: 'GET', url: '/api/relay/v1/jobs?view=completed', headers: dispatcher });
    assert.ok(history.json().items.some((job: { id: string }) => job.id === id));
    assert.ok((await action(id, { action: 'add_update', note: 'Cannot silently alter closed work' })).statusCode >= 400);
    current = await ok(id, { action: 'reopen', note: 'Site reported a recurrence; follow-up required' });
    assert.notEqual(current.job.status, 'completed');
    assert.match(JSON.stringify(current.events), /Temperature stable/);
  });
  it('enforces tenant, branch and assigned-responder permissions and CSRF', async () => {
    const current = await create(), id = current.job.id;
    await ok(id, { action: 'assign', assigneeId: responderId });
    for (const headers of [otherTenant, otherBranch]) {
      const result = await app.inject({ method: 'GET', url: `/api/relay/v1/jobs/${id}`, headers });
      assert.ok([403, 404].includes(result.statusCode), result.body);
      const mutation = await action(id, { action: 'add_update', note: 'Unauthorized' }, headers, current.job.version);
      assert.ok([403, 404].includes(mutation.statusCode), mutation.body);
      const list = await app.inject({ method: 'GET', url: '/api/relay/v1/jobs?view=all', headers });
      assert.ok(!list.json().items.some((job: { id: string }) => job.id === id));
    }
    const unrelated = await action(id, { action: 'start', note: 'Not assigned' }, colleague, (await detail(id)).job.version);
    assert.equal(unrelated.statusCode, 403, unrelated.body);
    assert.equal((await action(id, { action: 'assign', assigneeId: outsiderId }, responder)).statusCode, 403);
    const noCsrf = await app.inject({ method: 'POST', url: `/api/relay/v1/jobs/${id}/actions`, headers: { origin, cookie: dispatcher.cookie, 'idempotency-key': randomUUID() }, payload: { action: 'start', expectedVersion: 1 } });
    assert.equal(noCsrf.statusCode, 403);
    const blank = await action(id, { action: 'add_update', note: '   ' });
    assert.ok(blank.statusCode >= 400, blank.body);
    const fabricated = await action(id, { action: 'assign', assigneeId: 'missing-person' });
    assert.ok(fabricated.statusCode >= 400, fabricated.body);
  });
  it('deduplicates retries, rejects reused keys with different input, and serializes competing writes', async () => {
    const initial = await create(), id = initial.job.id, key = randomUUID();
    const intent = { action: 'add_update', note: 'One durable update' };
    const first = await action(id, intent, dispatcher, initial.job.version, key);
    assert.equal(first.statusCode, 200, first.body);
    const replay = await action(id, intent, dispatcher, initial.job.version, key);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal((await detail(id)).events.filter((e: { note: string }) => e.note === intent.note).length, 1);
    assert.equal((await action(id, { ...intent, note: 'Changed content' }, dispatcher, initial.job.version, key)).statusCode, 409);
    const version = (await detail(id)).job.version;
    const writes = await Promise.all(['Update A', 'Update B'].map(note => action(id, { action: 'add_update', note }, dispatcher, version)));
    assert.deepEqual(writes.map(r => r.statusCode).sort(), [200, 409]);
  });
  it('preserves late deadlines and cancels unresolved milestones with the job', async () => {
    const initial = await create(), id = initial.job.id;
    await ok(id, { action: 'assign', assigneeId: responderId });
    let current = await ok(id, { action: 'add_milestone', title: 'Already due promise', ownerId: responderId, dueAt: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(current.job.overdueMilestoneCount, 1, 'Trusted server time classifies the deadline');
    const unresolved = await action(id, { action: 'cancel', note: 'Must resolve the acknowledgement first' });
    assert.equal(unresolved.statusCode, 409);
    assert.equal(unresolved.json().error, 'acknowledgement_unresolved');
    await resolveAcknowledgement(id);
    current = await ok(id, { action: 'cancel', note: 'Customer cancelled request' });
    assert.equal(current.job.status, 'cancelled');
    assert.equal(current.milestones[0].status, 'cancelled');
    assert.equal(current.job.openMilestoneCount, 0);
    assert.match(JSON.stringify(current.events), /Customer cancelled request/);
  });
  it('lets a different commitment owner resolve only their promise, not operate the whole job', async () => {
    const initial = await create(), id = initial.job.id;
    await ok(id, { action: 'assign', assigneeId: responderId });
    const dueAt = new Date(Date.now() + 3_600_000).toISOString();
    const first = await ok(id, { action: 'add_milestone', title: 'Lead technician work', ownerId: responderId, dueAt });
    const otherMilestoneId = first.milestones[0].id;
    const current = await ok(id, { action: 'add_milestone', title: 'Colleague to collect part', ownerId: outsiderId, dueAt });
    const milestoneId = current.milestones.find((item: { ownerId: string }) => item.ownerId === outsiderId).id;
    assert.ok(current.job.openMilestoneOwnerIds.includes(outsiderId));
    await ok(id, { action: 'add_update', note: 'Part supplier has confirmed availability' }, colleague);
    assert.equal((await action(id, { action: 'start', note: 'Not the assigned job technician' }, colleague)).statusCode, 403);
    assert.equal((await action(id, { action: 'complete_milestone', milestoneId: otherMilestoneId, note: 'Not my promise to resolve' }, colleague)).statusCode, 403);
    const version = (await detail(id)).job.version, key = randomUUID();
    const fields = { action: 'complete_milestone', milestoneId, note: 'Collected the replacement part' };
    const done = await action(id, fields, colleague, version, key);
    assert.equal(done.statusCode, 200, done.body);
    assert.ok(!done.json().job.openMilestoneOwnerIds.includes(outsiderId));
    const replay = await action(id, fields, colleague, version, key);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal((await detail(id)).events.filter((e: { note: string }) => e.note === fields.note).length, 1);
  });
  async function standalone(externalId = `STANDALONE-${randomUUID()}`) {
    const reply = await app.inject({ method: 'POST', url: '/api/relay/v1/jobs', headers: { ...dispatcher, 'idempotency-key': randomUUID() },
      payload: { branchId, externalId, customerReference: 'Synthetic standalone request', priority: 'normal', description: 'No calls authorized at creation' } });
    assert.equal(reply.statusCode, 201, reply.body); return reply.json();
  }
  it('creates standalone jobs without calls and supports completion without an acknowledgement', async () => {
    const counts = () => pool.query('SELECT (SELECT count(*) FROM relay.commitments) AS commitments,(SELECT count(*) FROM relay.attempts) AS attempts');
    const beforeCounts = (await counts()).rows[0];
    const initial = await standalone(), id = initial.job.id;
    assert.equal(initial.acknowledgement, null); assert.equal(initial.job.acknowledgementId, null);
    assert.ok(initial.job.attentionReasons.includes('unassigned'));
    await ok(id, { action: 'assign', assigneeId: responderId });
    await ok(id, { action: 'start', note: 'Starting ordinary scheduled work' }, responder);
    await ok(id, { action: 'report_completion', note: 'Ordinary work completed' }, responder);
    const done = await ok(id, { action: 'confirm_completion', note: 'Completion report reviewed' });
    assert.equal(done.job.status, 'completed'); assert.equal(done.acknowledgement, null);
    assert.deepEqual(done.job.attentionReasons, []); assert.deepEqual((await counts()).rows[0], beforeCounts);
  });
  it('deduplicates standalone creation and rejects unauthorised creation', async () => {
    const key = randomUUID(), input = { branchId, externalId: `RETRY-${randomUUID()}`, customerReference: 'Retry fixture', priority: 'normal' };
    const request = () => app.inject({ method: 'POST', url: '/api/relay/v1/jobs', headers: { ...dispatcher, 'idempotency-key': key }, payload: input });
    const [first, second] = await Promise.all([request(), request()]);
    assert.equal(first.statusCode, 201, first.body); assert.deepEqual(first.json(), second.json());
    assert.equal((await app.inject({ method: 'POST', url: '/api/relay/v1/jobs', headers: { ...responder, 'idempotency-key': randomUUID() }, payload: input })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/relay/v1/jobs', headers: { ...otherTenant, 'idempotency-key': randomUUID() }, payload: { ...input, externalId: randomUUID() } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/relay/v1/jobs', headers: { ...dispatcher, 'idempotency-key': key }, payload: { ...input, priority: 'changed' } })).statusCode, 409);
  });
  it('starts an explicit acknowledgement atomically, validates readiness and preserves exact retries', async () => {
    const initial = await standalone(), id = initial.job.id;
    const key = randomUUID(), input = { expectedVersion: initial.job.version, dueAt: new Date(Date.now() + 3_600_000).toISOString() };
    const request = () => app.inject({ method: 'POST', url: `/api/relay/v1/jobs/${id}/acknowledgement`, headers: { ...dispatcher, 'idempotency-key': key }, payload: input });
    const blocked = await request(); assert.equal(blocked.statusCode, 422, blocked.body);
    assert.equal(blocked.json().error, 'contacts_not_ready'); assert.equal((await detail(id)).job.version, initial.job.version);
    assert.equal((await pool.query('SELECT 1 FROM relay.commitments WHERE tenant_id=$1 AND commitment_id=$2', [tenantId, id])).rowCount, 0);
    await pool.query(`INSERT INTO relay.contacts(tenant_id,person_id,phone,phone_verified_at) VALUES($1,$2,'+16045550123',clock_timestamp())
      ON CONFLICT(tenant_id,person_id) DO UPDATE SET phone=EXCLUDED.phone,phone_verified_at=EXCLUDED.phone_verified_at`, [tenantId, responderId]);
    const [started, replay] = await Promise.all([request(), request()]);
    assert.equal(started.statusCode, 200, started.body); assert.deepEqual(started.json(), replay.json());
    assert.equal(started.json().job.acknowledgementId, id); assert.equal(started.json().job.version, initial.job.version + 1);
    assert.equal(started.json().acknowledgement.policy.steps[0].recipientIds[0], responderId);
    assert.equal((await detail(id)).events.filter((event: { kind: string }) => event.kind === 'acknowledgement_started').length, 1);
    assert.equal((await pool.query('SELECT 1 FROM relay.commitments WHERE tenant_id=$1 AND commitment_id=$2', [tenantId, id])).rowCount, 1);
    const changed = await app.inject({ method: 'POST', url: `/api/relay/v1/jobs/${id}/acknowledgement`, headers: { ...dispatcher, 'idempotency-key': key }, payload: { ...input, expectedVersion: initial.job.version + 1 } });
    assert.equal(changed.statusCode, 409);
    const repeatNewKey = await app.inject({ method: 'POST', url: `/api/relay/v1/jobs/${id}/acknowledgement`, headers: { ...dispatcher, 'idempotency-key': randomUUID() }, payload: { ...input, expectedVersion: started.json().job.version } });
    assert.equal(repeatNewKey.json().error, 'acknowledgement_exists');
    await resolveAcknowledgement(id);
    const owned = await detail(id); assert.equal(owned.job.assigneeId, responderId); assert.equal(owned.job.status, 'requested');
  });
  it('serializes acknowledgement start against another job mutation and rejects stale intent', async () => {
    const initial = await standalone(), id = initial.job.id, version = initial.job.version;
    const result = await Promise.all([
      app.inject({ method: 'POST', url: `/api/relay/v1/jobs/${id}/acknowledgement`, headers: { ...dispatcher, 'idempotency-key': randomUUID() }, payload: { expectedVersion: version, dueAt: new Date(Date.now() + 3_600_000).toISOString() } }),
      action(id, { action: 'add_update', note: 'Competing operator update' }, dispatcher, version),
    ]);
    assert.deepEqual(result.map((reply) => reply.statusCode).sort(), [200, 409]);
    assert.equal((await detail(id)).job.version, version + 1);
    const other = await standalone(); await ok(other.job.id, { action: 'cancel', note: 'Ordinary request withdrawn' });
    const terminal = await app.inject({ method: 'POST', url: `/api/relay/v1/jobs/${other.job.id}/acknowledgement`, headers: { ...dispatcher, 'idempotency-key': randomUUID() }, payload: { expectedVersion: 2, dueAt: new Date(Date.now() + 3_600_000).toISOString() } });
    assert.equal(terminal.json().error, 'job_closed');
  });
  it('filters and counts more than 200 jobs before pagination, with scope-safe overview totals', async () => {
    const prefix = `QUERY-${randomUUID()}`;
    const records = Array.from({ length: 205 }, (_, index) => {
      const job = newStandaloneJob({ branchId, externalId: `${prefix}-${index}`, customerReference: index === 0 ? 'Needle oldest record' : 'Query fixture', priority: 'normal' }, randomUUID(), new Date(Date.now() - (206 - index) * 60000).toISOString());
      if (index === 0) job.assigneeId = responderId;
      if (index === 1) { job.status = 'scheduled'; job.scheduledAt = new Date(Date.now() - 60000).toISOString(); }
      if (index === 2) job.status = 'completion_reported';
      if (index === 3) job.status = 'completed';
      return job;
    });
    const before = (await app.inject({ method: 'GET', url: '/api/relay/v1/jobs/overview', headers: dispatcher })).json();
    await pool.query(`INSERT INTO relay.jobs(tenant_id,id,branch_id,acknowledgement_id,status,version,snapshot,created_at,updated_at)
      SELECT $1,item->>'id',$2,NULL,item->>'status',1,item,(item->>'createdAt')::timestamptz,(item->>'updatedAt')::timestamptz FROM jsonb_array_elements($3::jsonb) item`, [tenantId, branchId, JSON.stringify(records)]);
    const get = async (query: string, headers = dispatcher) => {
      const reply = await app.inject({ method: 'GET', url: `/api/relay/v1/jobs?view=all&search=${encodeURIComponent(prefix)}${query}`, headers });
      assert.equal(reply.statusCode, 200, reply.body); return reply.json();
    };
    const first = await get(''); assert.equal(first.total, 205); assert.equal(first.items.length, 200); assert.equal(first.hasMore, true);
    const second = await get('&offset=200'); assert.equal(second.total, 205); assert.equal(second.items.length, 5);
    const mine = await get('&filter=mine', responder); assert.equal(mine.total, 1); assert.equal(mine.items[0].id, records[0]!.id);
    assert.equal((await get(`&ownerId=${responderId}`)).total, 1);
    assert.equal((await get('&status=completed')).total, 1);
    const scheduled = await get('&status=scheduled&filter=attention'); assert.equal(scheduled.total, 1); assert.ok(scheduled.items[0].attentionReasons.includes('missed_start'));
    assert.equal((await get('', otherTenant)).total, 0); assert.equal((await get('', otherBranch)).total, 0);
    assert.equal((await app.inject({ method: 'GET', url: `/api/relay/v1/jobs?branchId=${branchId}`, headers: otherBranch })).statusCode, 403);
    const after = (await app.inject({ method: 'GET', url: '/api/relay/v1/jobs/overview', headers: dispatcher })).json();
    assert.equal(after.active, before.active + 204); assert.equal(after.completionReview, before.completionReview + 1);
    const search = await app.inject({ method: 'GET', url: '/api/relay/v1/jobs?search=Needle%20oldest%20record', headers: dispatcher });
    assert.equal(search.json().total, 1); assert.equal(search.json().items[0].id, records[0]!.id);
  });
  it('provides a scoped cross-job commitments inbox with ownership and current versions', async () => {
    const prefix = `PROMISE-${randomUUID()}`, initial = await standalone();
    const jobId = initial.job.id;
    const first = await ok(jobId, { action: 'add_milestone', title: `${prefix} technician`, ownerId: responderId, dueAt: new Date(Date.now() - 60000).toISOString() });
    await ok(jobId, { action: 'add_milestone', title: `${prefix} colleague`, ownerId: outsiderId, dueAt: new Date(Date.now() + 60000).toISOString() });
    const get = async (query = '', headers = dispatcher) => {
      const response = await app.inject({ method: 'GET', url: `/api/relay/v1/job-commitments?search=${prefix}${query}`, headers });
      assert.equal(response.statusCode, 200, response.body); return response.json();
    };
    assert.equal((await get()).total, 2);
    const mine = await get('&filter=mine', responder); assert.equal(mine.total, 1); assert.equal(mine.items[0].jobVersion, 3);
    assert.equal(mine.items[0].job.id, jobId); assert.equal(mine.items[0].milestone.ownerId, responderId);
    assert.equal((await get('', otherTenant)).total, 0); assert.equal((await get('', otherBranch)).total, 0);
    await ok(jobId, { action: 'complete_milestone', milestoneId: first.milestones[0].id, note: 'Technician promise delivered' }, responder);
    assert.equal((await get('&view=completed&filter=mine', responder)).total, 1);
    await ok(jobId, { action: 'cancel', note: 'Follow-up request withdrawn' });
    assert.equal((await get()).total, 0); assert.equal((await get('&view=all')).total, 2);
  });
  it('derives acknowledgement and delivery attention before any worker cycle', async () => {
    const initial = await create(), id = initial.job.id, past = new Date(Date.now() - 60_000).toISOString();
    // Synthetic overdue and exhausted fixtures; no provider or worker is invoked.
    await pool.query("UPDATE relay.commitments SET snapshot=jsonb_set(snapshot,'{dueAt}',to_jsonb($3::text)) WHERE tenant_id=$1 AND commitment_id=$2", [tenantId, id, past]);
    await pool.query(`INSERT INTO relay.attempts(tenant_id,branch_id,attempt_id,commitment_id,step_index,recipient_id,person_id,channel,phone,status,available_at,last_error)
      VALUES($1,$2,$3,$4,0,$5,$5,'voice','+16045550123','exhausted',clock_timestamp(),'synthetic_failure')`, [tenantId, branchId, randomUUID(), id, responderId]);
    const current = await detail(id);
    assert.deepEqual(current.job.attentionReasons, ['unassigned','acknowledgement_unowned','acknowledgement_overdue','delivery_problem']);
    const reply = await app.inject({ method: 'GET', url: `/api/relay/v1/jobs?search=${initial.job.externalId}&filter=attention`, headers: dispatcher });
    assert.equal(reply.json().total, 1); assert.deepEqual(reply.json().items[0].attentionReasons, current.job.attentionReasons);
  });
  it('paginates global commitments after applying ownership and search filters', async () => {
    const initial = await standalone(), prefix = `PAGED-PROMISE-${randomUUID()}`;
    const now = new Date().toISOString();
    const milestones = Array.from({ length: 205 }, (_, index) => ({ id: randomUUID(), title: `${prefix}-${index}`, ownerId: responderId,
      dueAt: new Date(Date.now() + (index + 1) * 60000).toISOString(), status: 'open', completedAt: null, completedBy: null, createdAt: now, updatedAt: now }));
    await pool.query(`INSERT INTO relay.job_milestones(tenant_id,job_id,id,status,due_at,snapshot)
      SELECT $1,$2,item->>'id','open',(item->>'dueAt')::timestamptz,item FROM jsonb_array_elements($3::jsonb) item`, [tenantId, initial.job.id, JSON.stringify(milestones)]);
    const request = (offset: number) => app.inject({ method: 'GET', url: `/api/relay/v1/job-commitments?search=${prefix}&filter=mine&offset=${offset}`, headers: responder });
    const first = (await request(0)).json(), second = (await request(200)).json();
    assert.equal(first.total, 205); assert.equal(first.items.length, 200); assert.equal(first.hasMore, true);
    assert.equal(second.total, 205); assert.equal(second.items.length, 5); assert.equal(second.hasMore, false);
    const others = await app.inject({ method: 'GET', url: `/api/relay/v1/job-commitments?search=${prefix}&filter=mine`, headers: colleague });
    assert.equal(others.json().total, 0);
  });
  it('blocks cancelled tenants from the new job endpoints', async () => {
    const initial = await create();
    await pool.query("INSERT INTO relay.deletion_tombstones(tenant_id,cancelled_at,backup_delete_by) VALUES($1,statement_timestamp(),statement_timestamp()+interval '30 days')", [tenantId]);
    const list = await app.inject({ method: 'GET', url: '/api/relay/v1/jobs?view=all', headers: dispatcher });
    assert.equal(list.statusCode, 401);
    const mutation = await action(initial.job.id, { action: 'add_update', note: 'Blocked after cancellation' }, dispatcher, initial.job.version);
    assert.equal(mutation.statusCode, 401);
  });

});

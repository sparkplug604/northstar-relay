import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseRelayEmail, actionTokenHash, opaqueActionToken, type EmailCandidate } from '../../../packages/relay-adapters/src/index.js';
import { RelayPostgresStore, RelayStoreError, requestDigest } from '../../../packages/relay-storage-postgres/src/index.js';
import { RelayAuthentication, encryptSecret, type RelayAuth } from './relay/auth.js';
import { authorizeBranch, createWorkOrder, authorizeIntakeBranch, intakeActorId, intakeActorTenant, isRelaySourceActor, validateSourceActor, type RelayIntakeActor, type RelaySourceActor } from './relay/work-orders.js';
import { relayIdempotencyKey, type RelayIntegrationOptions } from './relay-integrations.js';

const sourceFields = z.object({
  externalId:z.string().trim().min(1).max(200), customerReference:z.string().trim().min(1).max(200),
  priority:z.string().trim().min(1).max(80), dueAt:z.iso.datetime({ offset:true }), sourceReceivedAt:z.iso.datetime({ offset:true }),
  note:z.string().max(4000).optional(),
}).strict();
type IntakeRow = { id:string; branch_id:string; candidate:EmailCandidate; status:string; commitment_id:string|null; review_reason:string|null; received_at:Date|string };
const safeIntake = (row:IntakeRow) => ({ id:row.id, branchId:row.branch_id, status:row.status, fields:row.candidate.fields, reasons:row.review_reason ? [...row.candidate.reasons,row.review_reason] : row.candidate.reasons, provenance:row.candidate.provenance, parserVersion:row.candidate.parserVersion, receivedAt:new Date(row.received_at).toISOString(), commitmentId:row.commitment_id });

export async function registerRelayIntake(app:FastifyInstance, config:RelayIntegrationOptions):Promise<void> {
  const auth = new RelayAuthentication(config);
  const {store} = config; const base='/api/relay/v1';
  async function operator(request:FastifyRequest, mutation=false):Promise<RelayAuth> {
    const actor=await auth.authorize(request,{roles:['organization_admin','branch_dispatcher']});
    if(mutation) auth.csrf(request,actor);
    return actor;
  }
  async function load(actor:RelayAuth,id:string):Promise<IntakeRow> {
    const row=await store.tenantTx(actor.organization.id,async client=>(await client.query('SELECT * FROM relay.intake WHERE tenant_id=$1 AND id=$2',[actor.organization.id,id])).rows[0]);
    if(!row) throw new RelayStoreError('intake_not_found','Intake item not found',404);
    authorizeBranch(actor,String(row.branch_id));
    return row as IntakeRow;
  }
  async function promote(actor:RelayIntakeActor,row:IntakeRow,fields:z.infer<typeof sourceFields>,key:string) {
    const tenantId=intakeActorTenant(actor),actorId=intakeActorId(actor);
    authorizeIntakeBranch(actor,row.branch_id);
    await store.tenantTx(tenantId,client=>validateSourceActor(client,actor,row.branch_id));
    if(row.status==='promoted') {
      if (requestDigest(fields) !== requestDigest(row.candidate.fields)) throw new RelayStoreError('intake_already_promoted','This intake already created a job. Open that job to record an update; changing the original intake is not supported');
      return safeIntake(row);
    }
    // Each reviewed request has its own durable receipt. A rejected automatic command
    // must not poison later corrections. Source identity remains the uniqueness guard.
    async function recoverPromotion() {
      const existing=await store.tenantTx(tenantId,async client=>(await client.query('SELECT snapshot,note FROM relay.commitments WHERE tenant_id=$1 AND branch_id=$2 AND source_kind=\'email\' AND source_message_id=$3',[tenantId,row.branch_id,row.id])).rows[0]);
      if(!existing) return null;
      const state=existing.snapshot;
      const prior={externalId:state.workOrder.externalId,customerReference:state.workOrder.customerReference,priority:state.workOrder.priority,dueAt:state.dueAt,sourceReceivedAt:state.workOrder.sourceReceivedAt,note:existing.note||''};
      if(requestDigest(prior)!==requestDigest({...fields,note:fields.note||''})) throw new RelayStoreError('intake_already_promoted','A different correction already created this work order');
      return {commitment:state};
    }
    let result=await recoverPromotion();
    if(!result) {
      try { result=await createWorkOrder(store,actor,{branchId:row.branch_id,...fields,sourceKind:'email',sourceMessageId:row.id},`intake:${row.id}:${requestDigest(key).slice(0,32)}`); }
      catch(error) { result=await recoverPromotion(); if(!result) throw error; }
    }
    const changed=await store.tenantTx(tenantId,async client=>{
      await validateSourceActor(client,actor,row.branch_id);
      const current=(await client.query('SELECT * FROM relay.intake WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,row.id])).rows[0] as IntakeRow;
      if(current.status==='promoted') return current;
      const candidate={...current.candidate,fields,provenance:{...current.candidate.provenance,review:{source:isRelaySourceActor(actor)?'source_connection':'operator',value:actorId}}};
      const saved=(await client.query("UPDATE relay.intake SET status='promoted',commitment_id=$3,candidate=$4,review_reason=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *",[tenantId,row.id,result.commitment.commitmentId,candidate])).rows[0];
      await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,'intake_promoted',$3)",[tenantId,actorId,{intakeId:row.id,commitmentId:result.commitment.commitmentId,commandId:key}]);
      return saved as IntakeRow;
    });
    return safeIntake(changed);
  }
  async function receive(actor:RelayIntakeActor,branchId:string,connectionId:string,receiptId:string,rawEmail:string) {
    authorizeIntakeBranch(actor,branchId);
    const tenantId=intakeActorTenant(actor),actorId=intakeActorId(actor);
    const candidate=await parseRelayEmail(rawEmail,await store.now());
    const row=await store.tenantTx(tenantId,async client=>{
      await validateSourceActor(client,actor,branchId);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`intake:${tenantId}:${connectionId}:${receiptId}`]);
      const prior=(await client.query('SELECT * FROM relay.intake WHERE tenant_id=$1 AND connection_id=$2 AND receipt_id=$3',[tenantId,connectionId,receiptId])).rows[0];
      if(prior) {
        if(prior.content_hash!==candidate.contentHash) throw new RelayStoreError('intake_replay_conflict','Receipt identity was reused with different content');
        return prior as IntakeRow;
      }
      const branch=(await client.query('SELECT id FROM relay.branches WHERE tenant_id=$1 AND id=$2',[tenantId,branchId])).rows[0];
      if(!branch) throw new RelayStoreError('branch_not_found','Branch not found',404);
      const saved=(await client.query('INSERT INTO relay.intake(tenant_id,branch_id,id,connection_id,receipt_id,content_hash,candidate,status,raw_encrypted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[tenantId,branchId,randomUUID(),connectionId,receiptId,candidate.contentHash,candidate,candidate.status,encryptSecret(rawEmail,config.authEncryptionKey)])).rows[0];
      await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,'intake_received',$3)",[tenantId,actorId,{intakeId:saved.id,status:candidate.status,parserVersion:candidate.parserVersion}]);
      return saved as IntakeRow;
    });
    if(row.status==='parsed') {
      try { return await promote(actor,row,sourceFields.parse(row.candidate.fields),`auto:${row.id}`); }
      catch(error) {
        if(!(error instanceof RelayStoreError)) throw error;
        await store.tenantTx(tenantId,client=>client.query("UPDATE relay.intake SET status='needs_review',review_reason=$3 WHERE tenant_id=$1 AND id=$2 AND status<>'promoted'",[tenantId,row.id,error.code]));
        row.status='needs_review'; row.review_reason=error.code;
      }
    }
    return safeIntake(row);
  }

  app.get(`${base}/intake`,async request=>{
    const actor=await operator(request);
    const query=z.object({status:z.enum(['all','pending','parsed','needs_review','rejected','promoted']).default('all'),
      search:z.string().trim().max(200).default(''),branchId:z.string().min(1).optional(),
      offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict().parse(request.query);
    if(query.branchId) authorizeBranch(actor,query.branchId);
    const branchId=query.branchId??(actor.user.role==='organization_admin'?null:actor.user.branchId);
    return store.tenantTx(actor.organization.id,async client=>{
      const where=`tenant_id=$1 AND ($2::text IS NULL OR branch_id=$2)
        AND ($3='all' OR status=$3 OR ($3='pending' AND status IN ('parsed','needs_review')))
        AND ($4='' OR strpos(lower(coalesce(candidate->'fields'->>'externalId','')||' '||coalesce(candidate->'fields'->>'customerReference','')),lower($4))>0)`;
      const params=[actor.organization.id,branchId,query.status,query.search];
      const result=(await client.query(`WITH filtered AS (
        SELECT id,branch_id,candidate,status,commitment_id,review_reason,received_at FROM relay.intake WHERE ${where}
      ), page AS (SELECT * FROM filtered ORDER BY received_at DESC,id LIMIT 200 OFFSET $5)
      SELECT (SELECT count(*)::int FROM filtered) AS total,
        coalesce(jsonb_agg(page ORDER BY received_at DESC,id),'[]'::jsonb) AS items FROM page`,[...params,query.offset])).rows[0];
      const hasMore=query.offset+result.items.length<result.total;
      return {items:result.items.map((row:IntakeRow)=>safeIntake(row)),total:result.total,hasMore,nextOffset:hasMore?query.offset+200:null};
    });
  });
  app.post(`${base}/intake`,{bodyLimit:600*1024},async request=>{
    const actor=await operator(request,true);
    const input=z.object({branchId:z.string().min(1),rawEmail:z.string().min(1).max(512*1024)}).strict().parse(request.body);
    return receive(actor,input.branchId,`manual:${input.branchId}`,relayIdempotencyKey(request),input.rawEmail);
  });
  app.post(`${base}/intake/:id/promote`,async request=>{
    const actor=await operator(request,true);
    const id=z.string().min(1).parse((request.params as {id:string}).id);
    return promote(actor,await load(actor,id),sourceFields.parse(request.body),relayIdempotencyKey(request));
  });

  app.get(`${base}/intake/connections`,async request=>{
    const actor=await operator(request);
    return store.tenantTx(actor.organization.id,async client=>({items:(await client.query('SELECT id,branch_id AS "branchId",name,active FROM relay.source_connections WHERE tenant_id=$1 AND ($2::text IS NULL OR branch_id=$2)',[actor.organization.id,actor.user.role==='organization_admin'?null:actor.user.branchId])).rows}));
  });
  app.post(`${base}/intake/connections`,async request=>{
    const actor=await operator(request,true);
    const input=z.object({branchId:z.string().min(1),name:z.string().min(1).max(100)}).strict().parse(request.body);
    authorizeBranch(actor,input.branchId);
    const id=randomUUID(),token=opaqueActionToken();
    await store.tenantTx(actor.organization.id,async client=>{
      await client.query('INSERT INTO relay.source_connections(tenant_id,branch_id,id,name,token_hash) VALUES($1,$2,$3,$4,$5)',[actor.organization.id,input.branchId,id,input.name,actionTokenHash(token)]);
      await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,'source_connection_created',$3)",[actor.organization.id,actor.user.id,{connectionId:id}]);
    });
    return {id,token,url:`${config.publicOrigin}${base}/inbound/${id}`,warning:'Store this credential securely. Configure only an approved Canadian receiving service.'};
  });

  app.patch(`${base}/intake/connections/:id`,async request=>{
    const actor=await operator(request,true);
    const input=z.object({active:z.literal(false)}).strict().parse(request.body);
    const id=z.string().uuid().parse((request.params as {id:string}).id);
    await store.tenantTx(actor.organization.id,async client=>{
      const row=(await client.query('SELECT branch_id FROM relay.source_connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.organization.id,id])).rows[0];
      if(!row) throw new RelayStoreError('source_not_found','Source connection not found',404);
      authorizeBranch(actor,row.branch_id);
      await client.query('UPDATE relay.source_connections SET active=$3 WHERE tenant_id=$1 AND id=$2',[actor.organization.id,id,input.active]);
      await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,'source_connection_revoked',$3)",[actor.organization.id,actor.user.id,{connectionId:id}]);
    });
    return {active:false};
  });

  app.post(`${base}/inbound/:id`,{bodyLimit:600*1024},async request=>{
    const token=request.headers.authorization?.replace(/^Bearer /,'');
    if(!token || token.length>200) throw new RelayStoreError('intake_unauthorized','Invalid intake credentials',401);
    const id=z.string().uuid().parse((request.params as {id:string}).id);
    const input=z.object({receiptId:z.string().min(1).max(200),rawEmail:z.string().min(1).max(512*1024)}).strict().parse(request.body);
    const organizations=(await store.pool.query('SELECT id,name FROM relay.organizations o WHERE NOT EXISTS(SELECT 1 FROM relay.deletion_tombstones d WHERE d.tenant_id=o.id)')).rows;
    for(const organization of organizations) {
      const match=await store.tenantTx(String(organization.id),async client=>(await client.query('SELECT * FROM relay.source_connections WHERE tenant_id=$1 AND id=$2 AND token_hash=$3 AND active',[organization.id,id,actionTokenHash(token)])).rows[0]);
      if(!match) continue;
      const actor:RelaySourceActor={kind:'source_connection',tenantId:String(organization.id),branchId:String(match.branch_id),connectionId:id};
      // Credential belongs to this fixed connection; the body cannot select another tenant/branch.
      return receive(actor,String(match.branch_id),id,input.receiptId,input.rawEmail);
    }
    throw new RelayStoreError('intake_unauthorized','Invalid intake credentials',401);
  });
}

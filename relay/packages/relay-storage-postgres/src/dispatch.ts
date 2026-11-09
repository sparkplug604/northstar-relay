import type {PoolClient} from 'pg';
import type {Job,TechnicianPlanning,TechnicianProfile,TechnicianMatches} from '@northstar/relay-domain';
import {assertJobScope,type JobScope} from './jobs.js';
import {RelayStoreError,type RelayPostgresStore,requestDigest} from './store.js';
import {checkTechnician} from './dispatch-check.js';

export async function lockDispatchBranch(client:PoolClient,tenant:string,branch:string){
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['dispatch:'+tenant+':'+branch]);
}
export async function readTechnicians(client:PoolClient,scope:JobScope,branch?:string):Promise<TechnicianPlanning[]>{
  await assertJobScope(client,scope,branch);
  const result=await client.query(`SELECT m.person_id,m.branch_id,p.display_name,t.version,t.profile
    FROM relay.memberships m JOIN relay.people p ON p.id=m.person_id
    LEFT JOIN relay.technician_planning t ON t.tenant_id=m.tenant_id AND t.person_id=m.person_id
    WHERE m.tenant_id=$1 AND p.active AND m.role='on_call_responder'
      AND ($2::text IS NULL OR m.branch_id=$2)
      AND ($3::boolean OR m.branch_id=$4)
    ORDER BY p.display_name FOR SHARE OF m,p`,
    [scope.tenantId,branch??null,scope.role==='organization_admin',scope.branchId]);
  return result.rows.map(row=>({personId:row.person_id,branchId:row.branch_id,displayName:row.display_name,
    version:row.version??0,profile:row.profile??null}));
}
export function listTechnicians(store:RelayPostgresStore,scope:JobScope){
  return store.tenantTx(scope.tenantId,async client=>({items:await readTechnicians(client,scope)}));
}
export async function matches(client:PoolClient,scope:JobScope,job:Job,onlyPerson?:string):Promise<TechnicianMatches>{
  const people=await readTechnicians(client,scope,job.branchId);
  const jobs=(await client.query("SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND branch_id=$2 AND status NOT IN ('completed','cancelled','completion_reported')",
    [scope.tenantId,job.branchId])).rows.map(row=>row.snapshot as Job);
  const now=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  const candidates=[];
  for(const person of people){
    if(onlyPerson&&person.personId!==onlyPerson)continue;
    candidates.push(await checkTechnician(job,person,jobs,now));
  }
  const rank={available:0,needs_check:1,blocked:2};
  candidates.sort((a,b)=>rank[a.status]-rank[b.status]||
    a.travel.reduce((sum,leg)=>sum+(leg.minutes??0),0)-b.travel.reduce((sum,leg)=>sum+(leg.minutes??0),0)||a.displayName.localeCompare(b.displayName));
  return {jobId:job.id,jobVersion:job.version,scheduledAt:job.scheduledAt,estimatedMinutes:job.estimatedMinutes??null,
    checkedAt:now,candidates};
}
export function getTechnicianMatches(store:RelayPostgresStore,scope:JobScope,id:string){
  return store.tenantTx(scope.tenantId,async client=>{
    const job=(await client.query('SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND id=$2',[scope.tenantId,id])).rows[0]?.snapshot as Job|undefined;
    if(!job)throw new RelayStoreError('job_not_found','Job not found',404);
    await assertJobScope(client,scope,job.branchId);
    return matches(client,scope,job);
  });
}
export function saveTechnician(store:RelayPostgresStore,scope:JobScope,personId:string,input:{expectedVersion:number;profile:TechnicianProfile},key:string){
  if(!['organization_admin','branch_dispatcher'].includes(scope.role))throw new RelayStoreError('forbidden','Only dispatch can change technician availability',403);
  const digest=requestDigest({personId,input,actor:scope.actorId});
  return store.tenantTx(scope.tenantId,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['planning-command:'+scope.tenantId+':'+key]);
    const person=(await readTechnicians(client,scope)).find(person=>person.personId===personId);
    if(!person)throw new RelayStoreError('person_not_found','Technician not found',404);
    await lockDispatchBranch(client,scope.tenantId,person.branchId);
    const prior=(await client.query('SELECT request_digest,outcome FROM relay.planning_commands WHERE tenant_id=$1 AND command_id=$2',[scope.tenantId,key])).rows[0];
    if(prior){
      if(prior.request_digest!==digest)throw new RelayStoreError('idempotency_conflict','This command was already used',409);
      return prior.outcome as TechnicianPlanning;
    }
    const current=(await client.query('SELECT version FROM relay.technician_planning WHERE tenant_id=$1 AND person_id=$2',[scope.tenantId,personId])).rows[0];
    if((current?.version??0)!==input.expectedVersion)throw new RelayStoreError('planning_version_conflict','Availability changed. Reload before saving.',409);
    const version=input.expectedVersion+1;
    await client.query(`INSERT INTO relay.technician_planning(tenant_id,person_id,branch_id,version,profile)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,person_id)
      DO UPDATE SET profile=EXCLUDED.profile,version=EXCLUDED.version,updated_at=clock_timestamp()`,
      [scope.tenantId,personId,person.branchId,version,input.profile]);
    const outcome={...person,version,profile:input.profile};
    await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,'technician_planning_updated',$3)",
      [scope.tenantId,scope.actorId,{personId,version}]);
    await client.query('INSERT INTO relay.planning_commands(tenant_id,command_id,request_digest,outcome) VALUES($1,$2,$3,$4)',[scope.tenantId,key,digest,outcome]);
    return outcome;
  });
}

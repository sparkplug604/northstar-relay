import {randomUUID} from 'node:crypto';
import {DateTime} from 'luxon';
import {dispatchZone} from './timezone.js';
import type {Job,TechnicianCandidate} from '@northstar/relay-domain';
import type {PoolClient} from 'pg';
import {assertJobScope,applyJobAction,type JobScope} from './jobs.js';
import {lockDispatchBranch,readTechnicians} from './dispatch.js';
import {checkTechnician,workingPeriods} from './dispatch-check.js';
import {RelayStoreError,type RelayPostgresStore} from './store.js';

export interface AssignmentProposal {
  personId:string;displayName:string;scheduledAt:string;endsAt:string;jobVersion:number;reason:string;key:string;
}
interface Search {notBefore?:string|undefined;excludePersonIds?:string[]|undefined}
async function readJob(client:PoolClient,scope:JobScope,id:string):Promise<Job>{
  const row=(await client.query('SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND id=$2',[scope.tenantId,id])).rows[0];
  if(!row)throw new RelayStoreError('job_not_found','Job not found',404);
  const job=row.snapshot as Job;
  await assertJobScope(client,scope,job.branchId);
  return job;
}
export async function assignmentOptions(store:RelayPostgresStore,scope:JobScope,id:string,search:Search={}){
  return store.tenantTx(scope.tenantId,async client=>{
    const job=await readJob(client,scope,id);
    const people=await readTechnicians(client,scope,job.branchId);
    const jobs=(await client.query("SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND branch_id=$2 AND status NOT IN ('completed','cancelled','completion_reported')",[scope.tenantId,job.branchId])).rows.map(row=>row.snapshot as Job);
    const now=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
    const current=(await client.query('SELECT revision,proposal FROM relay.assignment_proposals WHERE tenant_id=$1 AND job_id=$2',[scope.tenantId,id])).rows[0];
    const start=Math.max(Date.parse(now)+15*60000,Date.parse(job.serviceWindow?.earliestStart??now),Date.parse(search.notBefore??now));
    const horizonEnd=start+14*86400000;
    const finish=Math.min(horizonEnd,job.serviceWindow?.completeBy?Date.parse(job.serviceWindow.completeBy):horizonEnd);
    const options:(TechnicianCandidate&{scheduledAt:string;endsAt:string})[]=[];
    const unavailable:TechnicianCandidate[]=[];
    for(const person of people){
      if(search.excludePersonIds?.includes(person.personId))continue;
      const unknown=await checkTechnician({...job,scheduledAt:null},person,jobs,now);
      // This workflow searches for the time; do not ask the dispatcher to set one first.
      unknown.reasons=unknown.reasons.filter(reason=>reason!=='Set a scheduled time for this job.');
      const missing= !person.profile || job.requiredSkills===undefined || !job.estimatedMinutes || !job.site;
      if(missing||unknown.status==='blocked'||!['requested','scheduled'].includes(job.status)){
        unavailable.push(unknown);continue;
      }
      let found=0;
      let last:TechnicianCandidate|undefined;
      const periods=workingPeriods(person.profile,start-86400000,finish);
      for(const period of periods){
        let slot=Math.ceil(Math.max(start,period.start)/900000)*900000;
        while(slot+job.estimatedMinutes!*60000<=Math.min(period.end,finish)&&found<3){
          const scheduledAt=new Date(slot).toISOString();
          last=await checkTechnician({...job,scheduledAt},person,jobs,now);
          if(last.status==='available'){
            options.push({...last,scheduledAt,endsAt:new Date(slot+job.estimatedMinutes!*60000).toISOString()});
            found++;slot+=3600000;
          }else slot+=900000;
        }
        if(found>=3)break;
      }
      if(!found)unavailable.push(last??{...unknown,status:'blocked',reasons:['No suitable opening was found within the client window and the next 14 days.']});
    }
    options.sort((a,b)=>Date.parse(a.scheduledAt)-Date.parse(b.scheduledAt)||
      a.travel.reduce((sum,leg)=>sum+(leg.minutes??0),0)-b.travel.reduce((sum,leg)=>sum+(leg.minutes??0),0));
    const proposal=(current?.proposal??null) as AssignmentProposal|null;
    const timezone=(await client.query('SELECT timezone FROM relay.branches WHERE tenant_id=$1 AND id=$2',[scope.tenantId,job.branchId])).rows[0]?.timezone??'America/Vancouver';
    const label=(instant:string)=>DateTime.fromISO(instant,{setZone:true}).setZone(dispatchZone(timezone)).toFormat("ccc, LLL d, h:mm a 'UTC'ZZ");
    const labelledProposal=proposal?{...proposal,startLabel:label(proposal.scheduledAt),endLabel:label(proposal.endsAt)}:null;
    const receipt=proposal?(await client.query("SELECT envelope FROM relay.job_events WHERE tenant_id=$1 AND job_id=$2 AND envelope->>'note' LIKE $3 ORDER BY aggregate_version DESC LIMIT 1",
      [scope.tenantId,id,'%['+proposal.key+']'])).rows[0]?.envelope??null:null;
    return {job,timezone,clientDeadlineLabel:job.serviceWindow?.completeBy?label(job.serviceWindow.completeBy):null,earliestStartLabel:job.serviceWindow?.earliestStart?label(job.serviceWindow.earliestStart):null,revision:Number(current?.revision??0),proposal:labelledProposal,receipt,
      flags:proposal&&!receipt&&proposal.jobVersion!==job.version?['The job changed. Ask for a fresh proposal.']:[],
      checkedAt:now,searchedUntil:new Date(finish).toISOString(),
      options:options.filter(option=>!proposal||option.personId!==proposal.personId||option.scheduledAt!==proposal.scheduledAt)
        .map(option=>({...option,startLabel:label(option.scheduledAt),endLabel:label(option.endsAt)})),unavailable,
      timingRecorded:job.serviceWindow!==undefined};
  });
}
export async function proposeAssignment(store:RelayPostgresStore,scope:JobScope,id:string,input:{
  revision:number;jobVersion:number;personId:string;scheduledAt:string;reason:string;
}){
  await store.tenantTx(scope.tenantId,async client=>{
    const job=await readJob(client,scope,id);
    await lockDispatchBranch(client,scope.tenantId,job.branchId);
    const current=await readJob(client,scope,id);
    if(current.version!==input.jobVersion)throw new RelayStoreError('job_version_conflict','The job changed. Read it again.',409);
    if(!current.serviceWindow)throw new RelayStoreError('client_timing_missing','Record client timing before proposing an assignment',409);
    if(!['requested','scheduled'].includes(current.status))throw new RelayStoreError('invalid_job_state','Only jobs awaiting a visit can be assigned here',409);
    const people=await readTechnicians(client,scope,current.branchId);
    const person=people.find(person=>person.personId===input.personId);
    if(!person)throw new RelayStoreError('person_not_found','Technician not found',404);
    const jobs=(await client.query("SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND branch_id=$2 AND status NOT IN ('completed','cancelled','completion_reported')",[scope.tenantId,current.branchId])).rows.map(row=>row.snapshot as Job);
    const now=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
    const evaluation=await checkTechnician({...current,scheduledAt:input.scheduledAt},person,jobs,now);
    if(evaluation.status!=='available')throw new RelayStoreError('technician_unavailable',evaluation.reasons.join(' '),409);
    await client.query('INSERT INTO relay.assignment_proposals(tenant_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[scope.tenantId,id]);
    const proposal:AssignmentProposal={personId:person.personId,displayName:person.displayName,scheduledAt:input.scheduledAt,
      endsAt:new Date(Date.parse(input.scheduledAt)+current.estimatedMinutes!*60000).toISOString(),
      jobVersion:current.version,reason:input.reason,key:randomUUID()};
    const changed=await client.query('UPDATE relay.assignment_proposals SET revision=revision+1,proposal=$4 WHERE tenant_id=$1 AND job_id=$2 AND revision=$3',
      [scope.tenantId,id,input.revision,proposal]);
    if(changed.rowCount!==1)throw new RelayStoreError('proposal_conflict','The proposal changed. Read it again.',409);
  });
  return assignmentOptions(store,scope,id);
}
export async function applyAssignment(store:RelayPostgresStore,scope:JobScope,id:string,revision:number){
  const proposal=await store.tenantTx(scope.tenantId,async client=>{
    await readJob(client,scope,id);
    const row=(await client.query('SELECT revision,proposal FROM relay.assignment_proposals WHERE tenant_id=$1 AND job_id=$2',[scope.tenantId,id])).rows[0];
    if(!row?.proposal||row.revision!==revision)throw new RelayStoreError('proposal_conflict','The proposal changed. Review it again.',409);
    return row.proposal as AssignmentProposal;
  });
  return applyJobAction(store,scope,id,{action:'assign_visit',assigneeId:proposal.personId,scheduledAt:proposal.scheduledAt,
    expectedVersion:proposal.jobVersion,note:'Assignment approved · '+proposal.reason+' ['+proposal.key+']'},'assignment:'+proposal.key,async client=>{
      const current=(await client.query('SELECT revision,proposal FROM relay.assignment_proposals WHERE tenant_id=$1 AND job_id=$2',[scope.tenantId,id])).rows[0];
      if(current?.revision!==revision||current?.proposal?.key!==proposal.key)throw new RelayStoreError('proposal_conflict','The proposal changed. Review the latest option before approving.',409);
    });
}

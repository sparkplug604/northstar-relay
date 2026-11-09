import {DateTime} from 'luxon';
import {dispatchZone} from './timezone.js';
import {lockDispatchBranch,matches} from './dispatch.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  authorizeJobActor, createJob, deriveJob, JobTransitionError, transitionJob,
  type Job, type JobAction, type JobActor, type JobDetail, type JobEvent, type JobMilestone, type RelayCommitment,
} from '@northstar/relay-domain';
import { RelayStoreError, requestDigest, type RelayPostgresStore } from './store.js';

export interface JobScope { tenantId: string; actorId: string; role: JobActor['role']; branchId: string }

export async function assertJobScope(client: PoolClient, scope: JobScope, branchId?: string): Promise<void> {
  const member = (await client.query(`SELECT m.role,m.branch_id,p.active FROM relay.memberships m
    JOIN relay.people p ON p.id=m.person_id WHERE m.tenant_id=$1 AND m.person_id=$2 FOR SHARE OF m,p`,
  [scope.tenantId, scope.actorId])).rows[0];
  if (!member?.active || member.role !== scope.role || member.branch_id !== scope.branchId
    || (branchId !== undefined && scope.role !== 'organization_admin' && member.branch_id !== branchId)) {
    throw new RelayStoreError('forbidden', 'Your membership does not authorize this job', 403);
  }
}

async function validateAssignee(client: PoolClient, tenantId: string, branchId: string, personId: string): Promise<void> {
  const member = (await client.query(`SELECT m.person_id FROM relay.memberships m JOIN relay.people p ON p.id=m.person_id
    WHERE m.tenant_id=$1 AND m.branch_id=$2 AND m.person_id=$3 AND p.active FOR SHARE OF m,p`, [tenantId, branchId, personId])).rows[0];
  if (!member) throw new RelayStoreError('assignee_invalid', 'Choose an active member of this job’s branch', 422);
}

export async function persistJobEvent(client: PoolClient, tenantId: string, job: Job, event: JobEvent): Promise<void> {
  await client.query(`INSERT INTO relay.job_events(tenant_id,job_id,id,aggregate_version,envelope,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6)`, [tenantId, job.id, event.id, job.version, event, event.occurredAt]);
}

/** Called inside the acknowledgement transaction; ownership never completes the job. */
export async function synchronizeAcknowledgementJob(client: PoolClient, previous: RelayCommitment | null,
  acknowledgement: RelayCommitment, description: string, actorId: string, now: string): Promise<void> {
  const tenantId = acknowledgement.tenantId;
  if (previous === null) {
    const existing = (await client.query('SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, acknowledgement.commitmentId])).rows[0]?.snapshot as Job | undefined;
    if (existing) {
      if (existing.acknowledgementId || ['completed', 'cancelled'].includes(existing.status)) throw new RelayStoreError('acknowledgement_not_available', 'This job cannot start another acknowledgement', 409);
      const linked = { ...existing, acknowledgementId: acknowledgement.commitmentId, version: existing.version + 1, updatedAt: now };
      await client.query('UPDATE relay.jobs SET acknowledgement_id=$3,snapshot=$4,version=$5,updated_at=$6 WHERE tenant_id=$1 AND id=$2', [tenantId, existing.id, acknowledgement.commitmentId, linked, linked.version, now]);
      await persistJobEvent(client, tenantId, linked, { id: randomUUID(), kind: 'acknowledgement_started', actorId, occurredAt: now, note: 'An acknowledgement contact sequence was explicitly started.', details: { acknowledgementId: acknowledgement.commitmentId, dueAt: acknowledgement.dueAt } });
      return;
    }
    const job = createJob(acknowledgement, description, now);
    await client.query(`INSERT INTO relay.jobs(tenant_id,id,branch_id,acknowledgement_id,status,version,snapshot,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [tenantId, job.id, job.branchId, job.acknowledgementId, job.status, job.version, job, now]);
    await persistJobEvent(client, tenantId, job, { id: randomUUID(), kind: 'job_created', actorId, occurredAt: now,
      note: description, details: { acknowledgementId: acknowledgement.commitmentId } });
    return;
  }
  if (previous.ownerRecipientId !== null || acknowledgement.ownerRecipientId === null) return;
  const personId = acknowledgement.recipients.find((item) => item.recipientId === acknowledgement.ownerRecipientId)?.personId;
  if (!personId) return;
  const row = (await client.query('SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, acknowledgement.commitmentId])).rows[0];
  const current = row?.snapshot as Job | undefined;
  if (!current || current.assigneeId || ['completed', 'cancelled', 'completion_reported'].includes(current.status)) return;
  try { await validateAssignee(client, tenantId, current.branchId, personId); }
  catch (error) { if (error instanceof RelayStoreError && error.code === 'assignee_invalid') return; throw error; }
  const job: Job = { ...current, assigneeId: personId, version: current.version + 1, updatedAt: now };
  await client.query('UPDATE relay.jobs SET snapshot=$3,version=$4,updated_at=$5 WHERE tenant_id=$1 AND id=$2', [tenantId, job.id, job, job.version, now]);
  await persistJobEvent(client, tenantId, job, { id: randomUUID(), kind: 'job_assigned', actorId, occurredAt: now,
    note: 'Assigned when acknowledgement ownership was accepted.', details: { assigneeId: personId, source: 'acknowledgement' } });
}

export async function readJobDetail(client: PoolClient, scope: JobScope, id: string, lockedJob?: Job): Promise<JobDetail> {
  const job = lockedJob ?? (await client.query('SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND id=$2 FOR SHARE', [scope.tenantId, id])).rows[0]?.snapshot as Job | undefined;
  if (!job) throw new RelayStoreError('job_not_found', 'Job not found', 404);
  await assertJobScope(client, scope, job.branchId);
  const asOf: string = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  const milestones = (await client.query('SELECT snapshot FROM relay.job_milestones WHERE tenant_id=$1 AND job_id=$2 ORDER BY due_at,id', [scope.tenantId, id])).rows.map((row) => row.snapshot as JobMilestone);
  const events = (await client.query('SELECT envelope FROM relay.job_events WHERE tenant_id=$1 AND job_id=$2 ORDER BY aggregate_version', [scope.tenantId, id])).rows.map((row) => row.envelope as JobEvent);
  const acknowledgement = ((await client.query('SELECT snapshot FROM relay.commitments WHERE tenant_id=$1 AND commitment_id=$2', [scope.tenantId, job.acknowledgementId])).rows[0]?.snapshot ?? null) as RelayCommitment | null;
  const deliveryProblem = (await client.query("SELECT 1 FROM relay.attempts WHERE tenant_id=$1 AND commitment_id=$2 AND status IN ('failed','uncertain','exhausted') LIMIT 1", [scope.tenantId, job.acknowledgementId])).rowCount! > 0;
  const timezone=job.serviceWindow?(await client.query('SELECT timezone FROM relay.branches WHERE tenant_id=$1 AND id=$2',[scope.tenantId,job.branchId])).rows[0]?.timezone:undefined;
  const label=(instant:string)=>DateTime.fromISO(instant,{setZone:true}).setZone(dispatchZone(timezone??'UTC')).toFormat("ccc, LLL d, h:mm a 'UTC'ZZ");
  const clientTiming=job.serviceWindow?{timezone:timezone??'UTC',
    completeByLabel:job.serviceWindow.completeBy?label(job.serviceWindow.completeBy):null,
    earliestStartLabel:job.serviceWindow.earliestStart?label(job.serviceWindow.earliestStart):null}:undefined;
  return { job: {...deriveJob(job, milestones, asOf, acknowledgement, deliveryProblem),...(clientTiming?{clientTiming}:{})}, milestones, events, acknowledgement, asOf };
}

export function getJob(store: RelayPostgresStore, scope: JobScope, id: string): Promise<JobDetail> {
  return store.tenantTx(scope.tenantId, (client) => readJobDetail(client, scope, id));
}
export { listJobs, jobsOverview, listJobCommitments } from './jobs-query.js';
export { createStandaloneJob, startJobAcknowledgement } from './jobs-create.js';

export async function applyJobAction(store: RelayPostgresStore, scope: JobScope, id: string, input: JobAction, key: string, guard?:(client:PoolClient)=>Promise<void>): Promise<JobDetail> {
  const digest = requestDigest({ id, input, actorId: scope.actorId });
  try {
    return await store.tenantTx(scope.tenantId, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`job-command:${scope.tenantId}:${key}`]);
      const branchRow=(await client.query('SELECT branch_id FROM relay.jobs WHERE tenant_id=$1 AND id=$2',[scope.tenantId,id])).rows[0];
      if(branchRow)await lockDispatchBranch(client,scope.tenantId,branchRow.branch_id);
      const job = (await client.query('SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [scope.tenantId, id])).rows[0]?.snapshot as Job | undefined;
      if (!job) throw new RelayStoreError('job_not_found', 'Job not found', 404);
      await assertJobScope(client, scope, job.branchId);
      const actor = { id: scope.actorId, role: scope.role };
      const milestones = (await client.query('SELECT snapshot FROM relay.job_milestones WHERE tenant_id=$1 AND job_id=$2 ORDER BY due_at,id', [scope.tenantId, id])).rows.map((row) => row.snapshot as JobMilestone);
      authorizeJobActor(job, actor, milestones, input);
      const prior = (await client.query('SELECT request_digest,outcome FROM relay.job_commands WHERE tenant_id=$1 AND command_id=$2', [scope.tenantId, key])).rows[0];
      if (prior) {
        if (prior.request_digest !== digest) throw new RelayStoreError('idempotency_conflict', 'This idempotency key was used with different input');
        return prior.outcome as JobDetail;
      }
      await guard?.(client);
      if (input.action === 'cancel' || input.action === 'confirm_completion') {
        const acknowledgement = (await client.query('SELECT snapshot FROM relay.commitments WHERE tenant_id=$1 AND commitment_id=$2',
          [scope.tenantId, job.acknowledgementId])).rows[0]?.snapshot as RelayCommitment;
        if (acknowledgement && acknowledgement.ownerRecipientId === null && ['scheduled', 'active', 'breached'].includes(acknowledgement.status)) {
          throw new RelayStoreError('acknowledgement_unresolved', 'Resolve or cancel the acknowledgement before closing this job; its calls are still independent', 409);
        }
      }
      if (input.action === 'assign'||input.action === 'assign_visit') await validateAssignee(client, scope.tenantId, job.branchId, input.assigneeId);
      if (input.action === 'add_milestone') await validateAssignee(client, scope.tenantId, job.branchId, input.ownerId);
      const now: string = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
      if(input.action==='assign'&&input.checkAvailability){
        if(!['organization_admin','branch_dispatcher'].includes(scope.role))throw new RelayStoreError('forbidden','Only dispatch can approve an assignment',403);
        const evaluation=await matches(client,scope,job,input.assigneeId);
        if(evaluation.candidates[0]?.status!=='available')throw new RelayStoreError('technician_unavailable','Availability changed or needs checking. Find a technician again before approving.',409);
      }
      if(input.action==='assign_visit'){
        if(!['organization_admin','branch_dispatcher'].includes(scope.role))throw new RelayStoreError('forbidden','Only dispatch can approve a visit',403);
        if(!job.serviceWindow)throw new RelayStoreError('client_timing_missing','Record client timing before approving a visit',409);
        const evaluated=await matches(client,scope,{...job,scheduledAt:input.scheduledAt},input.assigneeId);
        if(evaluated.candidates[0]?.status!=='available')throw new RelayStoreError('technician_unavailable','This technician or time no longer fits. Refresh the proposal.',409);
      }
      const outcome = transitionJob(job, milestones, input, actor, now, randomUUID(), randomUUID());
      await client.query('UPDATE relay.jobs SET status=$3,version=$4,snapshot=$5,updated_at=$6 WHERE tenant_id=$1 AND id=$2', [scope.tenantId, id, outcome.job.status, outcome.job.version, outcome.job, now]);
      for (const milestone of outcome.milestones) {
        await client.query(`INSERT INTO relay.job_milestones(tenant_id,job_id,id,status,due_at,snapshot) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(tenant_id,id) DO UPDATE SET status=EXCLUDED.status,due_at=EXCLUDED.due_at,snapshot=EXCLUDED.snapshot`,
        [scope.tenantId, id, milestone.id, milestone.status, milestone.dueAt, milestone]);
      }
      if(input.action==='assign'&&input.checkAvailability)outcome.event.note='Dispatcher approved assignment after checking working hours, time off, skills, booked visits and estimated road travel.';
      await persistJobEvent(client, scope.tenantId, outcome.job, outcome.event);
      await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,$3,$4)",
        [scope.tenantId, scope.actorId, `job:${input.action}`, { jobId: id, commandId: key, version: outcome.job.version }]);
      const detail = await readJobDetail(client, scope, id, outcome.job);
      await client.query('INSERT INTO relay.job_commands(tenant_id,command_id,job_id,request_digest,outcome) VALUES($1,$2,$3,$4,$5)', [scope.tenantId, key, id, digest, detail]);
      return detail;
    });
  } catch (error) {
    if (error instanceof JobTransitionError) throw new RelayStoreError(error.code, error.message, error.statusCode);
    throw error;
  }
}

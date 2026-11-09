import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { newStandaloneJob, type Job, type JobDetail, type RelayCommand, type StandaloneJobInput } from '@northstar/relay-domain';
import { RelayStoreError, requestDigest, type RelayPostgresStore } from './store.js';
import { assertJobScope, persistJobEvent, readJobDetail, type JobScope } from './jobs.js';

function requireDispatcher(scope: JobScope): void {
  if (!['organization_admin', 'branch_dispatcher'].includes(scope.role)) throw new RelayStoreError('forbidden', 'A dispatcher or administrator must perform this action', 403);
}
async function priorCommand(client: PoolClient, scope: JobScope, key: string, digest: string): Promise<JobDetail | null> {
  const prior = (await client.query('SELECT request_digest,outcome FROM relay.job_commands WHERE tenant_id=$1 AND command_id=$2', [scope.tenantId, key])).rows[0];
  if (!prior) return null;
  if (prior.request_digest !== digest) throw new RelayStoreError('idempotency_conflict', 'This idempotency key was used with different input');
  await assertJobScope(client, scope, (prior.outcome as JobDetail).job.branchId);
  return prior.outcome as JobDetail;
}
async function receipt(client: PoolClient, scope: JobScope, key: string, digest: string, detail: JobDetail, action: string): Promise<void> {
  await client.query('INSERT INTO relay.job_commands(tenant_id,command_id,job_id,request_digest,outcome) VALUES($1,$2,$3,$4,$5)', [scope.tenantId, key, detail.job.id, digest, detail]);
  await client.query('INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,$3,$4)', [scope.tenantId, scope.actorId, action, { jobId: detail.job.id, commandId: key }]);
}

export function createStandaloneJob(store: RelayPostgresStore, scope: JobScope, input: StandaloneJobInput, key: string): Promise<JobDetail> {
  requireDispatcher(scope);
  const digest = requestDigest({ action: 'create_job', actorId: scope.actorId, input });
  return store.tenantTx(scope.tenantId, async (client) => {
    await assertJobScope(client, scope, input.branchId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`job-command:${scope.tenantId}:${key}`]);
    const prior = await priorCommand(client, scope, key, digest); if (prior) return prior;
    if (!(await client.query('SELECT 1 FROM relay.branches WHERE tenant_id=$1 AND id=$2', [scope.tenantId, input.branchId])).rowCount) throw new RelayStoreError('branch_not_found', 'Branch not found', 404);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`job-external:${scope.tenantId}:${input.branchId}:${input.externalId}`]);
    if ((await client.query("SELECT 1 FROM relay.jobs WHERE tenant_id=$1 AND branch_id=$2 AND snapshot->>'externalId'=$3", [scope.tenantId, input.branchId, input.externalId])).rowCount) throw new RelayStoreError('job_exists', 'A job with this reference already exists in the branch', 409);
    const now: string = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
    const job = newStandaloneJob(input, requestDigest([scope.tenantId, 'standalone-job', key]).slice(0, 32), now);
    await client.query(`INSERT INTO relay.jobs(tenant_id,id,branch_id,acknowledgement_id,status,version,snapshot,created_at,updated_at)
      VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$7)`, [scope.tenantId, job.id, job.branchId, job.status, job.version, job, now]);
    await persistJobEvent(client, scope.tenantId, job, { id: randomUUID(), kind: 'job_created', actorId: scope.actorId, occurredAt: now,
      note: job.description, details: { standalone: true, acknowledgementId: null } });
    const detail = await readJobDetail(client, scope, job.id, job);
    await receipt(client, scope, key, digest, detail, 'job:created');
    return detail;
  });
}

export type ResolveJobRecipients = (client: PoolClient, tenantId: string, branchId: string, fallback: string[], now: string) => Promise<{ recipientIds: string[]; routingSource: string }>;
export function startJobAcknowledgement(store: RelayPostgresStore, scope: JobScope, id: string, input: { expectedVersion: number; dueAt: string }, key: string, resolveRecipients: ResolveJobRecipients): Promise<JobDetail> {
  requireDispatcher(scope);
  const digest = requestDigest({ action: 'start_acknowledgement', actorId: scope.actorId, id, input });
  const commandId = `job-ack:${key}`;
  return store.tenantTx(scope.tenantId, async (client) => {
    // Match the acknowledgement store's command -> commitment -> job lock order.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`job-command:${scope.tenantId}:${key}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`command:${scope.tenantId}:${commandId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`commitment:${scope.tenantId}:${id}`]);
    const job = (await client.query('SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [scope.tenantId, id])).rows[0]?.snapshot as Job | undefined;
    if (!job) throw new RelayStoreError('job_not_found', 'Job not found', 404);
    await assertJobScope(client, scope, job.branchId);
    const prior = await priorCommand(client, scope, key, digest); if (prior) return prior;
    if (job.version !== input.expectedVersion) throw new RelayStoreError('job_version_conflict', 'This job changed. Reload before saving.', 409);
    if (job.acknowledgementId) throw new RelayStoreError('acknowledgement_exists', 'This job already has an acknowledgement sequence', 409);
    if (['completed', 'cancelled'].includes(job.status)) throw new RelayStoreError('job_closed', 'Reopen the job before starting an acknowledgement', 422);
    const now: string = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
    if (Date.parse(input.dueAt) <= Date.parse(now)) throw new RelayStoreError('future_time_required', 'Choose a future ownership deadline', 422);
    const settings = (await client.query('SELECT * FROM relay.settings WHERE tenant_id=$1 AND branch_id=$2 FOR SHARE', [scope.tenantId, job.branchId])).rows[0];
    if (!settings) throw new RelayStoreError('settings_not_ready', 'Configure this branch’s on-call settings first', 422);
    const routing = await resolveRecipients(client, scope.tenantId, job.branchId, settings.recipient_ids as string[], now);
    const ids = routing.recipientIds;
    if (!ids.length || new Set(ids).size !== ids.length) throw new RelayStoreError('recipients_required', 'Configure an on-call recipient list first', 422);
    const people = (await client.query(`SELECT p.id,p.display_name,c.phone,c.phone_verified_at FROM relay.memberships m
      JOIN relay.people p ON p.id=m.person_id JOIN relay.contacts c ON c.tenant_id=m.tenant_id AND c.person_id=m.person_id
      WHERE m.tenant_id=$1 AND m.branch_id=$2 AND p.id=ANY($3::text[]) AND p.active FOR SHARE OF m,p,c`, [scope.tenantId, job.branchId, ids])).rows;
    if (people.length !== ids.length || people.some((person) => !person.phone_verified_at || !/^\+[1-9]\d{7,14}$/.test(person.phone ?? ''))) throw new RelayStoreError('contacts_not_ready', 'Every selected on-call person needs an active account and verified phone number', 422);
    const recipients = ids.map((personId) => ({ recipientId: personId, personId, displayName: String(people.find((person) => person.id === personId)!.display_name), contactMethodId: `contact:${personId}` }));
    const command: RelayCommand = {
      type: 'create_commitment', commandId, tenantId: scope.tenantId, commitmentId: id, branchId: job.branchId, workOrderId: id,
      actorId: scope.actorId, actorRole: scope.role, occurredAt: now, correlationId: key, activatesAt: now, dueAt: input.dueAt,
      workOrder: { externalId: job.externalId, customerReference: job.customerReference, priority: job.priority, sourceKind: 'manual', sourceMessageId: `job:${id}`, sourceReceivedAt: job.createdAt },
      recipients, policy: { policyId: `branch:${job.branchId}`, version: Number(settings.version), name: `Branch on-call order (${routing.routingSource})`,
        steps: ids.map((personId, index) => ({ stepId: `step:${index}`, offsetSeconds: index * Number(settings.interval_seconds), recipientIds: [personId], channels: settings.channels, terminal: index === ids.length - 1 })) },
    };
    const outcome = await store.applyCommand(command, digest, job.description, undefined, client);
    if (outcome.status === 'rejected') throw new RelayStoreError(outcome.code, outcome.reason, 422);
    const detail = await readJobDetail(client, scope, id);
    await receipt(client, scope, key, digest, detail, 'job:acknowledgement_started');
    return detail;
  });
}

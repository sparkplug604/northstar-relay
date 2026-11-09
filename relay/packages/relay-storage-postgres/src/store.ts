import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { handleRelayCommand, type EscalationStepSnapshot, type RelayCommand, type RelayCommandOutcome, type RelayCommitment } from '@northstar/relay-domain';
import { synchronizeAcknowledgementJob } from './jobs.js';

export class RelayStoreError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 409) { super(message); }
}

export function requestDigest(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)]));
    return item;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function nextActionAt(state: RelayCommitment): string | null {
  if (state.status === 'scheduled') return state.activatesAt;
  if (state.ownerRecipientId !== null || !['active', 'breached'].includes(state.status)) return null;
  const dates = [state.nextEscalationAt, state.breachedAt === null ? new Date(Date.parse(state.dueAt) + 1).toISOString() : null].filter((item): item is string => item !== null);
  return dates.length === 0 ? null : dates.sort()[0]!;
}

export class RelayPostgresStore {
  constructor(public readonly pool: Pool) {}
  static fromConnectionString(url: string): RelayPostgresStore {
    if (!url) throw new Error('RELAY_DATABASE_URL is required');
    return new RelayPostgresStore(new Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 5000, statement_timeout: 15000 }));
  }
  async close(): Promise<void> { await this.pool.end(); }
  async assertRestrictedRuntime(): Promise<void> {
    const result = await this.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    if (result.rows[0]?.rolsuper || result.rows[0]?.rolbypassrls) throw new Error('Relay production database role must not be a superuser or bypass row-level security');
  }
  async tenantTx<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('relay.tenant_id',$1,true)", [tenantId]);
      if ((await client.query('SELECT 1 FROM relay.deletion_tombstones WHERE tenant_id=$1', [tenantId])).rowCount) throw new RelayStoreError('tenant_cancelled', 'This organization is no longer active', 403);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async now(): Promise<string> { return (await this.pool.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString(); }
  async commandOutcome(tenantId: string, commandId: string, digest: string): Promise<RelayCommandOutcome | null> {
    return this.tenantTx(tenantId, async (client) => {
      const row = (await client.query('SELECT request_digest,outcome FROM relay.commands WHERE tenant_id=$1 AND command_id=$2', [tenantId, commandId])).rows[0];
      if (!row) return null;
      if (row.request_digest !== digest) throw new RelayStoreError('idempotency_conflict', 'This idempotency key was used with different input');
      return row.outcome as RelayCommandOutcome;
    });
  }

  async applyCommand(command: RelayCommand, digest?: string, note = '', guard?: (client: PoolClient, current: RelayCommitment | null, dbNow: string) => Promise<void>, transactionClient?: PoolClient): Promise<RelayCommandOutcome> {
    const { occurredAt: _occurredAt, correlationId: _correlationId, ...intent } = command;
    const expectedDigest = digest ?? requestDigest(intent);
    const execute = async (client: PoolClient): Promise<RelayCommandOutcome> => {
      // Explicit callers may compose atomic job/acknowledgement writes only inside a matching tenant transaction.
      if (transactionClient && (await client.query("SELECT current_setting('relay.tenant_id',true) AS tenant")).rows[0].tenant !== command.tenantId) {
        throw new RelayStoreError('tenant_transaction_mismatch', 'The command must run in its organization transaction', 403);
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`command:${command.tenantId}:${command.commandId}`]);
      const prior = (await client.query('SELECT request_digest,outcome FROM relay.commands WHERE tenant_id=$1 AND command_id=$2', [command.tenantId, command.commandId])).rows[0];
      if (prior) {
        if (prior.request_digest !== expectedDigest) throw new RelayStoreError('idempotency_conflict', 'This idempotency key was used with different input');
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`commitment:${command.tenantId}:${command.commitmentId}`]);
      const stored = (await client.query('SELECT snapshot FROM relay.commitments WHERE tenant_id=$1 AND commitment_id=$2 FOR UPDATE', [command.tenantId, command.commitmentId])).rows[0];
      const state = stored ? stored.snapshot as RelayCommitment : null;
      if (command.actorRole !== 'system') {
        const membership = (await client.query('SELECT m.role,m.branch_id,p.active FROM relay.memberships m JOIN relay.people p ON p.id=m.person_id WHERE m.tenant_id=$1 AND m.person_id=$2 FOR SHARE OF m,p', [command.tenantId, command.actorId])).rows[0];
        const branchId = state?.branchId ?? (command.type === 'create_commitment' ? command.branchId : null);
        if (!membership?.active || membership.role !== command.actorRole || (membership.role !== 'organization_admin' && membership.branch_id !== branchId)) throw new RelayStoreError('forbidden', 'Current organization membership does not authorize this action', 403);
      }
      if ((command.type === 'acknowledge_commitment' && command.mechanism !== 'dispatcher') || command.type === 'decline_commitment') {
        const recipientId = command.type === 'acknowledge_commitment' ? command.ownerRecipientId : command.recipientId;
        const attempt = (await client.query('SELECT attempt_id FROM relay.attempts WHERE tenant_id=$1 AND commitment_id=$2 AND attempt_id=$3 AND person_id=$4 AND recipient_id=$5', [command.tenantId, command.commitmentId, command.attemptId, command.actorId, recipientId])).rows[0];
        if (!attempt) throw new RelayStoreError('attempt_not_authorized', 'The communication attempt does not belong to this recipient', 403);
      }
      const dbNow: string = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
      if (guard) await guard(client, state, dbNow);
      if (prior) return prior.outcome as RelayCommandOutcome;
      const timed = { ...command, occurredAt: dbNow } as RelayCommand;
      const outcome = handleRelayCommand(state, timed);
      if (outcome.status === 'accepted') {
        const next = outcome.state;
        if (state === null) {
          try {
            await client.query('INSERT INTO relay.commitments(tenant_id,branch_id,commitment_id,work_order_id,external_id,source_kind,source_message_id,status,version,snapshot,note,next_action_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [next.tenantId, next.branchId, next.commitmentId, next.workOrderId, next.workOrder.externalId, next.workOrder.sourceKind, next.workOrder.sourceMessageId, next.status, next.version, next, note, nextActionAt(next)]);
          } catch (error) {
            if ((error as { code?: string }).code === '23505') throw new RelayStoreError('work_order_exists', 'This source work order already exists in the branch');
            throw error;
          }
        } else {
          await client.query('UPDATE relay.commitments SET status=$3,version=$4,snapshot=$5,next_action_at=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND commitment_id=$2', [next.tenantId, next.commitmentId, next.status, next.version, next, nextActionAt(next)]);
        }
        await synchronizeAcknowledgementJob(client, state, next, note, command.actorId, dbNow);
        for (const event of outcome.events) {
          await client.query('INSERT INTO relay.events(tenant_id,event_id,commitment_id,command_id,aggregate_version,event_type,occurred_at,envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [event.tenantId, event.eventId, event.commitmentId, event.commandId, event.aggregateVersion, event.eventType, event.occurredAt, event]);
          if (event.eventType === 'escalation_step_scheduled') {
            const stepIndex = event.payload.stepIndex as number;
            const step = event.payload.step as EscalationStepSnapshot;
            for (const recipientId of step.recipientIds) {
              if (next.declinedRecipientIds.includes(recipientId)) continue;
              const recipient = next.recipients.find((candidate) => candidate.recipientId === recipientId)!;
              const contact = (await client.query('SELECT c.phone,c.phone_verified_at,p.active FROM relay.contacts c JOIN relay.people p ON p.id=c.person_id WHERE c.tenant_id=$1 AND c.person_id=$2', [next.tenantId, recipient.personId])).rows[0];
              for (const channel of step.channels) {
                const eligible = contact?.phone && contact?.phone_verified_at && contact?.active;
                await client.query('INSERT INTO relay.attempts(tenant_id,branch_id,attempt_id,commitment_id,step_index,recipient_id,person_id,channel,phone,status,available_at,last_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(tenant_id,commitment_id,step_index,recipient_id,channel) DO NOTHING', [next.tenantId, next.branchId, randomUUID(), next.commitmentId, stepIndex, recipientId, recipient.personId, channel, contact?.phone ?? '', eligible ? 'pending' : 'exhausted', event.occurredAt, eligible ? null : 'contact_not_verified_or_inactive']);
              }
            }
          }
        }
        if (next.ownerRecipientId !== null || ['cancelled', 'closed', 'fulfilled'].includes(next.status)) {
          await client.query("UPDATE relay.attempts SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND commitment_id=$2 AND status IN ('pending','failed','leased')", [next.tenantId, next.commitmentId]);
        }
        if (command.type === 'acknowledge_commitment' && command.attemptId) await client.query("UPDATE relay.attempts SET status='acknowledged',updated_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2", [command.tenantId, command.attemptId]);
      }
      await client.query('INSERT INTO relay.commands(tenant_id,command_id,commitment_id,request_digest,outcome) VALUES($1,$2,$3,$4,$5)', [command.tenantId, command.commandId, command.commitmentId, expectedDigest, outcome]);
      await client.query('INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,$3,$4)', [command.tenantId, command.actorId, command.type, { commandId: command.commandId, commitmentId: command.commitmentId, status: outcome.status }]);
      return outcome;
    };
    return transactionClient ? execute(transactionClient) : this.tenantTx(command.tenantId, execute);
  }

  async getCommitment(tenantId: string, id: string): Promise<RelayCommitment | null> {
    return this.tenantTx(tenantId, async (client) => ((await client.query('SELECT snapshot FROM relay.commitments WHERE tenant_id=$1 AND commitment_id=$2', [tenantId, id])).rows[0]?.snapshot as RelayCommitment | undefined) ?? null);
  }
  async listCommitments(tenantId: string, branchId?: string): Promise<readonly { commitment: RelayCommitment; note: string }[]> {
    return this.tenantTx(tenantId, async (client) => (await client.query('SELECT snapshot,note FROM relay.commitments WHERE tenant_id=$1 AND ($2::text IS NULL OR branch_id=$2) ORDER BY created_at DESC LIMIT 200', [tenantId, branchId ?? null])).rows.map((row) => ({ commitment: row.snapshot as RelayCommitment, note: row.note as string })));
  }
  async listDueCommitments(limit = 100): Promise<readonly RelayCommitment[]> {
    const tenants = await this.pool.query('SELECT id FROM relay.organizations o WHERE NOT EXISTS(SELECT 1 FROM relay.deletion_tombstones d WHERE d.tenant_id=o.id) ORDER BY id');
    const due: RelayCommitment[] = [];
    for (const tenant of tenants.rows) {
      try {
        const states = await this.tenantTx(String(tenant.id), async (client) => (await client.query('SELECT snapshot FROM relay.commitments WHERE tenant_id=$1 AND next_action_at <= clock_timestamp() ORDER BY next_action_at LIMIT $2', [tenant.id, limit])).rows.map((row) => row.snapshot as RelayCommitment));
        due.push(...states);
      } catch (error) { if (!(error instanceof RelayStoreError && error.code === 'tenant_cancelled')) throw error; }
    }
    return due;
  }
}

export function createRelayStore(databaseUrl: string): RelayPostgresStore { return RelayPostgresStore.fromConnectionString(databaseUrl); }

import type { RelayCommand, RelayCommitment, WorkOrderSnapshot } from '@northstar/relay-domain';
import type { PoolClient } from 'pg';
import { RelayPostgresStore, RelayStoreError, requestDigest } from '../../../../packages/relay-storage-postgres/src/index.js';
import type { RelayAuth } from './auth.js';
import { resolveOnCallRecipients } from './schedules.js';
import { authorizeBranch } from './scope.js';
export { authorizeBranch } from './scope.js';

export interface WorkOrderInput {
  branchId: string; externalId: string; customerReference: string; priority: string; dueAt: string;
  note?: string | undefined; recipientIds?: string[] | undefined; sourceKind?: WorkOrderSnapshot['sourceKind'] | undefined; sourceMessageId?: string | undefined; sourceReceivedAt?: string | undefined;
}
export interface RelaySourceActor {
  readonly kind: 'source_connection'; readonly tenantId: string; readonly branchId: string; readonly connectionId: string;
}
export type RelayIntakeActor = RelayAuth | RelaySourceActor;
export function isRelaySourceActor(actor: RelayIntakeActor): actor is RelaySourceActor { return 'kind' in actor && actor.kind === 'source_connection'; }
export function intakeActorTenant(actor: RelayIntakeActor): string { return isRelaySourceActor(actor) ? actor.tenantId : actor.organization.id; }
export function intakeActorId(actor: RelayIntakeActor): string { return isRelaySourceActor(actor) ? `source:${actor.connectionId}` : actor.user.id; }
export function authorizeIntakeBranch(actor: RelayIntakeActor, branchId: string): void {
  if (!isRelaySourceActor(actor)) return authorizeBranch(actor, branchId);
  if (actor.branchId !== branchId) throw new RelayStoreError('source_branch_forbidden', 'The source credential is restricted to its configured branch', 403);
}
export async function validateSourceActor(client: PoolClient, actor: RelayIntakeActor, branchId: string): Promise<void> {
  if (!isRelaySourceActor(actor)) return;
  const source = (await client.query('SELECT id FROM relay.source_connections WHERE tenant_id=$1 AND branch_id=$2 AND id=$3 AND active FOR SHARE', [actor.tenantId, branchId, actor.connectionId])).rows[0];
  if (!source) throw new RelayStoreError('source_not_authorized', 'The source connection is inactive or does not belong to this branch', 403);
}
export async function requireWorkOrder(store: RelayPostgresStore, auth: RelayAuth, id: string): Promise<RelayCommitment> {
  const commitment = await store.getCommitment(auth.organization.id, id);
  if (!commitment) throw new RelayStoreError('work_order_not_found', 'Work order not found', 404);
  authorizeBranch(auth, commitment.branchId);
  return commitment;
}
export async function createWorkOrder(store: RelayPostgresStore, actor: RelayIntakeActor, input: WorkOrderInput, key: string): Promise<{ commitment: RelayCommitment }> {
  authorizeIntakeBranch(actor, input.branchId);
  if (!isRelaySourceActor(actor) && actor.user.role === 'on_call_responder') throw new RelayStoreError('forbidden', 'A dispatcher or administrator must create work orders', 403);
  const tenantId = intakeActorTenant(actor); const actorId = intakeActorId(actor);
  const actorRole = isRelaySourceActor(actor) ? 'system' : actor.user.role;
  if (isRelaySourceActor(actor)) await store.tenantTx(tenantId, (client) => validateSourceActor(client, actor, input.branchId));
  const digest = requestDigest({ action: 'create', userId: actorId, input });
  const replay = await store.commandOutcome(tenantId, key, digest);
  if (replay) {
    if (replay.status === 'rejected') throw new RelayStoreError(replay.code, replay.reason, 422);
    return { commitment: replay.state };
  }
  const now = await store.now();
  const commitmentId = requestDigest([tenantId, 'create', key]).slice(0, 32);
  const receivedOverdue = input.sourceKind !== undefined && input.sourceKind !== 'manual' && Date.parse(input.dueAt) <= Date.parse(now);
  const config = await store.tenantTx(tenantId, async (client) => {
    await validateSourceActor(client, actor, input.branchId);
    const settings = (await client.query('SELECT s.* FROM relay.settings s WHERE tenant_id=$1 AND branch_id=$2 FOR SHARE', [tenantId, input.branchId])).rows[0];
    if (!settings) throw new RelayStoreError('branch_not_found', 'Branch not found', 404);
    const routing = input.recipientIds ? { recipientIds: input.recipientIds, routingSource: 'manual-selection' } : await resolveOnCallRecipients(client, tenantId, input.branchId, settings.recipient_ids as string[], now);
    const ids = routing.recipientIds;
    if (ids.length === 0 || new Set(ids).size !== ids.length) throw new RelayStoreError('recipients_required', 'Configure an on-call recipient list first', 422);
    const rows = (await client.query('SELECT p.id,p.display_name FROM relay.memberships m JOIN relay.people p ON p.id=m.person_id WHERE m.tenant_id=$1 AND m.branch_id=$2 AND p.id=ANY($3::text[]) AND p.active', [tenantId, input.branchId, ids])).rows;
    if (rows.length !== ids.length) throw new RelayStoreError('recipient_invalid', 'Recipients must be active members of this branch', 422);
    return { version: Number(settings.version), routingSource: routing.routingSource, intervalSeconds: Number(settings.interval_seconds), channels: settings.channels as ('sms' | 'voice')[], recipients: ids.map((id) => ({ recipientId: id, personId: id, displayName: String(rows.find((row) => row.id === id)!.display_name), contactMethodId: `contact:${id}` })) };
  });
  const policy = {
    policyId: `branch:${input.branchId}`, version: config.version, name: `${receivedOverdue ? 'Overdue intake fallback' : 'Branch on-call order'} (${config.routingSource})`,
    steps: receivedOverdue ? [{ stepId: 'overdue-fallback', offsetSeconds: 0, recipientIds: config.recipients.map((recipient) => recipient.recipientId), channels: config.channels, terminal: true }] : config.recipients.map((recipient, index) => ({ stepId: `step:${index}`, offsetSeconds: index * config.intervalSeconds, recipientIds: [recipient.recipientId], channels: config.channels, terminal: index === config.recipients.length - 1 })),
  };
  const command: RelayCommand = {
    type: 'create_commitment', commandId: key, tenantId, commitmentId, branchId: input.branchId,
    workOrderId: commitmentId, actorId, actorRole, occurredAt: now, correlationId: key,
    ...(receivedOverdue ? { receivedOverdue: true } : {}),
    activatesAt: now, dueAt: input.dueAt, recipients: config.recipients, policy,
    workOrder: { externalId: input.externalId, sourceKind: input.sourceKind ?? 'manual', sourceMessageId: input.sourceMessageId ?? `manual:${key}`, customerReference: input.customerReference, priority: input.priority, sourceReceivedAt: input.sourceReceivedAt ?? now },
  };
  const outcome = await store.applyCommand(command, digest, input.note ?? '', (client) => validateSourceActor(client, actor, input.branchId));
  if (outcome.status === 'rejected') throw new RelayStoreError(outcome.code, outcome.reason, 422);
  return { commitment: outcome.state };
}

export async function actOnWorkOrder(store: RelayPostgresStore, auth: RelayAuth, id: string, input: { action: string; reason?: string | undefined; sourceStatus?: string | undefined; recipientId?: string | undefined }, key: string): Promise<{ commitment: RelayCommitment }> {
  const commitment = await requireWorkOrder(store, auth, id);
  const base = { commandId: key, tenantId: auth.organization.id, commitmentId: id, actorId: auth.user.id, actorRole: auth.user.role, occurredAt: await store.now(), correlationId: key };
  let command: RelayCommand;
  if (input.action === 'acknowledge' || input.action === 'decline') {
    const recipientId = auth.user.role === 'on_call_responder' ? auth.user.id : input.recipientId ?? (commitment.recipients.some((item) => item.personId === auth.user.id) ? auth.user.id : '');
    if (!recipientId) throw new RelayStoreError('recipient_required', 'Select the person taking ownership', 422);
    const attemptId = await store.tenantTx(auth.organization.id, async (client) => (await client.query('SELECT attempt_id FROM relay.attempts WHERE tenant_id=$1 AND commitment_id=$2 AND recipient_id=$3 ORDER BY created_at DESC LIMIT 1', [auth.organization.id, id, recipientId])).rows[0]?.attempt_id as string | undefined);
    command = input.action === 'acknowledge'
      ? { ...base, type: 'acknowledge_commitment', ownerRecipientId: recipientId, mechanism: auth.user.role === 'on_call_responder' ? 'web' : 'dispatcher', attemptId: attemptId ?? null }
      : { ...base, type: 'decline_commitment', recipientId, attemptId: attemptId ?? '' };
  } else if (input.action === 'cancel') command = { ...base, type: 'cancel_commitment', reason: input.reason ?? '' };
  else if (input.action === 'source_acceptance') command = { ...base, type: 'record_source_acceptance', sourceStatus: input.sourceStatus as 'pending' | 'accepted' | 'declined' | 'not_required' };
  else if (input.action === 'fulfill') command = { ...base, type: 'fulfill_commitment' };
  else if (input.action === 'close') command = { ...base, type: 'close_commitment', ...(input.reason !== undefined ? { reason: input.reason } : {}) };
  else throw new RelayStoreError('invalid_action', 'Unknown work-order action', 400);
  const outcome = await store.applyCommand(command, requestDigest({ userId: auth.user.id, id, input }));
  if (outcome.status === 'rejected') throw new RelayStoreError(outcome.code, outcome.reason, 422);
  return { commitment: outcome.state };
}

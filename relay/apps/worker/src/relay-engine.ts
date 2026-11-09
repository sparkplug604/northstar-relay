import { randomUUID } from "node:crypto";
import type { RelayCommand, RelayCommitment } from "../../../packages/relay-domain/src/index.js";
import { actionTokenHash, DefiniteDeliveryFailure, opaqueActionToken, type RelayProvider } from "../../../packages/relay-adapters/src/twilio.js";
import type { RelayPostgresStore } from "../../../packages/relay-storage-postgres/src/store.js";

export interface RelayEngineOptions {
  leaseSeconds?: number;
  retryLimit?: number;
  batchSize?: number;
  sendTimeoutMilliseconds?: number;
  /** Optional explicit tenant shard; authorization still comes from tenant transactions. */
  tenantIds?: readonly string[];
}
export interface RelayCycleResult {
  skippedOverlap: boolean;
  commitmentsExamined: number;
  transitionsAccepted: number;
  staleTimers: number;
  rejected: number;
  attemptsClaimed: number;
  notificationsSent: number;
  notificationsFailed: number;
  notificationsUncertain: number;
  notificationsCancelled: number;
}
interface LeasedAttempt {
  tenant_id: string;
  attempt_id: string;
  commitment_id: string;
  lease_token: string;
}
interface SendingAttempt extends LeasedAttempt {
  channel: "voice" | "sms";
  phone: string;
  attempts: number;
}
type WorkerStore = Pick<RelayPostgresStore, "pool" | "tenantTx" | "now" | "getCommitment" | "listDueCommitments" | "applyCommand">;

function emptyResult(): RelayCycleResult {
  return { skippedOverlap: false, commitmentsExamined: 0, transitionsAccepted: 0, staleTimers: 0, rejected: 0, attemptsClaimed: 0, notificationsSent: 0, notificationsFailed: 0, notificationsUncertain: 0, notificationsCancelled: 0 };
}

export class RelayEngine {
  private running = false;
  private nextTenantIndex = 0;
  private readonly options: Required<Omit<RelayEngineOptions, "tenantIds">>;
  private readonly tenantIds: readonly string[] | undefined;

  constructor(private readonly store: WorkerStore, private readonly provider: RelayProvider, options: RelayEngineOptions = {}) {
    this.options = { leaseSeconds: options.leaseSeconds ?? 30, retryLimit: options.retryLimit ?? 3, batchSize: options.batchSize ?? 50, sendTimeoutMilliseconds: options.sendTimeoutMilliseconds ?? 10_000 };
    this.tenantIds = options.tenantIds === undefined ? undefined : [...options.tenantIds];
    if (this.tenantIds?.some(id => !id.trim())) throw new Error("Tenant shard IDs cannot be blank");
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    }
    if (this.options.sendTimeoutMilliseconds >= this.options.leaseSeconds * 1_000) throw new Error("Provider timeout must be shorter than the delivery lease");
  }

  async runCycle(): Promise<RelayCycleResult> {
    const result = emptyResult();
    if (this.running) return { ...result, skippedOverlap: true };
    this.running = true;
    try {
      await this.advanceDue(result);
      const tenantIds = this.tenantIds ?? (await this.store.pool.query<{ id: string }>("SELECT id FROM relay.organizations o WHERE NOT EXISTS(SELECT 1 FROM relay.deletion_tombstones d WHERE d.tenant_id=o.id) ORDER BY id")).rows.map(row => row.id);
      for (const tenantId of tenantIds) {
        try {
          result.notificationsUncertain += await this.recover(tenantId);
        } catch (error) { if ((error as { code?: string }).code !== "tenant_cancelled") throw error; }
      }
      // Fair, globally bounded batches. Do not let 50 slow sends for one tenant
      // postpone all other tenants or their absolute deadline transitions.
      const deadline = performance.now() + this.options.sendTimeoutMilliseconds;
      let emptyTenants = 0;
      while (tenantIds.length && result.attemptsClaimed < this.options.batchSize && emptyTenants < tenantIds.length && performance.now() < deadline) {
        const tenantId = tenantIds[this.nextTenantIndex % tenantIds.length]!;
        this.nextTenantIndex = (this.nextTenantIndex + 1) % tenantIds.length;
        await this.advanceDue(result);
        try {
          const attempts = await this.claim(tenantId);
          if (!attempts.length) { emptyTenants += 1; continue; }
          emptyTenants = 0;
          result.attemptsClaimed += attempts.length;
          for (const attempt of attempts) await this.dispatch(attempt, result);
        } catch (error) { if ((error as { code?: string }).code !== 'tenant_cancelled') throw error; emptyTenants += 1; }
      }
      await this.advanceDue(result);
      return result;
    } finally {
      this.running = false;
    }
  }

  private async advanceDue(result: RelayCycleResult): Promise<void> {
    const due = (await this.store.listDueCommitments(this.options.batchSize)).filter(state => this.tenantIds === undefined || this.tenantIds.includes(state.tenantId));
    result.commitmentsExamined += due.length;
    for (const candidate of due) {
      try { await this.advance(candidate, result); }
      catch (error) { if ((error as { code?: string }).code !== 'tenant_cancelled') throw error; }
    }
  }

  private async advance(candidate: RelayCommitment, result: RelayCycleResult): Promise<void> {
    // A delayed worker processes each due policy step in order before the deadline event.
    for (let count = 0; count < candidate.policy.steps.length + 3; count += 1) {
      const state = await this.store.getCommitment(candidate.tenantId, candidate.commitmentId);
      if (!state || state.ownerRecipientId !== null) return;
      const now = await this.store.now();
      const command = this.timerCommand(state, now);
      if (!command) return;
      const outcome = await this.store.applyCommand(command);
      if (outcome.status === "accepted") result.transitionsAccepted += 1;
      else if (outcome.status === "duplicate" || outcome.status === "ignored_stale_timer") { result.staleTimers += 1; return; }
      else { result.rejected += 1; return; }
    }
  }

  private timerCommand(state: RelayCommitment, now: string): RelayCommand | null {
    const metadata = { tenantId: state.tenantId, commitmentId: state.commitmentId, actorId: "relay-worker", actorRole: "system" as const, occurredAt: now, correlationId: `timer:${state.commitmentId}:${state.version}` };
    if (state.status === "scheduled" && Date.parse(state.activatesAt) <= Date.parse(now)) {
      return { ...metadata, commandId: `activate:${state.commitmentId}:${state.version}`, type: "activate_commitment", expectedVersion: state.version, expectedDueAt: state.dueAt, expectedActivatesAt: state.activatesAt };
    }
    if (state.status !== "active" && state.status !== "breached") return null;
    if (state.nextEscalationAt !== null && Date.parse(state.nextEscalationAt) <= Date.parse(now)) {
      return { ...metadata, commandId: `step:${state.commitmentId}:${state.version}:${state.nextStepIndex}`, type: "schedule_escalation_step", expectedVersion: state.version, expectedStepIndex: state.nextStepIndex, expectedScheduledAt: state.nextEscalationAt };
    }
    if (state.breachedAt === null && Date.parse(state.dueAt) < Date.parse(now)) {
      return { ...metadata, commandId: `breach:${state.commitmentId}:${state.version}`, type: "mark_commitment_breached", expectedVersion: state.version, expectedDueAt: state.dueAt };
    }
    return null;
  }

  private async recover(tenantId: string): Promise<number> {
    return this.store.tenantTx(tenantId, async (client) => {
      const uncertain = await client.query<{ attempt_id: string }>("UPDATE relay.attempts SET status='uncertain',lease_token=NULL,lease_expires_at=NULL,last_error='sending_lease_expired',updated_at=clock_timestamp() WHERE tenant_id=$1 AND status='sending' AND lease_expires_at<=clock_timestamp() RETURNING attempt_id", [tenantId]);
      for (const row of uncertain.rows) await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,'relay-worker','delivery_uncertain',$2)", [tenantId, { attemptId: row.attempt_id, reason: "sending_lease_expired" }]);
      await client.query("UPDATE relay.attempts SET status='exhausted',lease_token=NULL,lease_expires_at=NULL,last_error='retry_limit_reached',updated_at=clock_timestamp() WHERE tenant_id=$1 AND status IN ('pending','failed','leased') AND attempts >= $2 AND (status<>'leased' OR lease_expires_at<=clock_timestamp())", [tenantId, this.options.retryLimit]);
      return uncertain.rows.length;
    });
  }

  private async claim(tenantId: string): Promise<LeasedAttempt[]> {
    return this.store.tenantTx(tenantId, async (client) => (await client.query<LeasedAttempt>(`
      WITH due AS (
        SELECT tenant_id,attempt_id FROM relay.attempts
        WHERE tenant_id=$1 AND attempts<$2 AND available_at<=clock_timestamp()
          AND (status IN ('pending','failed') OR (status='leased' AND lease_expires_at<=clock_timestamp()))
        ORDER BY available_at,created_at,attempt_id FOR UPDATE SKIP LOCKED LIMIT $3
      )
      UPDATE relay.attempts a SET status='leased',lease_token=$4,
        lease_expires_at=clock_timestamp()+($5 * interval '1 second'),updated_at=clock_timestamp()
      FROM due WHERE a.tenant_id=due.tenant_id AND a.attempt_id=due.attempt_id
      RETURNING a.tenant_id,a.attempt_id,a.commitment_id,a.lease_token`,
    [tenantId, this.options.retryLimit, 1, randomUUID(), this.options.leaseSeconds])).rows);
  }

  private async prepare(attempt: LeasedAttempt, tokenHash: string): Promise<SendingAttempt | null> {
    return this.store.tenantTx(attempt.tenant_id, async (client) => {
      // Use the same lock order as commands so ownership cannot be half-committed.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`commitment:${attempt.tenant_id}:${attempt.commitment_id}`]);
      const row = (await client.query<{ snapshot: RelayCommitment }>("SELECT snapshot FROM relay.commitments WHERE tenant_id=$1 AND commitment_id=$2 FOR UPDATE", [attempt.tenant_id, attempt.commitment_id])).rows[0];
      const current = (await client.query<SendingAttempt & { recipient_id: string; person_id: string; status: string; valid_lease: boolean }>("SELECT *,lease_expires_at>clock_timestamp() AS valid_lease FROM relay.attempts WHERE tenant_id=$1 AND attempt_id=$2 FOR UPDATE", [attempt.tenant_id, attempt.attempt_id])).rows[0];
      if (!current || current.status !== "leased" || current.lease_token !== attempt.lease_token || !current.valid_lease) return null;
      const state = row?.snapshot;
      const contact = (await client.query<{ phone: string; phone_verified_at: Date | null; active: boolean; branch_id: string; role: string }>("SELECT c.phone,c.phone_verified_at,p.active,m.branch_id,m.role FROM relay.contacts c JOIN relay.people p ON p.id=c.person_id JOIN relay.memberships m ON m.tenant_id=c.tenant_id AND m.person_id=c.person_id WHERE c.tenant_id=$1 AND c.person_id=$2", [attempt.tenant_id, current.person_id])).rows[0];
      const declined = state?.recipients.some(recipient => recipient.personId === current.person_id && state.declinedRecipientIds.includes(recipient.recipientId));
      const eligibleRecipient = state?.recipients.some(recipient => recipient.recipientId === current.recipient_id && recipient.personId === current.person_id);
      const reason = !state || !eligibleRecipient ? "assignment_missing"
        : state.ownerRecipientId !== null || !["active", "breached"].includes(state.status) ? "commitment_not_actionable"
        : declined ? "recipient_declined"
        : !contact?.active || !contact.phone_verified_at || contact.phone !== current.phone ? "contact_changed_or_unverified"
        : contact.role !== "organization_admin" && contact.branch_id !== state.branchId ? "membership_branch_changed" : null;
      if (reason) {
        await client.query("UPDATE relay.attempts SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,last_error=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2 AND lease_token=$3", [attempt.tenant_id, attempt.attempt_id, attempt.lease_token, reason]);
        await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,'relay-worker','delivery_suppressed',$2)", [attempt.tenant_id, { attemptId: attempt.attempt_id, reason }]);
        return null;
      }
      const sending = await client.query<SendingAttempt>("UPDATE relay.attempts SET status='sending',attempts=attempts+1,acknowledgement_token_hash=$4,acknowledgement_expires_at=GREATEST($6::timestamptz,clock_timestamp())+interval '1 hour',lease_expires_at=clock_timestamp()+($5 * interval '1 second'),updated_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2 AND lease_token=$3 AND status='leased' RETURNING *", [attempt.tenant_id, attempt.attempt_id, attempt.lease_token, tokenHash, this.options.leaseSeconds, state!.dueAt]);
      await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,'relay-worker','delivery_started',$2)", [attempt.tenant_id, { attemptId: attempt.attempt_id, channel: current.channel }]);
      return sending.rows[0] ?? null;
    });
  }

  private async dispatch(lease: LeasedAttempt, result: RelayCycleResult): Promise<void> {
    const actionToken = opaqueActionToken();
    const attempt = await this.prepare(lease, actionTokenHash(actionToken));
    if (!attempt) { result.notificationsCancelled += 1; return; }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const delivery = await Promise.race([
        this.provider.send({ attemptId: attempt.attempt_id, channel: attempt.channel, destination: attempt.phone, locale: "en", actionToken }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("provider_timeout")), this.options.sendTimeoutMilliseconds); }),
      ]);
      const changed = await this.store.tenantTx(attempt.tenant_id, async (client) => {
        const update = await client.query("UPDATE relay.attempts SET status='submitted',provider_reference=$4,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2 AND lease_token=$3 AND status='sending'", [attempt.tenant_id, attempt.attempt_id, attempt.lease_token, delivery.reference]);
        // A capability acknowledgement/callback can win before send() returns.
        // Retain its newer status but never lose the successful provider SID.
        if (!update.rowCount) await client.query("UPDATE relay.attempts SET provider_reference=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2 AND acknowledgement_token_hash=$3 AND provider_reference IS NULL AND status IN ('submitted','answered','delivered','acknowledged','cancelled','exhausted')", [attempt.tenant_id, attempt.attempt_id, actionTokenHash(actionToken), delivery.reference]);
        if (update.rowCount) await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,'relay-worker','delivery_submitted',$2)", [attempt.tenant_id, { attemptId: attempt.attempt_id, simulated: delivery.simulated }]);
        return update.rowCount ?? 0;
      });
      if (changed) result.notificationsSent += 1;
    } catch (error) {
      const definite = error instanceof DefiniteDeliveryFailure;
      const permanent = definite && (error.code === "destination_not_allowlisted" || error.code === "invalid_attempt_capability" || /^provider_rejected_4(?!29)\d\d$/.test(error.code));
      const status = !definite ? "uncertain" : permanent || attempt.attempts >= this.options.retryLimit ? "exhausted" : "failed";
      const errorCode = definite ? error.code : "provider_outcome_uncertain";
      await this.store.tenantTx(attempt.tenant_id, async (client) => {
        const update = await client.query("UPDATE relay.attempts SET status=$4,last_error=$5,lease_token=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+($6 * interval '1 second'),updated_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2 AND lease_token=$3 AND status='sending'", [attempt.tenant_id, attempt.attempt_id, attempt.lease_token, status, errorCode, Math.min(60, 2 ** attempt.attempts)]);
        if (update.rowCount) await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,'relay-worker',$2,$3)", [attempt.tenant_id, `delivery_${status}`, { attemptId: attempt.attempt_id, reason: errorCode }]);
      });
      if (definite) result.notificationsFailed += 1;
      else result.notificationsUncertain += 1;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

export type RelayActorRole =
  | "on_call_responder"
  | "branch_dispatcher"
  | "organization_admin"
  | "platform_admin"
  | "system";

export type ContactChannel = "sms" | "voice";

export type CommitmentStatus =
  | "scheduled"
  | "active"
  | "owned"
  | "fulfilled"
  | "breached"
  | "closed"
  | "cancelled";

export type SourceAcceptanceStatus = "unknown" | "pending" | "accepted" | "declined" | "not_required";

export interface WorkOrderSnapshot {
  readonly externalId: string;
  readonly sourceKind: "manual" | "email" | "servicechannel" | "corrigo";
  readonly sourceMessageId: string;
  readonly customerReference: string;
  readonly priority: string;
  readonly sourceReceivedAt: string;
}

export interface RecipientSnapshot {
  readonly recipientId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly contactMethodId: string;
}

export interface EscalationStepSnapshot {
  readonly stepId: string;
  readonly offsetSeconds: number;
  readonly recipientIds: readonly string[];
  readonly channels: readonly ContactChannel[];
  readonly terminal: boolean;
}

export interface EscalationPolicySnapshot {
  readonly policyId: string;
  readonly version: number;
  readonly name: string;
  readonly steps: readonly EscalationStepSnapshot[];
}

export interface SourceAcceptance {
  readonly status: SourceAcceptanceStatus;
  readonly recordedAt: string | null;
  readonly recordedBy: string | null;
}

export interface RelayCommitment {
  readonly tenantId: string;
  readonly branchId: string;
  readonly commitmentId: string;
  readonly workOrderId: string;
  readonly commitmentType: "acknowledge_work_order";
  readonly status: CommitmentStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly activatesAt: string;
  readonly dueAt: string;
  readonly workOrder: WorkOrderSnapshot;
  readonly policy: EscalationPolicySnapshot;
  readonly recipients: readonly RecipientSnapshot[];
  readonly nextStepIndex: number;
  readonly nextEscalationAt: string | null;
  readonly scheduledStepIndexes: readonly number[];
  readonly declinedRecipientIds: readonly string[];
  readonly ownerRecipientId: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgementMechanism: "web" | "dtmf" | "dispatcher" | null;
  readonly breachedAt: string | null;
  readonly fulfilledAt: string | null;
  readonly closedAt: string | null;
  readonly cancellationReason: string | null;
  readonly closureReason?: string | null;
  readonly sourceAcceptance: SourceAcceptance;
  readonly processedCommandIds: readonly string[];
}

interface RelayCommandBase {
  readonly commandId: string;
  readonly tenantId: string;
  readonly commitmentId: string;
  readonly actorId: string;
  readonly actorRole: RelayActorRole;
  readonly occurredAt: string;
  readonly correlationId: string;
}

interface ExpectedTimerState {
  readonly expectedVersion: number;
  readonly expectedDueAt: string;
}

export type RelayCommand =
  | (RelayCommandBase & {
      readonly type: "create_commitment";
      readonly receivedOverdue?: boolean;
      readonly branchId: string;
      readonly workOrderId: string;
      readonly activatesAt: string;
      readonly dueAt: string;
      readonly workOrder: WorkOrderSnapshot;
      readonly policy: EscalationPolicySnapshot;
      readonly recipients: readonly RecipientSnapshot[];
    })
  | (RelayCommandBase & ExpectedTimerState & {
      readonly type: "activate_commitment";
      readonly expectedActivatesAt: string;
    })
  | (RelayCommandBase & {
      readonly type: "schedule_escalation_step";
      readonly expectedVersion: number;
      readonly expectedStepIndex: number;
      readonly expectedScheduledAt: string;
    })
  | (RelayCommandBase & {
      readonly type: "decline_commitment";
      readonly recipientId: string;
      readonly attemptId: string;
    })
  | (RelayCommandBase & {
      readonly type: "acknowledge_commitment";
      readonly ownerRecipientId: string;
      readonly mechanism: "web" | "dtmf" | "dispatcher";
      readonly attemptId: string | null;
    })
  | (RelayCommandBase & ExpectedTimerState & { readonly type: "mark_commitment_breached" })
  | (RelayCommandBase & {
      readonly type: "record_source_acceptance";
      readonly sourceStatus: Exclude<SourceAcceptanceStatus, "unknown">;
    })
  | (RelayCommandBase & { readonly type: "fulfill_commitment" })
  | (RelayCommandBase & { readonly type: "close_commitment"; readonly reason?: string })
  | (RelayCommandBase & { readonly type: "cancel_commitment"; readonly reason: string });

export type RelayEventType =
  | "commitment_created"
  | "commitment_activated"
  | "escalation_step_scheduled"
  | "commitment_declined"
  | "commitment_acknowledged"
  | "commitment_breached"
  | "source_acceptance_recorded"
  | "commitment_fulfilled"
  | "commitment_closed"
  | "commitment_cancelled";

export interface RelayDomainEvent {
  readonly eventId: string;
  readonly eventType: RelayEventType;
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly commitmentId: string;
  readonly aggregateVersion: number;
  readonly commandId: string;
  readonly actorId: string;
  readonly actorRole: RelayActorRole;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type RelayCommandOutcome =
  | { readonly status: "accepted"; readonly state: RelayCommitment; readonly events: readonly RelayDomainEvent[] }
  | { readonly status: "duplicate"; readonly state: RelayCommitment; readonly events: readonly [] }
  | { readonly status: "ignored_stale_timer"; readonly state: RelayCommitment; readonly events: readonly [] }
  | {
      readonly status: "rejected";
      readonly state: RelayCommitment | null;
      readonly code: string;
      readonly reason: string;
      readonly events: readonly [];
    };

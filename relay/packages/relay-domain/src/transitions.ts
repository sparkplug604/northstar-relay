import { randomUUID } from "node:crypto";
import { addSeconds, validateCommitmentConfiguration } from "./policy.js";
import { immutableSnapshot } from "./snapshot.js";
import type {
  RelayCommand,
  RelayCommandOutcome,
  RelayCommitment,
  RelayDomainEvent,
  RelayEventType,
} from "./types.js";

const RETAINED_COMMAND_IDS = 1_000;

function nonBlank(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function timestamp(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be a valid ISO timestamp`);
  return milliseconds;
}

function makeEvent(
  command: RelayCommand,
  eventType: RelayEventType,
  aggregateVersion: number,
  payload: Readonly<Record<string, unknown>>,
): RelayDomainEvent {
  return immutableSnapshot({
    eventId: randomUUID(),
    eventType,
    schemaVersion: 1,
    tenantId: command.tenantId,
    commitmentId: command.commitmentId,
    aggregateVersion,
    commandId: command.commandId,
    actorId: command.actorId,
    actorRole: command.actorRole,
    occurredAt: command.occurredAt,
    correlationId: command.correlationId,
    payload,
  });
}

function accepted(state: RelayCommitment | null, events: readonly RelayDomainEvent[]): RelayCommandOutcome {
  let next = state;
  for (const event of events) next = evolve(next, event);
  if (next === null) throw new Error("accepted Relay command did not create state");
  return Object.freeze({ status: "accepted", state: next, events: Object.freeze([...events]) });
}

function rejected(state: RelayCommitment | null, code: string, reason: string): RelayCommandOutcome {
  return { status: "rejected", state, code, reason, events: [] };
}

function stale(state: RelayCommitment): RelayCommandOutcome {
  return { status: "ignored_stale_timer", state, events: [] };
}

function timerMatches(state: RelayCommitment, expectedVersion: number, expectedDueAt: string): boolean {
  return state.version === expectedVersion && state.dueAt === expectedDueAt;
}

function isAdministrator(command: RelayCommand): boolean {
  return command.actorRole === "branch_dispatcher" || command.actorRole === "organization_admin";
}

function isKnownRecipient(state: RelayCommitment, recipientId: string): boolean {
  return state.recipients.some((recipient) => recipient.recipientId === recipientId);
}

function isRecipientDeclined(state: RelayCommitment, recipientId: string): boolean {
  const personId = state.recipients.find((recipient) => recipient.recipientId === recipientId)?.personId;
  return state.recipients.some((recipient) => recipient.personId === personId && state.declinedRecipientIds.includes(recipient.recipientId));
}

function isOwner(state: RelayCommitment, actorId: string): boolean {
  return state.recipients.some((recipient) => recipient.recipientId === state.ownerRecipientId && recipient.personId === actorId);
}

function earlierTime(left: string, right: string): string {
  return timestamp(left, "time") <= timestamp(right, "time") ? left : right;
}

function canActForRecipient(state: RelayCommitment, command: Extract<RelayCommand, { type: "acknowledge_commitment" }>): boolean {
  const recipient = state.recipients.find((candidate) => candidate.recipientId === command.ownerRecipientId);
  if (recipient === undefined) return false;
  if (isAdministrator(command)) return true;
  return command.actorRole === "on_call_responder" && command.actorId === recipient.personId;
}

export function handleRelayCommand(state: RelayCommitment | null, command: RelayCommand): RelayCommandOutcome {
  try {
    nonBlank(command.commandId, "commandId");
    nonBlank(command.tenantId, "tenantId");
    nonBlank(command.commitmentId, "commitmentId");
    nonBlank(command.actorId, "actorId");
    nonBlank(command.correlationId, "correlationId");
    timestamp(command.occurredAt, "occurredAt");
    if (!["on_call_responder", "branch_dispatcher", "organization_admin", "platform_admin", "system"].includes(command.actorRole)) {
      return rejected(state, "actor_role_invalid", "Unknown actor role");
    }

    if (state !== null) {
      if (state.tenantId !== command.tenantId || state.commitmentId !== command.commitmentId) {
        return rejected(state, "aggregate_identity_mismatch", "Command does not belong to this commitment");
      }
      if (state.processedCommandIds.includes(command.commandId)) return { status: "duplicate", state, events: [] };
    }

    switch (command.type) {
      case "create_commitment": {
        if (state !== null) return rejected(state, "commitment_exists", "Commitment already exists");
        if (!isAdministrator(command) && command.actorRole !== "system") {
          return rejected(state, "creator_not_authorized", "Automated intake, dispatcher, or organization administrator role required");
        }
        nonBlank(command.branchId, "branchId");
        nonBlank(command.workOrderId, "workOrderId");
        nonBlank(command.workOrder.externalId, "external work-order ID");
        nonBlank(command.workOrder.sourceMessageId, "source message ID");
        timestamp(command.workOrder.sourceReceivedAt, "sourceReceivedAt");
        const overdue = command.receivedOverdue === true;
        if (overdue && (command.workOrder.sourceKind === 'manual' || timestamp(command.dueAt, 'dueAt') >= timestamp(command.occurredAt, 'occurredAt') || timestamp(command.activatesAt, 'activatesAt') > timestamp(command.occurredAt, 'occurredAt'))) return rejected(state, 'overdue_intake_invalid', 'Overdue source intake requires an elapsed original deadline and an activation time no later than receipt processing');
        validateCommitmentConfiguration(command.activatesAt, command.dueAt, command.policy, command.recipients, { allowOverdue: overdue });
        const events = [makeEvent(command, "commitment_created", 1, {
          branchId: command.branchId,
          workOrderId: command.workOrderId,
          activatesAt: command.activatesAt,
          dueAt: command.dueAt,
          workOrder: command.workOrder,
          policy: command.policy,
          recipients: command.recipients,
          ...(overdue ? { receivedOverdue: true } : {}),
        })];
        if (overdue) {
          events.push(makeEvent(command, 'commitment_activated', 2, {}));
          events.push(makeEvent(command, 'commitment_breached', 3, { dueAt: command.dueAt, detectedAtIntake: true }));
          events.push(makeEvent(command, 'escalation_step_scheduled', 4, { stepIndex: 0, step: command.policy.steps[0], scheduledFor: command.activatesAt, overdueFallback: true }));
        }
        return accepted(null, events);
      }
      case "activate_commitment": {
        if (state === null) return rejected(state, "commitment_not_found", "Commitment not found");
        if (command.actorRole !== "system") return rejected(state, "system_role_required", "Only the system may activate commitments");
        if (state.status !== "scheduled") return stale(state);
        if (!timerMatches(state, command.expectedVersion, command.expectedDueAt) || state.activatesAt !== command.expectedActivatesAt) {
          return stale(state);
        }
        if (timestamp(command.occurredAt, "occurredAt") < timestamp(state.activatesAt, "activatesAt")) {
          return rejected(state, "activation_not_due", "Commitment activation time has not arrived");
        }
        return accepted(state, [makeEvent(command, "commitment_activated", state.version + 1, {})]);
      }
      case "schedule_escalation_step": {
        if (state === null) return rejected(state, "commitment_not_found", "Commitment not found");
        if (command.actorRole !== "system") return rejected(state, "system_role_required", "Only the system may schedule escalation");
        if (state.status !== "active" && state.status !== "breached") return stale(state);
        if (state.ownerRecipientId !== null || state.nextEscalationAt === null) return stale(state);
        if (
          state.version !== command.expectedVersion
          || state.nextStepIndex !== command.expectedStepIndex
          || state.nextEscalationAt !== command.expectedScheduledAt
        ) return stale(state);
        if (timestamp(command.occurredAt, "occurredAt") < timestamp(state.nextEscalationAt, "nextEscalationAt")) {
          return rejected(state, "escalation_not_due", "Escalation step is not due");
        }
        const step = state.policy.steps[state.nextStepIndex];
        if (step === undefined) return stale(state);
        const recipientIds = step.recipientIds.filter((recipientId) => !isRecipientDeclined(state, recipientId));
        return accepted(state, [makeEvent(command, "escalation_step_scheduled", state.version + 1, {
          stepIndex: state.nextStepIndex,
          step: { ...step, recipientIds },
          skippedRecipientIds: step.recipientIds.filter((recipientId) => isRecipientDeclined(state, recipientId)),
          skipped: recipientIds.length === 0,
          scheduledFor: state.nextEscalationAt,
        })]);
      }
      case "decline_commitment": {
        if (state === null) return rejected(state, "commitment_not_found", "Commitment not found");
        if (state.status !== "active" && state.status !== "breached") {
          return rejected(state, "commitment_not_actionable", "Commitment cannot be declined in its current state");
        }
        if (state.ownerRecipientId !== null) return rejected(state, "commitment_already_owned", "Commitment already has an owner");
        if (!isKnownRecipient(state, command.recipientId)) return rejected(state, "recipient_not_eligible", "Recipient is not in the commitment snapshot");
        const recipient = state.recipients.find((candidate) => candidate.recipientId === command.recipientId)!;
        if ((command.actorRole !== "on_call_responder" && !isAdministrator(command)) || command.actorId !== recipient.personId) {
          return rejected(state, "recipient_action_required", "Only the contacted recipient can decline");
        }
        nonBlank(command.attemptId, "attemptId");
        if (isRecipientDeclined(state, command.recipientId)) {
          return rejected(state, "recipient_already_declined", "Recipient already declined this commitment");
        }
        return accepted(state, [makeEvent(command, "commitment_declined", state.version + 1, {
          recipientId: command.recipientId,
          attemptId: command.attemptId,
        })]);
      }
      case "acknowledge_commitment": {
        if (state === null) return rejected(state, "commitment_not_found", "Commitment not found");
        if (state.status !== "active" && state.status !== "breached") {
          return rejected(state, "commitment_not_actionable", "Commitment cannot be acknowledged in its current state");
        }
        if (state.ownerRecipientId !== null) return rejected(state, "commitment_already_owned", "Commitment already has an owner");
        if (isRecipientDeclined(state, command.ownerRecipientId)) {
          return rejected(state, "recipient_already_declined", "A recipient who declined cannot later claim the same commitment");
        }
        if (!canActForRecipient(state, command)) return rejected(state, "recipient_not_authorized", "Actor cannot acknowledge for this recipient");
        if (!["web", "dtmf", "dispatcher"].includes(command.mechanism)) {
          return rejected(state, "acknowledgement_mechanism_invalid", "Unknown acknowledgement mechanism");
        }
        if (command.mechanism === "dispatcher" && !isAdministrator(command)) {
          return rejected(state, "dispatcher_role_required", "Dispatcher acknowledgement requires dispatcher or administrator role");
        }
        if (command.mechanism !== "dispatcher" && command.attemptId === null) {
          return rejected(state, "attempt_required", "Web and DTMF acknowledgement require a communication attempt");
        }
        if (command.mechanism !== "dispatcher") nonBlank(command.attemptId!, "attemptId");
        const events: RelayDomainEvent[] = [];
        let nextVersion = state.version + 1;
        const acknowledgementTime = timestamp(command.occurredAt, "occurredAt");
        if (state.breachedAt === null && acknowledgementTime > timestamp(state.dueAt, "dueAt")) {
          events.push(makeEvent(command, "commitment_breached", nextVersion, { dueAt: state.dueAt }));
          nextVersion += 1;
        }
        events.push(makeEvent(command, "commitment_acknowledged", nextVersion, {
          ownerRecipientId: command.ownerRecipientId,
          mechanism: command.mechanism,
          attemptId: command.attemptId,
        }));
        return accepted(state, events);
      }
      case "mark_commitment_breached": {
        if (state === null) return rejected(state, "commitment_not_found", "Commitment not found");
        if (command.actorRole !== "system") return rejected(state, "system_role_required", "Only the system may record deadline breaches");
        if (state.status !== "active" || state.ownerRecipientId !== null || state.breachedAt !== null) return stale(state);
        if (!timerMatches(state, command.expectedVersion, command.expectedDueAt)) return stale(state);
        if (timestamp(command.occurredAt, "occurredAt") <= timestamp(state.dueAt, "dueAt")) {
          return rejected(state, "deadline_not_elapsed", "Commitment deadline has not elapsed");
        }
        return accepted(state, [makeEvent(command, "commitment_breached", state.version + 1, { dueAt: state.dueAt })]);
      }
      case "record_source_acceptance": {
        if (state === null) return rejected(state, "commitment_not_found", "Commitment not found");
        if (!isAdministrator(command) && !(command.actorRole === "on_call_responder" && isOwner(state, command.actorId))) {
          return rejected(state, "source_status_not_authorized", "Named owner, dispatcher, or administrator role required");
        }
        if (command.sourceStatus === "not_required" && !isAdministrator(command)) {
          return rejected(state, "dispatcher_role_required", "Only a dispatcher or administrator may waive source acceptance");
        }
        if (!["pending", "accepted", "declined", "not_required"].includes(command.sourceStatus)) {
          return rejected(state, "source_status_invalid", "Unknown source acceptance status");
        }
        if (state.status === "closed" || state.status === "cancelled" || state.status === "fulfilled") {
          return rejected(state, "commitment_not_actionable", "Finalized commitment cannot change source acceptance");
        }
        return accepted(state, [makeEvent(command, "source_acceptance_recorded", state.version + 1, {
          sourceStatus: command.sourceStatus,
        })]);
      }
      case "fulfill_commitment": {
        if (state === null) return rejected(state, "commitment_not_found", "Commitment not found");
        if (!isAdministrator(command)) return rejected(state, "dispatcher_role_required", "Dispatcher or administrator role required");
        if (state.ownerRecipientId === null) return rejected(state, "owner_required", "Commitment requires a named owner");
        if (state.sourceAcceptance.status !== "accepted" && state.sourceAcceptance.status !== "not_required") {
          return rejected(state, "source_acceptance_required", "Source acceptance must be accepted or not required");
        }
        if (state.status !== "owned" && state.status !== "breached") {
          return rejected(state, "commitment_not_actionable", "Commitment cannot be fulfilled in its current state");
        }
        return accepted(state, [makeEvent(command, "commitment_fulfilled", state.version + 1, {})]);
      }
      case "close_commitment": {
        if (state === null) return rejected(state, "commitment_not_found", "Commitment not found");
        if (!isAdministrator(command)) return rejected(state, "dispatcher_role_required", "Dispatcher or administrator role required");
        if (state.status !== "fulfilled" && state.status !== "breached" && state.status !== "cancelled") {
          return rejected(state, "commitment_not_closable", "Commitment must be fulfilled, breached, or cancelled before closure");
        }
        if (command.reason !== undefined) nonBlank(command.reason, "closure reason");
        return accepted(state, [makeEvent(command, "commitment_closed", state.version + 1, { reason: command.reason?.trim() ?? null })]);
      }
      case "cancel_commitment": {
        if (state === null) return rejected(state, "commitment_not_found", "Commitment not found");
        if (!isAdministrator(command)) return rejected(state, "dispatcher_role_required", "Dispatcher or administrator role required");
        if (state.status !== "scheduled" && state.status !== "active") {
          return rejected(state, "commitment_not_cancellable", "Only scheduled or active commitments can be cancelled");
        }
        if (state.ownerRecipientId !== null || state.breachedAt !== null) {
          return rejected(state, "commitment_not_cancellable", "Owned or breached commitments cannot be cancelled");
        }
        if (timestamp(command.occurredAt, "occurredAt") > timestamp(state.dueAt, "dueAt")) {
          return rejected(state, "deadline_elapsed", "An expired commitment must retain its breach history and cannot be cancelled");
        }
        nonBlank(command.reason, "cancellation reason");
        return accepted(state, [makeEvent(command, "commitment_cancelled", state.version + 1, { reason: command.reason.trim() })]);
      }
      default:
        return rejected(state, "command_type_invalid", "Unknown Relay command type");
    }
  } catch (error) {
    return rejected(state, "invalid_command", error instanceof Error ? error.message : "Invalid Relay command");
  }
}

function appendProcessed(state: RelayCommitment, commandId: string): readonly string[] {
  if (state.processedCommandIds.includes(commandId)) return state.processedCommandIds;
  return [...state.processedCommandIds, commandId].slice(-RETAINED_COMMAND_IDS);
}

function payload<T>(event: RelayDomainEvent): T {
  return event.payload as T;
}

export function evolve(state: RelayCommitment | null, event: RelayDomainEvent): RelayCommitment {
  nonBlank(event.eventId, "eventId");
  nonBlank(event.tenantId, "tenantId");
  nonBlank(event.commitmentId, "commitmentId");
  nonBlank(event.commandId, "commandId");
  timestamp(event.occurredAt, "occurredAt");
  if (event.schemaVersion !== 1) throw new Error("Unsupported Relay event schema version");
  if (!Number.isInteger(event.aggregateVersion) || event.aggregateVersion < 1) {
    throw new Error("Event aggregate version must be a positive integer");
  }
  if (state === null) {
    if (event.eventType !== "commitment_created" || event.aggregateVersion !== 1) {
      throw new Error("The first event must create the commitment at version 1");
    }
  } else {
    if (event.tenantId !== state.tenantId || event.commitmentId !== state.commitmentId) {
      throw new Error("Event does not belong to this commitment");
    }
    if (event.eventType === "commitment_created") throw new Error("A creation event cannot replace an existing commitment");
    if (event.aggregateVersion !== state.version + 1) throw new Error("Event aggregate versions must be consecutive");
  }
  return immutableSnapshot(evolveEvent(state, event));
}

function evolveEvent(state: RelayCommitment | null, event: RelayDomainEvent): RelayCommitment {
  switch (event.eventType) {
    case "commitment_created": {
      const value = payload<Pick<RelayCommitment, "branchId" | "workOrderId" | "activatesAt" | "dueAt" | "workOrder" | "policy" | "recipients"> & { receivedOverdue?: boolean }>(event);
      if (value.receivedOverdue && (value.workOrder.sourceKind === 'manual' || timestamp(value.dueAt, 'dueAt') >= timestamp(event.occurredAt, 'occurredAt'))) throw new Error('Overdue creation event must preserve an elapsed source deadline');
      validateCommitmentConfiguration(value.activatesAt, value.dueAt, value.policy, value.recipients, { allowOverdue: value.receivedOverdue === true });
      return {
        tenantId: event.tenantId,
        branchId: value.branchId,
        commitmentId: event.commitmentId,
        workOrderId: value.workOrderId,
        commitmentType: "acknowledge_work_order",
        status: "scheduled",
        version: event.aggregateVersion,
        createdAt: event.occurredAt,
        activatesAt: value.activatesAt,
        dueAt: value.dueAt,
        workOrder: value.workOrder,
        policy: value.policy,
        recipients: value.recipients,
        nextStepIndex: 0,
        nextEscalationAt: null,
        scheduledStepIndexes: [],
        declinedRecipientIds: [],
        ownerRecipientId: null,
        acknowledgedAt: null,
        acknowledgementMechanism: null,
        breachedAt: null,
        fulfilledAt: null,
        closedAt: null,
        cancellationReason: null,
        closureReason: null,
        sourceAcceptance: { status: "unknown", recordedAt: null, recordedBy: null },
        processedCommandIds: [event.commandId],
      };
    }
    case "commitment_activated": {
      if (state === null) throw new Error("commitment_activated requires state");
      const firstStep = state.policy.steps[0];
      return {
        ...state,
        status: "active",
        version: event.aggregateVersion,
        nextEscalationAt: firstStep === undefined ? null : addSeconds(state.activatesAt, firstStep.offsetSeconds),
        processedCommandIds: appendProcessed(state, event.commandId),
      };
    }
    case "escalation_step_scheduled": {
      if (state === null) throw new Error("escalation_step_scheduled requires state");
      const { stepIndex, skipped } = payload<{ stepIndex: number; skipped?: boolean }>(event);
      if (stepIndex !== state.nextStepIndex || !state.policy.steps[stepIndex]) {
        throw new Error("Escalation event must advance the next policy step");
      }
      const nextStepIndex = stepIndex + 1;
      const nextStep = state.policy.steps[nextStepIndex];
      const scheduledAt = nextStep === undefined ? null : addSeconds(state.activatesAt, nextStep.offsetSeconds);
      return {
        ...state,
        version: event.aggregateVersion,
        nextStepIndex,
        nextEscalationAt: skipped && scheduledAt !== null ? earlierTime(scheduledAt, event.occurredAt) : scheduledAt,
        scheduledStepIndexes: [...state.scheduledStepIndexes, stepIndex],
        processedCommandIds: appendProcessed(state, event.commandId),
      };
    }
    case "commitment_declined": {
      if (state === null) throw new Error("commitment_declined requires state");
      const { recipientId } = payload<{ recipientId: string }>(event);
      return {
        ...state,
        version: event.aggregateVersion,
        declinedRecipientIds: [...state.declinedRecipientIds, recipientId],
        nextEscalationAt: state.nextEscalationAt === null ? null : earlierTime(state.nextEscalationAt, event.occurredAt),
        processedCommandIds: appendProcessed(state, event.commandId),
      };
    }
    case "commitment_breached": {
      if (state === null) throw new Error("commitment_breached requires state");
      return {
        ...state,
        status: "breached",
        version: event.aggregateVersion,
        breachedAt: event.occurredAt,
        processedCommandIds: appendProcessed(state, event.commandId),
      };
    }
    case "commitment_acknowledged": {
      if (state === null) throw new Error("commitment_acknowledged requires state");
      const value = payload<{ ownerRecipientId: string; mechanism: RelayCommitment["acknowledgementMechanism"] }>(event);
      return {
        ...state,
        status: state.breachedAt === null ? "owned" : "breached",
        version: event.aggregateVersion,
        ownerRecipientId: value.ownerRecipientId,
        acknowledgedAt: event.occurredAt,
        acknowledgementMechanism: value.mechanism,
        nextEscalationAt: null,
        processedCommandIds: appendProcessed(state, event.commandId),
      };
    }
    case "source_acceptance_recorded": {
      if (state === null) throw new Error("source_acceptance_recorded requires state");
      const { sourceStatus } = payload<{ sourceStatus: RelayCommitment["sourceAcceptance"]["status"] }>(event);
      return {
        ...state,
        version: event.aggregateVersion,
        sourceAcceptance: { status: sourceStatus, recordedAt: event.occurredAt, recordedBy: event.actorId },
        processedCommandIds: appendProcessed(state, event.commandId),
      };
    }
    case "commitment_fulfilled": {
      if (state === null) throw new Error("commitment_fulfilled requires state");
      return {
        ...state,
        status: "fulfilled",
        version: event.aggregateVersion,
        fulfilledAt: event.occurredAt,
        processedCommandIds: appendProcessed(state, event.commandId),
      };
    }
    case "commitment_closed": {
      if (state === null) throw new Error("commitment_closed requires state");
      const { reason } = payload<{ reason?: string | null }>(event);
      return {
        ...state,
        status: "closed",
        version: event.aggregateVersion,
        closedAt: event.occurredAt,
        closureReason: reason ?? null,
        nextEscalationAt: null,
        processedCommandIds: appendProcessed(state, event.commandId),
      };
    }
    case "commitment_cancelled": {
      if (state === null) throw new Error("commitment_cancelled requires state");
      const { reason } = payload<{ reason: string }>(event);
      return {
        ...state,
        status: "cancelled",
        version: event.aggregateVersion,
        cancellationReason: reason,
        nextEscalationAt: null,
        processedCommandIds: appendProcessed(state, event.commandId),
      };
    }
    default:
      throw new Error("Unknown Relay event type");
  }
}

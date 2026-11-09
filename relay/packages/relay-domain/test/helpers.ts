import assert from "node:assert/strict";
import {
  handleRelayCommand,
  type EscalationPolicySnapshot,
  type RecipientSnapshot,
  type RelayCommand,
  type RelayCommandOutcome,
  type RelayCommitment,
} from "../src/index.js";

const ORIGIN = Date.parse("2026-09-05T08:00:00.000Z");

export function at(seconds: number): string {
  return new Date(ORIGIN + seconds * 1_000).toISOString();
}

export const recipients: readonly RecipientSnapshot[] = [
  { recipientId: "recipient-primary", personId: "person-primary", displayName: "Primary Tech", contactMethodId: "phone-primary" },
  { recipientId: "recipient-secondary", personId: "person-secondary", displayName: "Secondary Tech", contactMethodId: "phone-secondary" },
  { recipientId: "recipient-owner", personId: "person-owner", displayName: "Branch Owner", contactMethodId: "phone-owner" },
];

export const policy: EscalationPolicySnapshot = {
  policyId: "policy-after-hours-emergency",
  version: 1,
  name: "After-hours emergency",
  steps: [
    { stepId: "primary", offsetSeconds: 0, recipientIds: ["recipient-primary"], channels: ["sms", "voice"], terminal: false },
    { stepId: "secondary", offsetSeconds: 120, recipientIds: ["recipient-secondary"], channels: ["sms", "voice"], terminal: false },
    { stepId: "owner", offsetSeconds: 600, recipientIds: ["recipient-owner"], channels: ["sms", "voice"], terminal: true },
  ],
};

export function base(
  commandId: string,
  occurredAt: string,
  actorId = "dispatcher-1",
  actorRole: RelayCommand["actorRole"] = "branch_dispatcher",
) {
  return {
    commandId,
    tenantId: "tenant-1",
    commitmentId: "commitment-1",
    actorId,
    actorRole,
    occurredAt,
    correlationId: "correlation-1",
  } as const;
}

export function createCommand(commandId = "create"): Extract<RelayCommand, { type: "create_commitment" }> {
  return {
    ...base(commandId, at(0)),
    type: "create_commitment",
    branchId: "branch-1",
    workOrderId: "work-order-1",
    activatesAt: at(0),
    dueAt: at(900),
    workOrder: {
      externalId: "WO-1042",
      sourceKind: "email",
      sourceMessageId: "message-1",
      customerReference: "customer-reference-1",
      priority: "emergency",
      sourceReceivedAt: at(-30),
    },
    policy,
    recipients,
  };
}

export function requireAccepted(outcome: RelayCommandOutcome): RelayCommitment {
  assert.equal(outcome.status, "accepted");
  if (outcome.status !== "accepted") throw new Error("Expected accepted Relay command");
  return outcome.state;
}

export function createScheduled(): RelayCommitment {
  return requireAccepted(handleRelayCommand(null, createCommand()));
}

export function createActive(): RelayCommitment {
  const scheduled = createScheduled();
  return requireAccepted(handleRelayCommand(scheduled, {
    ...base("activate", at(0), "timer", "system"),
    type: "activate_commitment",
    expectedVersion: scheduled.version,
    expectedActivatesAt: scheduled.activatesAt,
    expectedDueAt: scheduled.dueAt,
  }));
}

export function scheduleNext(state: RelayCommitment, commandId: string, occurredAt: string): RelayCommandOutcome {
  assert.notEqual(state.nextEscalationAt, null);
  return handleRelayCommand(state, {
    ...base(commandId, occurredAt, "timer", "system"),
    type: "schedule_escalation_step",
    expectedVersion: state.version,
    expectedStepIndex: state.nextStepIndex,
    expectedScheduledAt: state.nextEscalationAt!,
  });
}

import type { EscalationPolicySnapshot, RecipientSnapshot } from "./types.js";

function timestamp(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be a valid ISO timestamp`);
  return milliseconds;
}

export function addSeconds(isoTime: string, seconds: number): string {
  return new Date(timestamp(isoTime, "time") + seconds * 1_000).toISOString();
}

export function validateCommitmentConfiguration(
  activatesAt: string,
  dueAt: string,
  policy: EscalationPolicySnapshot,
  recipients: readonly RecipientSnapshot[],
  options: { readonly allowOverdue?: boolean } = {},
): void {
  const activation = timestamp(activatesAt, "activatesAt");
  const deadline = timestamp(dueAt, "dueAt");
  if (deadline <= activation && !options.allowOverdue) throw new Error("dueAt must be later than activatesAt");
  if (options.allowOverdue && deadline > activation) throw new Error("overdue intake must preserve an already elapsed deadline");
  if (options.allowOverdue && (policy.steps.length !== 1 || policy.steps[0]?.offsetSeconds !== 0 || !policy.steps[0]?.terminal)) throw new Error("overdue intake requires one immediate terminal escalation step");
  if (!policy.policyId.trim() || !policy.name.trim()) throw new Error("policy identity and name are required");
  if (!Number.isInteger(policy.version) || policy.version < 1) throw new Error("policy version must be a positive integer");
  if (policy.steps.length === 0) throw new Error("escalation policy requires at least one step");
  if (recipients.length === 0) throw new Error("commitment requires at least one recipient");

  const recipientIds = new Set<string>();
  for (const recipient of recipients) {
    if (!recipient.recipientId.trim() || !recipient.personId.trim() || !recipient.contactMethodId.trim()) {
      throw new Error("recipient identity and contact method are required");
    }
    if (recipientIds.has(recipient.recipientId)) throw new Error("recipient IDs must be unique");
    recipientIds.add(recipient.recipientId);
  }

  const durationSeconds = options.allowOverdue ? 0 : Math.floor((deadline - activation) / 1_000);
  const stepIds = new Set<string>();
  let previousOffset = -1;
  for (const [index, step] of policy.steps.entries()) {
    if (!step.stepId.trim() || stepIds.has(step.stepId)) throw new Error("escalation step IDs must be present and unique");
    stepIds.add(step.stepId);
    if (!Number.isInteger(step.offsetSeconds) || step.offsetSeconds < 0) {
      throw new Error("escalation step offsets must be non-negative integers");
    }
    if (step.offsetSeconds <= previousOffset) throw new Error("escalation step offsets must be strictly increasing");
    if (step.offsetSeconds > durationSeconds) throw new Error("escalation step cannot be scheduled after the commitment deadline");
    previousOffset = step.offsetSeconds;
    if (step.recipientIds.length === 0 || new Set(step.recipientIds).size !== step.recipientIds.length) {
      throw new Error("each escalation step requires unique recipients");
    }
    if (step.channels.length === 0 || new Set(step.channels).size !== step.channels.length) {
      throw new Error("each escalation step requires unique channels");
    }
    if (step.channels.some((channel) => channel !== "sms" && channel !== "voice")) {
      throw new Error("escalation channels must be sms or voice");
    }
    for (const recipientId of step.recipientIds) {
      if (!recipientIds.has(recipientId)) throw new Error(`escalation step references unknown recipient ${recipientId}`);
    }
    if (step.terminal && index !== policy.steps.length - 1) throw new Error("only the final escalation step may be terminal");
  }
  if (!policy.steps.at(-1)?.terminal) throw new Error("the final escalation step must be terminal");
}

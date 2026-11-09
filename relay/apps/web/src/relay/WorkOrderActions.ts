import type { Attempt, Commitment, Session } from "./api.js";

export type WorkOrderAction = "acknowledge" | "decline" | "cancel" | "source_acceptance" | "fulfill" | "close";

// Mirror command permissions, not general navigation access. The API remains
// authoritative: another person or the deadline can change state after loading.
export function workOrderActions(state: Commitment, session: Session, attempts: readonly Attempt[], now = Date.now()) {
  const canManage = session.user.role === "branch_dispatcher" || session.user.role === "organization_admin";
  const responder = session.user.role === "on_call_responder";
  const declined = new Set(state.declinedRecipientIds ?? []);
  const declinedPeople = new Set(state.recipients.filter((recipient) => declined.has(recipient.recipientId)).map((recipient) => recipient.personId));
  const eligibleRecipients = state.recipients.filter((recipient) => !declinedPeople.has(recipient.personId));
  const ownRecipients = eligibleRecipients.filter((recipient) => recipient.personId === session.user.id);
  const contacted = ownRecipients.some((recipient) => attempts.some((attempt) => attempt.recipientId === recipient.recipientId));
  const owner = state.recipients.some((recipient) => recipient.recipientId === state.ownerRecipientId && recipient.personId === session.user.id);
  const awaitingOwner = !state.ownerRecipientId && ["active", "breached"].includes(state.status);
  const terminal = ["fulfilled", "cancelled", "closed"].includes(state.status);
  const sourceReady = ["accepted", "not_required"].includes(state.sourceAcceptance.status);
  const allowed: Record<WorkOrderAction, boolean> = {
    acknowledge: awaitingOwner && (canManage ? eligibleRecipients.length > 0 : responder && contacted),
    decline: awaitingOwner && (canManage || responder) && contacted,
    source_acceptance: !terminal && (canManage || (responder && owner)),
    fulfill: canManage && !!state.ownerRecipientId && ["owned", "breached"].includes(state.status) && sourceReady,
    cancel: canManage && ["scheduled", "active"].includes(state.status) && !state.ownerRecipientId && !state.breachedAt && now <= Date.parse(state.dueAt),
    close: canManage && ["fulfilled", "breached", "cancelled"].includes(state.status),
  };
  const primary: WorkOrderAction | null = allowed.acknowledge ? "acknowledge"
    : allowed.fulfill ? "fulfill"
    : allowed.source_acceptance && !sourceReady ? "source_acceptance" : null;
  return { allowed, primary, canManage, eligibleRecipients, hasDeclined: declinedPeople.has(session.user.id) };
}

import type { RelayCommitment, SourceAcceptance } from "./types.js";

export interface RelayCommitmentReadModel {
  readonly lifecycle: "scheduled" | "awaiting_owner" | "owned" | "fulfilled" | "closed" | "cancelled";
  readonly ownerRecipientId: string | null;
  readonly ownershipSla: "pending" | "on_time" | "late" | "missed" | "cancelled";
  readonly dueAt: string;
  readonly acknowledgedAt: string | null;
  readonly breachEffectiveAt: string | null;
  readonly breachRecordedAt: string | null;
  readonly sourceAcceptance: SourceAcceptance;
}

/** Ownership, timeliness, and portal acceptance are independent operator-facing facts. */
export function relayCommitmentReadModel(state: RelayCommitment, asOf: string): RelayCommitmentReadModel {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new Error("asOf must be a valid timestamp");
  const deadline = Date.parse(state.dueAt);
  const breached = state.breachedAt !== null;
  const cancelled = state.status === "cancelled" || (state.cancellationReason !== null && state.ownerRecipientId === null && !breached);
  const acknowledged = state.acknowledgedAt !== null;
  const ownershipSla = cancelled ? "cancelled"
    : acknowledged ? (breached || Date.parse(state.acknowledgedAt!) > deadline ? "late" : "on_time")
    : breached || now > deadline ? "missed" : "pending";
  const lifecycle = state.status === "breached" ? (state.ownerRecipientId === null ? "awaiting_owner" : "owned")
    : state.status === "active" ? "awaiting_owner" : state.status;
  return Object.freeze({
    lifecycle,
    ownerRecipientId: state.ownerRecipientId,
    ownershipSla,
    dueAt: state.dueAt,
    acknowledgedAt: state.acknowledgedAt,
    breachEffectiveAt: ownershipSla === "late" || ownershipSla === "missed" ? state.dueAt : null,
    breachRecordedAt: state.breachedAt,
    sourceAcceptance: Object.freeze({ ...state.sourceAcceptance }),
  });
}

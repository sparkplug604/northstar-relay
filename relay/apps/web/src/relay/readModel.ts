import type { Commitment, EventRecord } from "./api.js";

/** A missed deadline is an outcome, not an indication that a later owner is absent. */
export function displayWorkOrderState(commitment: Pick<Commitment, "status" | "ownerRecipientId" | "breachedAt">): { lifecycle: string; deadlineMissed: boolean } {
  return {
    lifecycle: commitment.status === "breached" ? commitment.ownerRecipientId === null ? "active" : "owned" : commitment.status,
    deadlineMissed: commitment.breachedAt !== null || commitment.status === "breached",
  };
}

export function eventReason(event: Pick<EventRecord, "eventType" | "payload">): string | null {
  if (event.eventType !== "commitment_closed" && event.eventType !== "commitment_cancelled") return null;
  const reason = event.payload?.reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
}

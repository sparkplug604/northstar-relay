import assert from "node:assert/strict";
import { test } from "node:test";
import type { Attempt, Commitment, RelayRole, Session } from "../apps/web/src/relay/api.js";
import { workOrderActions } from "../apps/web/src/relay/WorkOrderActions.js";

const now = Date.parse("2026-09-05T12:00:00Z");
const state: Commitment = {
  commitmentId: "commitment-1", workOrderId: "work-1", branchId: "branch-1", status: "active",
  dueAt: "2026-09-05T13:00:00Z", createdAt: "2026-09-05T11:00:00Z", acknowledgedAt: null,
  breachedAt: null, ownerRecipientId: null, nextEscalationAt: null, declinedRecipientIds: [],
  workOrder: { externalId: "WO-101", customerReference: "Customer", priority: "normal", sourceKind: "manual" },
  recipients: [{ recipientId: "recipient-1", personId: "person-1", displayName: "Pat" }, { recipientId: "recipient-2", personId: "person-2", displayName: "Robin" }],
  sourceAcceptance: { status: "unknown", recordedAt: null, recordedBy: null },
};
const attempt: Attempt = { attemptId: "attempt-1", recipientId: "recipient-1", channel: "voice", status: "delivered" };
function session(role: RelayRole = "on_call_responder", id = "person-1"): Session {
  return { user: { id, displayName: "Pat", email: "pat@example.test", role, branchId: "branch-1" }, organization: { id: "org-1", name: "Example" }, branches: [], csrfToken: "test", providerMode: "simulated" };
}

test("Relay gives contacted responders ownership controls but not source controls before ownership", () => {
  const result = workOrderActions(state, session(), [attempt], now);
  assert.equal(result.primary, "acknowledge");
  assert.equal(result.allowed.acknowledge, true);
  assert.equal(result.allowed.decline, true);
  assert.equal(result.allowed.source_acceptance, false);
  assert.equal(result.allowed.cancel, false);
  assert.equal(result.allowed.fulfill, false);
  assert.equal(result.allowed.close, false);
  const beforeContact = workOrderActions(state, session(), [], now);
  assert.equal(beforeContact.allowed.acknowledge, false);
  assert.equal(beforeContact.allowed.decline, false);
});

test("Relay limits source status to named owner or dispatcher, never another assigned responder", () => {
  const owned = { ...state, status: "owned", ownerRecipientId: "recipient-1" };
  assert.equal(workOrderActions(owned, session(), [attempt], now).allowed.source_acceptance, true);
  assert.equal(workOrderActions(owned, session("on_call_responder", "person-2"), [attempt], now).allowed.source_acceptance, false);
  assert.equal(workOrderActions(owned, session("branch_dispatcher", "dispatcher"), [], now).allowed.source_acceptance, true);
});

test("declining once hides both response actions and removes every snapshot for that person", () => {
  const declined = { ...state, declinedRecipientIds: ["recipient-1"], recipients: [...state.recipients, { recipientId: "recipient-1-alt", personId: "person-1", displayName: "Pat (second contact)" }] };
  const result = workOrderActions(declined, session(), [attempt], now);
  assert.equal(result.hasDeclined, true);
  assert.equal(result.allowed.acknowledge, false);
  assert.equal(result.allowed.decline, false);
  const dispatcher = workOrderActions(declined, session("branch_dispatcher", "dispatcher"), [], now);
  assert.deepEqual(dispatcher.eligibleRecipients.map((recipient) => recipient.personId), ["person-2"]);
  assert.equal(dispatcher.allowed.acknowledge, true);
  assert.equal(workOrderActions({ ...state, declinedRecipientIds: ["recipient-1", "recipient-2"] }, session("branch_dispatcher"), [], now).allowed.acknowledge, false);
});

test("handoff requires owner plus accepted source outcome and does not imply source verification", () => {
  const owned = { ...state, status: "owned", ownerRecipientId: "recipient-1" };
  const dispatcher = session("branch_dispatcher", "dispatcher");
  assert.equal(workOrderActions(owned, dispatcher, [], now).primary, "source_acceptance");
  assert.equal(workOrderActions(owned, dispatcher, [], now).allowed.fulfill, false);
  for (const status of ["accepted", "not_required"]) {
    const ready = { ...owned, sourceAcceptance: { ...owned.sourceAcceptance, status } };
    assert.equal(workOrderActions(ready, dispatcher, [], now).primary, "fulfill");
    assert.equal(workOrderActions(ready, session(), [], now).allowed.fulfill, false);
  }
});

test("administrative actions preserve missed deadline and terminal-state boundaries", () => {
  const dispatcher = session("branch_dispatcher", "dispatcher");
  assert.equal(workOrderActions(state, dispatcher, [], now).allowed.cancel, true);
  assert.equal(workOrderActions(state, dispatcher, [], Date.parse(state.dueAt) + 1).allowed.cancel, false);
  for (const status of ["fulfilled", "cancelled", "closed"]) {
    const result = workOrderActions({ ...state, status }, dispatcher, [], now);
    assert.equal(result.allowed.acknowledge, false);
    assert.equal(result.allowed.decline, false);
    assert.equal(result.allowed.source_acceptance, false);
    assert.equal(result.allowed.fulfill, false);
    assert.equal(result.allowed.cancel, false);
    assert.equal(result.allowed.close, status !== "closed");
  }
  const breached = workOrderActions({ ...state, status: "breached", breachedAt: "2026-09-05T11:59:00Z" }, dispatcher, [], now);
  assert.equal(breached.allowed.cancel, false);
  assert.equal(breached.allowed.close, true);
  assert.equal(breached.primary, "acknowledge");
});

test("auditor and platform role navigation access does not imply domain mutation permission", () => {
  for (const role of ["auditor", "platform_admin"] as const) {
    assert.equal(Object.values(workOrderActions(state, session(role), [attempt], now).allowed).some(Boolean), false);
    assert.equal(Object.values(workOrderActions({ ...state, status: "owned", ownerRecipientId: "recipient-1" }, session(role), [attempt], now).allowed).some(Boolean), false);
  }
});

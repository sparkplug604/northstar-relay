import assert from "node:assert/strict";
import { test } from "node:test";
import { getDetail, isMfaChallenge, relayRequest, useSessionToken } from "../apps/web/src/relay/api.js";
import { localDateInput, reviewedTimestamp } from "../apps/web/src/relay/dateInput.js";
import { stateLabel } from "../apps/web/src/relay/i18n.js";
import { displayWorkOrderState, eventReason } from "../apps/web/src/relay/readModel.js";

test("Relay source review preserves the exact original instant and timestamp precision when unchanged", () => {
  const original = "2026-11-01T01:30:45.120-08:00";
  const visible = localDateInput(original).replace(/0$/, "");
  assert.equal(reviewedTimestamp(visible, original), original);
  assert.equal(reviewedTimestamp(localDateInput("2026-09-05T12:30:00.000Z").replace(/\.000$/, ""), "2026-09-05T12:30:00.000Z"), "2026-09-05T12:30:00.000Z");
  assert.throws(() => reviewedTimestamp("not a timestamp", original), /invalid_timestamp/);
});

test("Relay API uses cookies and action headers only for explicit mutations", async (t) => {
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    requests.push(init); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  useSessionToken({ csrfToken: "unit-test-csrf" });
  await relayRequest("/action/opaque-test-token");
  await relayRequest("/work-orders/test/actions", { method: "POST", body: { action: "acknowledge" }, key: "persistent-test-command" });
  assert.equal(requests[0]?.credentials, "same-origin");
  assert.equal(requests[0]?.cache, "no-store");
  assert.equal((requests[0]?.headers as Record<string, string>)["X-CSRF-Token"], undefined);
  assert.equal(requests[0]?.body, undefined);
  assert.equal((requests[1]?.headers as Record<string, string>)["X-CSRF-Token"], "unit-test-csrf");
  assert.equal((requests[1]?.headers as Record<string, string>)["Idempotency-Key"], "persistent-test-command");
  assert.equal(requests[1]?.body, JSON.stringify({ action: "acknowledge" }));
  useSessionToken(null);
});

test("an authenticated non-MFA login does not enter the MFA challenge screen", () => {
  assert.equal(isMfaChallenge({ mfaRequired: false, csrfToken: "token" }), false);
  assert.equal(isMfaChallenge({ mfaRequired: true, enrollmentRequired: true, csrfToken: "token" }), true);
});

test("Relay normalizes persisted attempt records without using delivery as ownership", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ commitment: { ownerRecipientId: null }, events: [], attempts: [{ attempt_id: "attempt-1", recipient_id: "recipient-1", channel: "voice", status: "delivered", created_at: "2026-09-05T12:00:00Z" }] }), { headers: { "content-type": "application/json" } }));
  const result = await getDetail("work-order-1");
  assert.equal(result.attempts[0]?.attemptId, "attempt-1");
  assert.equal(result.attempts[0]?.status, "delivered");
  assert.equal(result.commitment.ownerRecipientId, null);
});

test("intake review gives bilingual field explanations instead of parser tokens", () => {
  assert.equal(stateLabel("en", "missing_field:due-at"), "Ownership deadline: Missing");
  assert.equal(stateLabel("fr", "missing_field:due-at"), "Échéance de prise en charge: Manquant");
  assert.equal(stateLabel("fr", "unsupported_template"), "Modèle source non reconnu");
});

test("Relay queue shows a late named owner independently from the missed deadline", () => {
  assert.deepEqual(displayWorkOrderState({ status: "breached", ownerRecipientId: "recipient-1", breachedAt: "2026-09-05T12:00:00Z" }), { lifecycle: "owned", deadlineMissed: true });
  assert.deepEqual(displayWorkOrderState({ status: "breached", ownerRecipientId: null, breachedAt: "2026-09-05T12:00:00Z" }), { lifecycle: "active", deadlineMissed: true });
  assert.deepEqual(displayWorkOrderState({ status: "closed", ownerRecipientId: "recipient-1", breachedAt: "2026-09-05T12:00:00Z" }), { lifecycle: "closed", deadlineMissed: true });
  assert.deepEqual(displayWorkOrderState({ status: "owned", ownerRecipientId: "recipient-1", breachedAt: null }), { lifecycle: "owned", deadlineMissed: false });
});

test("the operator timeline includes recorded closure and cancellation explanations", () => {
  assert.equal(eventReason({ eventType: "commitment_closed", payload: { reason: "Manager confirmed the handoff.\nCustomer notified." } }), "Manager confirmed the handoff.\nCustomer notified.");
  assert.equal(eventReason({ eventType: "commitment_cancelled", payload: { reason: "Source withdrew this request." } }), "Source withdrew this request.");
  assert.equal(eventReason({ eventType: "commitment_closed", payload: { reason: null } }), null);
  assert.equal(eventReason({ eventType: "escalation_step_scheduled", payload: { reason: "Internal diagnostic" } }), null);
});

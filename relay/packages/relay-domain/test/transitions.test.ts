import assert from "node:assert/strict";
import test from "node:test";
import { handleRelayCommand } from "../src/index.js";
import { at, base, createActive, createCommand, createScheduled, requireAccepted, scheduleNext } from "./helpers.js";

test("a commitment snapshots the work order, policy and recipients before activation", () => {
  const state = createScheduled();
  assert.equal(state.status, "scheduled");
  assert.equal(state.workOrder.externalId, "WO-1042");
  assert.equal(state.policy.version, 1);
  assert.equal(state.recipients.length, 3);
  assert.equal(state.sourceAcceptance.status, "unknown");
  assert.equal(state.nextEscalationAt, null);
});

test("activation schedules the first policy step and steps advance in policy order", () => {
  let state = createActive();
  assert.equal(state.nextEscalationAt, at(0));

  const first = scheduleNext(state, "step-0", at(0));
  state = requireAccepted(first);
  assert.equal(first.events[0]?.eventType, "escalation_step_scheduled");
  assert.equal(first.events[0]?.payload.stepIndex, 0);
  assert.equal(state.nextStepIndex, 1);
  assert.equal(state.nextEscalationAt, at(120));

  const early = scheduleNext(state, "step-1-early", at(119));
  assert.equal(early.status, "rejected");
  if (early.status === "rejected") assert.equal(early.code, "escalation_not_due");

  state = requireAccepted(scheduleNext(state, "step-1", at(120)));
  assert.deepEqual(state.scheduledStepIndexes, [0, 1]);
  assert.equal(state.nextEscalationAt, at(600));
});

test("recipient acknowledgement names an owner and suppresses later steps", () => {
  let state = createActive();
  state = requireAccepted(scheduleNext(state, "step-primary", at(0)));
  const acknowledged = handleRelayCommand(state, {
    ...base("ack-primary", at(30), "person-primary", "on_call_responder"),
    type: "acknowledge_commitment",
    ownerRecipientId: "recipient-primary",
    mechanism: "dtmf",
    attemptId: "attempt-primary-voice",
  });
  state = requireAccepted(acknowledged);
  assert.equal(state.status, "owned");
  assert.equal(state.ownerRecipientId, "recipient-primary");
  assert.equal(state.nextEscalationAt, null);
  assert.equal(state.sourceAcceptance.status, "unknown");

  const oldTimer = handleRelayCommand(state, {
    ...base("old-step", at(120), "timer", "system"),
    type: "schedule_escalation_step",
    expectedVersion: state.version - 1,
    expectedStepIndex: 1,
    expectedScheduledAt: at(120),
  });
  assert.equal(oldTimer.status, "ignored_stale_timer");
});

test("declining accelerates the next unscheduled escalation step", () => {
  let state = createActive();
  state = requireAccepted(scheduleNext(state, "step-primary", at(0)));
  state = requireAccepted(handleRelayCommand(state, {
    ...base("decline-primary", at(20), "person-primary", "on_call_responder"),
    type: "decline_commitment",
    recipientId: "recipient-primary",
    attemptId: "attempt-primary-voice",
  }));
  assert.deepEqual(state.declinedRecipientIds, ["recipient-primary"]);
  assert.equal(state.nextEscalationAt, at(20));
  state = requireAccepted(scheduleNext(state, "step-secondary", at(20)));
  assert.deepEqual(state.scheduledStepIndexes, [0, 1]);
});

test("the first valid acknowledgement wins", () => {
  let state = createActive();
  state = requireAccepted(handleRelayCommand(state, {
    ...base("ack-primary", at(10), "person-primary", "on_call_responder"),
    type: "acknowledge_commitment",
    ownerRecipientId: "recipient-primary",
    mechanism: "web",
    attemptId: "attempt-primary-sms",
  }));
  const second = handleRelayCommand(state, {
    ...base("ack-secondary", at(11), "person-secondary", "on_call_responder"),
    type: "acknowledge_commitment",
    ownerRecipientId: "recipient-secondary",
    mechanism: "web",
    attemptId: "attempt-secondary-sms",
  });
  assert.equal(second.status, "rejected");
  assert.equal(second.state?.ownerRecipientId, "recipient-primary");
});

test("a duplicate command is idempotent", () => {
  const state = createScheduled();
  const duplicate = handleRelayCommand(state, createCommand());
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.state.version, state.version);
});

test("an acknowledgement received after the deadline preserves both breach and ownership", () => {
  const active = createActive();
  const outcome = handleRelayCommand(active, {
    ...base("late-ack", at(901), "person-primary", "on_call_responder"),
    type: "acknowledge_commitment",
    ownerRecipientId: "recipient-primary",
    mechanism: "dtmf",
    attemptId: "attempt-late",
  });
  const state = requireAccepted(outcome);
  assert.deepEqual(outcome.events.map((event) => event.eventType), ["commitment_breached", "commitment_acknowledged"]);
  assert.equal(state.status, "breached");
  assert.equal(state.breachedAt, at(901));
  assert.equal(state.ownerRecipientId, "recipient-primary");
  assert.equal(state.acknowledgedAt, at(901));
  assert.equal(state.processedCommandIds.filter((id) => id === "late-ack").length, 1);
});

test("a deadline timer is stale after a timely acknowledgement", () => {
  let state = createActive();
  const timerVersion = state.version;
  state = requireAccepted(handleRelayCommand(state, {
    ...base("ack", at(899), "person-primary", "on_call_responder"),
    type: "acknowledge_commitment",
    ownerRecipientId: "recipient-primary",
    mechanism: "web",
    attemptId: "attempt-before-deadline",
  }));
  const breach = handleRelayCommand(state, {
    ...base("breach", at(901), "timer", "system"),
    type: "mark_commitment_breached",
    expectedVersion: timerVersion,
    expectedDueAt: state.dueAt,
  });
  assert.equal(breach.status, "ignored_stale_timer");
  assert.equal(breach.state.breachedAt, null);
});

test("source acceptance is separate and required before fulfillment", () => {
  let state = createActive();
  state = requireAccepted(handleRelayCommand(state, {
    ...base("ack", at(10), "person-primary", "on_call_responder"),
    type: "acknowledge_commitment",
    ownerRecipientId: "recipient-primary",
    mechanism: "web",
    attemptId: "attempt-1",
  }));
  const premature = handleRelayCommand(state, {
    ...base("premature-fulfill", at(20)),
    type: "fulfill_commitment",
  });
  assert.equal(premature.status, "rejected");
  if (premature.status === "rejected") assert.equal(premature.code, "source_acceptance_required");

  state = requireAccepted(handleRelayCommand(state, {
    ...base("source-accepted", at(30), "person-primary", "on_call_responder"),
    type: "record_source_acceptance",
    sourceStatus: "accepted",
  }));
  assert.equal(state.sourceAcceptance.status, "accepted");
  assert.equal(state.status, "owned");

  state = requireAccepted(handleRelayCommand(state, {
    ...base("fulfilled", at(31)),
    type: "fulfill_commitment",
  }));
  assert.equal(state.status, "fulfilled");
  assert.equal(state.breachedAt, null);
});

test("responder identity must match the recipient snapshot", () => {
  const state = createActive();
  const outcome = handleRelayCommand(state, {
    ...base("impersonated-ack", at(10), "person-secondary", "on_call_responder"),
    type: "acknowledge_commitment",
    ownerRecipientId: "recipient-primary",
    mechanism: "dtmf",
    attemptId: "attempt-primary",
  });
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") assert.equal(outcome.code, "recipient_not_authorized");
});

test("only an unowned, unbreached scheduled or active commitment can be cancelled", () => {
  let state = createActive();
  state = requireAccepted(handleRelayCommand(state, {
    ...base("cancel", at(30)),
    type: "cancel_commitment",
    reason: "Duplicate source work order",
  }));
  assert.equal(state.status, "cancelled");
  assert.equal(state.cancellationReason, "Duplicate source work order");
  assert.equal(state.nextEscalationAt, null);
});

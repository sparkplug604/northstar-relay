import assert from "node:assert/strict";
import test from "node:test";
import { evolve, handleRelayCommand, relayCommitmentReadModel, type RelayCommand, type RelayCommitment, type RelayDomainEvent } from "../src/index.js";
import { at, base, createActive, createCommand, createScheduled, requireAccepted, scheduleNext } from "./helpers.js";

function acknowledge(state: RelayCommitment, seconds = 30) {
  return handleRelayCommand(state, {
    ...base(`ack-${seconds}`, at(seconds), "person-primary", "on_call_responder"),
    type: "acknowledge_commitment", ownerRecipientId: "recipient-primary", mechanism: "dtmf", attemptId: "attempt-primary",
  });
}

function breach(state: RelayCommitment, seconds = 901) {
  return handleRelayCommand(state, {
    ...base(`breach-${seconds}`, at(seconds), "worker", "system"), type: "mark_commitment_breached",
    expectedVersion: state.version, expectedDueAt: state.dueAt,
  });
}

test("an expired commitment cannot hide its breach through cancellation before the worker runs", () => {
  for (const active of [createActive(), createScheduled()]) {
    const result = handleRelayCommand(active, { ...base("cancel-after-expiry", at(901)), type: "cancel_commitment", reason: "Duplicate" });
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.code, "deadline_elapsed");
    assert.deepEqual(result.state, active);
  }
});

test("snapshots are deeply frozen copies of inputs and emitted events", () => {
  const command = structuredClone(createCommand());
  const result = handleRelayCommand(null, command);
  const state = requireAccepted(result);
  const mutable = command as unknown as { policy: { steps: { recipientIds: string[] }[] }; recipients: { displayName: string }[]; workOrder: { externalId: string } };
  mutable.policy.steps[0]!.recipientIds[0] = "changed-person";
  mutable.recipients[0]!.displayName = "Changed";
  mutable.workOrder.externalId = "CHANGED";
  assert.equal(state.policy.steps[0]!.recipientIds[0], "recipient-primary");
  assert.equal(state.recipients[0]!.displayName, "Primary Tech");
  assert.equal(state.workOrder.externalId, "WO-1042");
  assert.notEqual(result.events[0]!.payload.policy, state.policy);
  assert.throws(() => { (state.policy.steps[0]!.recipientIds as string[])[0] = "changed"; }, TypeError);
  assert.throws(() => { (result.events[0]!.payload as Record<string, unknown>).policy = {}; }, TypeError);
  assert.ok(Object.isFrozen(result.events));
  assert.ok(Object.isFrozen(state.recipients[0]));
});

test("only system actors can activate, schedule escalation, or record timer breaches", () => {
  const scheduled = createScheduled();
  const active = createActive();
  for (const role of ["on_call_responder", "branch_dispatcher", "organization_admin", "platform_admin"] as const) {
    const commands: [RelayCommitment, RelayCommand][] = [
      [scheduled, { ...base(`activate-${role}`, at(0), "person-primary", role), type: "activate_commitment", expectedVersion: scheduled.version, expectedDueAt: scheduled.dueAt, expectedActivatesAt: scheduled.activatesAt }],
      [active, { ...base(`schedule-${role}`, at(0), "person-primary", role), type: "schedule_escalation_step", expectedVersion: active.version, expectedStepIndex: 0, expectedScheduledAt: active.nextEscalationAt! }],
      [active, { ...base(`breach-${role}`, at(901), "person-primary", role), type: "mark_commitment_breached", expectedVersion: active.version, expectedDueAt: active.dueAt }],
    ];
    for (const [state, command] of commands) {
      const result = handleRelayCommand(state, command);
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.equal(result.code, "system_role_required");
    }
  }
});

test("source acceptance requires the named owner or a dispatcher and only administrators may waive it", () => {
  const active = createActive();
  const owned = requireAccepted(acknowledge(active));
  for (const [state, actorId, sourceStatus] of [
    [active, "person-primary", "accepted"], [owned, "unrelated-person", "accepted"],
    [owned, "person-secondary", "accepted"], [owned, "person-primary", "not_required"],
  ] as const) {
    const result = handleRelayCommand(state, { ...base(`source-${actorId}-${sourceStatus}`, at(40), actorId, "on_call_responder"), type: "record_source_acceptance", sourceStatus });
    assert.equal(result.status, "rejected");
  }
  assert.equal(handleRelayCommand(owned, { ...base("owner-source", at(40), "person-primary", "on_call_responder"), type: "record_source_acceptance", sourceStatus: "accepted" }).status, "accepted");
  assert.equal(handleRelayCommand(owned, { ...base("dispatcher-waiver", at(40)), type: "record_source_acceptance", sourceStatus: "not_required" }).status, "accepted");
});

test("platform administrators have no routine customer mutation rights", () => {
  const create = { ...createCommand(), actorRole: "platform_admin" as const };
  assert.equal(handleRelayCommand(null, create).status, "rejected");
  const active = createActive();
  const actions: RelayCommand[] = [
    { ...base("platform-source", at(40), "platform", "platform_admin"), type: "record_source_acceptance", sourceStatus: "accepted" },
    { ...base("platform-ack", at(40), "platform", "platform_admin"), type: "acknowledge_commitment", ownerRecipientId: "recipient-primary", mechanism: "dispatcher", attemptId: null },
    { ...base("platform-cancel", at(40), "platform", "platform_admin"), type: "cancel_commitment", reason: "Cancel" },
  ];
  for (const command of actions) assert.equal(handleRelayCommand(active, command).status, "rejected");
});

test("a delayed decline never postpones an already due escalation", () => {
  const active = requireAccepted(scheduleNext(createActive(), "primary-step", at(0)));
  const result = handleRelayCommand(active, { ...base("delayed-decline", at(200), "person-primary", "on_call_responder"), type: "decline_commitment", recipientId: "recipient-primary", attemptId: "attempt-primary" });
  assert.equal(requireAccepted(result).nextEscalationAt, at(120));
});

test("administrators and dispatchers may decline only their own contacted assignment", () => {
  for (const actorRole of ["organization_admin", "branch_dispatcher"] as const) {
    const active = createActive();
    const command = { ...base(`decline-${actorRole}`, at(10), "person-primary", actorRole), type: "decline_commitment" as const, recipientId: "recipient-primary", attemptId: "primary-attempt" };
    assert.equal(handleRelayCommand(active, command).status, "accepted");
    assert.equal(handleRelayCommand(active, { ...command, actorId: "person-secondary" }).status, "rejected");
  }
});

test("later policy steps skip every contact identity belonging to a declined person", () => {
  const original = createCommand();
  const command = {
    ...original,
    recipients: [...original.recipients, { recipientId: "primary-other-phone", personId: "person-primary", displayName: "Primary", contactMethodId: "phone-other" }],
    policy: { ...original.policy, steps: original.policy.steps.map((step, index) => index === 1 ? { ...step, recipientIds: ["primary-other-phone"] } : step) },
  };
  let state = requireAccepted(handleRelayCommand(null, command));
  state = requireAccepted(handleRelayCommand(state, { ...base("activate", at(0), "timer", "system"), type: "activate_commitment", expectedVersion: state.version, expectedDueAt: state.dueAt, expectedActivatesAt: state.activatesAt }));
  state = requireAccepted(scheduleNext(state, "first", at(0)));
  state = requireAccepted(handleRelayCommand(state, { ...base("decline", at(20), "person-primary", "on_call_responder"), type: "decline_commitment", recipientId: "recipient-primary", attemptId: "attempt-primary" }));
  const skipped = scheduleNext(state, "skip-repeated-person", at(20));
  state = requireAccepted(skipped);
  assert.equal(skipped.events[0]!.payload.skipped, true);
  assert.deepEqual((skipped.events[0]!.payload.step as { recipientIds: string[] }).recipientIds, []);
  assert.equal(state.nextEscalationAt, at(20));
  assert.equal(handleRelayCommand(state, { ...base("claim-via-other-phone", at(21), "person-primary", "on_call_responder"), type: "acknowledge_commitment", ownerRecipientId: "primary-other-phone", mechanism: "web", attemptId: "attempt-other" }).status, "rejected");
  const final = scheduleNext(state, "owner-step", at(20));
  assert.deepEqual((final.events[0]!.payload.step as { recipientIds: string[] }).recipientIds, ["recipient-owner"]);
});

test("acknowledgement at the exact deadline is timely while breach requires time strictly after it", () => {
  const active = createActive();
  assert.equal(breach(active, 900).status, "rejected");
  const timely = requireAccepted(acknowledge(active, 900));
  assert.equal(timely.status, "owned");
  assert.equal(timely.breachedAt, null);
  assert.equal(breach(timely, 901).status, "ignored_stale_timer");
  const late = acknowledge(active, 901);
  assert.deepEqual(late.events.map((event) => event.aggregateVersion), [3, 4]);
  assert.deepEqual(late.events.map((event) => event.eventType), ["commitment_breached", "commitment_acknowledged"]);
  assert.equal(requireAccepted(late).breachedAt, at(901));
});

test("replay validates aggregate identity, event sequence and schema", () => {
  const creation = handleRelayCommand(null, createCommand());
  const scheduled = requireAccepted(creation);
  const activated = handleRelayCommand(scheduled, { ...base("activate", at(0), "worker", "system"), type: "activate_commitment", expectedVersion: scheduled.version, expectedDueAt: scheduled.dueAt, expectedActivatesAt: scheduled.activatesAt });
  const activation = activated.events[0]!;
  for (const invalid of [
    { ...activation, tenantId: "other-tenant" }, { ...activation, commitmentId: "other-commitment" },
    { ...activation, aggregateVersion: 1 }, { ...activation, aggregateVersion: 3 },
    { ...activation, schemaVersion: 2 },
  ]) assert.throws(() => evolve(scheduled, invalid as RelayDomainEvent));
  assert.throws(() => evolve(requireAccepted(activated), creation.events[0]!));
  assert.throws(() => evolve(null, activation));
  assert.throws(() => evolve(null, { ...creation.events[0]!, aggregateVersion: 2 }));
  assert.deepEqual(evolve(evolve(null, creation.events[0]!), activation), activated.state);
});

test("late acknowledgement multi-event replay preserves one command and the same state", () => {
  const active = createActive();
  const result = acknowledge(active, 901);
  const replayed = result.events.reduce<RelayCommitment>(evolve, active);
  assert.deepEqual(replayed, result.state);
  assert.equal(replayed.processedCommandIds.filter((id) => id === "ack-901").length, 1);
});

test("read model presents lifecycle, ownership SLA and source acceptance independently", () => {
  const active = createActive();
  assert.equal(relayCommitmentReadModel(active, at(901)).ownershipSla, "missed");
  assert.equal(relayCommitmentReadModel(active, at(901)).breachRecordedAt, null);
  const late = requireAccepted(acknowledge(active, 901));
  const model = relayCommitmentReadModel(late, at(902));
  assert.equal(model.lifecycle, "owned");
  assert.equal(model.ownershipSla, "late");
  assert.equal(model.sourceAcceptance.status, "unknown");
  assert.equal(model.breachEffectiveAt, at(900));
  assert.equal(model.breachRecordedAt, at(901));
  assert.equal(relayCommitmentReadModel(requireAccepted(acknowledge(active, 900)), at(1000)).ownershipSla, "on_time");
});

test("closure preserves breach and its reason and finalized source status cannot change", () => {
  const missed = requireAccepted(breach(createActive()));
  const closed = requireAccepted(handleRelayCommand(missed, { ...base("close", at(910)), type: "close_commitment", reason: "  Customer cancelled service  " }));
  assert.equal(closed.closureReason, "Customer cancelled service");
  assert.equal(closed.breachedAt, missed.breachedAt);
  assert.equal(relayCommitmentReadModel(closed, at(920)).ownershipSla, "missed");
  assert.equal(handleRelayCommand(closed, { ...base("source-after-close", at(921)), type: "record_source_acceptance", sourceStatus: "not_required" }).status, "rejected");
});

test("invalid runtime role, command kind, and blank acknowledgement attempt fail closed", () => {
  assert.equal(handleRelayCommand(null, { ...createCommand(), actorRole: "invented" } as unknown as RelayCommand).status, "rejected");
  assert.equal(handleRelayCommand(createActive(), { ...base("unknown", at(1)), type: "invented" } as unknown as RelayCommand).status, "rejected");
  assert.equal(handleRelayCommand(createActive(), { ...base("blank-attempt", at(1), "person-primary", "on_call_responder"), type: "acknowledge_commitment", ownerRecipientId: "recipient-primary", mechanism: "web", attemptId: " " }).status, "rejected");
});

test("tenant mismatches fail even when the command ID has already been processed", () => {
  const state = createScheduled();
  const result = handleRelayCommand(state, { ...createCommand(), tenantId: "other-tenant" });
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") assert.equal(result.code, "aggregate_identity_mismatch");
});

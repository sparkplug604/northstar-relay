import assert from "node:assert/strict";
import test from "node:test";
import { evolve, handleRelayCommand, type RelayCommand, type RelayCommitment } from "../src/index.js";
import { at, base, createCommand, requireAccepted } from "./helpers.js";

test("seeded mixed command sequences retain identity, deadlines, ownership and replay consistency", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    let randomState = seed;
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState; };
    const created = handleRelayCommand(null, createCommand());
    let state = requireAccepted(created);
    let replay: RelayCommitment | null = evolve(null, created.events[0]!);
    let previous: RelayCommand = createCommand();
    let seconds = 0;
    for (let index = 0; index < 80; index += 1) {
      seconds += random() % 35;
      const metadata = base(`seed-${seed}-${index}`, at(seconds));
      const person = random() % 2 === 0 ? "primary" : "secondary";
      const choice = random() % 10;
      const command: RelayCommand = choice === 0 ? previous
        : choice === 1 ? { ...metadata, actorId: "worker", actorRole: "system", type: "activate_commitment", expectedVersion: state.version, expectedDueAt: state.dueAt, expectedActivatesAt: state.activatesAt }
        : choice === 2 ? { ...metadata, actorId: "worker", actorRole: "system", type: "schedule_escalation_step", expectedVersion: state.version, expectedStepIndex: state.nextStepIndex, expectedScheduledAt: state.nextEscalationAt ?? at(0) }
        : choice === 3 ? { ...metadata, actorId: `person-${person}`, actorRole: "on_call_responder", type: "acknowledge_commitment", ownerRecipientId: `recipient-${person}`, mechanism: "web", attemptId: `attempt-${person}` }
        : choice === 4 ? { ...metadata, actorId: `person-${person}`, actorRole: "on_call_responder", type: "decline_commitment", recipientId: `recipient-${person}`, attemptId: `attempt-${person}` }
        : choice === 5 ? { ...metadata, actorId: "worker", actorRole: "system", type: "mark_commitment_breached", expectedVersion: state.version, expectedDueAt: state.dueAt }
        : choice === 6 ? { ...metadata, type: "record_source_acceptance", sourceStatus: "not_required" }
        : choice === 7 ? { ...metadata, type: "fulfill_commitment" }
        : choice === 8 ? { ...metadata, type: "close_commitment", reason: "Reviewed" }
        : { ...metadata, type: "cancel_commitment", reason: "Duplicate" };
      const before = state;
      const result = handleRelayCommand(state, command);
      previous = command;
      if (result.status === "accepted") {
        state = result.state;
        for (const event of result.events) replay = evolve(replay, event);
        assert.equal(state.version, before.version + result.events.length);
        assert.deepEqual(state, replay);
        assert.ok(Object.isFrozen(state));
      } else {
        assert.deepEqual(result.state, before);
        assert.equal(result.events.length, 0);
      }
      assert.equal(state.tenantId, "tenant-1");
      assert.equal(state.commitmentId, "commitment-1");
      assert.equal(state.dueAt, at(900));
      if (before.ownerRecipientId !== null) assert.equal(state.ownerRecipientId, before.ownerRecipientId);
      if (before.breachedAt !== null) assert.equal(state.breachedAt, before.breachedAt);
      if (state.acknowledgedAt !== null && Date.parse(state.acknowledgedAt) > Date.parse(state.dueAt)) assert.notEqual(state.breachedAt, null);
      if (state.ownerRecipientId !== null || state.status === "closed" || state.status === "cancelled") assert.equal(state.nextEscalationAt, null);
    }
  }
});

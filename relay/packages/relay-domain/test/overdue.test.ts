import assert from 'node:assert/strict';
import test from 'node:test';
import { evolve, handleRelayCommand } from '../src/index.js';
import { at, createCommand, requireAccepted } from './helpers.js';

function overdueCommand() {
  const command = createCommand();
  return {
    ...command, receivedOverdue: true, activatesAt: at(1800), occurredAt: at(1800),
    policy: { ...command.policy, steps: [{ stepId: 'overdue-fallback', offsetSeconds: 0, recipientIds: command.recipients.map((recipient) => recipient.recipientId), channels: ['voice' as const], terminal: true }] },
  };
}
test('overdue source intake preserves the original deadline and atomically schedules immediate unowned fallback', () => {
  const command = overdueCommand();
  const result = handleRelayCommand(null, command);
  const state = requireAccepted(result);
  assert.equal(state.dueAt, at(900));
  assert.equal(state.activatesAt, at(1800));
  assert.equal(state.createdAt, at(1800));
  assert.equal(state.breachedAt, at(1800));
  assert.equal(state.status, 'breached');
  assert.equal(state.ownerRecipientId, null);
  assert.equal(state.sourceAcceptance.status, 'unknown');
  assert.equal(state.nextEscalationAt, null);
  assert.deepEqual(result.events.map((event) => event.eventType), ['commitment_created', 'commitment_activated', 'commitment_breached', 'escalation_step_scheduled']);
  assert.deepEqual(state.scheduledStepIndexes, [0]);
  let replayed = null;
  for (const event of result.events) replayed = evolve(replayed, event);
  assert.deepEqual(replayed, state);
});
test('overdue intake mode cannot be used to breach a future deadline or delay fallback', () => {
  const command = overdueCommand();
  assert.equal(handleRelayCommand(null, { ...command, dueAt: at(1900) }).status, 'rejected');
  assert.equal(handleRelayCommand(null, { ...command, dueAt: at(1800) }).status, 'rejected');
  assert.equal(handleRelayCommand(null, { ...command, policy: { ...command.policy, steps: [{ ...command.policy.steps[0]!, offsetSeconds: 30 }] } }).status, 'rejected');
  assert.equal(handleRelayCommand(null, { ...command, workOrder: { ...command.workOrder, sourceKind: 'manual' } }).status, 'rejected');
});
test('normal future intake and ordinary timestamp validation remain unchanged', () => {
  assert.equal(handleRelayCommand(null, createCommand()).state?.status, 'scheduled');
  const command = overdueCommand();
  assert.equal(handleRelayCommand(null, { ...command, receivedOverdue: false }).status, 'rejected');
});

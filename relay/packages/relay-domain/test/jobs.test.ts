import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeJobActor, createJob, deriveJob, jobAttentionReasons, newStandaloneJob, JobTransitionError, transitionJob, type Job, type JobAction, type JobActor, type JobMilestone } from '../src/index.js';
import { at, createActive } from './helpers.js';

const dispatcher: JobActor = { id: 'dispatcher-1', role: 'branch_dispatcher' };
const technician: JobActor = { id: 'person-primary', role: 'on_call_responder' };
type Intent = JobAction extends infer A ? A extends JobAction ? Omit<A, 'expectedVersion'> : never : never;
function act(job: Job, milestones: readonly JobMilestone[], input: Intent, actor = dispatcher, seconds = 10) {
  return transitionJob(job, milestones, { ...input, expectedVersion: job.version } as JobAction,
    actor, at(seconds), `event-${job.version}`, `milestone-${job.version}`);
}
function initial(): Job { return createJob(createActive(), 'Emergency refrigeration request', at(0)); }
function started() {
  const assigned = act(initial(), [], { action: 'assign', assigneeId: technician.id });
  return act(assigned.job, [], { action: 'start', note: 'Work begun' }, technician);
}
function hasCode(code: string) { return (error: unknown) => error instanceof JobTransitionError && error.code === code; }

test('acknowledgement fulfillment and closure never infer work completion', () => {
  for (const status of ['owned', 'fulfilled', 'closed', 'cancelled'] as const) {
    const job = createJob({ ...createActive(), status, ownerRecipientId: 'recipient-primary', fulfilledAt: at(3), closedAt: at(4) }, 'Imported job', at(5));
    assert.equal(job.status, 'requested'); assert.equal(job.assigneeId, technician.id);
    assert.equal(job.completedAt, null); assert.equal(job.completionReportedAt, null);
  }
});

test('job journey separates blocked work, reported completion and confirmed completion', () => {
  let state = act(initial(), [], { action: 'assign', assigneeId: technician.id });
  state = act(state.job, state.milestones, { action: 'schedule', scheduledAt: at(200), note: 'Morning visit booked' });
  assert.equal(state.job.status, 'scheduled');
  state = act(state.job, state.milestones, { action: 'start', note: 'Arrived on site' }, technician, 200);
  state = act(state.job, state.milestones, { action: 'block', note: 'Waiting for replacement valve' }, technician, 220);
  assert.equal(state.job.blocker, 'Waiting for replacement valve');
  state = act(state.job, state.milestones, { action: 'resume', note: 'Replacement valve arrived' }, technician, 300);
  assert.equal(state.job.blocker, null);
  state = act(state.job, state.milestones, { action: 'report_completion', note: 'Valve replaced; temperature stable' }, technician, 400);
  assert.equal(state.job.status, 'completion_reported'); assert.equal(state.job.completedAt, null);
  assert.equal(state.job.completionReportedAt, at(400)); assert.equal(state.job.completionReportedBy, technician.id);
  state = act(state.job, state.milestones, { action: 'confirm_completion', note: 'Completion reviewed with customer' }, dispatcher, 500);
  assert.equal(state.job.status, 'completed'); assert.equal(state.job.completedAt, at(500)); assert.equal(state.job.completedBy, dispatcher.id);
  assert.equal(state.job.completionReportedAt, at(400));
});

test('unassigned and unrelated responders cannot operate a job', () => {
  assert.throws(() => act(initial(), [], { action: 'start', note: 'Starting now' }), hasCode('assignee_required'));
  assert.throws(() => act(initial(), [], { action: 'add_update', note: 'Unassigned update' }, technician), hasCode('forbidden'));
  assert.throws(() => act(started().job, [], { action: 'add_update', note: 'Someone else' }, { id: 'other', role: 'on_call_responder' }), hasCode('forbidden'));
});

test('responders cannot assign, schedule, confirm, reopen or cancel the job', () => {
  const job = started().job;
  const actions: Intent[] = [{ action: 'assign', assigneeId: 'other' }, { action: 'schedule', scheduledAt: at(500), note: 'New plan' },
    { action: 'confirm_completion', note: 'Looks done' }, { action: 'reopen', note: 'Reopen please' }, { action: 'cancel', note: 'Cancel please' }];
  for (const action of actions) assert.throws(() => act(job, [], action, technician), hasCode('forbidden'));
});

test('multiple milestones prevent completion until each is resolved', () => {
  let state = started();
  state = act(state.job, state.milestones, { action: 'add_milestone', title: 'ETA update', ownerId: technician.id, dueAt: at(100) });
  state = act(state.job, state.milestones, { action: 'add_milestone', title: 'Confirm parts arrival', ownerId: dispatcher.id, dueAt: at(200) });
  assert.equal(state.job.openMilestoneCount, 2); assert.equal(state.job.nextDueAt, at(100));
  assert.throws(() => act(state.job, state.milestones, { action: 'report_completion', note: 'Work done' }, technician), hasCode('unresolved_milestones'));
  state = act(state.job, state.milestones, { action: 'complete_milestone', milestoneId: state.milestones[0]!.id, note: 'ETA shared with customer' }, technician, 110);
  assert.equal(state.event.details.completedLate, true); assert.equal(state.milestones[0]!.completedBy, technician.id);
  state = act(state.job, state.milestones, { action: 'cancel_milestone', milestoneId: state.milestones[1]!.id, note: 'No replacement parts needed' }, dispatcher, 120);
  assert.equal(state.job.openMilestoneCount, 0);
  state = act(state.job, state.milestones, { action: 'report_completion', note: 'Unit repaired and tested' }, technician, 130);
  assert.equal(state.job.status, 'completion_reported');
});

test('overdue status is derived from supplied server time without changing the stored milestone', () => {
  const state = act(started().job, [], { action: 'add_milestone', title: 'Progress update', ownerId: technician.id, dueAt: at(100) });
  assert.equal(deriveJob(state.job, state.milestones, at(100)).overdueMilestoneCount, 0);
  assert.equal(deriveJob(state.job, state.milestones, at(101)).overdueMilestoneCount, 1);
  assert.equal(state.milestones[0]!.status, 'open');
});

test('deadline revisions preserve old and new due dates and explanation', () => {
  let state = act(started().job, [], { action: 'add_milestone', title: 'Parts arrival', ownerId: technician.id, dueAt: at(100) });
  state = act(state.job, state.milestones, { action: 'reschedule_milestone', milestoneId: state.milestones[0]!.id, dueAt: at(300), note: 'Supplier delayed shipment' }, technician, 150);
  assert.equal(state.event.details.oldDueAt, at(100)); assert.equal(state.event.details.newDueAt, at(300));
  assert.equal(state.event.note, 'Supplier delayed shipment'); assert.equal(state.job.nextDueAt, at(300));
});

test('cancellation explicitly resolves outstanding milestones and reopening requires a new start', () => {
  let state = act(started().job, [], { action: 'add_milestone', title: 'Return visit', ownerId: technician.id, dueAt: at(200) });
  const milestoneId = state.milestones[0]!.id;
  state = act(state.job, state.milestones, { action: 'cancel', note: 'Customer withdrew request' });
  assert.equal(state.job.status, 'cancelled'); assert.equal(state.job.openMilestoneCount, 0);
  assert.deepEqual(state.event.details.cancelledMilestoneIds, [milestoneId]);
  assert.throws(() => act(state.job, state.milestones, { action: 'add_update', note: 'Late change' }), hasCode('job_closed'));
  state = act(state.job, state.milestones, { action: 'reopen', note: 'Customer reinstated request' });
  assert.equal(state.job.status, 'requested'); assert.equal(state.milestones[0]!.status, 'cancelled');
});

test('completed job cannot be edited and reopening does not retain misleading completion timestamps', () => {
  let state = act(started().job, [], { action: 'report_completion', note: 'Repair tested' }, technician);
  assert.throws(() => act(state.job, [], { action: 'add_milestone', title: 'More work', ownerId: technician.id, dueAt: at(300) }), hasCode('completion_review_pending'));
  state = act(state.job, [], { action: 'confirm_completion', note: 'Repair verified' });
  assert.throws(() => act(state.job, [], { action: 'add_update', note: 'Retroactive change' }), hasCode('job_closed'));
  state = act(state.job, [], { action: 'reopen', note: 'Fault returned after visit' });
  assert.equal(state.job.completedAt, null); assert.equal(state.job.completionReportedAt, null);
  assert.equal(state.event.details.fromStatus, 'completed');
});

test('invalid transitions, empty reasons, invalid due dates and stale versions do not mutate state', () => {
  const state = started(); const original = structuredClone(state);
  assert.throws(() => act(state.job, [], { action: 'resume', note: 'Not blocked' }), hasCode('invalid_job_state'));
  assert.throws(() => act(state.job, [], { action: 'block', note: '  ' }), hasCode('note_required'));
  assert.throws(() => act(state.job, [], { action: 'add_milestone', title: 'Bad date', ownerId: technician.id, dueAt: 'invalid' }), hasCode('invalid_time'));
  assert.throws(() => transitionJob(state.job, [], { action: 'add_update', note: 'Stale update', expectedVersion: state.job.version - 1 }, dispatcher, at(20), 'e', 'm'), hasCode('job_version_conflict'));
  assert.deepEqual(state, original);
});

test('already missed promises may be recorded overdue but revised dates must be future', () => {
  const state = act(started().job, [], { action: 'add_milestone', title: 'Missed supplier reply', ownerId: technician.id, dueAt: at(1) }, dispatcher, 10);
  assert.equal(state.job.overdueMilestoneCount, 1);
  assert.throws(() => act(state.job, state.milestones, { action: 'reschedule_milestone', milestoneId: state.milestones[0]!.id, dueAt: at(2), note: 'Invalid revision' }), hasCode('future_time_required'));
});

test('a separate milestone owner may update, revise and complete their promise without owning the job', () => {
  const owner: JobActor = { id: 'milestone-owner', role: 'on_call_responder' };
  let state = act(started().job, [], { action: 'add_milestone', title: 'Supplier response', ownerId: owner.id, dueAt: at(100) });
  const milestoneId = state.milestones[0]!.id;
  assert.deepEqual(state.job.openMilestoneOwnerIds, [owner.id]);
  state = act(state.job, state.milestones, { action: 'add_update', note: 'Supplier contacted' }, owner);
  state = act(state.job, state.milestones, { action: 'reschedule_milestone', milestoneId, dueAt: at(200), note: 'Supplier needs more time' }, owner);
  state = act(state.job, state.milestones, { action: 'complete_milestone', milestoneId, note: 'Supplier confirmed availability' }, owner, 150);
  assert.equal(state.milestones[0]!.completedBy, owner.id); assert.deepEqual(state.job.openMilestoneOwnerIds, []);
  assert.equal(state.job.assigneeId, technician.id); assert.equal(state.job.status, 'in_progress');
});

test('milestone ownership does not grant lifecycle or other owners’ milestone permissions', () => {
  const owner: JobActor = { id: 'milestone-owner', role: 'on_call_responder' };
  let state = act(started().job, [], { action: 'add_milestone', title: 'Own promise', ownerId: owner.id, dueAt: at(100) });
  const ownMilestoneId = state.milestones[0]!.id;
  state = act(state.job, state.milestones, { action: 'add_milestone', title: 'Other promise', ownerId: technician.id, dueAt: at(200) });
  const otherMilestoneId = state.milestones[1]!.id;
  for (const action of [
    { action: 'block', note: 'Cannot block whole job' },
    { action: 'report_completion', note: 'Cannot complete whole job' },
    { action: 'add_milestone', title: 'Cannot add new promise', ownerId: owner.id, dueAt: at(300) },
    { action: 'complete_milestone', milestoneId: otherMilestoneId, note: 'Not my promise' },
    { action: 'cancel_milestone', milestoneId: otherMilestoneId, note: 'Not my promise' },
    { action: 'reschedule_milestone', milestoneId: otherMilestoneId, dueAt: at(300), note: 'Not my promise' },
  ] as Intent[]) assert.throws(() => act(state.job, state.milestones, action, owner), hasCode('forbidden'));
  state = act(state.job, state.milestones, { action: 'cancel_milestone', milestoneId: ownMilestoneId, note: 'Own promise no longer required' }, owner);
  assert.equal(state.milestones[0]!.status, 'cancelled');
});

test('resolved milestone ownership authorizes exact replay checks but not new edits or updates', () => {
  const owner: JobActor = { id: 'milestone-owner', role: 'on_call_responder' };
  let state = act(started().job, [], { action: 'add_milestone', title: 'Own promise', ownerId: owner.id, dueAt: at(100) });
  const input = { action: 'complete_milestone', milestoneId: state.milestones[0]!.id, note: 'Own promise delivered' } as const;
  const replay: JobAction = { ...input, expectedVersion: state.job.version };
  state = act(state.job, state.milestones, input, owner);
  assert.doesNotThrow(() => authorizeJobActor(state.job, owner, state.milestones, replay));
  assert.throws(() => act(state.job, state.milestones, input, owner), hasCode('milestone_closed'));
  assert.throws(() => act(state.job, state.milestones, { action: 'add_update', note: 'No outstanding responsibility' }, owner), hasCode('forbidden'));
});

test('attention reasons combine operational and acknowledgement risks without calling a provider', () => {
  const job = newStandaloneJob({ externalId: 'JOB', customerReference: 'Customer', branchId: 'branch-1', priority: 'normal' }, 'job-1', at(0));
  assert.equal(job.acknowledgementId, null); assert.deepEqual(jobAttentionReasons(job, [], at(0)), ['unassigned']);
  assert.deepEqual(jobAttentionReasons({ ...job, assigneeId: technician.id, status: 'scheduled', scheduledAt: at(5) }, [], at(10)), ['missed_start']);
  const milestone: JobMilestone = { id: 'm', title: 'Due promise', ownerId: technician.id, dueAt: at(100), status: 'open', completedAt: null, completedBy: null, createdAt: at(0), updatedAt: at(0) };
  const reasons = jobAttentionReasons({ ...job, status: 'blocked' }, [milestone], at(1000), createActive(), true);
  assert.deepEqual(reasons, ['unassigned', 'acknowledgement_unowned', 'acknowledgement_overdue', 'delivery_problem', 'blocked', 'overdue_commitment']);
  assert.deepEqual(jobAttentionReasons({ ...job, status: 'completed' }, [milestone], at(1000), createActive(), true), []);
  assert.deepEqual(jobAttentionReasons({ ...job, status: 'completion_reported', assigneeId: technician.id }, [], at(1000)), ['completion_review']);
});

test('only dispatch can remove an assignment before work starts', () => {
  const assigned = act(initial(), [], { action: 'assign', assigneeId: technician.id }).job;
  const scheduled = act(assigned, [], { action: 'schedule', scheduledAt: at(200), note: 'Visit booked' }).job;
  assert.throws(() => act(scheduled, [], { action: 'unassign' }, technician), hasCode('forbidden'));
  assert.throws(() => act(started().job, [], { action: 'unassign' }), hasCode('invalid_job_state'));

  const result = act(scheduled, [], { action: 'unassign' });
  assert.equal(result.job.assigneeId, null);
  assert.equal(result.job.status, 'scheduled');
  assert.equal(result.job.scheduledAt, scheduled.scheduledAt);
  assert.equal(result.job.version, scheduled.version + 1);
  assert.equal(result.event.kind, 'job_unassigned');
  assert.equal(result.event.details.previousAssigneeId, technician.id);
});


test('a supplier update changes the blocker without resuming or losing the previous reason',()=>{
 const blocked=act(started().job,[],{action:'block',note:'Supplier has not confirmed arrival'});
 const updated=act(blocked.job,[],{action:'update_blocker',blocker:'Supplier confirmed Monday delivery; part still pending',note:'Approved supplier update'});
 assert.equal(updated.job.status,'blocked');assert.equal(updated.job.blocker,'Supplier confirmed Monday delivery; part still pending');
 assert.equal(updated.event.kind,'job_blocker_updated');assert.equal(updated.event.details.previousBlocker,'Supplier has not confirmed arrival');
 assert.throws(()=>act(started().job,[],{action:'update_blocker',blocker:'Waiting for delivery',note:'Cannot update an unblocked job'}),hasCode('invalid_job_state'));
});

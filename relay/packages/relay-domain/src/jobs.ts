import type { RelayActorRole, RelayCommitment } from './types.js';

export type JobStatus = 'requested' | 'scheduled' | 'in_progress' | 'blocked' | 'completion_reported' | 'completed' | 'cancelled';
export interface Job {
  id: string; branchId: string; acknowledgementId: string | null;
  externalId: string; customerReference: string; priority: string; description: string;
  status: JobStatus; version: number; assigneeId: string | null;
  scheduledAt: string | null; blocker: string | null; completionNote: string | null;
  completionReportedAt: string | null; completionReportedBy: string | null;
  completedAt: string | null; completedBy: string | null; createdAt: string; updatedAt: string;
  openMilestoneCount: number; overdueMilestoneCount: number; nextDueAt: string | null;
  site?: { label: string; latitude: number; longitude: number };
  estimatedMinutes?: number;
  requiredSkills?: string[];
  serviceWindow?: {earliestStart:string|null;completeBy:string|null};
  clientTiming?:{timezone:string;completeByLabel:string|null;earliestStartLabel:string|null};
  openMilestoneOwnerIds?: string[];
  attentionReasons?: JobAttentionReason[];
}
export interface JobMilestone {
  id: string; title: string; ownerId: string; dueAt: string;
  status: 'open' | 'completed' | 'cancelled'; completedAt: string | null; completedBy: string | null;
  createdAt: string; updatedAt: string;
}
export interface JobEvent {
  id: string; kind: string; actorId: string; occurredAt: string; note: string;
  details: Record<string, unknown>;
}
export interface JobDetail {
  job: Job; milestones: JobMilestone[]; events: JobEvent[];
  acknowledgement: RelayCommitment | null; asOf: string;
}
export type JobAttentionReason = 'unassigned' | 'missed_start' | 'acknowledgement_unowned' | 'acknowledgement_overdue' | 'delivery_problem' | 'blocked' | 'completion_review' | 'overdue_commitment';
export interface JobOverview { active: number; attention: number; mine: number; completionReview: number; asOf: string }
export interface JobListResult { items: Job[]; total: number; hasMore: boolean; nextOffset: number | null; asOf: string }
export interface JobCommitmentItem {
  milestone: JobMilestone;
  job: Pick<Job, 'id' | 'externalId' | 'customerReference' | 'branchId' | 'status' | 'assigneeId'>;
  jobVersion: number;
}
export interface JobCommitmentListResult { items: JobCommitmentItem[]; total: number; hasMore: boolean; nextOffset: number | null; asOf: string }
export interface StandaloneJobInput { externalId: string; customerReference: string; branchId: string; priority: string; description?: string | undefined; serviceWindow?:{earliestStart:string|null;completeBy:string|null}|undefined }
export type JobAction = (
  | { action: 'assign'; assigneeId: string; checkAvailability?: boolean | undefined }
  | {action:'assign_visit';assigneeId:string;scheduledAt:string;note:string}
  | {action:'dispatch_details';priority?:string|undefined;serviceWindow?:{earliestStart:string|null;completeBy:string|null}|undefined;site:{label:string;latitude:number;longitude:number}|null;estimatedMinutes:number;requiredSkills:string[]}
  | { action: 'unassign' }
  | { action:'update_blocker';blocker:string;note:string }
  | { action: 'schedule'; scheduledAt: string; note: string }
  | { action: 'start' | 'block' | 'resume' | 'report_completion' | 'confirm_completion' | 'reopen' | 'cancel' | 'add_update'; note: string }
  | { action: 'add_milestone'; title: string; ownerId: string; dueAt: string }
  | { action: 'reschedule_milestone'; milestoneId: string; dueAt: string; note: string }
  | { action: 'complete_milestone' | 'cancel_milestone'; milestoneId: string; note: string }
) & { expectedVersion: number };
export class JobTransitionError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 422) { super(message); }
}
export interface JobActor { id: string; role: RelayActorRole }

export function jobAttentionReasons(job: Job, milestones: readonly JobMilestone[], asOf: string, acknowledgement: RelayCommitment | null = null, deliveryProblem = false): JobAttentionReason[] {
  if (['completed', 'cancelled'].includes(job.status)) return [];
  const reasons: JobAttentionReason[] = [];
  if (!job.assigneeId) reasons.push('unassigned');
  if (job.status === 'scheduled' && job.scheduledAt && Date.parse(job.scheduledAt) < Date.parse(asOf)) reasons.push('missed_start');
  const unowned = acknowledgement && !acknowledgement.ownerRecipientId && ['scheduled', 'active', 'breached'].includes(acknowledgement.status);
  if (unowned) {
    reasons.push('acknowledgement_unowned');
    if (Date.parse(acknowledgement.dueAt) < Date.parse(asOf)) reasons.push('acknowledgement_overdue');
  }
  if (unowned && deliveryProblem) reasons.push('delivery_problem');
  if (job.status === 'blocked') reasons.push('blocked');
  if (job.status === 'completion_reported') reasons.push('completion_review');
  if (milestones.some((item) => item.status === 'open' && Date.parse(item.dueAt) < Date.parse(asOf))) reasons.push('overdue_commitment');
  return reasons;
}
export function deriveJob(job: Job, milestones: readonly JobMilestone[], asOf: string, acknowledgement: RelayCommitment | null = null, deliveryProblem = false): Job {
  const open = milestones.filter((item) => item.status === 'open');
  return { ...job, openMilestoneCount: open.length,
    overdueMilestoneCount: open.filter((item) => Date.parse(item.dueAt) < Date.parse(asOf)).length,
    openMilestoneOwnerIds: [...new Set(open.map((item) => item.ownerId))],
    attentionReasons: jobAttentionReasons(job, milestones, asOf, acknowledgement, deliveryProblem),
    nextDueAt: open.map((item) => item.dueAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null };
}

export function createJob(acknowledgement: RelayCommitment, description: string, now: string): Job {
  return {
    id: acknowledgement.commitmentId, branchId: acknowledgement.branchId,
    acknowledgementId: acknowledgement.commitmentId,
    externalId: acknowledgement.workOrder.externalId, customerReference: acknowledgement.workOrder.customerReference,
    priority: acknowledgement.workOrder.priority,
    description, status: 'requested', version: 1,
    assigneeId: acknowledgement.recipients.find((item) => item.recipientId === acknowledgement.ownerRecipientId)?.personId ?? null,
    scheduledAt: null, blocker: null, completionNote: null, completionReportedAt: null,
    completionReportedBy: null, completedAt: null, completedBy: null, createdAt: now, updatedAt: now,
    openMilestoneCount: 0, overdueMilestoneCount: 0, nextDueAt: null,
  };
}

export function newStandaloneJob(input: StandaloneJobInput, id: string, now: string): Job {
  return {
    ...(input.serviceWindow?{serviceWindow:{...input.serviceWindow}}:{}),
    id, branchId: input.branchId, acknowledgementId: null, externalId: input.externalId,
    customerReference: input.customerReference, priority: input.priority, description: input.description ?? '',
    status: 'requested', version: 1, assigneeId: null, scheduledAt: null, blocker: null,
    completionNote: null, completionReportedAt: null, completionReportedBy: null, completedAt: null, completedBy: null,
    createdAt: now, updatedAt: now, openMilestoneCount: 0, overdueMilestoneCount: 0,
    openMilestoneOwnerIds: [], nextDueAt: null, attentionReasons: ['unassigned'],
  };
}

export function authorizeJobActor(job: Job, actor: JobActor, milestones: readonly JobMilestone[] = [], input?: JobAction): void {
  const milestoneAction = input && ['complete_milestone', 'reschedule_milestone', 'cancel_milestone'].includes(input.action)
    && 'milestoneId' in input && milestones.some((item) => item.id === input.milestoneId && item.ownerId === actor.id);
  const milestoneUpdate = input?.action === 'add_update' && milestones.some((item) => item.status === 'open' && item.ownerId === actor.id);
  if (actor.role !== 'organization_admin' && actor.role !== 'branch_dispatcher'
    && !(actor.role === 'on_call_responder' && (actor.id === job.assigneeId || milestoneAction || milestoneUpdate))) {
    throw new JobTransitionError('forbidden', 'This action requires the assigned responder, commitment owner, dispatcher, or administrator', 403);
  }
}

function requireState(job: Job, statuses: readonly JobStatus[]): void {
  if (!statuses.includes(job.status)) throw new JobTransitionError('invalid_job_state', 'This action is not available for the current job state');
}
function requireNote(note: string): string {
  if (note.trim().length < 3 || note.length > 10000) throw new JobTransitionError('note_required', 'Record an explanation of at least three characters');
  return note.trim();
}
function milestoneTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new JobTransitionError('invalid_time', 'Choose a valid date and time');
  return new Date(timestamp).toISOString();
}
function futureTime(value: string, now: string): string {
  const timestamp = milestoneTime(value);
  if (Date.parse(timestamp) <= Date.parse(now)) throw new JobTransitionError('future_time_required', 'Choose a future date and time');
  return timestamp;
}

/** Pure transition: the caller supplies trusted server time, actor, and generated IDs. */
export function transitionJob(current: Job, currentMilestones: readonly JobMilestone[], input: JobAction,
  actor: JobActor, now: string, eventId: string, milestoneId: string): { job: Job; milestones: JobMilestone[]; event: JobEvent } {
  authorizeJobActor(current, actor, currentMilestones, input);
  if (current.version !== input.expectedVersion) throw new JobTransitionError('job_version_conflict', 'This job changed. Reload before saving.', 409);
  const manager = actor.role === 'organization_admin' || actor.role === 'branch_dispatcher';
  if (['assign', 'assign_visit', 'unassign', 'dispatch_details', 'schedule', 'confirm_completion', 'reopen', 'cancel'].includes(input.action) && !manager) {
    throw new JobTransitionError('forbidden', 'A dispatcher or administrator must perform this action', 403);
  }
  if (['completed', 'cancelled'].includes(current.status) && input.action !== 'reopen') {
    throw new JobTransitionError('job_closed', 'Reopen the job before making changes');
  }
  if (current.status === 'completion_reported' && !['confirm_completion', 'reopen', 'add_update', 'cancel'].includes(input.action)) {
    throw new JobTransitionError('completion_review_pending', 'Confirm completion or reopen the job before making further changes');
  }
  const job = { ...current, version: current.version + 1, updatedAt: now };
  const milestones = currentMilestones.map((item) => ({ ...item }));
  const event: JobEvent = { id: eventId, kind: '', actorId: actor.id, occurredAt: now,
    note: 'note' in input ? requireNote(input.note) : '', details: { fromStatus: current.status } };
  const noOpenMilestones = () => {
    if (milestones.some((item) => item.status === 'open')) throw new JobTransitionError('unresolved_milestones', 'Complete or cancel open commitments before recording job completion');
  };
  switch (input.action) {
    case 'assign':
      if (!input.assigneeId) throw new JobTransitionError('assignee_required', 'Choose an assigned person');
      job.assigneeId = input.assigneeId; event.kind = 'job_assigned';
      event.details = { previousAssigneeId: current.assigneeId, assigneeId: input.assigneeId };
      break;
    case 'assign_visit':
      requireState(current, ['requested', 'scheduled']);
      if (!input.assigneeId) throw new JobTransitionError('assignee_required', 'Choose a technician');
      job.assigneeId = input.assigneeId;
      job.scheduledAt = futureTime(input.scheduledAt, now);
      job.status = 'scheduled';
      event.kind = 'job_visit_assigned';
      event.details = {previousAssigneeId:current.assigneeId,assigneeId:input.assigneeId,
        previousScheduledAt:current.scheduledAt,scheduledAt:input.scheduledAt};
      break;
    case 'dispatch_details':
      if (['completed', 'cancelled'].includes(current.status)) throw new JobTransitionError('invalid_job_state', 'This job is closed');
      if (input.site) job.site = input.site;
      else delete job.site;
      if(input.priority!==undefined)job.priority=input.priority;
      if(input.serviceWindow!==undefined)job.serviceWindow={...input.serviceWindow};
      job.estimatedMinutes = input.estimatedMinutes;
      job.requiredSkills = [...input.requiredSkills];
      event.kind = 'job_dispatch_details_updated';
      event.details = { previousSite: current.site ?? null, site: input.site,
        previousEstimatedMinutes: current.estimatedMinutes ?? null, estimatedMinutes: input.estimatedMinutes,
        previousRequiredSkills: current.requiredSkills ?? null, requiredSkills: input.requiredSkills,
        previousPriority:current.priority,priority:job.priority,previousServiceWindow:current.serviceWindow??null,serviceWindow:job.serviceWindow??null };
      break;
    case 'unassign':
      requireState(current, ['requested', 'scheduled']);
      if (!current.assigneeId) throw new JobTransitionError('assignee_required', 'This job is already unassigned');
      job.assigneeId = null;
      event.kind = 'job_unassigned';
      event.details = { previousAssigneeId: current.assigneeId };
      break;
    case 'schedule':
      job.scheduledAt = futureTime(input.scheduledAt, now);
      if (current.status === 'requested') job.status = 'scheduled';
      event.kind = 'job_scheduled'; event.details = { previousScheduledAt: current.scheduledAt, scheduledAt: job.scheduledAt };
      break;
    case 'start':
      requireState(current, ['requested', 'scheduled']);
      if (!job.assigneeId) throw new JobTransitionError('assignee_required', 'Assign the job before starting work');
      job.status = 'in_progress'; event.kind = 'job_started'; break;
    case 'block':
      requireState(current, ['in_progress']); job.status = 'blocked'; job.blocker = event.note; event.kind = 'job_blocked'; break;
    case 'update_blocker':
      requireState(current, ['blocked']);
      job.blocker=requireNote(input.blocker);event.kind='job_blocker_updated';
      event.details={previousBlocker:current.blocker,blocker:job.blocker};break;
    case 'resume':
      requireState(current, ['blocked']); job.status = 'in_progress'; job.blocker = null; event.kind = 'job_resumed'; break;
    case 'report_completion':
      requireState(current, ['in_progress']); noOpenMilestones();
      job.status = 'completion_reported'; job.completionNote = event.note;
      job.completionReportedAt = now; job.completionReportedBy = actor.id; event.kind = 'completion_reported'; break;
    case 'confirm_completion':
      requireState(current, ['completion_reported']); noOpenMilestones();
      job.status = 'completed'; job.completedAt = now; job.completedBy = actor.id; event.kind = 'completion_confirmed'; break;
    case 'reopen':
      requireState(current, ['completion_reported', 'completed', 'cancelled']);
      job.status = 'requested'; job.blocker = null; job.scheduledAt = null; job.completionNote = null;
      job.completionReportedAt = null; job.completionReportedBy = null; job.completedAt = null; job.completedBy = null;
      event.kind = 'job_reopened'; break;
    case 'cancel':
      job.status = 'cancelled'; job.blocker = null; event.kind = 'job_cancelled';
      event.details = { fromStatus: current.status, cancelledMilestoneIds: milestones.filter((item) => item.status === 'open').map((item) => item.id) };
      for (const milestone of milestones) if (milestone.status === 'open') { milestone.status = 'cancelled'; milestone.updatedAt = now; }
      break;
    case 'add_update': event.kind = 'update_added'; break;
    case 'add_milestone': {
      const title = requireNote(input.title);
      if (title.length > 200 || !input.ownerId) throw new JobTransitionError('milestone_invalid', 'Choose a short title and owner');
      const dueAt = milestoneTime(input.dueAt);
      milestones.push({ id: milestoneId, title, ownerId: input.ownerId, dueAt, status: 'open',
        completedAt: null, completedBy: null, createdAt: now, updatedAt: now });
      event.kind = 'milestone_added'; event.details = { milestoneId, title, ownerId: input.ownerId, dueAt }; break;
    }
    case 'reschedule_milestone':
    case 'complete_milestone':
    case 'cancel_milestone': {
      const milestone = milestones.find((item) => item.id === input.milestoneId);
      if (!milestone) throw new JobTransitionError('milestone_not_found', 'Commitment not found', 404);
      if (milestone.status !== 'open') throw new JobTransitionError('milestone_closed', 'This commitment is already resolved');
      event.details = { milestoneId: milestone.id, title: milestone.title, dueAt: milestone.dueAt };
      if (input.action === 'reschedule_milestone') {
        const dueAt = futureTime(input.dueAt, now);
        event.kind = 'milestone_rescheduled'; event.details = { ...event.details, oldDueAt: milestone.dueAt, newDueAt: dueAt };
        milestone.dueAt = dueAt;
      } else if (input.action === 'complete_milestone') {
        milestone.status = 'completed'; milestone.completedAt = now; milestone.completedBy = actor.id;
        event.kind = 'milestone_completed'; event.details.completedLate = Date.parse(now) > Date.parse(milestone.dueAt);
      } else { milestone.status = 'cancelled'; event.kind = 'milestone_cancelled'; }
      milestone.updatedAt = now; break;
    }
  }
  event.details.toStatus = job.status;
  return { job: deriveJob(job, milestones, now), milestones, event };
}

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {acknowledgementUnresolved,canActOnJobMilestone,eligibleJobPeople,jobActions,jobIsMine,jobNeedsAttention,milestoneOverdue,type Job,type JobMilestone} from '../apps/web/src/relay/jobsModel.js';
import {jobErrorLabel,jt} from '../apps/web/src/relay/jobsI18n.js';
import {RelayApiError,type Person,type Session} from '../apps/web/src/relay/api.js';
import {beginPendingNavigation,navigationPending,queryOffset,safeReturnTo,updateListQuery,withReturnTo} from '../apps/web/src/relay/navigation.js';

const person:Person={id:'responder',displayName:'Responder',email:'responder@example.invalid',role:'on_call_responder',branchId:'branch',active:true};
const session:Session={user:person,organization:{id:'tenant',name:'Test'},branches:[],csrfToken:'test',providerMode:'simulated'};
const manager:Session={...session,user:{...person,id:'dispatcher',role:'branch_dispatcher'}};
const job:Job={id:'job',branchId:'branch',acknowledgementId:'ack',externalId:'WO-123',customerReference:'Test customer',priority:'normal',description:'Test job',status:'requested',version:1,assigneeId:'responder',scheduledAt:null,blocker:null,completionNote:null,completionReportedAt:null,completionReportedBy:null,completedAt:null,completedBy:null,createdAt:'2026-09-05T12:00:00Z',updatedAt:'2026-09-05T12:00:00Z',openMilestoneCount:0,overdueMilestoneCount:0,nextDueAt:null};

test('job UI separates responder execution, dispatch confirmation and terminal reopening',()=>{
  assert.ok(jobActions(job,session).includes('start'));
  assert.ok(!jobActions(job,session).includes('assign'));
  assert.deepEqual(jobActions({...job,assigneeId:'other'},session),[]);
  assert.ok(!jobActions({...job,assigneeId:null},manager).includes('start'));
  assert.ok(!jobActions({...job,status:'in_progress',openMilestoneCount:1},session).includes('report_completion'));
  assert.ok(jobActions({...job,status:'in_progress'},session).includes('report_completion'));
  assert.deepEqual(jobActions({...job,status:'completion_reported'},session),['add_update']);
  assert.ok(jobActions({...job,status:'completion_reported'},manager).includes('confirm_completion'));
  assert.deepEqual(jobActions({...job,status:'completed'},session),[]);
  assert.deepEqual(jobActions({...job,status:'cancelled'},manager),['reopen']);
  assert.deepEqual(jobActions(job,{...session,user:{...person,role:'auditor'}}),[]);
});

test('job people selectors exclude other branches, inactive contacts and non-operational roles',()=>{
  const unknown:Person={id:'unknown',displayName:'Unknown',email:'unknown@example.invalid',role:'on_call_responder',branchId:'branch'};
  const items=[person,{...person,id:'inactive',active:false},{...person,id:'other-branch',branchId:'other'},{...person,id:'auditor',role:'auditor' as const},unknown];
  assert.deepEqual(eligibleJobPeople(items,'branch'),[person]);
});

test('teammate milestone owners see their work without gaining job lifecycle or other milestone actions',()=>{
  const shared:Job={...job,assigneeId:'other',openMilestoneCount:2,openMilestoneOwnerIds:['responder','other']};
  const own:JobMilestone={id:'own',title:'Deliver spare part',ownerId:'responder',dueAt:'2026-09-05T13:00:00Z',status:'open',completedAt:null,completedBy:null,createdAt:job.createdAt,updatedAt:job.createdAt};
  const other:JobMilestone={...own,id:'other',ownerId:'other'};
  assert.equal(jobIsMine(shared,'responder'),true);
  assert.equal(jobIsMine({...shared,openMilestoneOwnerIds:[]},'responder'),false);
  assert.deepEqual(jobActions(shared,session,[own,other]),['add_update','reschedule_milestone','complete_milestone','cancel_milestone']);
  assert.equal(canActOnJobMilestone(shared,session,own),true);
  assert.equal(canActOnJobMilestone(shared,session,other),false);
  assert.equal(canActOnJobMilestone(shared,manager,other),true);
  assert.deepEqual(jobActions(shared,session,[{...own,status:'completed'},other]),[]);
  assert.deepEqual(jobActions({...shared,status:'completed'},session,[own]),[]);
  assert.deepEqual(jobActions({...shared,branchId:'other-branch'},session,[own]),[]);
});

test('overdue job commitments use server time, remain distinct from completion and handoff',()=>{
  const milestone:JobMilestone={id:'milestone',title:'Return with part',ownerId:'responder',dueAt:'2026-09-05T13:00:00Z',status:'open',completedAt:null,completedBy:null,createdAt:job.createdAt,updatedAt:job.createdAt};
  assert.equal(milestoneOverdue(milestone,milestone.dueAt),false);
  assert.equal(milestoneOverdue(milestone,'2026-09-05T13:00:01Z'),true);
  assert.equal(milestoneOverdue({...milestone,status:'completed'},'2026-09-06T00:00:00Z'),false);
  assert.equal(jobNeedsAttention({...job,status:'blocked',attentionReasons:['blocked']}),true);
  assert.equal(jobNeedsAttention({...job,status:'completion_reported',attentionReasons:['completion_review']}),true);
  assert.equal(jobNeedsAttention({...job,overdueMilestoneCount:1,attentionReasons:['overdue_commitment']}),true);
  assert.equal(jobNeedsAttention({...job,attentionReasons:['acknowledgement_overdue']}),true);
  assert.equal(jobNeedsAttention({...job,overdueMilestoneCount:1,attentionReasons:[]}),false,'The UI does not replace authoritative server attention reasons');
  assert.equal(jobNeedsAttention(job),false);
  assert.equal(acknowledgementUnresolved({status:'breached',ownerRecipientId:null}),true);
  assert.equal(acknowledgementUnresolved({status:'breached',ownerRecipientId:'owner'}),false);
  assert.equal(acknowledgementUnresolved({status:'closed',ownerRecipientId:null}),false);
  assert.equal(acknowledgementUnresolved(null),false);
});

test('job return navigation preserves local queue state without accepting external destinations',()=>{
  const origin='/relay/jobs?view=completed&search=freezer&branchId=west&offset=200';
  const destination=withReturnTo('/relay/jobs/job-1?jobAction=complete_milestone&milestoneId=m1',origin);
  const params=new URL(destination,'http://localhost').searchParams;
  assert.equal(params.get('returnTo'),origin);assert.equal(params.get('milestoneId'),'m1');
  assert.equal(safeReturnTo(params.get('returnTo')),origin);
  assert.equal(safeReturnTo('/relay/intake?status=pending'),'/relay/intake?status=pending');
  for(const value of ['https://example.com','//example.com','javascript:alert(1)','/relay/jobs/../../admin','/relay/profile'])assert.equal(safeReturnTo(value),'/relay/jobs');
  const search=new URLSearchParams('view=all&search=freezer&branchId=west&offset=200');
  assert.equal(updateListQuery('/relay/jobs',search,{status:'blocked',offset:null}),'/relay/jobs?view=all&search=freezer&branchId=west&status=blocked');
  assert.equal(search.get('offset'),'200','Editing URL filters does not mutate the source query');
  assert.equal(queryOffset(new URLSearchParams('offset=-1')),0);assert.equal(queryOffset(new URLSearchParams('offset=200')),200);
});

test('pending mutation navigation locks are released exactly once',()=>{
  assert.equal(navigationPending(),false);const finish=beginPendingNavigation(),other=beginPendingNavigation();
  assert.equal(navigationPending(),true);finish();finish();assert.equal(navigationPending(),true);other();assert.equal(navigationPending(),false);
});

test('job error messages distinguish stale versions from unresolved acknowledgement and completion blockers',()=>{
  assert.equal(jobErrorLabel('en',new RelayApiError(409,'job_version_conflict','')),jt('en','stale'));
  assert.equal(jobErrorLabel('fr',new RelayApiError(409,'acknowledgement_unresolved','')),jt('fr','ackUnresolved'));
  assert.equal(jobErrorLabel('en',new RelayApiError(422,'unresolved_milestones','')),jt('en','resolveFirst'));
  assert.equal(jobErrorLabel('fr',new RelayApiError(422,'future_time_required','')),jt('fr','futureTime'));
  assert.notEqual(jt('en','completion_reported'),jt('en','completed'));
  assert.notEqual(jt('fr','completion_reported'),jt('fr','completed'));
});

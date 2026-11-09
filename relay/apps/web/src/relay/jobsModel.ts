import {canDispatch,type Commitment,type Person,type Session} from './api.js';
import type {Job,JobMilestone,JobEvent,JobAction as DomainJobAction} from '@northstar/relay-domain';
export type {Job,JobMilestone,JobEvent,JobStatus} from '@northstar/relay-domain';
export interface JobDetail {job:Job;milestones:JobMilestone[];events:JobEvent[];acknowledgement:Commitment|null;asOf:string}
export interface JobsResult {items:Job[];total:number;asOf:string;hasMore:boolean;nextOffset:number|null}
export type JobView='active'|'completed'|'all';
export type JobFilter='all'|'attention'|'mine';
export type JobAction=DomainJobAction['action'];
export function jobNeedsAttention(job:Job):boolean{return (job.attentionReasons?.length??0)>0;}
export function jobIsMine(job:Job,personId:string):boolean{return job.assigneeId===personId||job.openMilestoneOwnerIds?.includes(personId)===true;}
export function jobActions(job:Job,session:Session,milestones?:readonly JobMilestone[]):JobAction[]{
  if(session.user.role!=='organization_admin'&&session.user.branchId!==job.branchId)return [];
  const manage=canDispatch(session),assigned=session.user.role==='on_call_responder'&&job.assigneeId===session.user.id;
  const ownsMilestone=session.user.role==='on_call_responder'&&(milestones?milestones.some(item=>item.status==='open'&&item.ownerId===session.user.id):job.openMilestoneOwnerIds?.includes(session.user.id)===true);
  if(!manage&&!assigned){
    if(!ownsMilestone||['completed','cancelled','completion_reported'].includes(job.status))return [];
    return ['add_update','reschedule_milestone','complete_milestone','cancel_milestone'];
  }
  if(job.status==='completed'||job.status==='cancelled')return manage?['reopen']:[];
  if(job.status==='completion_reported')return manage?['confirm_completion','reopen','cancel','add_update']:['add_update'];
  const actions:JobAction[]=['add_update','add_milestone','reschedule_milestone','complete_milestone','cancel_milestone'];
  if(manage)actions.push('assign','schedule','cancel');
  if(manage&&job.assigneeId&&['requested','scheduled'].includes(job.status))actions.push('unassign');
  if(job.assigneeId&&(job.status==='requested'||job.status==='scheduled'))actions.push('start');
  if(job.status==='in_progress'){actions.push('block');if(job.openMilestoneCount===0)actions.push('report_completion');}
  if(job.status==='blocked')actions.push('resume');
  return actions;
}
export function canActOnJobMilestone(job:Job,session:Session,milestone:JobMilestone):boolean{return milestone.status==='open'&&jobActions(job,session,[milestone]).includes('complete_milestone');}
export function eligibleJobPeople(people:Person[],branchId:string):Person[]{return people.filter(person=>person.branchId===branchId&&person.active===true&&['organization_admin','branch_dispatcher','on_call_responder'].includes(person.role));}
export function jobPath(id:string):string{return `/relay/jobs/${encodeURIComponent(id)}`;}
export function milestoneOverdue(milestone:JobMilestone,asOf:string):boolean{return milestone.status==='open'&&Date.parse(milestone.dueAt)<Date.parse(asOf);}
export function acknowledgementUnresolved(acknowledgement:Pick<Commitment,'status'|'ownerRecipientId'>|null):boolean{return acknowledgement!==null&&acknowledgement.ownerRecipientId===null&&['scheduled','active','breached'].includes(acknowledgement.status);}

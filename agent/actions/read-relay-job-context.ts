import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {displayTime} from '../server/recovery/dispatch-time.js';
import {relay} from '../server/recovery/relay.js';
import {readTechnicians} from './read-dispatch-planning.js';
export default defineAction({
 description:'Read current job facts, local date/time labels, assigned technician contacts, commitments and history. Set includePlanning=true to also read hours, time off, next working periods and nextShiftCommitmentDefaults. Copy supplied local labels exactly; never interpret UTC digits as local time. Use exact record IDs and versions for changes.',
 schema:z.object({jobId:z.string().min(1).max(200).describe('The selected jobId in current-screen.'),includePlanning:z.boolean().optional().describe('Set true when asked about technician hours, time off, next shift or a new work commitment. Omit for ordinary job facts.')}),
 outputSchema:z.object({job:z.unknown(),assignedTechnician:z.unknown(),commitments:z.array(z.unknown()),nextShiftCommitmentDefaults:z.unknown(),recentHistory:z.array(z.unknown())}),
 http:{method:'GET'},readOnly:true,deferLoading:false,maxResultChars:9000,
 run:({jobId,includePlanning})=>readRelayJobContext(jobId,includePlanning),
});

export async function readRelayJobContext(jobId:string,includePlanning=false){
  const [detail,people,technicians]=await Promise.all([
   relay<{job:Record<string,any>;milestones:Array<Record<string,any>>;events:Array<Record<string,any>>}>('/jobs/'+encodeURIComponent(jobId)),
   relay<{items:Array<{id:string;displayName:string;phone:string|null;email:string|null}>}>('/people'),includePlanning?readTechnicians():Promise.resolve([]),
  ]);
  const j=detail.job,person=people.items.find(p=>p.id===j.assigneeId),tech=technicians.find(p=>p.personId===j.assigneeId),period=tech?.nextWorkPeriods[0];
  return {
   job:{jobId:j.id,expectedVersion:j.version,client:j.customerReference,workDetails:j.description,status:j.status,priority:j.priority,blocker:j.blocker,visitAt:j.scheduledAt,visitAtLabel:j.scheduledAt?displayTime(j.scheduledAt):null,estimatedMinutes:j.estimatedMinutes,clientDeadline:j.clientTiming?.completeByLabel??(j.serviceWindow?.completeBy?displayTime(j.serviceWindow.completeBy):null),clientTiming:j.clientTiming,site:j.site,requiredSkills:j.requiredSkills},
   assignedTechnician:person?{personId:person.id,name:person.displayName,phone:person.phone,email:person.email,...(includePlanning?{timezone:tech?.profile?.timezone,skills:tech?.profile?.skills,workingHours:tech?.profile?.workingHours,timeOff:tech?.profile?.timeOff.map(p=>({startLabel:displayTime(p.start),endLabel:displayTime(p.end)})),nextWorkPeriods:tech?.nextWorkPeriods.slice(0,2).map(p=>({startLabel:p.startLabel,endLabel:p.endLabel}))}:{})}:null,
   commitments:detail.milestones.map(m=>({id:m.id,title:m.title,ownerId:m.ownerId,ownerName:people.items.find(p=>p.id===m.ownerId)?.displayName,dueAt:m.dueAt,dueAtLabel:displayTime(m.dueAt),status:m.status})),
   nextShiftCommitmentDefaults:includePlanning&&person&&period?{jobId:j.id,expectedVersion:j.version,ownerId:person.id,ownerName:person.displayName,dueAt:period.end,dueLabel:period.endLabel,reason:'Due at the end of the next working period, after subtracting saved time off. Choose a different time if the dispatcher specifies one.'}:null,
   recentHistory:detail.events.slice(-3).map(e=>({id:e.id,kind:e.kind,note:e.note,createdAt:e.createdAt})),
  };
}

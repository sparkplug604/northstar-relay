import {z} from 'zod';
import {relay} from './relay.js';
import {readAssignment} from './assignment.js';
import {triageJobSchema} from './triage.js';
import {displayTime} from './dispatch-time.js';
export {displayTime} from './dispatch-time.js';
const personSchema=z.object({id:z.string(),displayName:z.string(),phone:z.string().nullable().optional(),email:z.string().nullable().optional()}).passthrough();
const contactSchema=z.object({name:z.string(),phone:z.string().nullable(),email:z.string().nullable()});
const detailSchema=z.object({
 job:triageJobSchema,
 milestones:z.array(z.object({id:z.string(),title:z.string(),ownerId:z.string().nullable(),dueAt:z.string(),status:z.string()}).passthrough()),
 events:z.array(z.object({kind:z.string(),actorId:z.string().nullable(),occurredAt:z.string(),note:z.string().nullable(),details:z.record(z.string(),z.unknown())}).passthrough()),
 acknowledgement:z.object({status:z.string(),ownerRecipientId:z.string().nullable(),dueAt:z.string(),recipients:z.array(z.object({recipientId:z.string(),personId:z.string().nullable()}).passthrough())}).passthrough().nullable(),
 asOf:z.string(),
});
export const dispatchJobsSchema=z.object({checkedAt:z.string(),jobs:z.array(z.object({
 job:triageJobSchema,assigneeName:z.string().nullable(),assignmentRecorded:z.boolean(),scheduledLabel:z.string().nullable(),
 acceptance:z.object({status:z.string(),acceptedBy:z.string().nullable(),accepted:z.boolean(),dueLabel:z.string()}).nullable(),
 commitments:z.array(z.object({id:z.string().optional(),ownerId:z.string().nullable().optional(),dueAt:z.string().optional(),title:z.string(),ownerName:z.string().nullable(),dueLabel:z.string(),status:z.string()})),
 history:z.array(z.object({kind:z.string(),actorName:z.string().nullable(),atLabel:z.string(),note:z.string().nullable(),details:z.record(z.string(),z.unknown())})),
 contacts:z.object({technician:contactSchema.nullable(),client:contactSchema.nullable()}).optional(),
 availability:z.object({options:z.array(z.object({name:z.string(),start:z.string(),end:z.string()})),unavailable:z.array(z.object({name:z.string(),reasons:z.array(z.string())})),flags:z.array(z.string()),schedulingAllowed:z.boolean()}).nullable(),
}))});
export type DispatchJobs=z.infer<typeof dispatchJobsSchema>;
export async function readDispatchJobs(ids:string[],includeAvailability=false){
 const [people,...details]=await Promise.all([
  relay<{items:unknown[]}>('/people').then(result=>result.items.map(person=>personSchema.parse(person))),
  ...ids.map(id=>relay('/jobs/'+encodeURIComponent(id)).then(value=>detailSchema.parse(value))),
 ]);
 const name=(id:string|null)=>people.find(person=>person.id===id)?.displayName??null;
 const jobs=await Promise.all(details.map(async detail=>{
  const {job}=detail;const timezone=typeof job.clientTiming?.timezone==='string'?job.clientTiming.timezone:'America/Vancouver';
  const time=(instant:string)=>displayTime(instant,timezone);
  const ack=detail.acknowledgement;
  const availability=includeAvailability&&!['completed','cancelled'].includes(job.status)?await readAssignment(job.id):null;
  const technician=people.find(person=>person.id===job.assigneeId);
  return {job,contacts:{technician:technician?{name:technician.displayName,phone:technician.phone??null,email:technician.email??null}:null,client:null},assigneeName:name(job.assigneeId),assignmentRecorded:Boolean(job.assigneeId),scheduledLabel:job.scheduledAt?time(job.scheduledAt):null,
   acceptance:ack?{status:ack.status,accepted:Boolean(ack.ownerRecipientId),acceptedBy:name(ack.recipients.find(recipient=>recipient.recipientId===ack.ownerRecipientId)?.personId??null),dueLabel:time(ack.dueAt)}:null,
   commitments:detail.milestones.map(milestone=>({id:milestone.id,ownerId:milestone.ownerId,dueAt:milestone.dueAt,title:milestone.title,ownerName:name(milestone.ownerId),dueLabel:time(milestone.dueAt),status:milestone.status})),
   history:detail.events.slice(-8).reverse().map(event=>({kind:event.kind,actorName:name(event.actorId),atLabel:time(event.occurredAt),note:event.note,details:event.details})),
   availability:availability?{schedulingAllowed:['requested','scheduled'].includes(job.status),options:availability.options.slice(0,6).map(option=>({name:option.displayName,start:option.startLabel,end:option.endLabel})),unavailable:availability.unavailable.map(person=>({name:person.displayName,reasons:person.reasons})),flags:availability.flags}:null,
  };
 }));
 return dispatchJobsSchema.parse({checkedAt:new Date().toISOString(),jobs});
}

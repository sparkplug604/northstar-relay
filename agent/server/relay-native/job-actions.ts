import {createHash} from 'node:crypto';
import {z} from 'zod';
import {displayTime} from '../recovery/dispatch-time.js';
import {relay,RelayRequestError} from '../recovery/relay.js';
const id=z.string().min(1).max(200),note=z.string().trim().min(3).max(10000),date=z.iso.datetime({offset:true});
const site=z.object({label:z.string(),latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).nullable();
export const jobChange=z.discriminatedUnion('action',[
 z.object({action:z.literal('add_milestone'),title:z.string().trim().min(3).max(200),ownerId:id,dueAt:date}),
 z.object({action:z.literal('reschedule_milestone'),milestoneId:id,dueAt:date,note}),
 z.object({action:z.enum(['complete_milestone','cancel_milestone']),milestoneId:id,note}),
 z.object({action:z.literal('assign'),assigneeId:id,checkAvailability:z.literal(true).default(true)}),
 z.object({action:z.literal('unassign')}),
 z.object({action:z.literal('schedule'),scheduledAt:date,note}),
 z.object({action:z.literal('update_blocker'),blocker:note,note}),
 z.object({action:z.enum(['start','block','resume','report_completion','confirm_completion','reopen','cancel','add_update']),note}),
 z.object({action:z.literal('dispatch_details'),priority:z.enum(['urgent','high','normal','low']).optional(),serviceWindow:z.object({earliestStart:date.nullable(),completeBy:date.nullable()}).optional(),site,estimatedMinutes:z.number().int().min(1).max(1440),requiredSkills:z.array(z.string()).max(30)}),
]);
export const jobActionInput=z.object({jobId:id,expectedVersion:z.number().int().positive().describe('The exact current job.version returned by a fresh read.'),change:jobChange.describe('Same job command used by Relay UI. add_milestone creates a Work commitment; ownerId is a technician personId and dueAt is an ISO instant. schedule changes a visit, add_update records a confirmed appointment note. Never infer that a client was contacted.')});
type Detail={job:{id:string;version:number;customerReference:string;status:string;scheduledAt?:string|null};milestones:Array<{id:string;title:string;ownerId:string;dueAt:string;status:string}>;events:Array<{id:string;kind:string;details:Record<string,unknown>}>};
function stable(value:unknown):string{return value&&typeof value==='object'?Array.isArray(value)?'['+value.map(stable).join(',')+']':'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,val])=>JSON.stringify(key)+':'+stable(val)).join(',')+'}':JSON.stringify(value);}
const events:Record<string,string>={add_milestone:'milestone_added',reschedule_milestone:'milestone_rescheduled',complete_milestone:'milestone_completed',cancel_milestone:'milestone_cancelled',assign:'job_assigned',unassign:'job_unassigned',schedule:'job_scheduled',add_update:'update_added',block:'job_blocked',update_blocker:'job_blocker_updated',resume:'job_resumed',start:'job_started',report_completion:'completion_reported',confirm_completion:'completion_confirmed',reopen:'job_reopened',cancel:'job_cancelled',dispatch_details:'job_dispatch_details_updated'};
export async function applyJobChange(input:z.infer<typeof jobActionInput>){
 const body={...input.change,expectedVersion:input.expectedVersion};
 const key='native-job:'+createHash('sha256').update(stable({jobId:input.jobId,body})).digest('hex');
 const applied=await relay<Detail>('/jobs/'+encodeURIComponent(input.jobId)+'/actions',{key,body});
 const current=await relay<Detail>('/jobs/'+encodeURIComponent(input.jobId));
 const event=applied.events[applied.events.length-1];
 if(!event||!current.events.some(item=>item.id===event.id)||current.job.version<applied.job.version)throw Error('The Relay history receipt could not be verified. Retry this same change with the same expectedVersion.');
 const expected=events[input.change.action];
 if(expected&&event.kind!==expected)throw Error('Relay returned a different history event. Read the job before making another change.');
 const milestoneId=typeof event.details.milestoneId==='string'?event.details.milestoneId:undefined;
 const milestone=milestoneId?current.milestones.find(item=>item.id===milestoneId):undefined;
 if(input.change.action==='add_milestone'&&(!milestone||milestone.title!==input.change.title||milestone.ownerId!==input.change.ownerId||Date.parse(milestone.dueAt)!==Date.parse(input.change.dueAt)))throw Error('The created commitment could not be verified in the current job. Read it before retrying.');
 if(input.change.action==='schedule'&&(current.job.scheduledAt!==input.change.scheduledAt||event.details.scheduledAt!==input.change.scheduledAt))throw Error('The saved visit time could not be verified. Read job history before retrying.');
 let ownerName:string|undefined;
 if(milestone){try{const people=await relay<{items?:Array<{id:string;displayName:string}>}>('/people');ownerName=people.items?.find(person=>person.id===milestone.ownerId)?.displayName;}catch{/* Display enrichment cannot turn a verified write into a reported failure. */}}
 const displayMilestone=milestone?{...milestone,...(ownerName?{ownerName}:{}),dueAtLabel:displayTime(milestone.dueAt)}:null;
 const summary=input.change.action==='add_milestone'?'Created work commitment'+(ownerName?' for '+ownerName:'')+', due '+displayMilestone!.dueAtLabel+': '+input.change.title:input.change.action==='schedule'?'Moved '+current.job.customerReference+' to '+displayTime(current.job.scheduledAt!)+'.':'Saved '+input.change.action.replace(/_/g,' ')+' in Relay.';
 return {id:milestoneId??current.job.id,jobId:current.job.id,jobVersion:current.job.version,milestone:displayMilestone,event,change:{verb:input.change.action==='add_milestone'?'created':'updated',kind:input.change.action.includes('milestone')?'Work commitment':'Job',title:input.change.action==='add_milestone'?input.change.title:current.job.customerReference,detail:summary,url:'http://127.0.0.1:3004/relay/jobs/'+encodeURIComponent(current.job.id)},_receipt:{changed:true,verified:true,subject:'job:'+current.job.id,summary,checks:[{id:'relay-history',ok:true,detail:event.id},{id:'current-job',ok:true,detail:String(current.job.version)}]}};
}

export async function runJobChange(input:z.infer<typeof jobActionInput>){
 try{return await applyJobChange(input);}catch(error){
  if(!(error instanceof RelayRequestError))throw error;
  const refused=error.status>=400&&error.status<500;
  return {error:error.message,_receipt:{changed:!refused,verified:false as const,subject:'job:'+input.jobId,summary:refused?'Relay rejected the change. It was not saved.':'Relay returned an error; the write outcome is unknown. Read the job history before retrying.',checks:[{id:'relay-history',ok:false,detail:'HTTP '+error.status}]}};
 }
}

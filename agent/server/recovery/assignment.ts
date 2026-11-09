import {randomUUID} from 'node:crypto';
import {relay} from './relay.js';
import {readAppStateForCurrentTab} from '@agent-native/core/application-state';
import {z} from 'zod';
import {getRequestRunContext} from '@agent-native/core/server/request-context';

export const assignmentSchema=z.object({
  job:z.object({
    id:z.string(),version:z.number(),customerReference:z.string(),description:z.string(),priority:z.string(),
    scheduledAt:z.string().nullable(),
    serviceWindow:z.object({earliestStart:z.string().nullable(),completeBy:z.string().nullable()}).optional(),
  }).passthrough(),
  timezone:z.string(),clientDeadlineLabel:z.string().nullable(),earliestStartLabel:z.string().nullable(),
  revision:z.number(),timingRecorded:z.boolean(),checkedAt:z.string(),searchedUntil:z.string(),
  proposal:z.object({startLabel:z.string(),endLabel:z.string(),personId:z.string(),displayName:z.string(),scheduledAt:z.string(),endsAt:z.string(),jobVersion:z.number(),reason:z.string(),key:z.string()}).nullable(),
  receipt:z.unknown().nullable(),flags:z.array(z.string()),
  options:z.array(z.object({
    startLabel:z.string(),endLabel:z.string(),personId:z.string(),displayName:z.string(),scheduledAt:z.string(),endsAt:z.string(),profileVersion:z.number(),
    status:z.enum(['available','blocked','needs_check']),reasons:z.array(z.string()),
    travel:z.array(z.object({direction:z.string(),from:z.string(),to:z.string(),minutes:z.number().nullable(),source:z.string()})),
  })),
  unavailable:z.array(z.object({personId:z.string(),displayName:z.string(),status:z.enum(['available','blocked','needs_check']),reasons:z.array(z.string())}).passthrough()),
});
export type Assignment=z.infer<typeof assignmentSchema>;
type AssignmentTurn={jobId:string;revision:number;jobVersion:number;request:string;expires:number};
// Agent-Native retains registered engine callbacks across Vite server hot reloads.
// Keep bounded, expiring turn metadata shared with the reloaded request handlers.
// Durable proposals and assignments remain in Relay SQL.
type AssignmentRuntime={turns:Map<string,AssignmentTurn>;threadJobs:Map<string,{jobId:string;expires:number}>};
const runtimeGlobal=globalThis as typeof globalThis & {__relayAssignmentRuntimeV1?:AssignmentRuntime};
const runtime=runtimeGlobal.__relayAssignmentRuntimeV1??={turns:new Map(),threadJobs:new Map()};
const {turns,threadJobs}=runtime;
function turnKey(jobId:string){
  const run=getRequestRunContext();
  const identity=run?.runId??run?.threadId;
  return identity?identity+':'+jobId:null;
}
export function assignmentTurn(jobId:string){
  const key=turnKey(jobId),turn=key?turns.get(key):undefined;
  return turn&&turn.expires>Date.now()?turn:null;
}
export function bindAssignmentTurn(jobId:string,messages:Array<{role:string;content?:string}>){
  const key=turnKey(jobId);
  if(!key)throw Error('Assignment run context is unavailable.');
  const context=messages.map(message=>message.content??'').join('\n');
  const tokens=[...context.matchAll(/RELAY_ASSIGNMENT_TURN:([a-f0-9-]{36})/g)];
  const turn=tokens.reverse().map(match=>turns.get(match[1]!)).find(turn=>turn?.jobId===jobId&&turn.expires>Date.now());
  if(!turn)throw Error('The checked assignment context expired. Send the message again.');
  turns.set(key,turn);
  const threadId=getRequestRunContext()?.threadId;
  if(threadId){
    for(const [id,entry] of threadJobs)if(entry.expires<Date.now())threadJobs.delete(id);
    if(threadJobs.size>=128)threadJobs.delete(threadJobs.keys().next().value!);
    threadJobs.set(threadId,{jobId,expires:Date.now()+3600000});
  }
}
export async function assignmentJob(threadId?:string){
  const run=getRequestRunContext();
  const entry=threadJobs.get(threadId??run?.threadId??'');
  if(entry&&entry.expires>Date.now())return entry.jobId;
  const scope=run?.actionScope;
  if(scope?.kind==='relay-assignment'&&typeof scope.jobId==='string')return scope.jobId;
  const navigation=await readAppStateForCurrentTab('navigation') as {view?:string;jobId?:string}|null;
  return navigation?.view==='assignment'?navigation.jobId:null;
}
export async function readAssignment(jobId:string,notBefore?:string,excludePersonIds?:string[]){
  const query=new URLSearchParams();
  if(notBefore)query.set('notBefore',notBefore);
  if(excludePersonIds?.length)query.set('excludePersonIds',excludePersonIds.join(','));
  return assignmentSchema.parse(await relay('/jobs/'+encodeURIComponent(jobId)+'/assignment'+(query.size?'?'+query:'')));
}
export async function assertAssignmentContext(jobId:string){
  const current=await assignmentJob();
  if(current&&current!==jobId)throw Error('This conversation belongs to another job. Open that job before changing its proposal.');
}
export async function assignmentSummary(jobId:string,request=''){
  const state=await readAssignment(jobId);
  const key=randomUUID();
  for(const [id,turn] of turns){if(turn.expires<Date.now())turns.delete(id);}
  if(turns.size>=128)turns.delete(turns.keys().next().value!);
  turns.set(key,{jobId,revision:state.revision,jobVersion:state.job.version,request,expires:Date.now()+900000});
  const facts={
    jobId:state.job.id,jobVersion:state.job.version,client:state.job.customerReference,work:state.job.description,priority:state.job.priority,
    timezone:state.timezone,clientDeadlineLabel:state.clientDeadlineLabel,serviceWindow:state.job.serviceWindow??'Client timing not recorded',revision:state.revision,proposal:state.proposal,
    options:state.options.map(option=>({personId:option.personId,name:option.displayName,displayStart:option.startLabel,displayEnd:option.endLabel,scheduledAt:option.scheduledAt,endsAt:option.endsAt,
      travel:option.travel.map(leg=>({minutes:leg.minutes,from:leg.from,to:leg.to}))})),
    unavailable:state.unavailable.map(person=>({name:person.displayName,reasons:person.reasons})),flags:state.flags,
  };
  return 'RELAY_ASSIGNMENT_TURN:'+key+'\nASSIGNMENT WORKFLOW. Use these live facts for this job, rather than the Recovery board. '+
    'Recommend a technician and a time, explain why, and save a shared proposal with propose-assignment when asked to recommend or revise. '+
    'To recommend, call propose-assignment with preference earliest. The server binds the current revision and job version for this turn. For another option use preference alternative; for a later time use later. The tool resolves the exact technician and time from live checked openings. '+
    'If asked for a later day, call read-assignment-options with notBefore. Do not expand the client service window. '+
    'Only the dispatcher can approve. Approval happens through the visible Approve assignment button. '+
    'If no fit exists, explain what prevents it. Never invent available hours or claim a save happened. '+
    'priority urgent means emergency, high means urgent, normal routine, low can wait. '+
    'Use short readable paragraphs and at most three bullets. Here are the live facts: '+JSON.stringify(facts);
}

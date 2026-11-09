import {readAssignment} from '../recovery/assignment.js';
import {visitInstant,displayTime} from '../recovery/dispatch-time.js';
import {relay} from '../recovery/relay.js';
import {runJobChange} from './job-actions.js';
export async function updateClientDeadline(input:{jobId:string;expectedVersion:number;date:string;time:string}){
 let writeStarted=false;
 try{
  const state=await readAssignment(input.jobId),job=state.job;
  const completeBy=visitInstant(input.date,input.time,null,state.timezone);
  if(job.version!==input.expectedVersion&&Date.parse(job.serviceWindow?.completeBy??'')!==Date.parse(completeBy))throw Error('The job changed. Read it again before changing the client deadline.');
  if(!Number.isInteger(job.estimatedMinutes)||!Array.isArray(job.requiredSkills))throw Error('Record the estimated visit duration and required skills before changing dispatch details.');
  const change={action:'dispatch_details' as const,serviceWindow:{earliestStart:job.serviceWindow?.earliestStart??null,completeBy},site:job.site as {label:string;latitude:number;longitude:number}|null,estimatedMinutes:Number(job.estimatedMinutes),requiredSkills:job.requiredSkills as string[]};
  writeStarted=true;
  const saved=await runJobChange({jobId:input.jobId,expectedVersion:input.expectedVersion,change});
  if('error' in saved||!saved._receipt.verified)return saved;
  const current=await relay<{job:typeof job}>('/jobs/'+encodeURIComponent(input.jobId));
  const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  if(Date.parse(current.job.serviceWindow?.completeBy??'')!==Date.parse(completeBy)||current.job.scheduledAt!==job.scheduledAt||current.job.assigneeId!==job.assigneeId||current.job.priority!==job.priority||current.job.estimatedMinutes!==job.estimatedMinutes||!same(current.job.requiredSkills,job.requiredSkills)||!same(current.job.site,job.site)||current.job.serviceWindow?.earliestStart!==change.serviceWindow.earliestStart)throw Error('The saved deadline or preserved dispatch fields could not be verified. Read job history before retrying.');
  const summary='Updated '+job.customerReference+' client deadline to '+displayTime(completeBy,state.timezone)+'. The visit and technician are unchanged.';
  return {...saved,change:{...saved.change,detail:summary},_receipt:{...saved._receipt,summary,checks:[...saved._receipt.checks,{id:'client-deadline',ok:true,detail:completeBy}]}};
 }catch(error){const message=error instanceof Error?error.message:'Client deadline update could not be verified.';return {error:message,_receipt:{changed:writeStarted,verified:false as const,subject:'job:'+input.jobId,summary:message,checks:[{id:'client-deadline',ok:false,detail:message}]}};}
}

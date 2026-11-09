import {readAssignment} from '../recovery/assignment.js';
import {relay,RelayRequestError} from '../recovery/relay.js';
import {displayTime,visitInstant} from '../recovery/dispatch-time.js';
import {applyRelayAssignment} from '../../actions/apply-relay-assignment.js';
export async function rescheduleVisit(input:{jobId:string;expectedVersion:number;date:string;time?:string|undefined;note:string}){
 const {jobId,expectedVersion,date,time,note}=input;
 try{
  const state=await readAssignment(jobId);
  const scheduledAt=visitInstant(date,time,state.job.scheduledAt,state.timezone);
  const personId=state.job.assigneeId as string|null;
  if(!personId)throw Error('Assign a technician before moving this visit, or ask Relay to find one.');
  const previous=state.proposal;
  // Recover an identical approved retry without creating a second proposal or history event.
  const retry=state.receipt&&previous?.jobVersion===expectedVersion&&previous.personId===personId&&previous.scheduledAt===scheduledAt&&state.job.scheduledAt===scheduledAt;
  if(state.job.version!==expectedVersion&&!retry)throw Error('This job changed. Read the job again before proposing a date change.');
  const endsAt=Date.parse(scheduledAt)+Number(state.job.estimatedMinutes??0)*60000;
  if(!retry&&state.job.serviceWindow?.completeBy&&endsAt>Date.parse(state.job.serviceWindow.completeBy))throw Error('The requested visit would finish after the client deadline ('+state.clientDeadlineLabel+'). Confirm a new client deadline before moving it. No visit change was saved.');
  const proposal=retry?state:await relay<{revision:number}>('/jobs/'+encodeURIComponent(jobId)+'/assignment/proposal',{key:'native-visit-proposal:'+jobId+':'+expectedVersion+':'+scheduledAt,body:{revision:state.revision,jobVersion:expectedVersion,personId,scheduledAt,reason:note}});
  const saved=await applyRelayAssignment(jobId,proposal.revision);
  const current=await relay<{job:{scheduledAt:string;assigneeId:string}}>('/jobs/'+encodeURIComponent(jobId));
  if(current.job.scheduledAt!==scheduledAt||current.job.assigneeId!==personId)throw Error('The saved visit no longer matches this change. Check job history before retrying.');
  const visitAtLabel=displayTime(scheduledAt,state.timezone);
  const summary='Moved '+state.job.customerReference+' to '+visitAtLabel+'. The assigned technician is unchanged; Relay checked availability and client timing.';
  return {...saved,scheduledAt,visitAtLabel,change:{verb:'updated',kind:'Job visit',title:state.job.customerReference,detail:summary,url:'http://127.0.0.1:3004/relay/jobs/'+encodeURIComponent(jobId)},_receipt:{...saved._receipt,summary}};
 }catch(error){
  const message=error instanceof Error?error.message:'The visit change could not be verified.';
  // Validation/client errors are definite rejections; transport/server errors can have an uncertain outcome.
  const uncertain=error instanceof RelayRequestError?error.status>=500:!/What time|calendar date|local time|Assign a technician|job changed|client deadline/.test(message);
  return {error:message,_receipt:{changed:uncertain,verified:false as const,subject:'job:'+jobId,summary:message}};
 }
}

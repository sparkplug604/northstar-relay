import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {relay} from '../server/recovery/relay.js';
export default defineAction({description:'Apply the exact checked assignment proposal after Agent-Native dispatcher approval. Relay rechecks technician availability and client timing and records the technician and visit together in job history.',schema:z.object({jobId:z.string().min(1).max(200),revision:z.number().int().nonnegative().describe('Exact proposal revision from propose-assignment or read-assignment-options.')}),outputSchema:z.object({jobId:z.string(),proposal:z.unknown(),_receipt:z.object({changed:z.boolean(),verified:z.boolean(),subject:z.string(),summary:z.string()})}),needsApproval:true,allowPersistentApproval:false,deferLoading:true,retrySafe:true,mcpAnnotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false,idempotentHint:true},run:({jobId,revision})=>applyRelayAssignment(jobId,revision),
});
export async function applyRelayAssignment(jobId:string,revision:number){
 const saved=await relay<{job:{id:string;assigneeId:string;scheduledAt:string};proposal:unknown}>('/jobs/'+encodeURIComponent(jobId)+'/assignment/approve',{key:'native-assignment:'+jobId+':'+revision,body:{revision}});
 const current=await relay<{job:{assigneeId:string|null;scheduledAt:string|null};events:Array<{kind:string;details:Record<string,unknown>}>}>('/jobs/'+encodeURIComponent(jobId));
 if(current.job.assigneeId!==saved.job.assigneeId||current.job.scheduledAt!==saved.job.scheduledAt||!current.events.some(event=>event.kind==='job_visit_assigned'&&event.details.assigneeId===saved.job.assigneeId&&event.details.scheduledAt===saved.job.scheduledAt))throw Error('Assignment history could not be verified. Read the current job before retrying.');
 return {jobId,proposal:saved.proposal??null,_receipt:{changed:true,verified:true,subject:'job:'+jobId,summary:'Saved the checked technician and visit time in Relay job history.'}};
}

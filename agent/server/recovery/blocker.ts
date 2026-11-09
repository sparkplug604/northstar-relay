import {createGetDb} from '@agent-native/core/db';
import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import {blockerDrafts,type BlockerProposal} from '../db/schema.js';
import {relay,RelayRequestError} from './relay.js';
import {rankJob,triageJobSchema} from './triage.js';
const db=createGetDb({blockerDrafts});
const proposalSchema=z.object({key:z.string(),jobVersion:z.number(),blocker:z.string(),mode:z.enum(['record_update','resume_work']),note:z.string(),cleared:z.boolean(),state:z.enum(['draft','applying','applied'])});
export const blockerWorkflowSchema=z.object({job:triageJobSchema,revision:z.number(),proposal:proposalSchema.nullable(),receipt:z.object({kind:z.string(),note:z.string()}).passthrough().nullable(),flags:z.array(z.string())});
export type BlockerWorkflow=z.infer<typeof blockerWorkflowSchema>;
export const blockerInput=z.object({jobId:z.string().min(1).max(200),revision:z.number().int().nonnegative(),jobVersion:z.number().int().positive(),requestKey:z.uuid(),mode:z.enum(['record_update','resume_work']),note:z.string().trim().min(10).max(3500),cleared:z.boolean().default(false)});
type Input=z.infer<typeof blockerInput>;
async function detail(id:string){return relay<{job:z.infer<typeof triageJobSchema>;events:Array<{kind:string;note:string;[key:string]:unknown}>}>('/jobs/'+encodeURIComponent(id));}
const marker=(proposal:BlockerProposal)=>' ['+proposal.key+']';
export function changeNote(proposal:BlockerProposal){return (proposal.mode==='resume_work'?'Blocker cleared; work resumed':'Blocker update; work remains blocked')+' · '+proposal.note+marker(proposal);}
export function validateBlockerInput(input:Pick<Input,'mode'|'note'|'cleared'>){
 if(input.mode==='resume_work'&&!input.cleared)throw Error('Confirm the blocker is cleared and the technician can resume work. An ETA alone is not enough.');
 if(input.note.trim().length<10)throw Error('Record the confirmed facts before preparing a change.');
}
export async function readBlockerWorkflow(jobId:string){
 const [current,rows]=await Promise.all([detail(jobId),db().select().from(blockerDrafts).where(eq(blockerDrafts.jobId,jobId))]);
 const row=rows[0],proposal=row?.proposal??null;
 const receipt=proposal?current.events.find(event=>event.note===changeNote(proposal)&&event.kind===(proposal.mode==='resume_work'?'job_resumed':'job_blocker_updated'))??null:null;
 const flags=rankJob(triageJobSchema.parse(current.job)).reasons;
 if(proposal&&!receipt&&proposal.jobVersion!==current.job.version)flags.unshift('The job changed after this draft. Prepare a fresh update before approving.');
 return blockerWorkflowSchema.parse({job:current.job,revision:row?.revision??0,proposal,receipt,flags});
}
export async function proposeBlocker(input:Input){
 validateBlockerInput(input);
 const current=await readBlockerWorkflow(input.jobId);
 if(current.proposal?.key===input.requestKey)return current;
 if(current.proposal?.state==='applying'&&!current.receipt)throw Error('An approval is being saved. Retry that approval before replacing the draft.');
 if(current.job.status!=='blocked')throw Error('This job is no longer blocked. Refresh before proposing a change.');
 if(current.job.version!==input.jobVersion||current.revision!==input.revision)throw Error('The job or shared draft changed. Review the current blocker and try again.');
 const proposal:BlockerProposal={key:input.requestKey,jobVersion:input.jobVersion,blocker:current.job.blocker??'',mode:input.mode,note:input.note,cleared:input.cleared,state:'draft'};
 if(current.revision===0){
  const inserted=await db().insert(blockerDrafts).values({jobId:input.jobId,revision:1,proposal}).onConflictDoNothing().returning();
  if(!inserted.length)throw Error('Another draft was created. Review it before replacing it.');
 }else{
  const updated=await db().update(blockerDrafts).set({revision:input.revision+1,proposal}).where(and(eq(blockerDrafts.jobId,input.jobId),eq(blockerDrafts.revision,input.revision))).returning();
  if(!updated.length)throw Error('The shared draft changed. Review it again.');
 }
 return readBlockerWorkflow(input.jobId);
}
export async function approveBlocker(jobId:string,revision:number){
 const current=await readBlockerWorkflow(jobId),proposal=current.proposal;
 const retryOfClaim=proposal&&['applying','applied'].includes(proposal.state)&&current.revision===revision+1;
 if(!proposal||(current.revision!==revision&&!retryOfClaim))throw Error('The draft changed. Review the latest proposal before approving.');
 if(current.receipt){
  if(proposal.state!=='applied')await db().update(blockerDrafts).set({proposal:{...proposal,state:'applied'}}).where(and(eq(blockerDrafts.jobId,jobId),eq(blockerDrafts.revision,current.revision)));
  return readBlockerWorkflow(jobId);
 }
 validateBlockerInput(proposal);
 if(current.job.version!==proposal.jobVersion||current.job.status!=='blocked')throw Error('The job changed. Prepare a fresh update before approving.');
 let claimedRevision=current.revision;
 if(proposal.state==='draft'){
  const claimed=await db().update(blockerDrafts).set({revision:revision+1,proposal:{...proposal,state:'applying'}}).where(and(eq(blockerDrafts.jobId,jobId),eq(blockerDrafts.revision,revision))).returning();
  if(!claimed.length)throw Error('The draft changed while approving. Review it again.');
  claimedRevision=revision+1;
 }
 try{
  await relay('/jobs/'+encodeURIComponent(jobId)+'/actions',{key:'blocker:'+proposal.key,body:{action:proposal.mode==='resume_work'?'resume':'update_blocker',...(proposal.mode==='record_update'?{blocker:proposal.note}:{}),expectedVersion:proposal.jobVersion,note:changeNote(proposal)}});
 }catch(error){
  if(error instanceof RelayRequestError&&error.status>=400&&error.status<500){
   await db().update(blockerDrafts).set({revision:claimedRevision+1,proposal:{...proposal,state:'draft'}}).where(and(eq(blockerDrafts.jobId,jobId),eq(blockerDrafts.revision,claimedRevision)));
  }
  throw error;
 }
 const verified=await readBlockerWorkflow(jobId);
 if(!verified.receipt)throw Error('Relay has not returned the history receipt yet. Retry this approval; the same change will not be applied twice.');
 await db().update(blockerDrafts).set({proposal:{...proposal,state:'applied'}}).where(and(eq(blockerDrafts.jobId,jobId),eq(blockerDrafts.revision,claimedRevision)));
 return readBlockerWorkflow(jobId);
}

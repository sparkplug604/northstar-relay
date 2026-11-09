import {beforeEach,expect,it,vi} from 'vitest';
import {appendAgentChatContextToMessage} from '@agent-native/agentkit/chat-context';
import {dispatcherText} from './dispatcher-text.js';
import {blockerRequest} from './blocker-intent.js';
const fixture=vi.hoisted(()=>({row:null as null|{jobId:string;revision:number;proposal:Record<string,any>},job:{} as Record<string,any>,events:[] as Array<Record<string,any>>,writes:0,lostResponse:false}));
vi.mock('@agent-native/core/db',()=>({createGetDb:()=>()=>({
 select:()=>({from:()=>({where:async()=>fixture.row?[structuredClone(fixture.row)]:[]})}),
 update:()=>({set:(values:Record<string,any>)=>({where:()=>{
  let done=false;const execute=async()=>{if(!done&&fixture.row){fixture.row={...fixture.row,...values};done=true;}return fixture.row?[structuredClone(fixture.row)]:[];};
  return {returning:execute,then:(resolve:any,reject:any)=>execute().then(resolve,reject)};
 }})}),
})}));
vi.mock('./relay.js',()=>({RelayRequestError:class extends Error{constructor(public status:number){super('Relay error');}},relay:async(_path:string,change?:{body:Record<string,any>;key:string})=>{
 if(change){fixture.writes++;expect(change.key).toBe('blocker:proposal-key');fixture.job.version++;if(change.body.action==='resume'){fixture.job.status='in_progress';fixture.job.blocker=null;}else fixture.job.blocker=change.body.blocker;
  fixture.events.push({kind:change.body.action==='resume'?'job_resumed':'job_blocker_updated',note:change.body.note});
  if(fixture.lostResponse){fixture.lostResponse=false;throw new TypeError('Connection lost after commit');}
 }
 return {job:structuredClone(fixture.job),events:structuredClone(fixture.events)};
}}));
import {approveBlocker,validateBlockerInput} from './blocker.js';
beforeEach(()=>{
 fixture.job={id:'qa',version:1,customerReference:'QA shop',externalId:'QA',description:'Repair',priority:'normal',status:'blocked',assigneeId:'tech',scheduledAt:null,blocker:'Waiting for the part'};
 fixture.row={jobId:'qa',revision:1,proposal:{key:'proposal-key',jobVersion:1,blocker:'Waiting for the part',mode:'record_update',note:'Supplier confirmed a delivery ETA',cleared:false,state:'draft'}};
 fixture.events=[];fixture.writes=0;fixture.lostResponse=false;
});
it('ETA alone can prepare only an update that keeps the blocker',()=>{
 expect(blockerRequest('Supplier confirmed the part will arrive tomorrow. Please clear the blocker.')).toMatchObject({mode:'record_update',cleared:false});
 expect(blockerRequest('The part has not arrived. Please clear the blocker.')).toMatchObject({mode:'record_update',cleared:false});
});
it('a bare instruction asks for confirmed facts',()=>{
 expect(blockerRequest('Please clear the blocker.')).toMatchObject({needsFacts:true});
 expect(blockerRequest('Is anything blocked?')).toBeNull();
});
it('a confirmed arrival and explicit resume request can prepare a clearance',()=>{
 expect(blockerRequest('The part has arrived and Riley can resume work. Please clear the blocker.')).toMatchObject({mode:'resume_work',cleared:true});
});
it('clearance cannot be prepared without the human confirmation',()=>{
 expect(()=>validateBlockerInput({mode:'resume_work',cleared:false,note:'Supplier has given an ETA'})).toThrow('ETA alone is not enough');
});
it('saves once, verifies the history receipt and safely accepts an exact retry',async()=>{
 const result=await approveBlocker('qa',1);expect(result.receipt?.kind).toBe('job_blocker_updated');expect(result.job.status).toBe('blocked');
 await approveBlocker('qa',1);expect(fixture.writes).toBe(1);
});
it('blocks approval when the job changed after the draft',async()=>{
 fixture.job.version=2;await expect(approveBlocker('qa',1)).rejects.toThrow('job changed');expect(fixture.writes).toBe(0);
});
it('recovers a lost response by reading the receipt, without applying twice',async()=>{
 fixture.lostResponse=true;await expect(approveBlocker('qa',1)).rejects.toThrow('Connection lost');
 expect(fixture.row?.proposal.state).toBe('applying');
 const result=await approveBlocker('qa',1);expect(result.receipt?.kind).toBe('job_blocker_updated');expect(result.proposal?.state).toBe('applied');expect(fixture.writes).toBe(1);
});
it('a confirmed clearance uses one resume event and removes the blocker',async()=>{
 fixture.row!.proposal={...fixture.row!.proposal,mode:'resume_work',cleared:true,note:'Part is on site and technician is ready to resume'};
 const result=await approveBlocker('qa',1);expect(result.receipt?.kind).toBe('job_resumed');expect(result.job.status).toBe('in_progress');expect(result.job.blocker).toBeNull();expect(fixture.writes).toBe(1);
});

it('strips nested framework page context before extracting supplier facts',()=>{
 const facts='Supplier confirmed Monday delivery. Part is still pending.';
 const request='Please record this supplier update. Confirmed facts: '+facts;
 const message=appendAgentChatContextToMessage(appendAgentChatContextToMessage(request,'Relay page: jobs'),'Current URL and native resource context');
 const clean=dispatcherText(message);expect(clean).toBe(request);
 expect(blockerRequest(clean)).toMatchObject({mode:'record_update',note:facts});
});

it('arrival without readiness, negated readiness and hypothetical clearance cannot resume work',()=>{
 for(const request of [
  'The part has arrived. Please clear the blocker.',
  'The part has arrived but Riley cannot resume work. Please clear the blocker.',
  'The part has arrived but Riley is not ready to resume work. Please clear the blocker.',
  'If the part has arrived Riley can resume work. Please clear the blocker.',
 ]) expect(blockerRequest(request)).toMatchObject({mode:'record_update',cleared:false});
});

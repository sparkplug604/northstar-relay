import {expect,it} from 'vitest';
import {relayReplyGuard} from './reply-guard.js';
const context=(toolResults:any[])=>({toolResults} as Parameters<typeof relayReplyGuard>[0]);
it('blocks false success after a rejected write, even if an earlier read succeeded',async()=>{
 const result=await relayReplyGuard(context([{name:'read-relay-job-context',isError:false},{name:'create-work-commitment',isError:true}]));expect(result).toMatchObject({maxRetries:0,clearAllText:true});
});
it('permits a verified mutation receipt and factual reads',async()=>{
 expect(await relayReplyGuard(context([{name:'create-work-commitment',isError:false,receipt:{changed:true,verified:true}}]))).toBeUndefined();
 expect(await relayReplyGuard(context([{name:'read-relay-job-context',isError:false}]))).toBeUndefined();
});

it('requires a native action instead of an unfulfilled promise to modify the app',async()=>{
 const result=await relayReplyGuard({...context([{name:'read-relay-job-context',isError:false}]),text:"I'll now create this work commitment with approval."});expect(result).toMatchObject({maxRetries:1,clearAllText:true});
});

it('accepts a verified receipt persisted as Native approval continuation JSON',async()=>{
 expect(await relayReplyGuard(context([{name:'create-work-commitment',isError:false,content:JSON.stringify({_receipt:{changed:true,verified:true}})}]))).toBeUndefined();
 expect(await relayReplyGuard(context([{name:'create-work-commitment',isError:false,content:'Successful action result'}]))).toMatchObject({maxRetries:0});
});
it('blocks a failed receipt even when the Native call itself completed',async()=>{
 expect(await relayReplyGuard(context([{name:'update-relay-job',isError:false,content:JSON.stringify({_receipt:{changed:false,verified:false}})}]))).toMatchObject({maxRetries:0});
});

it('rewrites raw JSON instead of exposing a screen snapshot as the agent answer',async()=>{
 const result=await relayReplyGuard({...context([{name:'read-relay-job-context',isError:false}]),text:'{"view":"dispatch","record":{}}'});expect(result).toMatchObject({clearAllText:true,maxRetries:2});
});

it('allows factual answers grounded in Native current-screen without redundant tool calls',async()=>{
 expect(await relayReplyGuard({...context([]),text:'Riley Technician is assigned. Their saved phone is +16045550100.'})).toBeUndefined();
});

it('rejects a claimed new confirmation note when no Native write ran',async()=>{
 const result=await relayReplyGuard({...context([]),text:'The client confirmed the existing appointment by phone, so the job update is recorded.'});expect(result).toMatchObject({maxRetries:1,clearAllText:true});
});
it('permits read-only contact and existing-history answers without requiring a mutation',async()=>{
 expect(await relayReplyGuard({...context([]),text:'Riley is assigned. Their phone is +16045550100.'})).toBeUndefined();
 expect(await relayReplyGuard({...context([]),text:'The existing job update was recorded yesterday.'})).toBeUndefined();
});
it('accepts a verified job-note write',async()=>{
 expect(await relayReplyGuard({...context([{name:'add-relay-job-update',isError:false,receipt:{changed:true,verified:true,summary:'Saved note'}}]),text:'The job update is recorded.'})).toMatchObject({fallbackMessage:'Saved note'});
});

it('replaces a stale schedule answer with the actual saved local time',async()=>{
 const summary='Moved Parkside Foods to Nov 10, 9:30 a.m. GMT-7.';
 expect(await relayReplyGuard({...context([{name:'reschedule-relay-visit',isError:false,receipt:{changed:true,verified:true,summary}}]),text:'The approved action has run. Scheduled for November 9.'})).toMatchObject({maxRetries:0,clearAllText:true,fallbackMessage:summary});
});
it('does not announce approval or success for invalid scheduling arguments',async()=>{
 expect(await relayReplyGuard({...context([{name:'update-relay-job',isError:true,content:'Invalid action parameters'}]),text:'The approved action has run.'})).toMatchObject({maxRetries:0,clearAllText:true});
 expect(await relayReplyGuard({...context([]),text:'The approved action has run.'})).toMatchObject({maxRetries:1,clearAllText:true});
});
it('keeps a client deadline rejection explicit',async()=>{
 const summary='The requested visit would finish after the client deadline. No visit change was saved.';
 expect(await relayReplyGuard({...context([{name:'reschedule-relay-visit',isError:false,receipt:{changed:false,verified:false,summary}}]),text:'Waiting for approval.'})).toMatchObject({fallbackMessage:summary,maxRetries:0});
});

it('does not treat a saved note as recovery from a failed date change',async()=>{
 expect(await relayReplyGuard({...context([{name:'reschedule-relay-visit',isError:true,content:'Invalid parameters'},{name:'add-relay-job-update',isError:false,receipt:{changed:true,verified:true,summary:'Saved job note.'}}]),text:'The job date was changed.'})).toMatchObject({maxRetries:0,fallbackMessage:'Saved job note. Another requested change was not confirmed. Check the failed action details before trying again.'});
});

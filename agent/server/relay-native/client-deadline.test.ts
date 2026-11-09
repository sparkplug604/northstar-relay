import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({job:{id:'qa',version:7,customerReference:'Parkside Foods',scheduledAt:'2026-11-10T01:00:00.000Z',assigneeId:'casey',priority:'high',site:{label:'Commercial Drive',latitude:49.269,longitude:-123.07},estimatedMinutes:75,requiredSkills:['refrigeration'],serviceWindow:{earliestStart:'2026-11-07T07:23:00.000Z',completeBy:'2026-11-10T01:00:00.000Z'}},writes:0,inputs:[] as any[],cache:new Map<string,any>()}));
vi.mock('../recovery/assignment.js',()=>({readAssignment:async()=>({job:structuredClone(state.job),timezone:'America/Vancouver'})}));
vi.mock('../recovery/relay.js',()=>({relay:async()=>({job:structuredClone(state.job)})}));
vi.mock('./job-actions.js',()=>({runJobChange:async(input:any)=>{state.inputs.push(input);const key=JSON.stringify(input);if(state.cache.has(key))return state.cache.get(key);if(input.expectedVersion!==state.job.version)throw Error('Stale version');state.writes++;state.job.version++;state.job.serviceWindow=input.change.serviceWindow;const result={id:'qa',jobId:'qa',jobVersion:state.job.version,milestone:null,event:{id:'deadline-event',kind:'job_dispatch_details_updated'},change:{verb:'updated',kind:'Job',title:'Parkside Foods',detail:'Saved dispatch details',url:'http://127.0.0.1:3004/relay/jobs/qa'},_receipt:{changed:true,verified:true,subject:'job:qa',summary:'Saved dispatch details',checks:[]}};state.cache.set(key,result);return result;}}));
import {updateClientDeadline} from './client-deadline.js';
beforeEach(()=>{state.job.version=7;state.job.serviceWindow.completeBy='2026-11-10T01:00:00.000Z';state.inputs=[];state.writes=0;state.cache.clear();});
const input={jobId:'qa',expectedVersion:7,date:'2026-11-10',time:'18:00'};
it('updates only the deadline in branch-local time and preserves the dispatch fields',async()=>{
 const before=structuredClone(state.job);const result=await updateClientDeadline(input);expect(result._receipt.verified).toBe(true);expect(result._receipt.summary).toContain('Nov 10');expect(result._receipt.summary).toContain('6:00');expect(state.job.serviceWindow.completeBy).toBe('2026-11-11T01:00:00.000Z');expect(state.job.scheduledAt).toBe(before.scheduledAt);expect(state.job.assigneeId).toBe(before.assigneeId);expect(state.inputs[0].change).toMatchObject({site:before.site,estimatedMinutes:75,requiredSkills:['refrigeration'],serviceWindow:{earliestStart:before.serviceWindow.earliestStart}});expect(state.inputs[0].change.priority).toBeUndefined();
 await updateClientDeadline(input);expect(state.writes).toBe(1);
});
it('does not write against a changed job version or invalid local date',async()=>{
 state.job.version=8;expect((await updateClientDeadline(input))._receipt).toMatchObject({changed:false,verified:false});expect(state.writes).toBe(0);
 state.job.version=7;expect((await updateClientDeadline({...input,date:'2026-02-30'}))._receipt).toMatchObject({changed:false,verified:false});expect(state.writes).toBe(0);
});

import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({job:{id:'qa',version:3,customerReference:'QA client',scheduledAt:'2026-11-11T16:30:00.000Z',assigneeId:'casey',estimatedMinutes:30,serviceWindow:{completeBy:'2026-11-13T01:00:00.000Z'}},revision:0,proposal:null as any,receipt:null as any,proposals:0,writes:0,blocked:false}));
vi.mock('../recovery/assignment.js',()=>({readAssignment:async()=>structuredClone({...state,timezone:'America/Vancouver',clientDeadlineLabel:'Nov 12, 6:00 p.m. GMT-7'})}));
vi.mock('../recovery/relay.js',()=>{class RelayRequestError extends Error{constructor(public status:number){super('Technician is unavailable');}}return {RelayRequestError,relay:async(path:string,change?:any)=>{if(change){if(state.blocked)throw new RelayRequestError(409);state.proposals++;state.revision++;state.proposal={...change.body,jobVersion:change.body.jobVersion};return {revision:state.revision};}return {job:structuredClone(state.job)};}};});
vi.mock('../../actions/apply-relay-assignment.js',()=>({applyRelayAssignment:async()=>{if(!state.receipt){state.writes++;state.job.version++;state.job.scheduledAt=state.proposal.scheduledAt;state.receipt={id:'event-1'};}return {jobId:'qa',proposal:state.proposal,_receipt:{changed:true,verified:true,subject:'job:qa',summary:'Verified write'}};}}));
import {rescheduleVisit} from './reschedule-visit.js';
beforeEach(()=>{state.job.version=3;state.job.scheduledAt='2026-11-11T16:30:00.000Z';state.job.serviceWindow.completeBy='2026-11-13T01:00:00.000Z';state.proposals=0;state.writes=0;state.revision=0;state.proposal=null;state.receipt=null;state.blocked=false;});
const input={jobId:'qa',expectedVersion:3,date:'2026-11-10',note:'Move the visit date as requested'};
it('preserves local visit time and technician through the checked canonical workflow, including a retry',async()=>{
 const saved=await rescheduleVisit(input);expect(saved).toMatchObject({scheduledAt:'2026-11-10T16:30:00.000Z',_receipt:{changed:true,verified:true}});expect(saved._receipt.summary).toContain('Nov 10');expect(state.proposal.personId).toBe('casey');
 const retry=await rescheduleVisit(input);expect(retry._receipt.verified).toBe(true);expect(state.writes).toBe(1);expect(state.proposals).toBe(1);
});
it('rejects a visit after the client deadline without changing the job or client promise',async()=>{
 state.job.serviceWindow.completeBy='2026-11-10T01:00:00.000Z';const saved=await rescheduleVisit(input);expect(saved._receipt).toMatchObject({changed:false,verified:false});expect(saved._receipt.summary).toContain('client deadline');expect(state.proposals).toBe(0);expect(state.writes).toBe(0);expect(state.job.serviceWindow.completeBy).toBe('2026-11-10T01:00:00.000Z');
});
it('rejects changed job versions and technician conflicts without a success receipt',async()=>{
 state.job.version=4;expect((await rescheduleVisit(input))._receipt.verified).toBe(false);expect(state.proposals).toBe(0);
 state.job.version=3;state.blocked=true;expect((await rescheduleVisit(input))._receipt).toMatchObject({changed:false,verified:false});expect(state.writes).toBe(0);
});

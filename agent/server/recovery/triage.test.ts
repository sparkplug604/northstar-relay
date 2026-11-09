import {describe,expect,it,vi} from 'vitest';
vi.mock('./relay.js',()=>({relay:vi.fn()}));
import {rankJob,triageSummary,type Triage,type TriageJob} from './triage.js';
const now=Date.parse('2026-11-09T16:00:00Z');
const base:TriageJob={id:'test',version:1,externalId:'TEST',customerReference:'Test client',description:'Repair cooler',priority:'normal',status:'scheduled',assigneeId:'tech',scheduledAt:'2026-11-09T17:00:00Z',estimatedMinutes:60};
describe('dispatch triage checks',()=>{
 it('puts a missed client deadline above routine assignment gaps',()=>{
  const late=rankJob({...base,serviceWindow:{earliestStart:null,completeBy:'2026-11-09T15:00:00Z'}},now);
  const unassigned=rankJob({...base,assigneeId:null},now);
  expect(late.score).toBeGreaterThan(unassigned.score);expect(late.reasons).toContain('Client deadline has passed');
 });
 it('surfaces emergency and the actual blocker together',()=>{
  const job=rankJob({...base,priority:'urgent',status:'blocked',blocker:'Replacement fan has not arrived'},now);
  expect(job.score).toBe(120);expect(job.reasons).toContain('Blocked: Replacement fan has not arrived');expect(job.canAssign).toBe(false);
 });
 it('checks estimated finish rather than start time alone',()=>{
  expect(rankJob({...base,serviceWindow:{earliestStart:null,completeBy:'2026-11-09T17:30:00Z'}},now).reasons).toContain('Estimated finish is after the client deadline');
 });
 it('does not call completed jobs overdue or offer assignment',()=>{
  const job=rankJob({...base,status:'completed',serviceWindow:{earliestStart:null,completeBy:'2026-11-08T17:30:00Z'}},now);
  expect(job.score).toBe(0);expect(job.canAssign).toBe(false);
 });
 it('finished work needs review rather than being treated as unfinished',()=>{
  const job=rankJob({...base,status:'completion_reported',serviceWindow:{earliestStart:null,completeBy:'2026-11-08T17:30:00Z'}},now);
  expect(job.reasons).toEqual(['Finished work needs your confirmation']);
 });
});

function replyFor(job:TriageJob){const selected=rankJob(job,now);return triageSummary({checkedAt:new Date(now).toISOString(),total:1,truncated:false,items:[selected],selected,team:[]} as Triage);}
it('blocked replies separate the problem and next step and link to the job',()=>{
 const reply=replyFor({...base,status:'blocked',blocker:'Supplier has not confirmed the fan arrival'});
 expect(reply).toContain('**What’s wrong**');expect(reply).toContain('- Blocked: Supplier');
 expect(reply).toContain('**What to do next**');expect(reply).toContain('Ask the supplier');
 expect(reply).toContain('[Resolve with Relay](http://127.0.0.1:3004/relay/jobs/test?resolveBlocker=1)');
 expect(reply).not.toContain('jobAction=assign');
});
it('unassigned replies offer an assignment handoff without claiming a write',()=>{
 const reply=replyFor({...base,assigneeId:null});
 expect(reply).toContain('[Plan assignment](http://127.0.0.1:3004/relay/jobs/test?jobAction=assign)');
 expect(reply).toContain('Review the proposal before approving');expect(reply).toContain('No changes applied');
});

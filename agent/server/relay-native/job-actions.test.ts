import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({job:{id:'qa',version:1,customerReference:'QA',status:'requested'},milestones:[] as any[],events:[] as any[],cache:new Map<string,any>(),writes:0,failRead:false,failStatus:0}));
vi.mock('../recovery/relay.js',()=>{class RelayRequestError extends Error{constructor(public status:number){super('Relay rejected '+status);}}return {RelayRequestError,relay:async(_path:string,change?:{key:string;body:any})=>{
 if(change){if(state.failStatus)throw new RelayRequestError(state.failStatus);if(state.cache.has(change.key))return structuredClone(state.cache.get(change.key));if(change.body.expectedVersion!==state.job.version)throw Error('Stale job');state.writes++;state.job.version++;
 const milestone={id:'task-'+state.writes,title:change.body.title,ownerId:change.body.ownerId,dueAt:change.body.dueAt,status:'open'};state.milestones.push(milestone);state.events.push({id:'event-'+state.writes,kind:'milestone_added',details:{milestoneId:milestone.id}});
 const result=structuredClone({job:state.job,milestones:state.milestones,events:state.events});state.cache.set(change.key,result);return result;
 }
 if(state.failRead){state.failRead=false;throw Error('Read temporarily unavailable');}
 return structuredClone({job:state.job,milestones:state.milestones,events:state.events});
}};});
import {applyJobChange,runJobChange} from './job-actions.js';
beforeEach(()=>{state.job.version=1;state.milestones=[];state.events=[];state.cache.clear();state.writes=0;state.failRead=false;state.failStatus=0;});
const input={jobId:'qa',expectedVersion:1,change:{action:'add_milestone' as const,title:'Check with client',ownerId:'riley',dueAt:'2026-11-09T16:00:00.000Z'}};
it('creates a real work commitment once and verifies its canonical job and history record',async()=>{
 const result=await applyJobChange(input);expect(result.milestone).toMatchObject({title:'Check with client',ownerId:'riley',dueAt:input.change.dueAt});expect(result._receipt.verified).toBe(true);expect(result.milestone?.dueAtLabel).toContain('9:00');expect(result._receipt.summary).toContain('GMT-7');expect(result.event.id).toBe('event-1');
 await applyJobChange(input);expect(state.writes).toBe(1);expect(state.milestones).toHaveLength(1);
});
it('recovers an uncertain verification response using the same version-bound idempotency key',async()=>{
 state.failRead=true;await expect(applyJobChange(input)).rejects.toThrow('Read temporarily unavailable');
 const result=await applyJobChange(input);expect(result._receipt.verified).toBe(true);expect(state.writes).toBe(1);
});
it('does not apply a stale or changed action to a newer job',async()=>{
 state.job.version=2;await expect(applyJobChange(input)).rejects.toThrow('Stale job');expect(state.writes).toBe(0);
});

it('reports a definite rejection as a failed Native receipt, never as a saved record',async()=>{
 state.failStatus=422;const result=await runJobChange(input);expect(result._receipt).toMatchObject({changed:false,verified:false});expect(state.writes).toBe(0);expect('change' in result).toBe(false);
});
it('marks server errors as an uncertain write outcome requiring a history read',async()=>{
 state.failStatus=503;const result=await runJobChange(input);expect(result._receipt).toMatchObject({changed:true,verified:false});expect(result._receipt.summary).toContain('unknown');
});

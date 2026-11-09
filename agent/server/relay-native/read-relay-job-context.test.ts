import {expect,it,vi} from 'vitest';
vi.mock('../recovery/relay.js',()=>({relay:async(path:string)=>path==='/people'?{items:[{id:'casey',displayName:'Casey Technician',email:'casey@relay-demo.invalid',phone:null}]}:{job:{id:'parkside',version:9,assigneeId:'casey',customerReference:'Parkside Foods',scheduledAt:'2026-11-10T15:30:00.000Z',serviceWindow:{completeBy:'2026-11-11T01:00:00.000Z'},clientTiming:{timezone:'America/Vancouver',completeByLabel:'Tue, Nov 10, 6:00 PM UTC-07:00'}},milestones:[],events:[]}}));
vi.mock('../../actions/read-dispatch-planning.js',()=>({readTechnicians:async()=>[{personId:'casey',profile:{timezone:'America/Vancouver',skills:['refrigeration'],workingHours:[],timeOff:[]},nextWorkPeriods:[{start:'2026-11-09T15:00:00Z',end:'2026-11-10T01:00:00Z',startLabel:'Nov 9, 8:00 a.m. GMT-7',endLabel:'Nov 9, 6:00 p.m. GMT-7'}]}]}));
import {readRelayJobContext} from '../../actions/read-relay-job-context.js';
it('exposes the client deadline as its local day/time across a UTC midnight boundary',async()=>{
 const {job}=await readRelayJobContext('parkside');expect(job.clientDeadline).toBe('Tue, Nov 10, 6:00 PM UTC-07:00');expect(job.clientDeadline).not.toContain('Nov 11');expect(job.visitAtLabel).toContain('8:30');
});

it('keeps unrelated next-shift dates out of basic facts while exposing them for commitment planning',async()=>{
 const basic=await readRelayJobContext('parkside');expect(basic.nextShiftCommitmentDefaults).toBeNull();expect(basic.assignedTechnician?.nextWorkPeriods).toBeUndefined();
 const planning=await readRelayJobContext('parkside',true);expect(planning.nextShiftCommitmentDefaults).toMatchObject({ownerId:'casey',dueAt:'2026-11-10T01:00:00Z',dueLabel:'Nov 9, 6:00 p.m. GMT-7'});expect(planning.job.clientDeadline).toContain('Nov 10');
});

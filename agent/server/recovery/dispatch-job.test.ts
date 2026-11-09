import {expect,it,vi} from 'vitest';
vi.mock('./assignment.js',()=>({readAssignment:vi.fn()}));
vi.mock('./relay.js',()=>({relay:async(path:string)=>path==='/people'?{items:[
 {id:'other',displayName:'Other Person',phone:'+15550000001',email:'other@relay-demo.invalid'},
 {id:'tech',displayName:'Riley Technician',phone:'+15550000002',email:'riley@relay-demo.invalid'},
]}:{job:{id:'pine',version:1,customerReference:'Pine Grocery',externalId:'PINE',description:'Repair fan',priority:'normal',status:'blocked',assigneeId:'tech',scheduledAt:null,blocker:'Waiting for part'},milestones:[],events:[],acknowledgement:null,asOf:'2026-11-08T08:00:00Z'}}));
import {readDispatchJobs} from './dispatch-job.js';
it('exposes only the assigned technician’s saved contacts and leaves missing client contacts unknown',async()=>{
 const result=await readDispatchJobs(['pine']);
 expect(result.jobs[0]?.contacts).toEqual({technician:{name:'Riley Technician',phone:'+15550000002',email:'riley@relay-demo.invalid'},client:null});
 expect(JSON.stringify(result)).not.toContain('other@relay-demo.invalid');
});

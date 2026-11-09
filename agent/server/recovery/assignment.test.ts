import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocked=vi.hoisted(()=>({run:{runId:'test-run',threadId:'test-thread'},revision:1}));
vi.mock('@agent-native/core/server/request-context',()=>({getRequestRunContext:()=>mocked.run}));
vi.mock('@agent-native/core/application-state',()=>({readAppStateForCurrentTab:async()=>null}));
vi.mock('./relay.js',()=>({relay:async()=>({
  job:{id:'job-1',version:7,customerReference:'Test client',description:'Repair cooler',priority:'high',scheduledAt:null},
  timezone:'America/Vancouver',clientDeadlineLabel:null,earliestStartLabel:null,
  revision:mocked.revision,timingRecorded:true,checkedAt:new Date().toISOString(),searchedUntil:new Date().toISOString(),
  proposal:null,receipt:null,flags:[],options:[],unavailable:[],
})}));
const runtime=globalThis as typeof globalThis & {__relayAssignmentRuntimeV1?:unknown};
beforeEach(()=>{delete runtime.__relayAssignmentRuntimeV1;mocked.revision=1;vi.resetModules();});
afterEach(()=>{delete runtime.__relayAssignmentRuntimeV1;});
describe('assignment context across server hot reloads',()=>{
  it('retained engine callbacks can read newly prepared turn context',async()=>{
    const retained=await import('./assignment.js');
    vi.resetModules();
    const reloaded=await import('./assignment.js');
    const context=await reloaded.assignmentSummary('job-1','Recommend a technician');
    retained.bindAssignmentTurn('job-1',[{role:'system',content:context}]);
    expect(retained.assignmentTurn('job-1')?.request).toBe('Recommend a technician');
    expect(reloaded.assignmentTurn('job-1')?.jobVersion).toBe(7);
  });
  it('uses the newest checked revision when history contains an older context',async()=>{
    const assignment=await import('./assignment.js');
    const old=await assignment.assignmentSummary('job-1','First recommendation');
    mocked.revision=2;
    const latest=await assignment.assignmentSummary('job-1','Find another option');
    assignment.bindAssignmentTurn('job-1',[{role:'system',content:old},{role:'user',content:latest}]);
    expect(assignment.assignmentTurn('job-1')?.revision).toBe(2);
    expect(assignment.assignmentTurn('job-1')?.request).toBe('Find another option');
  });
  it('does not accept a token belonging to a different job',async()=>{
    const assignment=await import('./assignment.js');
    const context=await assignment.assignmentSummary('job-1','Read options');
    expect(()=>assignment.bindAssignmentTurn('job-2',[{role:'system',content:context}])).toThrow('context expired');
  });
});

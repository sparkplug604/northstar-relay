import {defineAction} from '@agent-native/core/action';
import {readAppStateForCurrentTab} from '@agent-native/core/application-state';
import {z} from 'zod';
import {readRelayJobContext} from './read-relay-job-context.js';
import {readTechnicians} from './read-dispatch-planning.js';
import {readTriage} from '../server/recovery/triage.js';
export default defineAction({
 description:'Read the live Relay page and relevant records. Native includes this snapshot automatically in current-screen. A selected job includes its current version, assigned technician contacts/hours, client deadline and commitments. Other pages include current priority or team data. Read failures are not empty records.',
 schema:z.object({}),http:false,readOnly:true,
 run:async()=>{
  const navigation=await readAppStateForCurrentTab('navigation') as {view?:string;page?:string;jobId?:string}|null;
  if(!navigation)return {navigation:null};
  if(navigation.jobId)return {navigation,checkedAt:new Date().toISOString(),record:await readRelayJobContext(navigation.jobId)};
  if(navigation.view==='dispatch'&&['team','people'].includes(navigation.page??''))return {navigation,checkedAt:new Date().toISOString(),technicians:await readTechnicians()};
  if(navigation.view==='dispatch'&&['home','jobs'].includes(navigation.page??'home')){
   const state=await readTriage();return {navigation,checkedAt:state.checkedAt,activeJobs:state.total,flaggedJobs:state.items.length,truncated:state.truncated,priorities:state.items.slice(0,5).map(job=>({jobId:job.id,expectedVersion:job.version,client:job.customerReference,priority:job.priority,status:job.status,blocker:job.blocker,reasons:job.reasons,assignedTo:state.team.find(p=>p.personId===job.assigneeId)?.displayName,clientDeadline:job.clientTiming?.completeByLabel??job.serviceWindow?.completeBy,nextAction:job.nextAction}))};
  }
  return {navigation};
 },
});

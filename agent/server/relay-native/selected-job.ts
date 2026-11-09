import {getRequestRunContext} from '@agent-native/core/server/request-context';
import {readAppStateForCurrentTab} from '@agent-native/core/application-state';
const valid=(id:unknown):id is string=>typeof id==='string'&&id.length>0&&id.length<=200;
/** Use explicit input or this request's selected job; never guess from a global last-opened job. */
export async function selectedRelayJobId(explicit?:string){
 if(valid(explicit))return explicit;
 const context=getRequestRunContext();
 const scoped=context?.actionScope?.jobId;
 if(valid(scoped))return scoped;
 if(context?.browserTabId){const nav=await readAppStateForCurrentTab('navigation',{fallbackToGlobal:false}) as {jobId?:unknown}|null;if(valid(nav?.jobId))return nav.jobId;}
 throw Error('No job is selected. Open the job, or search the jobs list and pass its jobId.');
}

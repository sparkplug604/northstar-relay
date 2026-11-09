import {relayRequest,type Session} from './api.js';
import type {JobsResult} from './jobsModel.js';
import {useRelayResource} from './useRelayResource.js';
export interface JobsOverview {active:number;attention:number;mine:number;completionReview:number;asOf:string}
async function loadJobPages(path:string,signal:AbortSignal):Promise<JobsResult>{
  const first=await relayRequest<JobsResult>(path,{signal});
  const items=[...first.items],seen=new Set(items.map(job=>job.id));
  const query=new URLSearchParams(path.split('?')[1]);
  let offset=first.nextOffset;
  while(offset!==null&&items.length<1000){
    query.set('offset',String(offset));
    const page=await relayRequest<JobsResult>(`/jobs?${query}`,{signal});
    for(const job of page.items){if(!seen.has(job.id)){seen.add(job.id);items.push(job);}}
    offset=page.nextOffset!==null&&page.nextOffset>offset?page.nextOffset:null;
  }
  return {...first,items,hasMore:offset!==null,nextOffset:offset};
}
export function useJobs(session:Session,query:string,planning=false){
  return useRelayResource<JobsResult>(`/jobs?${query}`,`${session.organization.id}:${session.user.id}`,planning?loadJobPages:undefined);
}
export function useJobsOverview(session:Session){return useRelayResource<JobsOverview>('/jobs/overview',`${session.organization.id}:${session.user.id}`);}

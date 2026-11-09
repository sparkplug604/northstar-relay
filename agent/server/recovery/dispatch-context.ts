import {randomUUID} from 'node:crypto';
import {getRequestRunContext} from '@agent-native/core/server/request-context';
import {readAppStateForCurrentTab} from '@agent-native/core/application-state';
import type {DispatchPlan} from './dispatch-answer.js';
export type DispatchContext={page:string;jobId?:string;pageJobId?:string;request:string;expires:number;personName?:string;staffTopic?:string;plan?:DispatchPlan;blockerProposalKey?:string;history?:Array<{role:'user'|'assistant';content:string}>};
type Runtime={turns:Map<string,DispatchContext>;threads:Map<string,DispatchContext>};
const global=globalThis as typeof globalThis&{__relayDispatchContextV1?:Runtime};
const runtime=global.__relayDispatchContextV1??={turns:new Map(),threads:new Map()};
export async function dispatchContext(threadId?:string):Promise<DispatchContext|null>{
 const run=getRequestRunContext();
 const prior=runtime.threads.get(threadId??run?.threadId??'');
 const navigation=await readAppStateForCurrentTab('navigation') as {view?:string;page?:string;jobId?:string}|null;
 if(navigation?.view==='dispatch'){
  const samePage=prior&&prior.expires>Date.now()&&prior.page===(navigation.page??'home')&&prior.pageJobId===navigation.jobId;
  return {page:navigation.page??'home',...(navigation.jobId?{jobId:navigation.jobId,pageJobId:navigation.jobId}:{}),
   ...(samePage?{...(prior.jobId?{jobId:prior.jobId}:{}),history:prior.history??[],...(prior.personName?{personName:prior.personName}:{}),...(prior.staffTopic?{staffTopic:prior.staffTopic}:{})}:{}),request:'',expires:Date.now()+3600000};
 }
 const scope=run?.actionScope;
 if(scope?.kind==='relay-dispatch')return {page:typeof scope.page==='string'?scope.page:'home',...(typeof scope.jobId==='string'?{jobId:scope.jobId}:{}),request:'',expires:Date.now()+3600000};
 return prior&&prior.expires>Date.now()?prior:null;
}
export function prepareDispatch(context:DispatchContext,request:string){
 for(const [key,turn] of runtime.turns)if(turn.expires<Date.now())runtime.turns.delete(key);
 if(runtime.turns.size>=128)runtime.turns.delete(runtime.turns.keys().next().value!);
 const token=randomUUID();const turn={...context,request,expires:Date.now()+900000};delete turn.plan;delete turn.blockerProposalKey;runtime.turns.set(token,turn);
 return 'RELAY_DISPATCH_TURN:'+token+'\nYou are the Ask Relay dispatch partner. Current page: '+context.page+'. '+(context.jobId?'Current job: '+context.jobId+'. ':'')+'Use the appropriate live Relay read action before answering. Answer the actual question using current job facts and recent conversation, not a fixed triage report. Use registered draft actions to prepare changes from dispatcher-provided facts. Actual job changes require the dispatcher approval control and a verified history receipt. Never claim a draft has been applied.';
}
export function bindDispatch(messages:Array<{role:string;content?:string}>){
 const tokens=[...messages.map(message=>message.content??'').join('\n').matchAll(/RELAY_DISPATCH_TURN:([a-f0-9-]{36})/g)].reverse();
 const context=tokens.map(match=>runtime.turns.get(match[1]!)).find(turn=>turn&&turn.expires>Date.now());
 if(!context)throw Error('Refresh Ask Relay to load the current page context.');
 const run=getRequestRunContext();if(run?.threadId)runtime.threads.set(run.threadId,context);
 for(const [key,turn] of runtime.threads)if(turn.expires<Date.now())runtime.threads.delete(key);
 if(runtime.threads.size>128)runtime.threads.delete(runtime.threads.keys().next().value!);
 return context;
}

export function rememberDispatchReply(context:DispatchContext,reply:string){
 context.history=[...(context.history??[]),{role:'user' as const,content:context.request.slice(0,1500)},{role:'assistant' as const,content:reply.slice(0,2000)}].slice(-6);
}

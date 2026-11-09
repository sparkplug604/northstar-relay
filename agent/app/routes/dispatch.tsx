import {useEffect,useMemo,useRef,useState} from 'react';
import {useSearchParams} from 'react-router';
import {useActionQuery} from '@agent-native/core/client/hooks';
import {sendToAgentChat} from '@agent-native/core/client/agent-chat';
import {AgentChatSurface} from '@agent-native/toolkit/app/chat';
import {TAB_ID} from '@/lib/tab-id';
import {Button} from '@/components/ui/button';
import type {Triage} from '../../server/recovery/triage.js';
import '../dispatch.css';
import '@/components/dispatch/BlockerChangeApproval';
const resolutionPrompt='Help me resolve what needs attention on this job. What is confirmed, what is still unknown, and what should I ask the assigned technician or client?';
const post=(value:Record<string,unknown>)=>window.parent.postMessage(value,'http://127.0.0.1:3004');
export default function DispatchRoute(){
 const [params,setParams]=useSearchParams();const compact=params.get('mode')==='triage';
 const jobId=params.get('jobId')??undefined,page=params.get('page')??'home';
 const read=useActionQuery('read-dispatch-triage',jobId?{jobId}:{});
 const state=read.data as Triage|undefined;
 const scope=useMemo(()=>({type:'relay-dispatch',id:jobId?'job:'+jobId:'general',label:'Ask Relay',contextVersion:'v2'}),[jobId]);
 const observedVersion=useRef<{id:string;version:number}|null>(null);
 useEffect(()=>{const selected=state?.selected;if(!selected)return;const old=observedVersion.current;observedVersion.current={id:selected.id,version:selected.version};if(old?.id===selected.id&&old.version!==selected.version)post({type:'relay-job-updated',jobId:selected.id});},[state?.selected?.id,state?.selected?.version]);
 const root=useRef<HTMLDivElement>(null);const [hostContextReceived,setHostContextReceived]=useState(false),[chatReady,setChatReady]=useState(false);const [pending,setPending]=useState('');const [contextReady,setContextReady]=useState(compact);const [contextEpoch,setContextEpoch]=useState(0);
 useEffect(()=>{if(window.parent===window)setHostContextReceived(true);},[]);
 function resolveJob(id:string){if(id===jobId&&contextReady){ask(resolutionPrompt,id,true);return;}const next=new URLSearchParams(params);next.set('jobId',id);next.delete('resolve');setContextReady(false);setPending(resolutionPrompt);setParams(next,{replace:true});}
 function ask(message:string,selected?:string,newConversation=false){
  const target=selected??jobId;
  const selectedJob=state?.selected;
  const prompt=message===resolutionPrompt&&selectedJob&&selectedJob.id===target?message.replace('this job','this job ('+selectedJob.customerReference+')'):message;
  sendToAgentChat({message:prompt,submit:true,openSidebar:false,chatTarget:'local',...(newConversation?{newTab:true}:{}),
   context:'Relay page: '+page+(selected??jobId?' · job '+(selected??jobId):''),contextLabel:'Ask Relay · '+page,
   actionScope:{kind:'relay-dispatch',page,...(target?{jobId:target}:{})}});
 }
 useEffect(()=>{
  const receive=(event:MessageEvent)=>{
   if(event.origin!=='http://127.0.0.1:3004'||event.source!==window.parent)return;
   if(event.data?.type==='relay-triage-refresh'){void read.refetch();return;}
   if(event.data?.type!=='relay-ask-context')return;
   setHostContextReceived(true);
   const next=new URLSearchParams();next.set('relay','1');next.set('mode','panel');next.set('page',String(event.data.page??'home').slice(0,40));
   if(typeof event.data.jobId==='string'&&event.data.jobId.length<=200)next.set('jobId',event.data.jobId);
   setContextReady(false);setContextEpoch(value=>value+1);setParams(next,{replace:true});setPending(event.data.resolveBlocker===true?resolutionPrompt:typeof event.data.question==='string'?event.data.question.slice(0,2000):'');
  };
  window.addEventListener('message',receive);post({type:'relay-ask-ready'});
  return ()=>window.removeEventListener('message',receive);
 },[setParams]);
 useEffect(()=>{if((compact||hostContextReceived)&&state&&(jobId?state.selected?.id===jobId:!state.selected))setContextReady(true);},[state,jobId,page,contextEpoch,hostContextReceived,compact]);
 useEffect(()=>{if(contextReady&&jobId&&params.get('resolve')==='1'){const next=new URLSearchParams(params);next.delete('resolve');setParams(next,{replace:true});setPending(resolutionPrompt);}},[contextReady,jobId,params,setParams]);
 useEffect(()=>{if(contextReady&&pending&&state&&(!jobId||state.selected?.id===jobId)){ask(pending,undefined,pending===resolutionPrompt);setPending('');}},[pending,state,jobId,page,contextReady]);
 useEffect(()=>{const timer=window.setInterval(()=>void read.refetch(),60000);return ()=>window.clearInterval(timer);},[read.refetch]);
 useEffect(()=>{
  if(!compact||!root.current)return;
  const observer=new ResizeObserver(()=>post({type:'relay-triage-height',height:root.current!.scrollHeight+8}));observer.observe(root.current);
  return ()=>observer.disconnect();
 },[compact]);
 const jobs=state?.selected?[state.selected]:state?.items.slice(0,3)??[];
 const cards=<>{jobs.map(job=><article className={'dispatch-priority '+(job.score>=95?'dispatch-critical':'')} key={job.id}>
  <h3>{job.customerReference}</h3>{job.description&&!job.description.startsWith('Synthetic example.')&&<p>{job.description}</p>}
  <ul>{job.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>
  {job.serviceWindow?.completeBy&&<p><strong>Client deadline:</strong> {job.clientTiming?.completeByLabel??new Date(job.serviceWindow.completeBy).toLocaleString([],{timeZone:'America/Vancouver',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})}</p>}
  <div className="dispatch-buttons">
   <button onClick={()=>post({type:'relay-open-job',jobId:job.id})}>Open job</button>
   {job.canAssign&&<button onClick={()=>post({type:'relay-plan-assignment',jobId:job.id})}>Plan assignment</button>}
   {compact&&<Button size="sm" className="dispatch-resolve-trigger" onClick={()=>post({type:'relay-ask-job',jobId:job.id,resolveBlocker:true})}>Resolve with Relay</Button>}
  </div>
 </article>)}</>;
 function followReplyAction(event:React.MouseEvent){
  const anchor=(event.target as Element).closest('a');if(!anchor)return;
  let url:URL;try{url=new URL(anchor.href);}catch{return;}
  if(url.origin!=='http://127.0.0.1:3004')return;
  const match=url.pathname.match(/^\/relay\/jobs\/([^/]+)$/);
  if(!match&&!['/relay/jobs','/relay/people'].includes(url.pathname))return;
  event.preventDefault();event.stopPropagation();
  if(match){let id:string;try{id=decodeURIComponent(match[1]!);}catch{return;}if(id.length>200)return;
   if(url.searchParams.get('resolveBlocker')==='1'||anchor.textContent?.replace(/\s+/g,' ').trim()==='Open job to resolve blocker'){resolveJob(id);return;}
   post({type:url.searchParams.get('jobAction')==='assign'?'relay-plan-assignment':'relay-open-job',jobId:id});
  }else post({type:url.pathname==='/relay/people'?'relay-open-team':'relay-open-jobs'});
 }
 return <div ref={root} className={compact?'dispatch-home':'dispatch-panel'} onKeyDown={event=>{if(event.key==='Escape')post({type:'relay-ask-close'});}}>
  <div className="dispatch-controls">
  {compact&&<header><h2>What to focus on</h2><p>Live priority checks. You choose what happens next.</p></header>}
  {read.error&&<p role="alert">Could not refresh priority jobs. {state?'These are the last received results.':''}<button onClick={()=>void read.refetch()}>Retry</button></p>}
  {!state&&!read.error&&<p role="status">Checking client deadlines and job blockers…</p>}
  {state&&<>
   <div className="dispatch-toolbar"><small>{state.items.length} jobs flagged · checked {new Date(state.checkedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</small><button onClick={()=>void read.refetch()}>Refresh priorities</button></div>
   {state.truncated&&<p role="alert">Only the first 1,000 jobs were checked. Open Jobs to review the rest.</p>}
   {compact?cards:<details className="dispatch-priority-list"><summary>{state.selected?'Current job · '+state.selected.customerReference:'Priority jobs ('+state.items.length+')'}</summary>{cards}</details>}
   {!jobs.length&&<p>No active jobs match the priority checks.</p>}
   {compact&&state.items.length>3&&<button onClick={()=>post({type:'relay-open-jobs'})}>View all jobs</button>}
  </>}
  {!compact&&<><div className="dispatch-buttons dispatch-prompts">{state?.selected&&contextReady&&<Button size="sm" className="dispatch-resolve-trigger" onClick={()=>resolveJob(state.selected!.id)}>Resolve with Relay</Button>}<button onClick={()=>ask(jobId?'Explain this job’s blockers, client deadline risks, and the next action I should take.':'Which jobs should I deal with first, and why?')}>{jobId?(state?.selected?.status==='blocked'?'Explain the blocker':'Explain job risks'):'Prioritize today’s jobs'}</button><button onClick={()=>ask(page==='team'||page==='people'?'What technician skills and availability are recorded?':jobId?'Can the planned visit finish before this client’s deadline? Explain any recorded risks.':'Which client deadlines are at risk?')}>{page==='team'||page==='people'?'Review team profiles':jobId?'Check this deadline':'Check client deadlines'}</button></div>
   <p className="dispatch-boundary">Relay can prepare changes. You review and approve before a job changes.</p>
  </>}
  </div>
  {!compact&&<>
   <section className="dispatch-conversation" aria-label="Ask Relay conversation" inert={!contextReady||!chatReady} aria-busy={!contextReady||!chatReady} onClickCapture={followReplyAction}><AgentChatSurface onReadyChange={setChatReady} key={scope.id} mode="panel" restoreActiveThread={false} chatOnly browserTabId={TAB_ID} storageKey="relay-dispatch-v1" scope={scope} isolateHistoryByScope showCollapseButton={false}/></section>
  </>}
 </div>;
}

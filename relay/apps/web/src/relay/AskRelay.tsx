import {useEffect,useRef,useState} from 'react';
import type {RelayNavigate} from './navigation.js';
import './askRelay.css';
const nativeOrigin='http://127.0.0.1:3005';
const pageLabels:Record<string,string>={home:'Home',jobs:'Jobs',commitments:'Work commitments',intake:'Work Order Inbox',team:'Team',people:'People',settings:'Settings','on-call':'On call',work:'Work Order Acknowledgements',history:'Handoff history',recovery:'Recovery',profile:'My profile'};
function context(location:string){const url=new URL(location,window.location.origin);const parts=url.pathname.split('/');return {page:parts[2]||'home',...(parts[2]==='jobs'&&parts[3]?{jobId:decodeURIComponent(parts[3])}:{})};}
export function AskRelay({location,navigate}:{location:string;navigate:RelayNavigate}){
 const [open,setOpen]=useState(false),[mounted,setMounted]=useState(false),[ready,setReady]=useState(false),[conversation,setConversation]=useState(0);
 const frame=useRef<HTMLIFrameElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const initialSrc=useRef<string|null>(null);
 const pending=useRef<{jobId?:string;question?:string;resolveBlocker?:boolean}|null>(null),current=useRef(context(location));current.current=context(location);
 function send(){frame.current?.contentWindow?.postMessage({type:'relay-ask-context',...current.current,...pending.current},nativeOrigin);pending.current=null;}
 function startConversation(input:NonNullable<typeof pending.current>){
  pending.current=input;
  const first={...current.current,...input};
  initialSrc.current=nativeOrigin+'/dispatch-entry.html?mode=panel&page='+encodeURIComponent(first.page)+(first.jobId?'&jobId='+encodeURIComponent(first.jobId):'');
  setReady(false);setConversation(value=>value+1);setMounted(true);setOpen(true);
 }
 function close(){setOpen(false);trigger.current?.focus();}
 useEffect(()=>{if(ready)send();},[location,ready]);
 useEffect(()=>{
  const receive=(event:MessageEvent)=>{
   if(event.origin!==nativeOrigin)return;
   const own=event.source===frame.current?.contentWindow;
   const home=Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe.relay-home-triage')).some(item=>item.contentWindow===event.source);
   if(!own&&!home)return;
   const data=event.data;if(!data||typeof data.type!=='string')return;
   if(data.type==='relay-ask-ready'&&own){setReady(true);}
   if(data.type==='relay-ask-close'&&own)close();
   if(data.type==='relay-job-updated'&&own){window.dispatchEvent(new CustomEvent('relay-job-updated',{detail:{jobId:data.jobId}}));window.dispatchEvent(new Event('relay-priorities-refresh'));}
   if(data.type==='relay-open-team'){navigate('/relay/people');}
   if(data.type==='relay-open-jobs'){setOpen(false);navigate('/relay/jobs');}
   if(typeof data.jobId!=='string'||!data.jobId||data.jobId.length>200)return;
   if(data.type==='relay-open-job'||data.type==='relay-plan-assignment'){
    if(data.type==='relay-plan-assignment')setOpen(false);
    navigate('/relay/jobs/'+encodeURIComponent(data.jobId)+(data.type==='relay-plan-assignment'?'?jobAction=assign&askRelay='+Date.now():''));
   }
   if(data.type==='relay-ask-job'){
    startConversation({jobId:data.jobId,...(data.resolveBlocker===true?{resolveBlocker:true}:{question:typeof data.question==='string'?data.question.slice(0,2000):'Help me with this job.'})});
   }
  };
  const resolve=(event:Event)=>{const id=(event as CustomEvent<{jobId?:string}>).detail?.jobId;if(!id||id.length>200)return;startConversation({jobId:id,resolveBlocker:true});};
  window.addEventListener('relay-resolve-blocker',resolve);window.addEventListener('message',receive);return ()=>{window.removeEventListener('message',receive);window.removeEventListener('relay-resolve-blocker',resolve);};
 },[navigate,ready]);
 if(mounted&&!initialSrc.current){const first={...current.current,...pending.current};initialSrc.current=nativeOrigin+'/dispatch-entry.html?mode=panel&page='+encodeURIComponent(first.page)+(first.jobId?'&jobId='+encodeURIComponent(first.jobId):'');}
 return <>
  <button ref={trigger} type="button" className="relay-ask-trigger" aria-expanded={open} aria-controls="relay-ask-panel" onClick={()=>{setMounted(true);setOpen(value=>!value);}}>✳ Ask Relay</button>
  {mounted&&<aside id="relay-ask-panel" className="relay-ask-panel" aria-label="Ask Relay" hidden={!open} onKeyDown={event=>{if(event.key==='Escape')close();}}>
   <header><div><h2>Ask Relay</h2><small>{pageLabels[current.current.page]??'Relay'}{current.current.jobId?' · current job':''}</small></div><div className="relay-actions"><button type="button" aria-label="Reload Ask Relay" onClick={()=>{setReady(false);if(frame.current)frame.current.src=frame.current.src;}}>↻</button><button type="button" onClick={close} aria-label="Close Ask Relay">✕</button></div></header>
   {!ready&&<p role="status">Opening your dispatch partner…</p>}
   <iframe key={conversation} ref={frame} title="Ask Relay assistant" src={initialSrc.current??undefined}/>
  </aside>}
 </>;
}
export function HomeTriage(){
 const frame=useRef<HTMLIFrameElement>(null);const [height,setHeight]=useState(500),[failed,setFailed]=useState(false);
 useEffect(()=>{const refresh=()=>frame.current?.contentWindow?.postMessage({type:'relay-triage-refresh'},nativeOrigin);window.addEventListener('relay-priorities-refresh',refresh);const receive=(event:MessageEvent)=>{if(event.origin===nativeOrigin&&event.source===frame.current?.contentWindow&&event.data?.type==='relay-triage-height'&&Number.isFinite(event.data.height))setHeight(Math.max(180,Math.min(2200,event.data.height)));};window.addEventListener('message',receive);return ()=>{window.removeEventListener('message',receive);window.removeEventListener('relay-priorities-refresh',refresh);};},[]);
 return <section aria-label="Dispatch priorities" className="relay-home-triage-container">{failed&&<p role="alert">Could not open priority checks. Use Jobs to review the current work.</p>}<iframe ref={frame} title="Relay priority actions" className="relay-home-triage" src={nativeOrigin+'/dispatch-entry.html?mode=triage&page=home'} style={{height}} onError={()=>setFailed(true)}/></section>;
}

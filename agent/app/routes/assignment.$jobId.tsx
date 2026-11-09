import {useEffect,useMemo,useState} from 'react';
import {useParams} from 'react-router';
import {useActionQuery,useActionMutation} from '@agent-native/core/client/hooks';
import {sendToAgentChat} from '@agent-native/core/client/agent-chat';
import {AgentChatSurface} from '@agent-native/toolkit/app/chat';
import type {Assignment} from '../../server/recovery/assignment.js';
import {TAB_ID} from '@/lib/tab-id';
import '../assignment.css';

const priorities:Record<string,string>={urgent:'Emergency',high:'Urgent',normal:'Routine',low:'Can wait'};
export function meta(){return [{title:'Assign a technician · Northstar Relay'}];}

export default function AssignmentRoute(){
  const {jobId=''}=useParams();
  const read=useActionQuery('read-assignment-options',{jobId});
  const propose=useActionMutation('select-assignment-opening');
  const approve=useActionMutation('approve-assignment');
  const state=read.data as Assignment|undefined;
  const [error,setError]=useState(''),[pending,setPending]=useState(false);
  const scope=useMemo(()=>({type:'relay-assignment',id:'assignment-v4:'+jobId,label:'Job assignment',contextVersion:'assignment-v4'}),[jobId]);
  useEffect(()=>{
    const refresh=(event:MessageEvent)=>{
      if(event.origin==='http://127.0.0.1:3004'&&event.source===window.parent&&event.data?.type==='relay-assignment-refresh'&&event.data?.jobId===jobId)void read.refetch();
    };
    window.addEventListener('message',refresh);
    return ()=>window.removeEventListener('message',refresh);
  },[jobId,read.refetch]);
  function ask(alternative=false){
    if(!state)return;
    const message=alternative
      ?'Find an alternative technician or time to the current proposal, within the client window. Read current options, explain the tradeoff, and save the revised proposal.'
      :'Recommend the best suitable technician and an available time for this job. Consider client priority and deadline, skills, working hours, time off and travel. Save your recommendation as a proposal for me to approve.';
    sendToAgentChat({message,submit:true,openSidebar:false,chatTarget:'local',tabId:TAB_ID,
      context:'Assignment for '+state.job.customerReference+' · jobId '+jobId,contextLabel:'Job assignment',
      actionScope:{kind:'relay-assignment',jobId}});
  }
  async function choose(option:Assignment['options'][number]){
    if(!state||pending)return;setPending(true);setError('');
    try{
      await propose.mutateAsync({jobId,revision:state.revision,jobVersion:state.job.version,personId:option.personId,
        scheduledAt:option.scheduledAt,reason:'Dispatcher selected this available technician and visit time.'});
    }catch(error){setError(error instanceof Error?error.message:String(error));}
    finally{await read.refetch();setPending(false);}
  }
  async function apply(){
    if(!state||pending)return;setPending(true);setError('');
    window.parent.postMessage({type:'relay-assignment-busy',jobId,busy:true},'http://127.0.0.1:3004');
    try{
      await approve.mutateAsync({jobId,revision:state.revision});
      await read.refetch();
      window.parent.postMessage({type:'relay-assignment-applied',jobId},'http://127.0.0.1:3004');
    }catch(error){setError(error instanceof Error?error.message:String(error));}
    finally{
      setPending(false);
      window.parent.postMessage({type:'relay-assignment-busy',jobId,busy:false},'http://127.0.0.1:3004');
    }
  }
  return <div className="assignment-workspace">
    <section className="assignment-options" aria-label="Assignment options">
      <h1>Find a technician and time</h1>
      {!state&&<p role="status">{read.error?'Could not load assignment options.':'Checking the next available openings…'}</p>}
      {read.error&&<button type="button" onClick={()=>void read.refetch()}>Retry loading</button>}
      {state&&<>
        <h2>{state.job.customerReference.split(' — ')[0]}</h2>
        <p><strong>{priorities[state.job.priority]??state.job.priority}</strong> · {state.timezone}</p>
        <p>{state.job.serviceWindow?.completeBy?'Client needs it finished by '+state.clientDeadlineLabel:state.timingRecorded?'No fixed client deadline.':'Client timing has not been recorded. Close this dialog and use Edit dispatch details on the job page.'}</p>
        {state.job.serviceWindow?.earliestStart&&<p>Client can start from {state.earliestStartLabel}</p>}
        {error&&<p role="alert" className="assignment-error">{error}</p>}
        <div className="assignment-buttons">
          <button type="button" disabled={pending||!state.timingRecorded} onClick={()=>ask()}>Ask agent to recommend</button>
          <button type="button" disabled={pending||!state.proposal||!state.timingRecorded} onClick={()=>ask(true)}>Ask for another option</button>
        </div>
        {state.proposal&&<section className="assignment-proposal" aria-label="Proposed assignment">
          <h2>{state.receipt?'Assignment saved':'Proposed assignment'}</h2>
          <strong>{state.proposal.displayName}</strong>
          <p>{state.proposal.startLabel} – {state.proposal.endLabel}</p>
          <p>{state.proposal.reason}</p>
          {state.flags.map(flag=><p role="alert" key={flag}>{flag}</p>)}
          {state.receipt?<p role="status">Saved to Relay job history.</p>:<button type="button" disabled={pending||state.flags.length>0} onClick={()=>void apply()}>{pending?'Saving…':'Approve assignment'}</button>}
        </section>}
        <h2>Available openings</h2>
        {state.options.length===0&&<p>No suitable openings were found within the client window and the next 14 days.</p>}
        {state.options.map(option=><article className="assignment-option" key={option.personId+option.scheduledAt}>
          <h3>{option.displayName}</h3><p>{option.startLabel} – {option.endLabel}</p>
          <p>{option.travel.map(leg=>(leg.direction==='before'?'Drive in':'Drive after')+' '+(leg.minutes??'?')+' min').join(' · ')} · plus 10 min buffer per leg</p>
          <button type="button" disabled={pending||!state.timingRecorded} onClick={()=>void choose(option)}>Propose this opening</button>
        </article>)}
        {state.unavailable.length>0&&<details><summary>Why other technicians do not fit</summary>{state.unavailable.map(person=><article key={person.personId}>
          <h3>{person.displayName}</h3><ul>{person.reasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul>
        </article>)}</details>}
        <small>Road travel is estimated without live traffic. You approve the final technician and time.</small>
      </>}
    </section>
    <section className="assignment-chat" aria-label="Assignment agent conversation">
      <AgentChatSurface mode="panel" chatOnly browserTabId={TAB_ID} storageKey={'relay-assignment-v4-'+jobId}
        scope={scope} isolateHistoryByScope showCollapseButton={false}/>
    </section>
  </div>;
}

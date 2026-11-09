import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {JobSite,TechnicianPlanning,TechnicianProfile,TechnicianMatches} from '@northstar/relay-domain';
import {canDispatch,commandKey,relayRequest,type Session} from './api.js';
import {errorLabel,type Language} from './i18n.js';
import {DateTime} from './DateTime.js';
import {localDateInput,reviewedTimestamp} from './dateInput.js';
import type {Job,JobDetail} from './jobsModel.js';
import './dispatchPlanning.css';
import {clientDeadlineStatus} from './deadlineStatus.js';

export function SiteFields({site}:{site:JobSite|null|undefined}){
  return <div className="relay-dispatch-fields">
    <label>Location name or address<input name="siteLabel" defaultValue={site?.label??''} maxLength={200}/></label>
    <label>Latitude<input name="latitude" type="number" step="any" min="-90" max="90" defaultValue={site?.latitude}/></label>
    <label>Longitude<input name="longitude" type="number" step="any" min="-180" max="180" defaultValue={site?.longitude}/></label>
  </div>;
}
function readSite(form:FormData):JobSite|null{
  const label=String(form.get('siteLabel')??'').trim();
  if(!label)return null;
  if(!String(form.get('latitude')).trim()||!String(form.get('longitude')).trim())throw Error('Enter both coordinates for this location.');
  return {label,latitude:Number(form.get('latitude')),longitude:Number(form.get('longitude'))};
}
const skills=(value:FormDataEntryValue|null)=>String(value??'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean);
const days=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

export function TechnicianAvailability({session,language}:{session:Session;language:Language}){
  const [items,setItems]=useState<TechnicianPlanning[]>([]),[error,setError]=useState(''),[editing,setEditing]=useState<TechnicianPlanning|null>(null);
  async function refresh(){
    try{const result=await relayRequest<{items:TechnicianPlanning[]}>('/technicians');setItems(result.items);setError('');}
    catch(error){setError(errorLabel(language,error));}
  }
  useEffect(()=>{if(canDispatch(session))void refresh();},[session.organization.id,session.user.id]);
  if(!canDispatch(session))return null;
  return <section className="relay-card">
    <h2>Technician availability</h2><p>Set working hours, time off and skills so dispatch can check who can take a job.</p>
    {error&&<p role="alert" className="relay-error">{error}</p>}
    {editing&&<TechnicianForm key={editing.personId+':'+editing.version} item={editing} language={language}
      onClose={()=>setEditing(null)} onSaved={()=>{setEditing(null);void refresh();}}/>}
    <ul className="relay-planning-jobs">{items.map(item=><li key={item.personId}>
      <strong>{item.displayName}</strong>
      <p>{item.profile?item.profile.skills.join(', ')||'No skills recorded':'Availability not recorded'}</p>
      {item.profile&&<small>{item.profile.workingHours.length} working periods · {item.profile.timeOff.length} time-off periods · {item.profile.timezone}</small>}
      <button type="button" aria-label={'Edit availability: '+item.displayName} onClick={()=>setEditing(item)}>Edit availability</button>
    </li>)}</ul>
  </section>;
}
function TechnicianForm({item,language,onClose,onSaved}:{item:TechnicianPlanning;language:Language;onClose:()=>void;onSaved:()=>void}){
  const profile=item.profile;
  const [hours,setHours]=useState(profile?.workingHours??[]),[off,setOff]=useState(profile?.timeOff??[]);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    const form=new FormData(event.currentTarget);
    try{
      const next:TechnicianProfile={timezone:String(form.get('timezone')),skills:skills(form.get('skills')),workingHours:hours,timeOff:off,base:readSite(form)};
      await relayRequest('/technicians/'+encodeURIComponent(item.personId)+'/planning',{method:'POST',key:commandKey(),body:{expectedVersion:item.version,profile:next}});
      onSaved();
    }catch(error){setError(error instanceof Error?error.message:errorLabel(language,error));}
    finally{setBusy(false);}
  }
  return <form className="relay-dispatch-form" onSubmit={event=>void submit(event)}>
    <h3>{item.displayName}</h3>
    {error&&<p role="alert" className="relay-error">{error}</p>}
    <fieldset disabled={busy}>
      <label>Timezone<input required name="timezone" defaultValue={profile?.timezone??'America/Vancouver'} maxLength={80}/></label>
      <label>Skills, separated by commas<input name="skills" defaultValue={profile?.skills.join(', ')??''} maxLength={1800} placeholder="refrigeration, electrical"/></label>
      <h4>Working hours</h4><p>Use 24:00 for midnight. Split an overnight shift into two days.</p>
      {hours.map((row,index)=><div className="relay-dispatch-fields" key={index}>
        <label>Day<select value={row.weekday} onChange={event=>setHours(hours.map((value,i)=>i===index?{...value,weekday:Number(event.target.value)}:value))}>{days.map((day,i)=><option value={i+1} key={day}>{day}</option>)}</select></label>
        <label>Start<input required type="time" value={row.start} onChange={event=>setHours(hours.map((value,i)=>i===index?{...value,start:event.target.value}:value))}/></label>
        <label>End<input required pattern="([01][0-9]|2[0-3]):[0-5][0-9]|24:00" value={row.end} onChange={event=>setHours(hours.map((value,i)=>i===index?{...value,end:event.target.value}:value))}/></label>
        <button type="button" aria-label={'Remove working period '+(index+1)} onClick={()=>setHours(hours.filter((_,i)=>i!==index))}>Remove</button>
      </div>)}
      <button type="button" onClick={()=>setHours([...hours,{weekday:1,start:'08:00',end:'17:00'}])} disabled={hours.length>=28}>Add working period</button>
      <h4>Time off</h4><p>Dates use your browser’s local timezone.</p>
      {off.map((row,index)=><div className="relay-dispatch-fields" key={index}>
        <label>From<input required type="datetime-local" step="any" value={localDateInput(row.start)} onChange={event=>{if(event.target.value)setOff(off.map((value,i)=>i===index?{...value,start:reviewedTimestamp(event.target.value,row.start)}:value));}}/></label>
        <label>Until<input required type="datetime-local" step="any" value={localDateInput(row.end)} onChange={event=>{if(event.target.value)setOff(off.map((value,i)=>i===index?{...value,end:reviewedTimestamp(event.target.value,row.end)}:value));}}/></label>
        <button type="button" aria-label={'Remove time off '+(index+1)} onClick={()=>setOff(off.filter((_,i)=>i!==index))}>Remove</button>
      </div>)}
      <button type="button" disabled={off.length>=100} onClick={()=>setOff([...off,{start:new Date().toISOString(),end:new Date(Date.now()+3600000).toISOString()}])}>Add time off</button>
      <h4>Starting and return location</h4><p>Travel starts here when there is no earlier job that day and returns here after the last job.</p>
      <SiteFields site={profile?.base}/>
    </fieldset>
    <div className="relay-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="relay-primary" disabled={busy} type="submit">{busy?'Saving…':'Save availability'}</button></div>
  </form>;
}

export function JobDispatchPlanning({job,language,onChanged,onAssigned,onBusyChange,detailsOnly=false,editable=true}:{detailsOnly?:boolean;editable?:boolean;job:Job;language:Language;onChanged:()=>void;onAssigned?:()=>void;onBusyChange?:(busy:boolean)=>void}){
  const native=import.meta.env.VITE_RELAY_PLANNING_DEMO==='true'&&window.location.origin==='http://127.0.0.1:3004';
  const frame=useRef<HTMLIFrameElement|null>(null);
  const [deadlineMode,setDeadlineMode]=useState(job.serviceWindow?job.serviceWindow.completeBy?'date':'none':'unknown');
  const [editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [matches,setMatches]=useState<TechnicianMatches|null>(null);
  useEffect(()=>{onBusyChange?.(busy);return ()=>onBusyChange?.(false);},[busy,onBusyChange]);
  const request=useRef<AbortController|null>(null);
  useEffect(()=>{
    setMatches(null);
    if(!detailsOnly&&!native&&!['completed','cancelled'].includes(job.status))void find();
    return ()=>request.current?.abort();
  },[job.id,job.version,language]);
  useEffect(()=>{
    if(detailsOnly||!native)return;
    frame.current?.contentWindow?.postMessage({type:'relay-assignment-refresh',jobId:job.id},'http://127.0.0.1:3005');
  },[job.version,native,detailsOnly]);
  useEffect(()=>{
    if(detailsOnly||!native)return;
    const receive=(event:MessageEvent)=>{
      if(event.origin!=='http://127.0.0.1:3005'||event.source!==frame.current?.contentWindow||event.data?.jobId!==job.id)return;
      if(event.data.type==='relay-assignment-busy')setBusy(event.data.busy===true);
      if(event.data.type==='relay-assignment-applied'){setNotice('Assignment and time saved to job history.');onChanged();}
    };
    window.addEventListener('message',receive);
    return ()=>window.removeEventListener('message',receive);
  },[native,job.id,onChanged,detailsOnly]);
  async function find(){
    request.current?.abort();
    const controller=new AbortController();request.current=controller;
    setBusy(true);setError('');
    try{
      const result=await relayRequest<TechnicianMatches>('/jobs/'+encodeURIComponent(job.id)+'/technicians',{signal:controller.signal});
      if(!controller.signal.aborted)setMatches(result);
    }catch(error){if(!controller.signal.aborted)setError(errorLabel(language,error));}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    const form=new FormData(event.currentTarget);
    try{
      await relayRequest('/jobs/'+encodeURIComponent(job.id)+'/actions',{method:'POST',key:commandKey(),
        body:{action:'dispatch_details',expectedVersion:job.version,site:readSite(form),estimatedMinutes:Number(form.get('estimatedMinutes')),requiredSkills:skills(form.get('skills')),
          priority:String(form.get('priority')),
          ...(deadlineMode==='unknown'?{}:{serviceWindow:{
            earliestStart:String(form.get('earliestStart')??'')?reviewedTimestamp(String(form.get('earliestStart')),job.serviceWindow?.earliestStart??undefined):null,
            completeBy:deadlineMode==='date'?reviewedTimestamp(String(form.get('completeBy')),job.serviceWindow?.completeBy??undefined):null,
          }})}});
      setEditing(false);setNotice('Dispatch details saved.');onChanged();
    }catch(error){setError(error instanceof Error?error.message:errorLabel(language,error));}
    finally{setBusy(false);}
  }
  async function assign(personId:string){
    if(busy||!matches)return;setBusy(true);setError('');
    try{
      await relayRequest<JobDetail>('/jobs/'+encodeURIComponent(job.id)+'/actions',{method:'POST',key:commandKey(),
        body:{action:'assign',assigneeId:personId,expectedVersion:matches.jobVersion,checkAvailability:true}});
      setMatches(null);setNotice('Assignment saved to job history.');if(onAssigned)onAssigned();else onChanged();
    }catch(error){setMatches(null);setError(error instanceof Error?error.message:errorLabel(language,error));}
    finally{setBusy(false);}
  }
  const [clock,setClock]=useState(()=>Date.now());
  useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),60000);return ()=>window.clearInterval(timer);},[]);
  const deadline=clientDeadlineStatus(job,clock);
  const closed=['completed','cancelled'].includes(job.status);
  return <section className="relay-card" aria-label={detailsOnly?"Job requirements":"Dispatch planning"}>
    <div className="relay-section-heading"><h2>{detailsOnly?"Job requirements":"Who can take this job?"}</h2><div className="relay-actions">
      {detailsOnly&&editable&&<button type="button" disabled={busy||closed} aria-expanded={editing} onClick={()=>{setDeadlineMode(job.serviceWindow?job.serviceWindow.completeBy?'date':'none':'unknown');setEditing(!editing);}}>Edit dispatch details</button>}
      {!detailsOnly&&!native&&<button type="button" disabled={busy||closed} onClick={()=>void find()}>{busy?'Checking availability…':'Check technicians again'}</button>}
    </div></div>
    {(detailsOnly||!native)&&<dl className="relay-facts relay-job-requirements">
      <div className={'relay-job-priority relay-job-priority-'+job.priority}><dt>Priority</dt><dd><strong>{{urgent:'Emergency',high:'Urgent',normal:'Routine',low:'Can wait'}[job.priority]??job.priority}</strong></dd></div>
      <div className={'relay-client-deadline relay-client-deadline-'+deadline.tone}><dt>Client needs it finished</dt><dd><strong className="relay-deadline-status">{deadline.tone==='danger'?'⚠ ':deadline.tone==='warning'?'◷ ':''}{deadline.label}</strong>{job.serviceWindow?.completeBy&&<span className="relay-deadline-date">{job.clientTiming?.completeByLabel??<DateTime value={job.serviceWindow.completeBy} language={language}/>}</span>}{deadline.detail&&<small>{deadline.detail}</small>}</dd></div>
      {job.serviceWindow?.earliestStart&&<div><dt>Client can start from</dt><dd>{job.clientTiming?.earliestStartLabel??<DateTime value={job.serviceWindow.earliestStart} language={language}/>}</dd></div>}
      <div><dt>Job location</dt><dd>{job.site?.label??'Not recorded'}</dd></div>
      <div><dt>Estimated visit</dt><dd>{job.estimatedMinutes?job.estimatedMinutes+' minutes':'Not recorded'}</dd></div>
      <div><dt>Required skills</dt><dd>{job.requiredSkills===undefined?'Not recorded':job.requiredSkills.join(', ')||'No special skills required'}</dd></div>
    </dl>}
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert" className="relay-error">{error}</p>}
    {editing&&<form className="relay-dispatch-form" onSubmit={event=>void save(event)}>
      <fieldset disabled={busy}>
        <label>Priority<select name="priority" defaultValue={job.priority}>
          <option value="urgent">Emergency — as soon as possible</option><option value="high">Urgent</option>
          <option value="normal">Routine</option><option value="low">Can wait</option>
        </select></label>
        <label>When does the client need the work finished?<select value={deadlineMode} onChange={event=>setDeadlineMode(event.target.value)}>
          {!job.serviceWindow&&<option value="unknown">Not known yet</option>}<option value="date">By a specific date and time</option><option value="none">No fixed deadline</option>
        </select></label>
        {deadlineMode==='date'&&<label>Client completion deadline<input required type="datetime-local" step="any" name="completeBy" defaultValue={localDateInput(job.serviceWindow?.completeBy??undefined)}/></label>}
        <label>Client cannot start before (optional)<input type="datetime-local" step="any" name="earliestStart" defaultValue={localDateInput(job.serviceWindow?.earliestStart??undefined)}/></label>
        <label>Required skills, separated by commas<input name="skills" defaultValue={job.requiredSkills?.join(', ')??''} maxLength={1800}/></label>
        <label>Estimated visit in minutes<input type="number" name="estimatedMinutes" required min={1} max={1440} defaultValue={job.estimatedMinutes}/></label>
        <SiteFields site={job.site}/>
      </fieldset>
      <button type="submit" className="relay-primary" disabled={busy}>Save dispatch details</button>
    </form>}
    {!detailsOnly&&native&&<iframe ref={frame} title="Assignment assistant" src={'http://127.0.0.1:3005/assignment-entry.html?jobId='+encodeURIComponent(job.id)}
      className="relay-assignment-assistant"/>}
    {!detailsOnly&&!native&&matches&&<><p>Checked <DateTime value={matches.checkedAt} language={language}/>. Driving estimates exclude live traffic and include a separate 10-minute buffer for each leg. Starting location comes from the previous job or base.</p>
      {matches.candidates.length===0&&<p>No active technicians in this branch.</p>}
      <ul className="relay-dispatch-candidates">{matches.candidates.map(person=><li className="relay-card" key={person.personId}>
        <h3>{person.displayName}</h3><strong>{person.status==='available'?'Fits this visit':person.status==='blocked'?'Does not fit this visit':'Needs checking'}</strong>
        <ul>{person.reasons.map((reason,i)=><li key={i}>{reason}</li>)}</ul>
        {person.travel.map(leg=><p key={leg.direction}>Estimated drive · {leg.from} → {leg.to} · {leg.minutes===null?'Unavailable':leg.minutes+' min'}{leg.minutes!==null?' + 10 min buffer':''}</p>)}
        {person.personId===job.assigneeId?<p>Currently assigned</p>:<button type="button" className="relay-primary" disabled={busy||person.status!=='available'||closed}
          onClick={()=>void assign(person.personId)}>Approve assignment to {person.displayName}</button>}
      </li>)}</ul>
    </>}
  </section>;
}

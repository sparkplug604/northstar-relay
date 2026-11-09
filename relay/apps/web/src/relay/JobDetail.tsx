import {JobDispatchPlanning} from './DispatchPlanning.js';
import {lazy,Suspense,useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {canDispatch,commandKey,RelayApiError,relayRequest,type Person,type Session} from './api.js';
import {dateLabel,errorLabel,tr,type Language} from './i18n.js';
import {localDateInput,reviewedTimestamp} from './dateInput.js';
import {jt,jobEventLabel,jobErrorLabel} from './jobsI18n.js';
import {acknowledgementUnresolved,canActOnJobMilestone,eligibleJobPeople,jobActions,milestoneOverdue,type JobAction,type JobDetail as JobDetailData,type JobMilestone} from './jobsModel.js';
import {JobStatusBadge} from './Jobs.js';
import {JobHistory} from './JobHistory.js';
import {AcknowledgementPanel} from './AcknowledgementPanel.js';
import {DateTime,TimezoneNotice} from './DateTime.js';
import {beginPendingNavigation,safeReturnTo,type RelayNavigate} from './navigation.js';
import './workOrder.css';
import './jobs.css';

const JobSiteMap=lazy(()=>import('./JobPlanning.js').then(module=>({default:module.JobsMap})));

export function JobDetail({id,session,language,navigate,returnTo='/relay/jobs',initialAction,initialMilestoneId}:{id:string;session:Session;language:Language;navigate:RelayNavigate;returnTo?:string;initialAction?:string;initialMilestoneId?:string}){
  const [detail,setDetail]=useState<JobDetailData|null>(null),[people,setPeople]=useState<Person[]>([]),[peopleError,setPeopleError]=useState(false);
  const [error,setError]=useState(''),[actionError,setActionError]=useState(''),[stale,setStale]=useState(false),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[notice,setNotice]=useState(false);
  const [action,setAction]=useState<JobAction|null>(null),[selectedMilestone,setSelectedMilestone]=useState<JobMilestone|null>(null);
  const dialog=useRef<HTMLDialogElement|null>(null),opener=useRef<HTMLElement|null>(null),backButton=useRef<HTMLButtonElement|null>(null),submitting=useRef(false),key=useRef(commandKey()),version=useRef(0),request=useRef<AbortController|null>(null);
  const initialHandled=useRef(false);
  const t=(word:Parameters<typeof tr>[1])=>tr(language,word),j=(word:Parameters<typeof jt>[1])=>jt(language,word);
  const refresh=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);
    try{const value=await relayRequest<JobDetailData>(`/jobs/${encodeURIComponent(id)}`,{signal:controller.signal});if(!controller.signal.aborted){setDetail(value);version.current=value.job.version;key.current=commandKey();setStale(false);setError('');}}
    catch(failure){if(!controller.signal.aborted)setError(errorLabel(language,failure));}
    finally{if(!controller.signal.aborted)setLoading(false);}
  },[id,language]);
  const loadPeople=useCallback(async()=>{
    try{const value=await relayRequest<{items:Person[]}>('/people');setPeople(value.items);setPeopleError(false);}
    catch{setPeopleError(true);}
  },[session.organization.id,session.user.id]);
  useEffect(()=>{void refresh();return()=>request.current?.abort();},[refresh]);
  useEffect(()=>{void loadPeople();},[loadPeople]);
  useEffect(()=>{const updated=(event:Event)=>{if((event as CustomEvent<{jobId:string}>).detail?.jobId===id)void refresh();};window.addEventListener('relay-job-updated',updated);return ()=>window.removeEventListener('relay-job-updated',updated);},[id,refresh]);
  useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!submitting.current&&!action)void refresh();},30000);return()=>clearInterval(timer);},[refresh,action]);
  useEffect(()=>{
    if(action&&dialog.current&&!dialog.current.open)dialog.current.showModal();
    if(!action&&dialog.current?.open){dialog.current.close();(opener.current?.isConnected?opener.current:backButton.current)?.focus();}
  },[action]);
  const job=detail?.job,allowed=job?jobActions(job,session,detail?.milestones):[],eligible=job?eligibleJobPeople(people,job.branchId):[],ackPending=detail?acknowledgementUnresolved(detail.acknowledgement):false;
  const personName=(personId:string|null)=>personId?people.find(person=>person.id===personId)?.displayName??(personId===session.user.id?session.user.displayName:personId):j('unassigned');
  useEffect(()=>{
    if(!detail||initialHandled.current||!initialAction)return;initialHandled.current=true;
    const milestone=detail.milestones.find(item=>item.id===initialMilestoneId);
    if(initialAction==='assign'&&allowed.includes('assign'))choose('assign');
    else if(milestone&&['complete_milestone','reschedule_milestone','cancel_milestone'].includes(initialAction)&&canActOnJobMilestone(detail.job,session,milestone))choose(initialAction as JobAction,milestone);
    else setError(t('actionUnavailable'));
  },[detail,initialAction,initialMilestoneId]);
  function choose(value:JobAction,milestone:JobMilestone|null=null){
    if(!job||submitting.current)return;
    opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    key.current=commandKey();version.current=job.version;setActionError('');setStale(false);setNotice(false);setSelectedMilestone(milestone);setAction(value);
  }
  function dismiss(){if(!submitting.current&&!busy)setAction(null);}
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!action||!job||submitting.current||stale||!allowed.includes(action)||(ackPending&&['confirm_completion','cancel'].includes(action))||(selectedMilestone&&!detail?.milestones.some(item=>item.id===selectedMilestone.id&&canActOnJobMilestone(job,session,item))))return;
    submitting.current=true;setBusy(true);setActionError('');const finish=beginPendingNavigation();
    const form=new FormData(event.currentTarget);
    try{
      const fields:Record<string,unknown>={action,expectedVersion:version.current};
      for(const name of ['note','title','ownerId','assigneeId'])if(form.has(name))fields[name]=String(form.get(name)).trim();
      if(form.has('scheduledAt'))fields.scheduledAt=reviewedTimestamp(String(form.get('scheduledAt')),job.scheduledAt??undefined);
      if(form.has('dueAt'))fields.dueAt=reviewedTimestamp(String(form.get('dueAt')),selectedMilestone?.dueAt);
      if(selectedMilestone)fields.milestoneId=selectedMilestone.id;
      const result=await relayRequest<JobDetailData>(`/jobs/${encodeURIComponent(id)}/actions`,{method:'POST',key:key.current,body:fields});
      setDetail(result);version.current=result.job.version;setAction(null);setNotice(true);setError('');
    }catch(failure){
      if(failure instanceof RelayApiError&&['job_version_conflict','idempotency_conflict'].includes(failure.code)){setStale(true);setActionError(j('stale'));}
      else setActionError(jobErrorLabel(language,failure));
    }finally{finish();submitting.current=false;setBusy(false);}
  }
  const actionAvailable=action!==null&&allowed.includes(action)&&!(ackPending&&['confirm_completion','cancel'].includes(action))&&(!selectedMilestone||(job&&detail?.milestones.some(milestone=>milestone.id===selectedMilestone.id&&canActOnJobMilestone(job,session,milestone))));
  const dispatcher=canDispatch(session);
  const workActions=allowed.filter(value=>['resume','start','report_completion','block'].includes(value));
  const primary=dispatcher?allowed.find(value=>value==='confirm_completion'):workActions.find(value=>value!=='block');
  const secondary=allowed.filter(value=>['schedule','add_update'].includes(value)||(!dispatcher&&value==='block'));
  const [customer,work]=job?.customerReference.split(/\s+—\s+(.+)/)??[];
  const description=job?.description?.trim();
  const hasDescription=description&&description!=='Synthetic intake demonstration only';
  const attention=job?.attentionReasons?.filter(reason=>!['acknowledgement_unowned','acknowledgement_overdue','unassigned','blocked'].includes(reason))??[];
  const acknowledgement=detail?.acknowledgement;
  const needsPerson=action==='assign'||action==='add_milestone';
  const requiresNote=action!==null&&!['assign','unassign','add_milestone'].includes(action);
  const hasNote=action!==null&&!['assign','unassign','add_milestone'].includes(action);
  const timeInput=action==='schedule'?'scheduledAt':action==='add_milestone'||action==='reschedule_milestone'?'dueAt':null;
  const actionLabel=(value:JobAction)=>j(value==='assign'?(job?.assigneeId?'changeAssignment':'assignSomeone'):value==='reopen'&&job?.status==='completion_reported'?'returnCorrection':value);
  const actionForm=job&&action&&<form key={`${action}-${selectedMilestone?.id??''}`} aria-busy={busy} onSubmit={event=>void submit(event)} onChange={()=>{if(!submitting.current)key.current=commandKey();}}>
          {actionError&&<p className="relay-error" role="alert">{actionError}</p>}{!actionAvailable&&<p className="relay-warning" role="alert">{t('actionUnavailable')}</p>}
          {stale&&<button type="button" disabled={loading} onClick={()=>void refresh()}>{t(loading?'loading':'refresh')}</button>}
          {action==='unassign'&&<p>{j('unassignHelp')}</p>}{action==='report_completion'&&<p>{j('completionHelp')}</p>}{action==='confirm_completion'&&<p>{j('confirmHelp')}</p>}{action==='cancel'&&<p>{j('cancelHelp')}</p>}{action==='reopen'&&<p>{j('reopenHelp')}</p>}
          {needsPerson&&<>{peopleError&&<p className="relay-error" role="alert">{j('peopleError')} <button type="button" onClick={()=>void loadPeople()}>{t('retry')}</button></p>}<label>{j('assigned')}<select name={action==='assign'?'assigneeId':'ownerId'} required disabled={busy||peopleError} defaultValue={eligible.some(person=>person.id===job.assigneeId)?job.assigneeId??'':''}><option value="" disabled>{t('choosePerson')}</option>{eligible.map(person=><option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label>{!peopleError&&eligible.length===0&&<p className="relay-warning">{j('noPeople')}</p>}</>}
          {action==='add_milestone'&&<label>{j('title')}<input autoFocus required disabled={busy} name="title" minLength={3} maxLength={200}/></label>}
          {timeInput&&<label>{timeInput==='scheduledAt'?j('scheduledAt'):t('deadline')}<input type="datetime-local" step="any" required disabled={busy} name={timeInput} defaultValue={localDateInput((timeInput==='scheduledAt'?job.scheduledAt:selectedMilestone?.dueAt)??undefined)}/><small>{t('localTimeHelp')} {Intl.DateTimeFormat().resolvedOptions().timeZone}</small></label>}
          {hasNote&&<label>{j(requiresNote?'note':'optionalNote')}<textarea autoFocus={!needsPerson&&!timeInput} required={requiresNote} disabled={busy} name="note" rows={4} minLength={requiresNote?3:undefined} maxLength={4000}/></label>}
          <div className="relay-actions relay-work-dialog-actions"><button type="button" disabled={busy} onClick={dismiss}>{t('cancel')}</button><button type="submit" className={action==='cancel'?'relay-danger':'relay-primary'} disabled={busy||loading||stale||!actionAvailable||(needsPerson&&(peopleError||eligible.length===0))}>{t(busy?'saving':'confirm')}</button></div>
        </form>;
  return <div className="relay-work-order relay-job-detail">
    <button ref={backButton} className="relay-text-button" type="button" onClick={()=>navigate(safeReturnTo(returnTo),{restoreScroll:true})}>← {j(returnTo.startsWith('/relay/commitments')?'commitments':returnTo.startsWith('/relay/intake')?'inbox':'back')}</button>
    {error&&<p className="relay-error" role="alert">{error} <button type="button" onClick={()=>void refresh()}>{t('retry')}</button></p>}
    {notice&&<p className="relay-notice" role="status">{t('changeSaved')}</p>}
    {!detail||!job?!error&&<p role="status">{t('loading')}</p>:<>
      <header className="relay-job-detail-heading">
        <div><h1>{customer||job.externalId}</h1>{work&&<p><strong>{work}</strong></p>}
          {hasDescription?<p className="relay-note">{description}</p>:!work&&<p>{j('noWorkDetails')}</p>}
        </div>
        <div className="relay-job-detail-tools"><small>Ref. {job.externalId}</small><button type="button" disabled={busy||loading} onClick={()=>void refresh()}>{t(loading?'loading':'refresh')}</button></div>
      </header>
      {job.status==='blocked'&&<p className="relay-warning relay-note"><strong>{j('blocked')}: </strong>{job.blocker}{dispatcher&&import.meta.env.VITE_RELAY_PLANNING_DEMO==='true'&&<button type="button" onClick={()=>window.dispatchEvent(new CustomEvent('relay-resolve-blocker',{detail:{jobId:job.id}}))}>Resolve with Relay</button>}</p>}
      <JobDispatchPlanning detailsOnly editable={dispatcher} job={job} language={language} onChanged={()=>void refresh()}/>
      <section className="relay-card" aria-label={j('status')}>
        <div className="relay-section-heading"><div><JobStatusBadge job={job} language={language}/><p>{j('assigned')}: <strong>{personName(job.assigneeId)}</strong></p><p>{j('scheduledAt')}{' · '}{job.scheduledAt?<DateTime value={job.scheduledAt} language={language}/>:j('noSchedule')}</p></div>
          {allowed.includes('assign')&&(job.assigneeId?<details className="relay-job-detail-menu"><summary>{j('manageAssignment')}</summary><div className="relay-actions">
            <button type="button" disabled={busy} onClick={()=>choose('assign')}>{j('changeAssignment')}</button>
            {allowed.includes('unassign')&&<button type="button" disabled={busy} onClick={()=>choose('unassign')}>{j('unassign')}</button>}
          </div></details>:<button type="button" className="relay-primary" disabled={busy} onClick={()=>choose('assign')}>{j('assignSomeone')}</button>)}
        </div>
        <div className="relay-actions">
          {primary&&<button type="button" className="relay-primary" disabled={busy||(primary==='confirm_completion'&&ackPending)} onClick={()=>choose(primary)}>{actionLabel(primary)}</button>}
          {secondary.map(value=><button key={value} type="button" disabled={busy} onClick={()=>choose(value)}>{actionLabel(value)}</button>)}
          {(dispatcher&&workActions.length>0||allowed.includes('reopen'))&&<details className="relay-job-detail-menu"><summary>{j('moreJobActions')}</summary><div className="relay-actions">
            {[...(dispatcher?workActions:[]),...allowed.filter(value=>value==='reopen')].map(value=><button key={value} type="button" disabled={busy} onClick={()=>choose(value)}>{actionLabel(value)}</button>)}
          </div></details>}
        </div>
      </section>
      {ackPending&&acknowledgement&&<div className="relay-warning">
        <strong>{j('acceptancePending')}{acknowledgement.status==='breached'?' · '+j('overdue'):''}</strong>
        <p>{j('acceptBy')}{' · '}<DateTime value={acknowledgement.dueAt} language={language}/></p>
        <a href="#relay-acknowledgement" onClick={()=>{const panel=document.getElementById('relay-acknowledgement')?.closest('details');if(panel)panel.open=true;}}>{j('viewWorkOrderAck')}</a>
      </div>}
      {attention.length>0&&<ul className="relay-attention-reasons">{attention.map(reason=><li key={reason}>{jobEventLabel(language,reason)}</li>)}</ul>}
      {job.status==='in_progress'&&job.openMilestoneCount>0&&<p className="relay-muted">{j('resolveFirst')}</p>}
      <section className="relay-card"><div className="relay-section-heading"><h2>{j('commitments')}</h2>{allowed.includes('add_milestone')&&<button type="button" onClick={()=>choose('add_milestone')}>{j('add_milestone')}</button>}</div><p className="relay-muted">{j('inApp')}</p>
        {detail.milestones.length===0?<p className="relay-muted">{j('noCommitments')}</p>:<ul className="relay-job-milestones">{detail.milestones.map(milestone=><li key={milestone.id}><div><strong>{milestone.title}</strong><small>{personName(milestone.ownerId)} · <DateTime value={milestone.dueAt} language={language}/></small><span className={milestoneOverdue(milestone,detail.asOf)?'relay-status relay-status-breached':'relay-status'}>{milestoneOverdue(milestone,detail.asOf)?j('overdue'):j(milestone.status)}</span>{milestone.completedAt&&<small>{j('completed')}: <DateTime value={milestone.completedAt} language={language}/> · {personName(milestone.completedBy)}</small>}</div>{canActOnJobMilestone(job,session,milestone)&&<div className="relay-actions">{(['complete_milestone','reschedule_milestone','cancel_milestone']as const).filter(value=>allowed.includes(value)).map(value=><button key={value} type="button" aria-label={`${j(value)}: ${milestone.title}`} onClick={()=>choose(value,milestone)}>{j(value)}</button>)}</div>}</li>)}</ul>}
      </section>
      {import.meta.env.VITE_RELAY_PLANNING_DEMO==='true'&&job.site&&<section className="relay-card">
        <h2>{language==='fr'?'Lieu du travail':'Job location'}</h2>
        <Suspense fallback={<p role="status">{t('loading')}</p>}>
          <JobSiteMap jobs={[job]} language={language} name={personName} compact open={()=>backButton.current?.scrollIntoView({block:'start',behavior:'smooth'})}/>
        </Suspense>
      </section>}
      <details className="relay-card relay-job-support"><summary>Work order acceptance details</summary><AcknowledgementPanel detail={detail} session={session} language={language} navigate={navigate} onChanged={()=>void refresh()}/></details>
      {(job.completionReportedAt||job.completedAt)&&<section className="relay-card relay-job-completion"><h2>{j('completion')}</h2>{job.completionReportedAt&&<><p><strong>{j('reportedAt')}</strong><small>{personName(job.completionReportedBy)} · <DateTime value={job.completionReportedAt} language={language}/></small></p><p className="relay-note">{job.completionNote}</p></>}{job.completedAt?<p className="relay-notice"><strong>{j('confirmedAt')}</strong><small>{personName(job.completedBy)} · <DateTime value={job.completedAt} language={language}/></small></p>:<p className="relay-muted">{j(job.status==='completion_reported'?'pendingConfirmation':'notCompleted')}</p>}</section>}
      <details className="relay-card relay-job-record"><summary>Job record</summary><dl className="relay-facts"><div><dt>{t('branch')}</dt><dd>{session.branches.find(branch=>branch.id===job.branchId)?.name??job.branchId}</dd></div><div><dt>{j('created')}</dt><dd><DateTime value={job.createdAt} language={language}/></dd></div></dl><TimezoneNotice language={language}/></details>
      <details className="relay-job-support"><summary>Job history</summary><JobHistory events={detail.events} language={language} personName={personName}/></details>
      {allowed.includes('cancel')&&<div className="relay-work-administration"><button type="button" className="relay-danger" disabled={ackPending} onClick={()=>choose('cancel')}>{j('cancel')}</button></div>}
      <small>{j('shownAt')}: <DateTime value={detail.asOf} language={language}/></small>
      <dialog ref={dialog} className={action==='assign'?'relay-work-dialog relay-assignment-dialog':'relay-work-dialog'} aria-labelledby="relay-job-action-title"  onCancel={event=>{event.preventDefault();dismiss();}} onClose={dismiss}>
        {action&&<><h2 id="relay-job-action-title">{actionLabel(action)}</h2>{selectedMilestone&&<p>{selectedMilestone.title}</p>}{action==='assign'?<>
          <JobDispatchPlanning job={job} language={language} onChanged={()=>void refresh()} onBusyChange={setBusy}
            onAssigned={()=>{setAction(null);setNotice(true);void refresh();}}/>
          <details className="relay-manual-assignment"><summary>{language==='fr'?'Choisir une personne manuellement':'Choose a person manually'}</summary>
            {actionForm}
          </details>
          <button type="button" disabled={busy} onClick={dismiss}>{language==='fr'?'Fermer':'Close'}</button>
        </>:actionForm}</>}
      </dialog>
    </>}
  </div>;
}

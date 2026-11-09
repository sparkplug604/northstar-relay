import {useEffect,useRef,useState,type FormEvent} from 'react';
import {canDispatch,commandKey,relayRequest,type Person,type Session,type Settings} from './api.js';
import {tr,type Language} from './i18n.js';
import {jt,jobErrorLabel} from './jobsI18n.js';
import type {JobDetail} from './jobsModel.js';
import {WorkOrder} from './WorkOrder.js';
import {beginPendingNavigation,type RelayNavigate} from './navigation.js';

export function AcknowledgementPanel({detail,session,language,navigate,onChanged}:{detail:JobDetail;session:Session;language:Language;navigate:RelayNavigate;onChanged():void}){
  const [open,setOpen]=useState(false),[settings,setSettings]=useState<Settings|null>(null),[people,setPeople]=useState<Person[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[dueAt,setDueAt]=useState('');
  const submitting=useRef(false),key=useRef(commandKey()),version=useRef(detail.job.version);
  const t=(word:Parameters<typeof tr>[1])=>tr(language,word),j=(word:Parameters<typeof jt>[1])=>jt(language,word);
  async function load(){setLoading(true);setError('');try{const [configuration,contacts,current]=await Promise.all([relayRequest<Settings>(`/settings?branchId=${encodeURIComponent(detail.job.branchId)}`),relayRequest<{items:Person[]}>('/people'),relayRequest<JobDetail>(`/jobs/${encodeURIComponent(detail.job.id)}`)]);setSettings(configuration);setPeople(contacts.items);version.current=current.job.version;key.current=commandKey();if(current.acknowledgement){setOpen(false);onChanged();}}catch(failure){setError(jobErrorLabel(language,failure));}finally{setLoading(false);}}
  useEffect(()=>{if(open)void load();},[open]);
  async function submit(event:FormEvent){
    event.preventDefault();if(submitting.current)return;submitting.current=true;setBusy(true);setError('');const finish=beginPendingNavigation();
    try{const date=new Date(dueAt);if(!Number.isFinite(date.getTime()))throw new Error('invalid_date');await relayRequest<JobDetail>(`/jobs/${encodeURIComponent(detail.job.id)}/acknowledgement`,{method:'POST',key:key.current,body:{expectedVersion:version.current,dueAt:date.toISOString()}});setOpen(false);onChanged();}
    catch(failure){setError(jobErrorLabel(language,failure));}
    finally{finish();submitting.current=false;setBusy(false);}
  }
  const configured=!!settings?.recipientIds.length&&settings.recipientIds.every(id=>people.some(person=>person.id===id&&person.active===true&&person.phoneVerified&&person.phone));
  return <section className="relay-ack-workspace" id="relay-acknowledgement" aria-label={j('showAck')}>
    {detail.acknowledgement?<WorkOrder key={detail.acknowledgement.workOrderId} id={detail.acknowledgement.workOrderId} session={session} language={language} embedded onBack={()=>{}} onChanged={onChanged} onSource={commitment=>navigate(`/relay/intake?${new URLSearchParams({status:'all',branchId:commitment.branchId,search:commitment.workOrder.externalId})}`)}/>:<section className="relay-card"><div className="relay-section-heading"><h2>{j('noAck')}</h2>{canDispatch(session)&&!['completed','cancelled','completion_reported'].includes(detail.job.status)&&<button type="button" disabled={busy} onClick={()=>setOpen(!open)}>{open?t('cancel'):j('startAck')}</button>}</div><p className="relay-muted">{j('jobOnlyHelp')}</p>
      {open&&<form onSubmit={event=>void submit(event)} aria-busy={busy}><p>{j('startAckHelp')}</p>{loading?<p role="status">{t('loading')}</p>:<><p className={configured?'relay-notice':'relay-warning'}>{j(configured?'ackReady':'ackNotReady')}</p>{settings&&<small>{j('fallbackContacts')}: {settings.recipientIds.map(id=>people.find(person=>person.id===id)?.displayName??id).join(' → ')||t('noContacts')}</small>}</>}
        {error&&<p className="relay-error" role="alert">{error} <button type="button" disabled={busy||loading} onClick={()=>void load()}>{t('refresh')}</button></p>}
        <label>{t('dueAt')}<input type="datetime-local" step="any" required name="dueAt" disabled={busy} value={dueAt} onChange={event=>{setDueAt(event.target.value);key.current=commandKey();}}/><small>{t('localTimeHelp')} {Intl.DateTimeFormat().resolvedOptions().timeZone}</small></label>
        <div className="relay-actions"><button className="relay-primary" type="submit" disabled={busy||loading||!settings}>{busy?t('saving'):j('startAck')}</button><button type="button" disabled={busy} onClick={()=>navigate('/relay/on-call')}>{j('reviewConfiguration')}</button></div>
      </form>}
    </section>}
  </section>;
}

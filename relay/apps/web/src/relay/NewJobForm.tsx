import {useState,type FormEvent} from 'react';
import {commandKey,relayRequest,type Session} from './api.js';
import {errorLabel,tr,type Language} from './i18n.js';
import {jt} from './jobsI18n.js';
import type {JobDetail} from './jobsModel.js';
import {reviewedTimestamp} from './dateInput.js';
import {beginPendingNavigation} from './navigation.js';
interface Draft {externalId:string;customerReference:string;branchId:string;priority:string;description:string;key:string;deadlineMode:'unknown'|'none'|'date';earliestStart:string;completeBy:string}
const drafts=new Map<string,Draft>();
export function clearJobDrafts():void{drafts.clear();}
export function NewJobForm({session,language,onCreated,onClose,onPending}:{session:Session;language:Language;onCreated(id:string):void;onClose():void;onPending(value:boolean):void}){
  const scope=`${session.organization.id}:${session.user.id}`;
  const fresh=():Draft=>({externalId:'',customerReference:'',branchId:session.user.branchId||session.branches[0]?.id||'',priority:'normal',description:'',deadlineMode:'unknown',earliestStart:'',completeBy:'',key:commandKey()});
  const [draft,setDraft]=useState<Draft>(()=>({...fresh(),...drafts.get(scope)})),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const t=(key:Parameters<typeof tr>[1])=>tr(language,key),j=(key:Parameters<typeof jt>[1])=>jt(language,key);
  function update(patch:Partial<Draft>){const value={...draft,...patch,key:commandKey()};setDraft(value);drafts.set(scope,value);}
  async function submit(event:FormEvent){
    event.preventDefault();if(busy)return;setBusy(true);onPending(true);setError('');drafts.set(scope,draft);const finish=beginPendingNavigation();
    try{const {key,deadlineMode,earliestStart,completeBy,...fields}=draft;
      const body={...fields,...(deadlineMode==='unknown'?{}:{serviceWindow:{
        earliestStart:earliestStart?reviewedTimestamp(earliestStart,undefined):null,
        completeBy:deadlineMode==='date'?reviewedTimestamp(completeBy,undefined):null,
      }})};const result=await relayRequest<JobDetail>('/jobs',{method:'POST',key,body});drafts.delete(scope);finish();onPending(false);onCreated(result.job.id);}
    catch(failure){setError(errorLabel(language,failure));}
    finally{finish();setBusy(false);onPending(false);}
  }
  return <section className="relay-card" aria-labelledby="relay-new-job-title"><h2 id="relay-new-job-title">{j('newJob')}</h2><p>{j('jobOnlyHelp')}</p><small>{j('draftHelp')}</small>
    <form onSubmit={event=>void submit(event)} aria-busy={busy}>
      {error&&<p className="relay-error" role="alert">{error}</p>}
      <div className="relay-form-grid"><label>{t('externalId')}<input autoFocus required name="externalId" maxLength={160} disabled={busy} value={draft.externalId} onChange={event=>update({externalId:event.target.value})}/></label><label>{t('customer')}<input required name="customerReference" maxLength={200} disabled={busy} value={draft.customerReference} onChange={event=>update({customerReference:event.target.value})}/></label>
        <label>{t('branch')}<select name="branchId" required disabled={busy} value={draft.branchId} onChange={event=>update({branchId:event.target.value})}>{session.branches.map(branch=><option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
        <label>{t('priority')}<select name="priority" disabled={busy} value={draft.priority} onChange={event=>update({priority:event.target.value})}>{[['urgent','Emergency — as soon as possible'],['high','Urgent'],['normal','Routine'],['low','Can wait']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>Client completion expectation<select value={draft.deadlineMode} disabled={busy} onChange={event=>update({deadlineMode:event.target.value as Draft['deadlineMode']})}>
          <option value="unknown">Not known yet</option><option value="date">By a specific date and time</option><option value="none">No fixed deadline</option>
        </select></label>
        {draft.deadlineMode==='date'&&<label>Client needs work finished by<input type="datetime-local" step="any" required disabled={busy} value={draft.completeBy} onChange={event=>update({completeBy:event.target.value})}/></label>}
        <label>Client cannot start before (optional)<input type="datetime-local" step="any" disabled={busy} value={draft.earliestStart} onChange={event=>update({earliestStart:event.target.value})}/></label>
        <label className="relay-wide">{t('note')}<textarea name="description" rows={3} maxLength={4000} disabled={busy} value={draft.description} onChange={event=>update({description:event.target.value})}/></label></div>
      <div className="relay-actions"><button type="submit" className="relay-primary" disabled={busy}>{busy?t('saving'):j('saveJob')}</button><button type="button" disabled={busy} onClick={onClose}>{j('closeDraft')}</button><button type="button" disabled={busy} onClick={()=>{drafts.delete(scope);setDraft(fresh());setError('');}}>{j('clearDraft')}</button></div>
    </form>
  </section>;
}

import {SearchFiltersButton} from './SearchFiltersButton.js';
import {useEffect,useState} from 'react';
import {canDispatch,relayRequest,type Person,type Session} from './api.js';
import {errorLabel,tr,type Language} from './i18n.js';
import {jt} from './jobsI18n.js';
import {jobPath,milestoneOverdue,type JobMilestone,type JobStatus} from './jobsModel.js';
import {useRelayResource} from './useRelayResource.js';
import {DateTime,TimezoneNotice} from './DateTime.js';
import {ListPaging} from './ListPaging.js';
import {queryOffset,restoreListScroll,updateListQuery,withReturnTo,type RelayNavigate} from './navigation.js';
interface CommitmentRow {milestone:JobMilestone;job:{id:string;externalId:string;customerReference:string;branchId:string;status:JobStatus;assigneeId:string|null};jobVersion:number}
interface CommitmentList {items:CommitmentRow[];total:number;hasMore:boolean;nextOffset:number|null;asOf:string}
export function Commitments({session,language,navigate,search=''}:{session:Session;language:Language;navigate:RelayNavigate;search?:string}){
  const params=new URLSearchParams(search),filter=params.get('filter')==='all'?'all':'mine',view=['completed','all'].includes(params.get('view')??'')?params.get('view')!:'open',term=params.get('search')??'',branch=params.get('branchId')??'',offset=queryOffset(params);
  const query=new URLSearchParams({view,filter,offset:String(offset)});if(term)query.set('search',term);if(branch)query.set('branchId',branch);
  const {data,error,loading,refresh}=useRelayResource<CommitmentList>(`/job-commitments?${query}`,`${session.organization.id}:${session.user.id}`);
  const [filtersOpen,setFiltersOpen]=useState(false);
  const activeFilters=[term,view==='open'?'':view,branch].filter(Boolean).length;
  const [people,setPeople]=useState<Person[]>([]);
  const j=(key:Parameters<typeof jt>[1])=>jt(language,key),t=(key:Parameters<typeof tr>[1])=>tr(language,key);
  useEffect(()=>{const controller=new AbortController();void relayRequest<{items:Person[]}>('/people',{signal:controller.signal}).then(result=>setPeople(result.items)).catch(()=>{});return()=>controller.abort();},[session.user.id,session.organization.id]);
  useEffect(()=>{if(data)restoreListScroll();},[Boolean(data),search]);
  function change(patch:Record<string,string|number|null>){navigate(updateListQuery('/relay/commitments',params,{offset:null,...patch}),{replace:true});}
  const returnTo=updateListQuery('/relay/commitments',params,{});
  function open(row:CommitmentRow,action?:string){const path=jobPath(row.job.id)+(action?`?jobAction=${action}&milestoneId=${encodeURIComponent(row.milestone.id)}`:'');navigate(withReturnTo(path,returnTo));}
  function canAct(row:CommitmentRow){return row.milestone.status==='open'&&!['completed','cancelled','completion_reported'].includes(row.job.status)&&(session.user.role==='organization_admin'||session.user.branchId===row.job.branchId)&&(canDispatch(session)||(session.user.role==='on_call_responder'&&(row.job.assigneeId===session.user.id||row.milestone.ownerId===session.user.id)));}
  return <div className="relay-jobs"><div className="relay-section-heading"><h1>{language==='fr'?'Engagements de travail':'Work commitments'}</h1></div>
    <p>{language==='fr'
      ? 'Un travail est l’intervention à réaliser. Un engagement est une tâche liée à cette intervention, avec une personne responsable et une date limite.'
      : 'A job is the work to be done. A work commitment is a task for that job, with someone responsible and a deadline.'}</p>
    <p className="relay-muted">{j('inApp')}</p><TimezoneNotice language={language}/>
    <div className="relay-jobs-toolbar relay-commitments-toolbar"><div className="relay-filter-tabs" role="group" aria-label={j('commitments')}>{(['mine','all']as const).map(value=><button type="button" key={value} aria-pressed={filter===value} onClick={()=>change({filter:value})}>{j(value==='mine'?'myCommitments':'allCommitments')}</button>)}</div>
      <button type="button" className="relay-commitments-refresh" disabled={loading} onClick={()=>void refresh()}>{t(loading?'loading':'refresh')}</button>
      <SearchFiltersButton language={language} filtersOpen={filtersOpen} activeFilters={activeFilters} id="relay-commitment-filters" onToggle={()=>setFiltersOpen(open=>!open)}/>
    </div>
    <div id="relay-commitment-filters" className="relay-filters relay-job-filters relay-collapsible-filters" hidden={!filtersOpen}><label>{language==='fr'?'Rechercher des engagements':'Search commitments'}<input type="search" value={term} maxLength={200} onChange={event=>change({search:event.target.value})}/></label><label>{t('status')}<select value={view} onChange={event=>change({view:event.target.value})}>{(['open','completed','all']as const).map(value=><option key={value} value={value}>{j(value)}</option>)}</select></label>{session.branches.length>1&&<label>{t('branch')}<select value={branch} onChange={event=>change({branchId:event.target.value})}><option value="">{t('allBranches')}</option>{session.branches.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}</div>
    {error!=null&&<p className="relay-error" role="alert">{errorLabel(language,error)} <button type="button" onClick={()=>void refresh()}>{t('retry')}</button></p>}
    {!data&&!error&&<p role="status">{t('loading')}</p>}
    {data&&<>{data.items.length===0?<p className="relay-empty">{j('emptyCommitments')}</p>:data.items.map(row=><article className="relay-card" key={row.milestone.id}><div className="relay-section-heading"><div><span className="relay-eyebrow">{row.job.externalId} · {row.job.customerReference}</span><h2>{row.milestone.title}</h2></div><span className={milestoneOverdue(row.milestone,data.asOf)?'relay-status relay-status-breached':'relay-status'}>{j(milestoneOverdue(row.milestone,data.asOf)?'overdue':row.milestone.status)}</span></div><p>{j('assigned')}: <strong>{people.find(person=>person.id===row.milestone.ownerId)?.displayName??row.milestone.ownerId}</strong><small>{j('due')}: <DateTime value={row.milestone.dueAt} language={language}/></small></p><div className="relay-actions">{canAct(row)&&(['complete_milestone','reschedule_milestone','cancel_milestone']as const).map(action=><button type="button" key={action} className={action==='complete_milestone'?'relay-primary':''} aria-label={`${j(action)}: ${row.milestone.title}`} onClick={()=>open(row,action)}>{j(action)}</button>)}<button type="button" onClick={()=>open(row)}>{j('openJob')} →</button></div></article>)}<ListPaging offset={offset} count={data.items.length} total={data.total} hasMore={data.hasMore} nextOffset={data.nextOffset} loading={loading} language={language} onPage={value=>navigate(updateListQuery('/relay/commitments',params,{offset:value}),{replace:true})}/></>}
  </div>;
}

/// <reference types="vite/client" />
import {SearchFiltersButton} from './SearchFiltersButton.js';
import {lazy,Suspense,useEffect,useState} from 'react';
import {canDispatch,relayRequest,type Person,type Session} from './api.js';
import {errorLabel,tr,type Language} from './i18n.js';
import {NewJobForm} from './NewJobForm.js';
import {jt,jobEventLabel} from './jobsI18n.js';
import {jobPath,type Job,type JobView} from './jobsModel.js';
import {useJobs} from './useJobs.js';
import {DateTime,TimezoneNotice} from './DateTime.js';
import {ListPaging} from './ListPaging.js';
import {queryOffset,restoreListScroll,updateListQuery,withReturnTo,type RelayNavigate} from './navigation.js';
import './jobs.css';
const planningEnabled=import.meta.env.VITE_RELAY_PLANNING_DEMO==='true';
const JobsMap=lazy(()=>import('./JobPlanning.js').then(module=>({default:module.JobsMap})));
const JobsCalendar=lazy(()=>import('./JobPlanning.js').then(module=>({default:module.JobsCalendar})));

export function JobStatusBadge({job,language}:{job:Job;language:Language}){return <span className={`relay-status relay-job-status-${job.status}`}>{jt(language,job.status)}</span>;}
export function Jobs({session,language,navigate,search=''}:{session:Session;language:Language;navigate:RelayNavigate;search?:string}){
  const params=new URLSearchParams(search),view:JobView=params.get('view')==='completed'?'completed':params.get('view')==='all'?'all':'active';
  const filter=['mine','attention'].includes(params.get('filter')??'')?params.get('filter')!:'all',term=params.get('search')??'',branch=params.get('branchId')??'',owner=params.get('ownerId')??'',offset=queryOffset(params),creating=params.get('create')==='1';
  const [filtersOpen,setFiltersOpen]=useState(false);
  const activeFilters=[term,filter==='all'?'':filter,params.get('status'),branch,owner].filter(Boolean).length;
  const layout=planningEnabled&&params.get('layout')==='map'?'map':planningEnabled&&params.get('layout')==='calendar'?'calendar':'list';
  const states=['requested','scheduled','in_progress','blocked','completion_reported','completed','cancelled']as const;
  const status=states.find(value=>value===params.get('status'))??'';
  const query=new URLSearchParams({view,filter,offset:String(layout==='list'?offset:0)});for(const [key,value]of Object.entries({search:term,branchId:branch,ownerId:owner,status}))if(value)query.set(key,value);
  const [pending,setPending]=useState(false),[people,setPeople]=useState<Person[]>([]),[peopleError,setPeopleError]=useState(false);
  const {data,error,loading,refresh}=useJobs(session,query.toString(),layout!=='list');
  const t=(key:Parameters<typeof tr>[1])=>tr(language,key),j=(key:Parameters<typeof jt>[1])=>jt(language,key);
  useEffect(()=>{const controller=new AbortController();void relayRequest<{items:Person[]}>('/people',{signal:controller.signal}).then(result=>{setPeople(result.items);setPeopleError(false);}).catch(()=>{if(!controller.signal.aborted)setPeopleError(true);});return()=>controller.abort();},[session.user.id,session.organization.id]);
  useEffect(()=>{if(data)restoreListScroll();},[Boolean(data),search]);
  const name=(id:string|null)=>id?people.find(person=>person.id===id)?.displayName??id:j('unassigned');
  const visibleFilters=[
    view==='active'?null:j(view==='completed'?'completedJobs':'allJobs'),
    filter==='all'?null:j(filter==='mine'?'mine':'attention'),
    term?'"'+term+'"':null,status?j(status):null,
    owner?name(owner):null,branch?session.branches.find(item=>item.id===branch)?.name:null,
  ].filter(Boolean);
  function change(patch:Record<string,string|number|null>){navigate(updateListQuery('/relay/jobs',params,{offset:null,...patch}),{replace:true});}
  function open(id:string){navigate(withReturnTo(jobPath(id),updateListQuery('/relay/jobs',params,{create:null})));}
  return <div className="relay-jobs">
    <div className="relay-section-heading"><h1>{j('jobs')}</h1><div className="relay-actions"><button type="button" disabled={loading||pending} onClick={()=>void refresh()}>{t(loading?'loading':'refresh')}</button>{canDispatch(session)&&<button type="button" disabled={pending} className="relay-primary" onClick={()=>change({create:creating?null:'1'})}>{creating?j('closeDraft'):j('newJob')}</button>}</div></div>
    {creating&&canDispatch(session)&&<NewJobForm session={session} language={language} onCreated={open} onClose={()=>change({create:null})} onPending={setPending}/>}
    <TimezoneNotice language={language}/>
    {planningEnabled&&<div className="relay-actions relay-job-views" role="group" aria-label={language==='fr'?'Vue des travaux':'Jobs view'}>
      {(['list','map','calendar']as const).map((value,index)=><button key={value} type="button" disabled={pending} aria-pressed={layout===value} onClick={()=>change({layout:value==='list'?null:value})}>{(language==='fr'?['Liste','Carte','Calendrier']:['List','Map','Calendar'])[index]}</button>)}
      {canDispatch(session)&&<button type="button" onClick={()=>navigate('/relay/people')}>{language==='fr'?'Disponibilité des techniciens':'Technician availability'}</button>}
    </div>}
    {visibleFilters.length>0&&<div className="relay-notice" role="status">
      {language==='fr'?'Filtres actifs':'Showing'}{' · '}{visibleFilters.join(' · ')}
      <button type="button" disabled={pending} onClick={()=>change({view:'active',filter:null,search:null,status:null,branchId:null,ownerId:null})}>
        {language==='fr'?'Afficher tous les travaux actifs':'Show all active jobs'}</button>
    </div>}
    <div className="relay-jobs-toolbar">
    <div className="relay-filter-tabs" role="group" aria-label={j('jobs')}>{(['active','completed','all']as const).map(value=><button type="button" disabled={pending} key={value} aria-pressed={view===value} onClick={()=>change({view:value,status:null})}>{j(value==='active'?'activeJobs':value==='completed'?'completedJobs':'allJobs')}</button>)}</div>
    <SearchFiltersButton language={language} filtersOpen={filtersOpen} activeFilters={activeFilters} id="relay-jobs-filters" onToggle={()=>setFiltersOpen(open=>!open)}/>
    </div>
    <div id="relay-jobs-filters" className="relay-filters relay-job-filters relay-collapsible-filters" hidden={!filtersOpen}><label>{language==='fr'?'Rechercher des travaux':'Search jobs'}<input type="search" disabled={pending} value={term} onChange={event=>change({search:event.target.value})} maxLength={200}/></label><label>{j('filters')}<select disabled={pending} value={filter} onChange={event=>change({filter:event.target.value})}>{(['all','attention','mine']as const).map(value=><option key={value} value={value}>{j(value)}</option>)}</select></label><label>{j('status')}<select disabled={pending} value={status} onChange={event=>change({status:event.target.value,view:'all'})}><option value="">{j('allStatuses')}</option>{states.map(value=><option key={value} value={value}>{j(value)}</option>)}</select></label>{session.branches.length>1&&<label>{t('branch')}<select disabled={pending} value={branch} onChange={event=>change({branchId:event.target.value,ownerId:null})}><option value="">{t('allBranches')}</option>{session.branches.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}<label>{j('assigned')}<select disabled={pending||peopleError} value={owner} onChange={event=>change({ownerId:event.target.value})}><option value="">{j('allPeople')}</option>{people.filter(person=>!branch||person.branchId===branch).map(person=><option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label></div>
    {peopleError&&<p className="relay-warning" role="status">{j('peopleError')}</p>}
    {error!=null&&<p role="alert" className="relay-error">{errorLabel(language,error)} <button type="button" onClick={()=>void refresh()}>{t('retry')}</button></p>}
    {!data&&!error&&<p role="status">{t('loading')}</p>}
    {layout!=='list'&&<Suspense fallback={<p role="status">{t('loading')}</p>}>
      {layout==='map'?<JobsMap jobs={data?.items??[]} language={language} name={name} open={open}/>:<JobsCalendar jobs={data?.items??[]} language={language} name={name} open={open}
        dispatch={canDispatch(session)} owner={owner} people={people.filter(person=>(!branch||person.branchId===branch)&&(person.role==='on_call_responder'||person.id===owner))}
        onOwner={id=>change({ownerId:id})}/>}
      {data?.hasMore&&<p role="status">{language==='fr'?'Affinez les filtres pour voir les autres travaux.':'Some jobs are outside this view. Narrow the filters to see the rest.'}</p>}
    </Suspense>}
    {data&&layout==='list'&&(data.items.length===0?<div className="relay-empty"><p>{j('empty')}</p><button type="button" onClick={()=>navigate('/relay/jobs')}>{j('clearFilters')}</button></div>:<div className="relay-job-list">{data.items.map(job=>{
      // Older jobs store the client and short job title together.
      const [client='',...titleParts]=job.customerReference.split(' — ');
      const title=titleParts.join(' — ').trim() || job.description?.trim();
      return <article key={job.id} className="relay-card relay-job-row">
        <header className="relay-job-card-heading">
          <h2>{client.trim() || job.externalId}</h2>
          {client.trim() && <small>{language==='fr'?'Réf.':'Ref.'} {job.externalId}</small>}
        </header>
        <div className="relay-job-card-context">
          {title && <p>{title}</p>}
          <JobStatusBadge job={job} language={language}/>
          <p>{language==='fr'?'Visite prévue':'Scheduled visit'}{' · '}<DateTime value={job.scheduledAt} language={language}/></p>
          <p>{language==='fr'?'Compétences requises':'Required skills'}{' · '}{job.requiredSkills?.join(', ')||(language==='fr'?'Non précisées':'Not recorded')}</p>

          {(job.attentionReasons?.length??0)>0 && <ul className="relay-attention-reasons">{job.attentionReasons?.map(reason=>
            <li key={reason}>{reason==='blocked'&&job.blocker
              ? <><strong>{jobEventLabel(language,reason)}:</strong> {job.blocker}</>
              : jobEventLabel(language,reason)}</li>
          )}</ul>}
        </div>
        <dl><div><dt>{j('assigned')}</dt><dd>{name(job.assigneeId)}</dd></div><div><dt>{j('nextDue')}</dt><dd>{job.nextDueAt?<DateTime value={job.nextDueAt} language={language}/>:j('noDue')}</dd></div></dl>
        <button type="button" onClick={()=>open(job.id)}>{j('view')} →</button>
      </article>;
    })}</div>)}
    {data&&layout==='list'&&<><ListPaging offset={offset} total={data.total} count={data.items.length} hasMore={data.hasMore} nextOffset={data.nextOffset} loading={loading||pending} language={language} onPage={value=>navigate(updateListQuery('/relay/jobs',params,{offset:value}),{replace:true})}/><small>{j('shownAt')}: <DateTime value={data.asOf} language={language}/></small></>}
  </div>;
}

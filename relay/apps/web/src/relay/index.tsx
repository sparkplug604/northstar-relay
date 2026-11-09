import {useEffect,useRef,useState,type MouseEvent} from 'react';
import {canDispatch,relayRequest,RelayApiError,useSessionToken,type Session} from './api.js';
import {AskRelay} from './AskRelay.js';
import {Auth} from './Auth.js';
import {Home} from './Home.js';
import {Jobs} from './Jobs.js';
import {Commitments} from './Commitments.js';
import {Team} from './Team.js';
import {Settings} from './Settings.js';
import {JobDetail} from './JobDetail.js';
import {jt} from './jobsI18n.js';
import {Queue} from './Queue.js';
import {WorkOrder} from './WorkOrder.js';
import {People} from './People.js';
import {Profile} from './Profile.js';
import {OnCall} from './OnCall.js';
import {Intake} from './Intake.js';
import {ActionPage} from './ActionPage.js';
import {errorLabel,stateLabel,tr,type Language} from './i18n.js';
import {ux,parseWorkFilter} from './ux.js';
import {navigationPending,restoreListScroll,safeReturnTo,withReturnTo,type NavigationOptions} from './navigation.js';
import {clearJobDrafts} from './NewJobForm.js';
import './relay.css';
import './dispatchPlanning.css';

export function RelayApp() {
  const [session,setSession]=useState<Session|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [language,setLanguageState]=useState<Language>(()=>localStorage.getItem('northstar:relay-language')==='fr'?'fr':'en');
  const [location,setLocation]=useState(window.location.pathname+window.location.search),[signingOut,setSigningOut]=useState(false);
  const [menuOpen,setMenuOpen]=useState(false);
  const menuToggle=useRef<HTMLButtonElement>(null);
  const main=useRef<HTMLElement|null>(null),previousPath=useRef(location);
  const scrollPositions=useRef(new Map<string,number>()),currentLocation=useRef(location);currentLocation.current=location;
  const url=new URL(location,window.location.origin),path=url.pathname;
  const actionToken=path.startsWith('/relay/action/')?path.slice('/relay/action/'.length):null;
  const t=(key:Parameters<typeof tr>[1])=>tr(language,key),u=(key:Parameters<typeof ux>[1])=>ux(language,key);
  function setLanguage(value:Language){setLanguageState(value);localStorage.setItem('northstar:relay-language',value);}
  function navigate(next:string,options:NavigationOptions={}){
    if(navigationPending())return;
    const current=window.location.pathname+window.location.search;scrollPositions.current.set(current,window.scrollY);
    window.history.replaceState({...window.history.state,relayScrollY:window.scrollY},'',current);
    const state={relayScrollY:options.restoreScroll?scrollPositions.current.get(next)??0:0};
    if(options.replace)window.history.replaceState(state,'',next);else window.history.pushState(state,'',next);
    setLocation(next);window.scrollTo(0,state.relayScrollY);
  }
  function follow(event:MouseEvent<HTMLAnchorElement>,next:string){if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate(next);}
  function acceptSession(value:Session){useSessionToken(value);setSession(value);setError('');setLoading(false);if(path==='/relay/sign-in')navigate('/relay');}
  async function loadSession(background=false){
    if(!background){setLoading(true);setError('');}
    try{acceptSession(await relayRequest<Session>('/session'));}
    catch(failure){const expired=failure instanceof RelayApiError&&failure.status===401;if(expired||!background){useSessionToken(null);setSession(null);}if(!expired)setError(errorLabel(language,failure));}
    finally{if(!background)setLoading(false);}
  }
  async function signOut(){
    if(navigationPending())return;
    setSigningOut(true);setError('');
    try{await relayRequest('/auth/logout',{method:'POST',body:{}});useSessionToken(null);setSession(null);clearJobDrafts();scrollPositions.current.clear();navigate('/relay');}
    catch(failure){setError(errorLabel(language,failure));}
    finally{setSigningOut(false);}
  }
  useEffect(()=>{if(!actionToken)void loadSession();else setLoading(false);},[]);
  useEffect(()=>{document.documentElement.lang=language==='fr'?'fr-CA':'en-CA';document.title='Northstar Relay';},[language]);
  useEffect(()=>{const original=window.history.scrollRestoration;window.history.scrollRestoration='manual';const changed=()=>{if(navigationPending()){window.history.pushState({relayScrollY:window.scrollY},'',currentLocation.current);return;}setLocation(window.location.pathname+window.location.search);restoreListScroll();};const leaving=(event:BeforeUnloadEvent)=>{if(navigationPending()){event.preventDefault();event.returnValue='';}};window.addEventListener('popstate',changed);window.addEventListener('beforeunload',leaving);return()=>{window.history.scrollRestoration=original;window.removeEventListener('popstate',changed);window.removeEventListener('beforeunload',leaving);};},[]);
  useEffect(()=>{if(previousPath.current.split('?')[0]!==path){main.current?.focus({preventScroll:true});previousPath.current=location;}},[location,path]);
  useEffect(()=>{const expired=()=>{useSessionToken(null);setSession(null);clearJobDrafts();setError(tr(language,'accessError'));};window.addEventListener('northstar:relay-session-expired',expired);return()=>window.removeEventListener('northstar:relay-session-expired',expired);},[language]);
  let workOrderId:string|null=null,jobId:string|null=null;
  if(path.startsWith('/relay/work-orders/'))try{workOrderId=decodeURIComponent(path.slice('/relay/work-orders/'.length));}catch{}
  if(path.startsWith('/relay/jobs/'))try{jobId=decodeURIComponent(path.slice('/relay/jobs/'.length));}catch{}
  const branchName=session?.branches.find(branch=>branch.id===session.user.branchId)?.name;
  const team=path==='/relay/team'||path==='/relay/people';
  const settings=path==='/relay/settings'||path==='/relay/connections';
  const settingsLabel=language==='fr'?'Paramètres':'Settings';
  const historyWorkOrder=workOrderId&&safeReturnTo(url.searchParams.get('returnTo'),'/relay/work').split('?')[0]==='/relay/history';
  const tab=jobId||path==='/relay/jobs'?'jobs':path==='/relay/commitments'?'commitments':path==='/relay/recovery'?'recovery':path==='/relay/intake'||path==='/relay/work'||(workOrderId&&!historyWorkOrder)?'inbox':settings?'settings':team||path==='/relay/on-call'||historyWorkOrder||path==='/relay/history'?'team':path==='/relay/profile'?'profile':'home';
  const navigation=[{key:'home',label:u('home'),path:'/relay'},{key:'jobs',label:jt(language,'jobs'),path:'/relay/jobs'},{key:'commitments',label:jt(language,'commitments'),path:'/relay/commitments?filter=mine'},...(session&&canDispatch(session)&&session.providerMode==='simulated'&&window.location.origin==='http://127.0.0.1:3004'?[{key:'recovery',label:language==='fr'?'Replanifier':'Recovery',path:'/relay/recovery'}]:[]),...(session&&canDispatch(session)?[{key:'inbox',label:jt(language,'inbox'),path:'/relay/intake'},{key:'team',label:u('team'),path:'/relay/team'},{key:'settings',label:settingsLabel,path:'/relay/settings'}]:[])];
  const unavailable=(text:string)=><section className="relay-card"><h1>{text}</h1><button type="button" onClick={()=>navigate('/relay')}>{u('backHome')}</button></section>;
  function workspace(){
    if(!session)return null;
    if((team||settings||path==='/relay/intake')&&!canDispatch(session))return unavailable(u('noPermission'));
    if(path==='/relay/recovery'){
      if(!canDispatch(session)||session.providerMode!=='simulated'||window.location.origin!=='http://127.0.0.1:3004')return unavailable(u('noPermission'));
      const title=language==='fr'?'Replanification du quart':'Shift recovery';
      return <iframe title={title} src="http://127.0.0.1:3005/relay-entry.html" style={{width:'100%',height:'calc(100dvh - 155px)',minHeight:540,border:0}}/>;
    }
    if(jobId)return <JobDetail key={jobId+'-'+(url.searchParams.get('askRelay')??'')} id={jobId} session={session} language={language} navigate={navigate} returnTo={safeReturnTo(url.searchParams.get('returnTo'))} {...(url.searchParams.has('jobAction')?{initialAction:url.searchParams.get('jobAction')!}:{})} {...(url.searchParams.has('milestoneId')?{initialMilestoneId:url.searchParams.get('milestoneId')!}:{})}/>;
    if(path==='/relay/jobs')return <Jobs session={session} language={language} navigate={navigate} search={url.search}/>;
    if(path==='/relay/commitments')return <Commitments session={session} language={language} navigate={navigate} search={url.search}/>;
    if(workOrderId)return <WorkOrder key={workOrderId} id={workOrderId} session={session} language={language} onBack={()=>navigate(safeReturnTo(url.searchParams.get('returnTo'),'/relay/work'),{restoreScroll:true})} onJob={id=>navigate(withReturnTo(`/relay/jobs/${encodeURIComponent(id)}`,safeReturnTo(url.searchParams.get('returnTo'),'/relay/work')))}/>;
    if(path==='/relay'||path==='/relay/')return <Home session={session} language={language} navigate={navigate}/>;
    if(path==='/relay/profile')return <><Profile session={session} language={language} onSessionChanged={()=>void loadSession(true)}/><div className="relay-profile-signout"><button type="button" disabled={signingOut} onClick={()=>void signOut()}>{t(signingOut?'loading':'signOut')}</button></div></>;
    if(path==='/relay/people')return <People session={session} language={language}/>;
    if(path==='/relay/on-call')return <OnCall session={session} language={language}/>;
    if(path==='/relay/intake')return <Intake session={session} language={language} navigate={navigate}/>;
    if(path==='/relay/settings')return <Settings session={session} language={language} navigate={navigate}/>;
    if(path==='/relay/connections')return <><button type="button" className="relay-text-button" onClick={()=>navigate('/relay/settings')}>← {settingsLabel}</button><Intake session={session} language={language} navigate={navigate} connectionsOnly/></>;
    if(path==='/relay/team')return <Team language={language} navigate={navigate}/>;
    if(path==='/relay/work'||path==='/relay/history')return <Queue key={path} session={session} language={language} history={path==='/relay/history'} initialFilter={parseWorkFilter(url.searchParams.get('filter'))} navigate={navigate} onOpen={id=>navigate(withReturnTo(`/relay/work-orders/${encodeURIComponent(id)}`,location))}/>;
    return unavailable(u('notFound'));
  }
  return <div className="relay-app">
    <a href="#relay-main" className="relay-skip">{language==='fr'?'Aller au contenu':'Skip to content'}</a>
    {session&&!actionToken&&<div className={`relay-context-strip ${session.providerMode==='live'?'relay-context-live':''}`}>
      <strong title={session.organization.name}>{session.organization.name}</strong>
      {branchName&&<span className="relay-context-branch">{branchName}</span>}
      <span className="relay-context-status" role="status" title={t(session.providerMode==='live'?'live':'simulated')}>
        {session.providerMode==='live' ? t('live') : language==='fr' ? 'Simulation · aucun envoi réel' : 'Simulated · no real calls or texts'}
      </span>
    </div>}
    <header className="relay-header">
      <div className="relay-brand-lockup">
        <a className="relay-brand" href="/relay" aria-label={`Northstar Relay — ${u('home')}`} onClick={event=>{if(!actionToken)follow(event,'/relay');}}><span aria-hidden="true">✳</span> Northstar <strong>Relay</strong></a>
        <small>{language==='fr'?'Répartition des interventions et coordination des équipes sur le terrain':'Service dispatch and field team coordination'}</small>
      </div>
      <div className="relay-header-actions">
        {session&&!actionToken&&canDispatch(session)&&session.providerMode==='simulated'&&window.location.origin==='http://127.0.0.1:3004'&&<AskRelay location={location} navigate={navigate}/>}
<div className="relay-language" aria-label={language==='fr'?'Langue':'Language'}><button type="button" aria-pressed={language==='en'} onClick={()=>setLanguage('en')}>EN</button><button type="button" aria-pressed={language==='fr'} onClick={()=>setLanguage('fr')}>FR</button></div>{session&&!actionToken&&<button className="relay-identity" type="button" aria-label={`${u('profile')}: ${session.user.displayName}`} onClick={()=>navigate('/relay/profile')}>{session.user.email === 'dispatch@relay-demo.invalid'
          ? <img className="relay-avatar relay-drew-portrait" src="/drew-dispatcher.svg" alt=""/>
          : <span className="relay-avatar" aria-hidden="true">{session.user.displayName.slice(0,1)}</span>}<span className="relay-identity-text">{session.user.displayName}<small>{u('profile')}</small></span></button>}
        {session&&!actionToken&&<div className="relay-header-menu"
          onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setMenuOpen(false);}}
          onKeyDown={event=>{if(event.key==='Escape'&&menuOpen){event.preventDefault();setMenuOpen(false);menuToggle.current?.focus();}}}>
          <button type="button" ref={menuToggle} aria-expanded={menuOpen} aria-controls="relay-main-menu" onClick={()=>setMenuOpen(open=>!open)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
            <span>Menu</span>
          </button>
          <nav id="relay-main-menu" className="relay-menu-nav" hidden={!menuOpen} aria-label={language==='fr'?'Navigation principale':'Main navigation'}>
            {navigation.map(item=><a key={item.key} href={item.path} aria-current={tab===item.key?'page':undefined} onClick={event=>{setMenuOpen(false);follow(event,item.path);}}>{item.label}</a>)}
          </nav>
        </div>}
      </div>
    </header>
    <main className="relay-main" id="relay-main" tabIndex={-1} ref={main}>
      {actionToken?<ActionPage token={actionToken} language={language} setLanguage={setLanguage}/>:loading?<p className="relay-empty" role="status">{t('loading')}</p>:<>
        {error&&<p className="relay-error" role="alert">{error} <button type="button" onClick={()=>void loadSession()}>{t('retry')}</button></p>}
        {session?workspace():path==='/relay'||path==='/relay/'?<section className="relay-card relay-auth relay-entry"><span className="relay-avatar" aria-hidden="true">✳</span><h1>Northstar Relay</h1><button className="relay-primary" type="button" onClick={()=>navigate('/relay/sign-in')}>{t('signIn')}</button></section>:<Auth language={language} onSession={acceptSession}/>}
      </>}
    </main>
  </div>;
}

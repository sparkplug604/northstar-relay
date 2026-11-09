import {SearchFiltersButton} from './SearchFiltersButton.js';
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { canDispatch, commandKey, relayRequest, type QueueItem, type Session } from "./api.js";
import { dateLabel, errorLabel, stateLabel, tr, type Language } from "./i18n.js";
import { Connections } from "./Connections.js";
import { localDateInput, reviewedTimestamp } from "./dateInput.js";
import { beginPendingNavigation, restoreListScroll, withReturnTo, type RelayNavigate } from './navigation.js';
import { TimezoneNotice } from './DateTime.js';

interface SourceFields { externalId?: string; customerReference?: string; priority?: string; dueAt?: string; sourceReceivedAt?: string; note?: string }
interface IntakeRecord { id: string; status: string; branchId: string; fields: SourceFields; reasons: string[]; receivedAt: string; commitmentId: string|null; parserVersion: string; provenance: Record<string,unknown> }
interface IntakePage { items: IntakeRecord[]; total: number; hasMore: boolean; nextOffset: number|null }
type Props = { session: Session; language: Language; navigate?: RelayNavigate; connectionsOnly?: boolean };
function currentQuery() {
  const p=new URLSearchParams(window.location.search);
  return {status:['all','pending','promoted','rejected'].includes(p.get('status')??'')?p.get('status')!:'split',search:p.get('search')??'',branchId:p.get('branchId')??'',offset:Math.max(0,Math.min(1000000,Number(p.get('offset'))||0))};
}

export function Intake(props: Props) {
  return props.connectionsOnly ? <><h1>{tr(props.language,'connections')}</h1><Connections session={props.session} language={props.language}/></> : <Inbox {...props}/>;
}
function Inbox({ session, language, navigate }: Props) {
  const [page, setPage] = useState<IntakePage|null>(null),[query,setQuery]=useState(currentQuery),[loading,setLoading]=useState(true);
  const [created,setCreated]=useState<IntakePage|null>(null);
  const [createdError,setCreatedError]=useState(false);
  const [awaitingAcceptance,setAwaitingAcceptance]=useState<Set<string>>(new Set());
  const [acceptanceError,setAcceptanceError]=useState(false);
  const [filtersOpen,setFiltersOpen]=useState(false);
  const activeFilters=[query.search,query.status==='split'?'':query.status,query.branchId].filter(Boolean).length;
  const [showImport,setShowImport]=useState(false),[reviewBusy,setReviewBusy]=useState(false);
  const [rawEmail, setRawEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<IntakeRecord | null>(null);
  const [notice, setNotice] = useState<IntakeRecord | null>(null);
  const key = useRef(commandKey()),request=useRef<AbortController|null>(null);
  const t = (word: Parameters<typeof tr>[1]) => tr(language, word);
  const x=(en:string,fr:string)=>language==='fr'?fr:en;
  const pending=busy||reviewBusy;
  const queryString=new URLSearchParams({status:query.status==='split'?'pending':query.status,search:query.search,offset:String(query.offset),...(query.branchId?{branchId:query.branchId}:{})}).toString();
  const showSplit=query.status==='split';
  const createdQuery=new URLSearchParams(queryString);
  createdQuery.set('status','promoted');createdQuery.set('offset','0');
  const createdQueryString=createdQuery.toString();
  const refresh=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);
    const load=(search:string)=>relayRequest<IntakePage>(`/intake?${search}`,{signal:controller.signal});
    const primary=load(queryString)
      .then(result=>{if(!controller.signal.aborted){setPage(result);setError('');}return result;})
      .catch(failure=>{if(!controller.signal.aborted)setError(errorLabel(language,failure));return null;});
    const secondary=showSplit
      ? load(createdQueryString)
        .then(result=>{if(!controller.signal.aborted){setCreated(result);setCreatedError(false);}return result;})
        .catch(()=>{if(!controller.signal.aborted)setCreatedError(true);return null;})
      : Promise.resolve(null);
    const [requests,createdJobs]=await Promise.all([primary,secondary]);
    if(controller.signal.aborted)return;
    const visible=(showSplit?createdJobs?.items.slice(0,3):requests?.items)??[];
    const pendingIds=new Set(visible.flatMap(item=>item.status==='promoted'&&item.commitmentId?[item.commitmentId]:[]));
    const waiting=new Set<string>();
    try {
      for(let offset=0;pendingIds.size>0;offset+=100){
        const params=new URLSearchParams({view:'open',filter:'unowned',offset:String(offset)});
        if(query.branchId)params.set('branchId',query.branchId);
        const queue=await relayRequest<{items:QueueItem[];hasMore:boolean}>(`/work-orders?${params}`,{signal:controller.signal});
        for(const {commitment} of queue.items)if(pendingIds.delete(commitment.commitmentId))waiting.add(commitment.commitmentId);
        if(!queue.hasMore)break;
      }
      if(!controller.signal.aborted){setAwaitingAcceptance(waiting);setAcceptanceError(false);}
    }catch {
      if(!controller.signal.aborted){setAwaitingAcceptance(new Set());setAcceptanceError(true);}
    }
    if(!controller.signal.aborted)setLoading(false);
  },[queryString,createdQueryString,showSplit,query.branchId,session.organization.id,session.user.id,language]);
  useEffect(()=>{void refresh();return()=>request.current?.abort();},[refresh]);
  useEffect(()=>{if(page&&!loading)restoreListScroll();},[page,loading]);
  useEffect(()=>{const pop=()=>setQuery(currentQuery());window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[]);
  function filter(next:Partial<typeof query>){
    const updated={...query,offset:0,...next};setQuery(updated);setPage(null);setCreated(null);setCreatedError(false);setAwaitingAcceptance(new Set());setAcceptanceError(false);
    const params=new URLSearchParams({status:updated.status,search:updated.search,offset:String(updated.offset),...(updated.branchId?{branchId:updated.branchId}:{})});
    const path=`/relay/intake?${params}`;if(navigate)navigate(path,{replace:true});else window.history.replaceState(null,'',path);
  }
  function openJob(id:string){
    const path=withReturnTo(`/relay/jobs/${encodeURIComponent(id)}`,window.location.pathname+window.location.search);
    if(navigate)navigate(path);else window.location.assign(path);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if(pending)return; setBusy(true); setError(""); setNotice(null);
    const form = new FormData(event.currentTarget);
    const finish=beginPendingNavigation();
    try {
      const result = await relayRequest<IntakeRecord>("/intake", { method: "POST", key: key.current, body: { branchId: form.get("branchId"), rawEmail } });
      setRawEmail(""); key.current = commandKey();setShowImport(false);
      if (result.status !== "promoted" && result.status !== "rejected") setReviewing(result);
      setNotice(result); await refresh();
    } catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false);finish(); }
  }
  async function chooseFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 262_144 || !file.name.toLowerCase().endsWith(".eml")) { setError(t("fileTooLarge")); return; }
    try { setRawEmail(await file.text()); key.current = commandKey(); setError(""); }
    catch (failure) { setError(errorLabel(language, failure)); }
  }
  function requestCards(items:IntakeRecord[]) {
    return <ul className="relay-list">{items.map(record=><li key={record.id}><div style={{minWidth:0}}>
        <strong>{record.fields.customerReference || x('Request without a client name','Demande sans nom de client')}</strong>
        {record.fields.note?.trim()&&<p className="relay-note">{record.fields.note}</p>}
        <small>{record.status==='promoted' ? x('Job created. Open it to see the work.','Travail créé. Ouvrez-le pour voir les détails.')
          : record.status==='rejected' ? x('Request declined.','Demande refusée.')
          : x('Needs your review before a job can be created.','Vérification requise avant la création du travail.')}</small>
        {record.commitmentId&&awaitingAcceptance.has(record.commitmentId)&&<small className="relay-inbox-awaiting">{x('Waiting for someone to accept','En attente de prise en charge')}</small>}
        {record.fields.externalId&&<small>{x('Ref.','Réf.')} {record.fields.externalId}</small>}
        {record.reasons.length>0&&<small>{record.reasons.map(reason=>stateLabel(language,reason)).join(' · ')}</small>}
        <small>{t('deadline')}: <time dateTime={record.fields.dueAt} title={record.fields.dueAt}>{dateLabel(language,record.fields.dueAt)}</time></small>
        <details><summary>{x('Source details','Détails de la source')}</summary><p>{x('Received','Reçu')}: <time dateTime={record.receivedAt} title={record.receivedAt}>{dateLabel(language,record.receivedAt)}</time></p><p>{t('branch')}: {session.branches.find(branch=>branch.id===record.branchId)?.name??record.branchId} · {x('Parser','Analyseur')}: {record.parserVersion}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(record.provenance,null,2)}</pre></details>
      </div><div className="relay-actions">{record.commitmentId&&<button type="button" disabled={pending} onClick={()=>openJob(record.commitmentId!)}>{x('Open job','Ouvrir le travail')}</button>}{!['promoted','rejected'].includes(record.status)&&<button type="button" disabled={pending} onClick={()=>setReviewing(record)}>{x('Review request','Vérifier la demande')}</button>}</div></li>)}</ul>;
  }
  return <>
    <div className="relay-section-heading"><h1>{x('Work Order Inbox','Boîte de réception des bons de travail')}</h1><div className="relay-actions"><button type="button" disabled={pending||loading} onClick={() => void refresh()}>{t("refresh")}</button><button type="button" disabled={pending} onClick={()=>setShowImport(!showImport)}>{showImport?t('cancel'):x('Import email','Importer un courriel')}</button><SearchFiltersButton language={language} filtersOpen={filtersOpen} activeFilters={activeFilters} id="relay-inbox-filters" onToggle={()=>setFiltersOpen(open=>!open)}/></div></div>
    <p className="relay-muted">{x('Check new job requests and see which jobs are still waiting for someone to accept them.','Vérifiez les nouvelles demandes et voyez quels travaux attendent encore une prise en charge.')}</p>
    <TimezoneNotice language={language}/>
    {error && <p className="relay-error" role="alert">{error}</p>}
    {notice && <div className="relay-notice" role="status">{stateLabel(language, notice.status)} {notice.commitmentId&&<button type="button" onClick={()=>openJob(notice.commitmentId!)}>{x('Open job','Ouvrir le travail')}</button>}</div>}
    {showImport && canDispatch(session) && <section className="relay-card"><p className="relay-warning">{t("intakeHelp")} {x('A recognized request starts the configured acknowledgement contact sequence.','Une demande reconnue lance la séquence de contacts configurée pour l’accusé de réception.')}</p><form onSubmit={(event) => void submit(event)} onChange={() => { key.current = commandKey(); }}><fieldset disabled={pending} style={{border:0,padding:0,margin:0}}>
      <div className="relay-form-grid"><label>{t("branch")}<select name="branchId" defaultValue={session.user.branchId || session.branches[0]?.id}>{session.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label><label>{t("uploadEmail")}<input type="file" accept=".eml,message/rfc822" onChange={(event) => void chooseFile(event.target.files?.[0])} /></label></div>
      <label>{t("rawEmail")}<textarea required name="rawEmail" value={rawEmail} onChange={(event) => setRawEmail(event.target.value)} rows={7} maxLength={262_144} spellCheck={false} /></label><button className="relay-primary" disabled={busy || !rawEmail.trim()} type="submit">{t(busy ? "loading" : "parseEmail")}</button>
    </fieldset></form></section>}
    {reviewing && <ReviewForm key={reviewing.id} record={reviewing} language={language} onBusy={setReviewBusy} onCancel={() => setReviewing(null)} onSaved={record => { setReviewing(null); setNotice(record); void refresh(); }} />}
    <section className="relay-inbox-requests" aria-labelledby="relay-inbox-requests-title">
    <h2 id="relay-inbox-requests-title">{x('Incoming job requests','Demandes de travail reçues')}</h2>
    <p className="relay-muted">{x('Check requests before they become jobs. If a job already exists, open it from here.','Vérifiez les demandes avant qu’elles deviennent des travaux. Si un travail existe déjà, ouvrez-le ici.')}</p>
    <div id="relay-inbox-filters" className="relay-form-grid relay-collapsible-filters" hidden={!filtersOpen}><label>{t('status')}<select disabled={pending} value={query.status} onChange={event=>filter({status:event.target.value})}>{['split','pending','all','promoted','rejected'].map(status=><option key={status} value={status}>{status==='split'?x('Review and created jobs','À examiner et travaux créés'):status==='pending'?x('Needs review','À examiner'):status==='all'?x('All requests','Toutes les demandes'):status==='promoted'?x('Job created','Travail créé'):x('Declined','Refusée')}</option>)}</select></label>
      <label>{x('Search requests','Rechercher des demandes')}<input type="search" disabled={pending} maxLength={200} value={query.search} onChange={event=>filter({search:event.target.value})}/></label>
      {session.user.role==='organization_admin'&&<label>{t('branch')}<select disabled={pending} value={query.branchId} onChange={event=>filter({branchId:event.target.value})}><option value="">{x('All branches','Toutes les succursales')}</option>{session.branches.map(branch=><option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}</div>
    {loading&&<p role="status">{t('loading')}</p>}
    {(showSplit||page)&&<section className="relay-inbox-status-section" aria-labelledby="relay-request-status">
      <h3 id="relay-request-status">{query.status==='promoted'?x('Job already created','Travail déjà créé'):query.status==='rejected'?x('Declined requests','Demandes refusées'):query.status==='all'?x('All requests','Toutes les demandes'):x('Needs your review','À vérifier')}</h3>
      {page&&<>
        {!page.items.length?<p className="relay-empty">{showSplit?x('No requests need your review.','Aucune demande à vérifier.'):t('noIntake')}</p>:requestCards(page.items)}
        {(query.offset>0||page.hasMore)&&<div className="relay-actions"><button type="button" disabled={pending||loading||query.offset===0} onClick={()=>filter({offset:Math.max(0,query.offset-200)})}>{x('Previous page','Page précédente')}</button><button type="button" disabled={pending||loading||!page.hasMore} onClick={()=>filter({offset:page.nextOffset??0})}>{x('Next page','Page suivante')}</button></div>}
      </>}
    </section>}
    {acceptanceError&&<p role="status">{x('Could not check which jobs are still waiting for someone to accept.','Impossible de vérifier quels travaux attendent une prise en charge.')} <button type="button" onClick={()=>void refresh()}>{t('retry')}</button></p>}
    {showSplit&&<section className="relay-inbox-status-section" aria-labelledby="relay-created-title">
      <h3 id="relay-created-title">{x('Job already created','Travail déjà créé')}</h3>
      <button type="button" className="relay-text-button" onClick={()=>navigate ? navigate('/relay/work?filter=unowned') : window.location.assign('/relay/work?filter=unowned')}>{x('View all jobs waiting for someone to accept','Voir tous les travaux en attente de prise en charge')} →</button>
      {createdError&&<p role="status">{x('Could not load created jobs.','Impossible de charger les travaux créés.')} <button type="button" onClick={()=>void refresh()}>{t('retry')}</button></p>}
      {created&&(!created.items.length?<p className="relay-empty">{x('No requests have become jobs yet.','Aucune demande n’est encore devenue un travail.')}</p>:requestCards(created.items.slice(0,3)))}
      {created&&created.total>3&&<button type="button" className="relay-text-button" onClick={()=>filter({status:'promoted'})}>{x(`View all ${created.total} created jobs`,`Voir les ${created.total} travaux créés`)} →</button>}
    </section>}
    {!showSplit&&query.status==='promoted'&&<button type="button" className="relay-text-button" onClick={()=>navigate ? navigate('/relay/work?filter=unowned') : window.location.assign('/relay/work?filter=unowned')}>{x('View all jobs waiting for someone to accept','Voir tous les travaux en attente de prise en charge')} →</button>}
    {!showSplit&&<button type="button" className="relay-text-button" onClick={()=>filter({status:'split'})}>← {x('Back to Work Order Inbox sections','Retour aux sections de la boîte de réception')}</button>}
    </section>
  </>;
}

function ReviewForm({ record, language, onSaved, onCancel,onBusy }: { record: IntakeRecord; language: Language; onSaved(record:IntakeRecord): void; onCancel(): void;onBusy(busy:boolean):void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(commandKey());
  const t = (word: Parameters<typeof tr>[1]) => tr(language, word);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();if(busy)return; setBusy(true);onBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const finish=beginPendingNavigation();
    try {
      const dueAt = reviewedTimestamp(String(form.get("dueAt")), record.fields.dueAt);
      const sourceReceivedAt = reviewedTimestamp(String(form.get("sourceReceivedAt")), record.fields.sourceReceivedAt);
      const result=await relayRequest<IntakeRecord>(`/intake/${encodeURIComponent(record.id)}/promote`, { method: "POST", key: key.current, body: { externalId: form.get("externalId"), customerReference: form.get("customerReference"), priority: form.get("priority"), dueAt, sourceReceivedAt, note: form.get("note") } }); onSaved(result);
    } catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false);onBusy(false);finish(); }
  }
  return <section className="relay-card relay-action-card"><h2>{t("reviewTitle")}</h2><p className="relay-warning">{t("sourceDeadlineHelp")}</p>{error && <p className="relay-error" role="alert">{error}</p>}
    <form onSubmit={(event) => void submit(event)} onChange={() => { key.current = commandKey(); }}><fieldset disabled={busy} style={{border:0,padding:0,margin:0}}><div className="relay-form-grid">
      <label>{t("externalId")}<input autoFocus required name="externalId" defaultValue={record.fields.externalId} maxLength={200} /></label><label>{t("customer")}<input required name="customerReference" defaultValue={record.fields.customerReference} maxLength={200} /></label>
      <label>{t("priority")}<input required name="priority" defaultValue={record.fields.priority ?? "urgent"} maxLength={80} /></label>
      <label>{t("sourceReceived")}<input required type="datetime-local" step="0.001" name="sourceReceivedAt" defaultValue={localDateInput(record.fields.sourceReceivedAt)} /></label>
      <label>{t("dueAt")}<input required type="datetime-local" step="0.001" name="dueAt" defaultValue={localDateInput(record.fields.dueAt)} /><small>{t("localTimeHelp")} {Intl.DateTimeFormat().resolvedOptions().timeZone}</small></label>
      <label className="relay-wide">{t("note")}<textarea name="note" defaultValue={record.fields.note} rows={3} maxLength={4000} /></label>
    </div><div className="relay-actions"><button className="relay-primary" disabled={busy} type="submit">{t(busy ? "saving" : "promote")}</button><button type="button" disabled={busy} onClick={onCancel}>{t("cancel")}</button></div></fieldset></form>
  </section>;
}

import {SearchFiltersButton} from './SearchFiltersButton.js';
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { canDispatch, commandKey, relayRequest, type Commitment, type QueueItem, type Session } from "./api.js";
import { dateLabel, errorLabel, stateLabel, tr, type Language } from "./i18n.js";
import { displayWorkOrderState } from "./readModel.js";
import { ux, type WorkFilter } from "./ux.js";
import { useOverview } from "./useOverview.js";
import { jt } from "./jobsI18n.js";

export function ownerName(commitment: Commitment): string | null {
  return commitment.recipients.find((recipient) => recipient.recipientId === commitment.ownerRecipientId)?.displayName ?? null;
}
export function Status({ commitment, language, showDeadlineOutcome = true }: { commitment: Commitment; language: Language; showDeadlineOutcome?: boolean }) {
  const display = displayWorkOrderState(commitment);
  return <span className="relay-status-group"><span className={`relay-status relay-status-${display.lifecycle}`}>{stateLabel(language, display.lifecycle)}</span>{showDeadlineOutcome && display.deadlineMissed && <span className="relay-status relay-status-breached">{stateLabel(language, "breached")}</span>}</span>;
}
export function Queue({ session, language, history, onOpen, initialFilter = 'all', navigate }: {
  session: Session; language: Language; history: boolean; onOpen(id: string): void;
  initialFilter?: WorkFilter; navigate?(path:string):void;
}) {
  const [items,setItems]=useState<QueueItem[]|null>(null),[error,setError]=useState("");
  const [loading,setLoading]=useState(false),[hasMore,setHasMore]=useState(false),[creating,setCreating]=useState(false);
  const [search,setSearch]=useState(""),[querySearch,setQuerySearch]=useState(""),[branchId,setBranchId]=useState("");
  const [filtersOpen,setFiltersOpen]=useState(false);
  const [filter,setFilter]=useState<WorkFilter>(initialFilter);
  const controller=useRef<AbortController|null>(null);
  const retainedPages=useRef(1);
  const overview=useOverview(session);
  const t=(key:Parameters<typeof tr>[1])=>tr(language,key),u=(key:Parameters<typeof ux>[1])=>ux(language,key);
  useEffect(()=>setFilter(initialFilter),[initialFilter]);
  useEffect(()=>{const timer=setTimeout(()=>setQuerySearch(search),250);return()=>clearTimeout(timer);},[search]);
  const refresh=useCallback(async(offset=0)=>{
    controller.current?.abort();const current=new AbortController();controller.current=current;setLoading(true);setError("");
    const query=new URLSearchParams({view:history?'history':'open',offset:String(offset),filter:history?'all':filter,search:querySearch});
    if(branchId)query.set('branchId',branchId);
    try {
      const result=await relayRequest<{items:QueueItem[];hasMore:boolean}>(`/work-orders?${query}`,{signal:current.signal});
      if(offset===0)for(let page=1;page<retainedPages.current&&result.hasMore;page++){
        query.set('offset',String(page*100));
        const next=await relayRequest<{items:QueueItem[];hasMore:boolean}>(`/work-orders?${query}`,{signal:current.signal});
        result.items.push(...next.items);result.hasMore=next.hasMore;
      }
      if(!current.signal.aborted){retainedPages.current=Math.max(1,Math.ceil((offset+result.items.length)/100));setItems(previous=>[...new Map([...(offset===0?[]:previous??[]),...result.items].map(item=>[item.commitment.commitmentId,item])).values()]);setHasMore(result.hasMore);}
    } catch(failure){if(!current.signal.aborted)setError(errorLabel(language,failure));}
    finally{if(!current.signal.aborted)setLoading(false);}
  },[session.organization.id,session.user.id,history,filter,querySearch,branchId,language]);
  useEffect(()=>{retainedPages.current=1;setItems(null);void refresh();return()=>controller.current?.abort();},[refresh]);
  useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!creating)void refresh();},30000);return()=>clearInterval(timer);},[refresh,creating]);
  function selectFilter(next:WorkFilter){setFilter(next);if(!history)navigate?.(`/relay/work?filter=${next}`);}
  const counts=overview.data?.counts;
  const fr=language==='fr';
  const labels:Record<WorkFilter,string>={
    all:fr?'Tous les travaux ouverts':'All open jobs',
    unowned:fr?'En attente de prise en charge':'Waiting for someone to accept',
    overdue:fr?'En retard, sans responsable':'Late and still unaccepted',
    mine:fr?'Acceptés par moi':'Accepted by me',
  };
  const count=counts?.[filter==='all'?'open':filter==='unowned'?'awaitingOwner':filter==='overdue'?'overdue':'ownedByMe'];
  return <>
    {!history&&canDispatch(session)&&<button type="button" className="relay-text-button" onClick={()=>navigate?.('/relay/intake')}>← {fr?'Retour à la boîte des bons de travail':'Back to Work Order Inbox'}</button>}
    <div className="relay-section-heading"><h1>{jt(language,history?'ackHistory':'acknowledgements')}</h1>{history&&<button type="button" disabled={loading} onClick={()=>void refresh()}>{t(loading?'loading':'refresh')}</button>}</div>
    {!history&&<div className="relay-ack-toolbar">
      <strong>{labels[filter]}{count!==undefined&&!overview.error?` · ${count}`:''}</strong>
      <div className="relay-actions">
        <SearchFiltersButton language={language} filtersOpen={filtersOpen} activeFilters={[filter!=='all',search,branchId].filter(Boolean).length} id="relay-ack-filters" onToggle={()=>setFiltersOpen(open=>!open)}/>
        <button type="button" disabled={loading} onClick={()=>{void refresh();void overview.refresh();}}>{t(loading?'loading':'refresh')}</button>
        <details className="relay-ack-more">
          <summary>{fr?'Autres actions':'More actions'}</summary>
          <div className="relay-actions">
            <button type="button" onClick={()=>navigate?.('/relay/history')}>{jt(language,'ackHistory')}</button>
            {canDispatch(session)&&<><button type="button" onClick={()=>setCreating(open=>!open)}>{t(creating?'cancel':'create')}</button><button type="button" onClick={()=>navigate?.('/relay/settings')}>{fr?'Paramètres':'Settings'}</button></>}
          </div>
        </details>
      </div>
    </div>}
    {creating&&<CreateForm session={session} language={language} onCreated={id=>{setCreating(false);onOpen(id);}} onCancel={()=>setCreating(false)}/>}
    {overview.error&&!history&&<p className="relay-warning" role="status">{u(overview.data?'refreshHelp':'unknown')}</p>}
    {error&&<p className="relay-error" role="alert">{error} <button type="button" onClick={()=>void refresh()}>{t('retry')}</button></p>}
    <div id="relay-ack-filters" className="relay-filters relay-collapsible-filters" hidden={!history&&!filtersOpen}>
      {!history&&<label>{fr?'Afficher':'Show'}<select value={filter} onChange={event=>selectFilter(event.target.value as WorkFilter)}>{(['all','unowned','overdue','mine'] as const).map(value=><option key={value} value={value}>{labels[value]}</option>)}</select></label>}
      <label>{fr?'Rechercher des travaux':'Search jobs'}<input type="search" maxLength={200} value={search} onChange={e=>setSearch(e.target.value)}/></label>{session.branches.length>1&&<label>{t('branch')}<select value={branchId} onChange={e=>setBranchId(e.target.value)}><option value="">{t('allBranches')}</option>{session.branches.map(branch=><option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}</div>
    {items===null?!error&&<p role="status">{t('loading')}</p>:items.length===0?<div className="relay-empty"><p>{u('emptyFilter')}</p>{(search||branchId||filter!=='all')&&<button type="button" onClick={()=>{setSearch('');setBranchId('');selectFilter('all');}}>{u('clear')}</button>}</div>:<>
      {history?<>
      <div className="relay-table-wrap relay-work-table"><table className="relay-table"><thead><tr><th>{t('order')}</th><th>{t('status')}</th><th>{t('owner')}</th><th>{t('deadline')}</th></tr></thead><tbody>{items.map(({commitment})=><tr key={commitment.commitmentId}><td><button className="relay-order-link" type="button" onClick={()=>onOpen(commitment.workOrderId)}>{commitment.workOrder.externalId}</button><small>{commitment.workOrder.customerReference}</small></td><td><Status commitment={commitment} language={language}/></td><td>{ownerName(commitment)??t('noOwner')}</td><td><time dateTime={commitment.dueAt}>{dateLabel(language,commitment.dueAt)}</time></td></tr>)}</tbody></table></div>
      <div className="relay-work-cards">{items.map(({commitment})=><article className="relay-card relay-work-card" key={commitment.commitmentId}><div className="relay-card-title"><h2><button type="button" className="relay-order-link" onClick={()=>onOpen(commitment.workOrderId)}>{commitment.workOrder.externalId}</button></h2><Status commitment={commitment} language={language}/></div><p>{commitment.workOrder.customerReference}</p><dl><div><dt>{t('owner')}</dt><dd>{ownerName(commitment)??t('noOwner')}</dd></div><div><dt>{t('deadline')}</dt><dd><time dateTime={commitment.dueAt}>{dateLabel(language,commitment.dueAt)}</time></dd></div></dl><button type="button" className="relay-card-open" onClick={()=>onOpen(commitment.workOrderId)}>{u('viewOrder')} →</button></article>)}</div>
      </>:<div className="relay-ack-cards">{items.map(({commitment,note})=>{
        const {customerReference,externalId}=commitment.workOrder;
        const [client='',...titleParts]=customerReference.split(' — ');
        const title=titleParts.join(' — ').trim();
        const owner=ownerName(commitment);
        const waiting=commitment.ownerRecipientId===null;
        const overdue=waiting&&new Date(commitment.dueAt).getTime()<Date.now();
        return <article key={commitment.commitmentId} className="relay-card relay-ack-card">
          <header className="relay-job-card-heading">
            <h2>{client.trim() || externalId}</h2>
            {client.trim()&&<small>{fr?'Réf.':'Ref.'} {externalId}</small>}
          </header>
          {title&&<p>{title}</p>}
          {note&&note.trim()!==title&&<p>{note}</p>}
          <dl className="relay-ack-facts">
            <div><dt>{fr?'Accepté par':'Accepted by'}</dt><dd className={waiting?'relay-ack-waiting':undefined}>{waiting?(fr?'Personne pour le moment':'No one yet'):(owner??(fr?'Nom indisponible':'Name unavailable'))}</dd></div>
            <div><dt>{fr?'À accepter avant':'Accept by'}</dt><dd className={overdue?'relay-ack-waiting':undefined}><time dateTime={commitment.dueAt} title={commitment.dueAt}>{dateLabel(language,commitment.dueAt)}</time>{overdue&&<span> · {fr?'En retard':'Overdue'}</span>}</dd></div>
          </dl>
          <button type="button" onClick={()=>onOpen(commitment.workOrderId)}>{fr?'Voir la prise en charge du bon de travail':'View work order acknowledgement'} →</button>
        </article>;
      })}</div>}
      <div className="relay-list-footer"><small>{u('loaded')}: {items.length}</small>{hasMore&&<button type="button" disabled={loading} onClick={()=>void refresh(items.length)}>{loading?t('loading'):u('loadMore')}</button>}</div>
    </>}
  </>;
}

export function CreateForm({ session, language, onCreated, onCancel }: { session: Session; language: Language; onCreated(id: string): void; onCancel(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(commandKey());
  const t = (word: Parameters<typeof tr>[1]) => tr(language, word);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    const dueAt = new Date(String(data.get("dueAt")));
    if (!Number.isFinite(dueAt.getTime())) { setError(t("invalidInput")); setBusy(false); return; }
    try {
      const result = await relayRequest<{ commitment: Commitment } | Commitment>("/work-orders", {
        method: "POST", key: key.current,
        body: { branchId: data.get("branchId"), externalId: data.get("externalId"), customerReference: data.get("customerReference"), priority: data.get("priority"), dueAt: dueAt.toISOString(), note: data.get("note") },
      });
      onCreated("commitment" in result ? result.commitment.workOrderId : result.workOrderId);
    } catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false); }
  }
  return <section className="relay-card" aria-labelledby="relay-create-title"><h2 id="relay-create-title">{t("create")}</h2><p className="relay-muted">{t("createHelp")}</p>
    <form onSubmit={(event) => void submit(event)} onChange={() => { key.current = commandKey(); }}>
      {error && <p className="relay-error" role="alert">{error}</p>}
      <div className="relay-form-grid"><label>{t("externalId")}<input autoFocus required name="externalId" maxLength={160} /></label><label>{t("customer")}<input required name="customerReference" maxLength={200} /></label>
        <label>{t("branch")}<select required name="branchId" defaultValue={session.user.branchId || session.branches[0]?.id}>{session.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
        <label>{t("priority")}<select name="priority" defaultValue="urgent"><option value="urgent">{t("urgent")}</option><option value="high">{t("high")}</option><option value="normal">{t("normal")}</option></select></label>
        <label className="relay-wide">{t("dueAt")}<input required name="dueAt" type="datetime-local" /><small>{t("localTimeHelp")} {Intl.DateTimeFormat().resolvedOptions().timeZone}</small></label>
        <label className="relay-wide">{t("note")}<textarea name="note" rows={3} maxLength={4000} /></label></div>
      <div className="relay-actions"><button className="relay-primary" disabled={busy} type="submit">{t(busy ? "saving" : "saveWork")}</button><button disabled={busy} type="button" onClick={onCancel}>{t("cancel")}</button></div>
    </form>
  </section>;
}

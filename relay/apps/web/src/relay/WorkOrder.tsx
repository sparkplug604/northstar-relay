import { useEffect, useRef, useState, type FormEvent } from "react";
import { commandKey, getDetail, relayRequest, workOrderPath, type Commitment, type Detail, type Session } from "./api.js";
import { dateLabel, errorLabel, stateLabel, tr, type Language } from "./i18n.js";
import { ownerName, Status } from "./Queue.js";
import { eventReason } from "./readModel.js";
import { workOrderActions, type WorkOrderAction } from "./WorkOrderActions.js";
import { jt } from "./jobsI18n.js";
import {DateTime,TimezoneNotice} from './DateTime.js';
import {beginPendingNavigation} from './navigation.js';
import "./workOrder.css";

const titles = { acknowledge: "takeOwnership", decline: "decline", cancel: "cancelWork", source_acceptance: "recordSource", fulfill: "fulfill", close: "closeWork" } as const;
export function WorkOrder({ id, session, language, onBack, onJob, embedded=false, onChanged, onSource }: { id: string; session: Session; language: Language; onBack(): void; onJob?(id:string):void;embedded?:boolean;onChanged?():void;onSource?(commitment:Commitment):void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<WorkOrderAction | null>(null);
  const key = useRef(commandKey());
  const submitting = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const t = (word: Parameters<typeof tr>[1]) => tr(language, word);
  async function refresh() {
    try { setDetail(await getDetail(id)); setError(""); }
    catch (failure) { setError(errorLabel(language, failure)); }
  }
  useEffect(() => { setDetail(null); setAction(null); setNotice(false); setError(""); void refresh(); }, [id]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible" && !submitting.current && action === null) void refresh(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [id, action, language]);
  useEffect(() => {
    const element = dialog.current;
    if (action && element && !element.open) element.showModal();
    if (!action && element?.open) {
      element.close();
      (opener.current?.isConnected ? opener.current : backButton.current)?.focus();
    }
  }, [action]);
  function chooseAction(value: WorkOrderAction) {
    if (submitting.current) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAction(value); key.current = commandKey(); setActionError(""); setNotice(false);
  }
  function dismissAction() { if (!submitting.current) setAction(null); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!detail || !action || submitting.current) return;
    submitting.current = true; setBusy(true); setActionError("");
    const finish=beginPendingNavigation();
    const form = new FormData(event.currentTarget);
    try {
      const result = await relayRequest<{ commitment: Commitment }>(`${workOrderPath(detail.commitment)}/actions`, {
        method: "POST", key: key.current,
        body: { action, ...(form.has("reason") ? { reason: form.get("reason") } : {}), ...(form.has("recipientId") ? { recipientId: form.get("recipientId") } : {}), ...(form.has("sourceStatus") ? { sourceStatus: form.get("sourceStatus") } : {}) },
      });
      setDetail((current) => current ? { ...current, commitment: result.commitment } : current);
      setAction(null); setNotice(true); await refresh();onChanged?.();
    } catch (failure) { setActionError(errorLabel(language, failure)); }
    finally { finish();submitting.current = false; setBusy(false); }
  }
  const state = detail?.commitment;
  const actions = state && detail ? workOrderActions(state, session, detail.attempts) : null;
  const fr=language==="fr";
  const waiting=state?.ownerRecipientId===null;
  const stillOpen=state && !["fulfilled","cancelled","closed"].includes(state.status);
  const [client,...jobTitle]=state?.workOrder.customerReference.split(" — ")??[];
  const actionTitle = (value: WorkOrderAction) => value === "acknowledge" && actions?.canManage && !embedded
    ? (fr?"Indiquer qui a accepté":"Record who accepted")
    : t(value === "acknowledge" && actions?.canManage ? "recordOwner" : titles[value]);
  return <div className={`relay-work-order ${embedded?'relay-embedded-ack':''}`}>
    {!embedded&&<button ref={backButton} type="button" className="relay-text-button" onClick={onBack}>← {fr?"Retour aux prises en charge":"Back to Work Order Acknowledgements"}</button>}
    {error && <p className="relay-error" role="alert">{error} <button type="button" onClick={() => void refresh()}>{t("retry")}</button></p>}
    {notice && <p className="relay-notice" role="status">{t("changeSaved")}</p>}
    {!detail || !state || !actions ? !error && <p role="status">{t("loading")}</p> : <>
      <div className="relay-section-heading"><div>{embedded?<h2>{jt(language,'showAck')}</h2>:<><div className="relay-job-card-heading"><h1>{client || state.workOrder.externalId}</h1>{client&&<small>{fr?"Réf.":"Ref."} {state.workOrder.externalId}</small>}</div>{jobTitle.length>0&&<p>{jobTitle.join(" — ")}</p>}</>}</div></div>
      {!embedded&&<TimezoneNotice language={language}/>}
      {onJob&&<p className="relay-notice">{jt(language,'ackHelp')} <button type="button" onClick={()=>onJob(state.commitmentId)}>{jt(language,'view')} →</button></p>}
      <section className="relay-work-action-rail" aria-label={language === "fr" ? "État et actions de l’ordre" : "Work-order status and actions"}>
        <div className="relay-work-current">
          {embedded?<><span className="relay-eyebrow">{t("status")}</span><Status commitment={state} language={language}/><p>{t("owner")}: <strong>{ownerName(state) ?? t("noOwner")}</strong></p></>:<>
            <h2>{waiting&&stillOpen?(fr?"Personne n’a encore accepté":"No one has accepted yet"):fr?"Prise en charge":"Acceptance"}</h2>
            <dl className="relay-work-acceptance">
              <div><dt>{fr?"Accepté par":"Accepted by"}</dt><dd>{waiting?(fr?"Personne pour le moment":"No one yet"):(ownerName(state)??(fr?"Nom indisponible":"Name unavailable"))}{state.acknowledgedAt&&<small><DateTime value={state.acknowledgedAt} language={language}/></small>}</dd></div>
              <div><dt>{fr?"À accepter avant":"Accept by"}</dt><dd><DateTime value={state.dueAt} language={language}/>{waiting&&state.breachedAt&&<small className="relay-overdue">{fr?"En retard":"Overdue"}</small>}</dd></div>
            </dl>
            <Status commitment={state} language={language} showDeadlineOutcome={!(waiting&&state.breachedAt)}/>
          </>}
        </div>
        <div className="relay-work-next">
          {!embedded&&waiting&&stillOpen&&<div className="relay-work-acceptance-help">
            <strong>{fr?"Que faire ?":"What to do next"}</strong>
            <p>{actions.allowed.acknowledge
              ? actions.canManage
                ? (fr?"Si quelqu’un a accepté en dehors de Relay, indiquez son nom. Sinon, vérifiez les tentatives de contact.":"If someone agreed outside Relay, record their name. Otherwise, check the contact attempts.")
                : (fr?"Acceptez si vous pouvez prendre ce travail en charge.":"Accept the job if you can take responsibility for it.")
              : (fr?"Consultez les tentatives de contact pour voir qui Relay a tenté de joindre.":"Check the contact attempts to see who Relay tried to reach.")}</p>
            <a href="#relay-ack-contact-attempts">{fr?"Voir les tentatives de contact":"See contact attempts"} ↓</a>
          </div>}
          {actions.primary ? <>{(embedded||!waiting||!stillOpen)&&<span className="relay-eyebrow">{language === "fr" ? "Prochaine action" : "Next action"}</span>}<button className="relay-primary" type="button" disabled={busy} onClick={() => chooseAction(actions.primary!)}>{actionTitle(actions.primary)}</button></> : <p className="relay-muted">{actions.hasDeclined ? (language === "fr" ? "Votre refus est enregistré." : "Your decline is recorded.") : actions.allowed.close ? (language === "fr" ? "Vérifiez l’historique avant de clore l’ordre." : "Review the history before closing this work order.") : (language === "fr" ? "Aucune action de prise en charge disponible." : "No ownership action available.")}</p>}
          {(actions.allowed.decline || (actions.allowed.source_acceptance && actions.primary !== "source_acceptance")) && <div className="relay-actions relay-work-secondary">
            {actions.allowed.decline && <button type="button" onClick={() => chooseAction("decline")}>{t("decline")}</button>}
            {actions.allowed.source_acceptance && actions.primary !== "source_acceptance" && <button type="button" onClick={() => chooseAction("source_acceptance")}>{t("recordSource")}</button>}
          </div>}
        </div>
      </section>
      <div className="relay-detail-grid"><section className="relay-card"><dl className="relay-facts">
        {embedded&&<><div><dt>{t("owner")}</dt><dd>{ownerName(state) ?? t("noOwner")}{state.acknowledgedAt && <small>{dateLabel(language, state.acknowledgedAt)}</small>}</dd></div>
        <div><dt>{t("dueAt")}</dt><dd><DateTime value={state.dueAt} language={language}/>{state.breachedAt && <small className="relay-overdue">{stateLabel(language, "breached")}</small>}</dd></div></>}
        {!embedded&&<><div><dt>{t("branch")}</dt><dd>{session.branches.find((branch) => branch.id === state.branchId)?.name ?? state.branchId}</dd></div><div><dt>{t("priority")}</dt><dd>{["urgent", "high", "normal"].includes(state.workOrder.priority) ? t(state.workOrder.priority as "urgent" | "high" | "normal") : state.workOrder.priority}</dd></div></>}
      </dl>{!embedded&&detail.note && <p className="relay-note">{detail.note}</p>}
      {embedded && !state.ownerRecipientId && ["active", "breached"].includes(state.status) && <p className="relay-muted">{t("ownershipHelp")}</p>}
      </section><section className="relay-card"><h2>{t("source")}</h2><p><strong>{stateLabel(language, state.sourceAcceptance.status)}</strong></p><p className="relay-muted">{t("sourceHelp")}</p>{state.sourceAcceptance.recordedAt && <p><DateTime value={state.sourceAcceptance.recordedAt} language={language}/></p>}<dl className="relay-facts"><div><dt>{jt(language,'requestSource')}</dt><dd>{state.workOrder.sourceKind==='manual'?jt(language,'sourceManual'):state.workOrder.sourceKind==='email'?jt(language,'sourceEmail'):state.workOrder.sourceKind==='servicechannel'?'ServiceChannel':state.workOrder.sourceKind==='corrigo'?'Corrigo':state.workOrder.sourceKind}</dd></div><div><dt>{t('sourceReceived')}</dt><dd><DateTime value={state.workOrder.sourceReceivedAt} language={language}/></dd></div></dl>{onSource&&actions.canManage&&state.workOrder.sourceKind==='email'&&<button type="button" onClick={()=>onSource(state)}>{jt(language,'viewSource')} →</button>}</section></div>
      {(actions.allowed.cancel || actions.allowed.close) && <section className="relay-work-administration" aria-label={language === "fr" ? "Actions administratives" : "Administrative actions"}><p className="relay-muted">{t("reasonHelp")}</p><div className="relay-actions">
        {actions.allowed.cancel && <button className="relay-danger" type="button" onClick={() => chooseAction("cancel")}>{t("cancelWork")}</button>}
        {actions.allowed.close && <button className="relay-danger" type="button" onClick={() => chooseAction("close")}>{t("closeWork")}</button>}
      </div></section>}
      <dialog ref={dialog} className="relay-work-dialog" aria-labelledby="relay-action-title" onCancel={(event) => { event.preventDefault(); dismissAction(); }} onClose={dismissAction}>
        {action && <><span className="relay-eyebrow">{state.workOrder.externalId}</span><h2 id="relay-action-title">{actionTitle(action)}</h2><form key={action} onSubmit={(event) => void submit(event)} onChange={() => { if (!submitting.current) key.current = commandKey(); }} aria-busy={busy}>
          {actionError && <p className="relay-error" role="alert">{actionError}</p>}
          {action === "acknowledge" && <p>{t("ownershipHelp")}</p>}
          {action === "decline" && <p>{language === "fr" ? "Votre refus sera enregistré. Vous ne pourrez plus prendre cet ordre en charge." : "Your decline will be recorded. You will not be able to take ownership of this work order later."}</p>}
          {action === "fulfill" && <p>{t("fulfillHelp")}</p>}
          {action === "acknowledge" && actions.canManage && <label>{t("owner")}<select autoFocus required disabled={busy} name="recipientId" defaultValue=""><option value="" disabled>{t("choosePerson")}</option>{actions.eligibleRecipients.map((recipient) => <option key={recipient.recipientId} value={recipient.recipientId}>{recipient.displayName}</option>)}</select><small>{t("recordOwnerHelp")}</small></label>}
          {action === "source_acceptance" && <><p>{t("sourceHelp")}</p><label>{t("source")}<select autoFocus disabled={busy} name="sourceStatus" defaultValue={["accepted", "pending", "declined", ...(actions.canManage ? ["not_required"] : [])].includes(state.sourceAcceptance.status) ? state.sourceAcceptance.status : "pending"}>{["accepted", "pending", "declined", ...(actions.canManage ? ["not_required"] : [])].map((value) => <option key={value} value={value}>{stateLabel(language, value)}</option>)}</select></label></>}
          {(action === "cancel" || action === "close") && <label>{t("reason")}<textarea autoFocus disabled={busy} required name="reason" rows={3} minLength={3} maxLength={2000} /><small>{t("reasonHelp")}</small></label>}
          <div className="relay-actions relay-work-dialog-actions"><button type="button" disabled={busy} onClick={dismissAction}>{t("cancel")}</button><button autoFocus={(action === "acknowledge" && !actions.canManage) || action === "decline" || action === "fulfill"} className={action === "cancel" || action === "close" ? "relay-danger" : "relay-primary"} disabled={busy} type="submit">{t(busy ? "saving" : "confirm")}</button></div>
        </form></>}
      </dialog>
      <div className="relay-detail-grid"><section className="relay-card" id={embedded?undefined:"relay-ack-contact-attempts"}><h2>{t("attempts")}</h2>{detail.attempts.length === 0 ? <p className="relay-muted">{t("noAttempts")}</p> : <ul className="relay-list">{detail.attempts.map((attempt, index) => <li key={attempt.attemptId ?? attempt.id ?? index}><div><strong>{state.recipients.find((person) => person.recipientId === attempt.recipientId)?.displayName ?? t("noOwner")}</strong><small>{t(attempt.channel === "sms" ? "sms" : "voice")} · {dateLabel(language, attempt.scheduledAt ?? attempt.createdAt)}</small></div><span className={attempt.status === "failed" || attempt.status === "uncertain" ? "relay-overdue" : ""}>{stateLabel(language, attempt.status)}</span></li>)}</ul>}</section>
        <section className="relay-card"><h2>{t("timeline")}</h2>{detail.events.length === 0 ? <p className="relay-muted">{t("noEvents")}</p> : <ol className="relay-timeline">{[...detail.events].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).map((event) => <li key={event.eventId}><strong>{stateLabel(language, event.eventType)}</strong><time dateTime={event.occurredAt}>{dateLabel(language, event.occurredAt)}</time>{eventReason(event) && <p className="relay-event-reason">{eventReason(event)}</p>}</li>)}</ol>}</section></div>
    </>}
  </div>;
}

import {TechnicianAvailability} from './DispatchPlanning.js';
import { useEffect, useState, type FormEvent } from "react";
import { isAdministrator, relayRequest, type Person, type Session } from "./api.js";
import { errorLabel, stateLabel, tr, type Language } from "./i18n.js";

export function People({ session, language }: { session: Session; language: Language }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Person | "new" | null>(null);
  const [saved, setSaved] = useState(false);
  const [verifying, setVerifying] = useState<Person | null>(null);
  const t = (key: Parameters<typeof tr>[1]) => tr(language, key);
  async function refresh() {
    try { setPeople((await relayRequest<{ items: Person[] }>("/people")).items); setError(""); }
    catch (failure) { setError(errorLabel(language, failure)); }
  }
  useEffect(() => { void refresh(); }, [session.organization.id]);
  return <>
    <div className="relay-section-heading"><h1>{t("people")}</h1>{isAdministrator(session) ? <button className="relay-primary" type="button" onClick={() => { setEditing("new"); setSaved(false); }}>{t("addPerson")}</button> : <button type="button" disabled={!people?.some((person) => person.id === session.user.id)} onClick={() => { setEditing(people?.find((person) => person.id === session.user.id) ?? null); setSaved(false); }}>{t("editProfile")}</button>}</div>
    {error && <p className="relay-error" role="alert">{error} <button type="button" onClick={() => void refresh()}>{t("retry")}</button></p>}
    {saved && <p className="relay-notice" role="status">{t("changeSaved")}</p>}
    {verifying && <VerifyPhone key={verifying.id} person={verifying} language={language} onCancel={() => setVerifying(null)} onVerified={() => { setVerifying(null); setSaved(true); void refresh(); }} />}
    {editing && <PersonForm key={editing === "new" ? "new" : editing.id} session={session} language={language} person={editing === "new" ? null : editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setSaved(true); void refresh(); }} />}
    <TechnicianAvailability session={session} language={language}/>
    {people === null ? !error && <p role="status">{t("loading")}</p> : people.length === 0 ? <p className="relay-empty">{t("noPeople")}</p> : <div className="relay-table-wrap"><table className="relay-table"><thead><tr><th>{t("name")}</th><th>{t("role")}</th><th>{t("phone")}</th><th>{t("status")}</th><th><span className="relay-sr-only">{t("edit")}</span></th></tr></thead><tbody>{people.map((person) => <tr key={person.id}><td><strong>{person.displayName}</strong><small>{person.email}</small></td><td>{stateLabel(language, person.role)}<small>{session.branches.find((branch) => branch.id === person.branchId)?.name}</small></td><td>{person.phone ?? t("emptyPhone")}{person.phone && <small>{t(person.phoneVerified ? "verified" : "unverified")}</small>}</td><td>{t(person.active === false ? "inactive" : "active")}</td><td><div className="relay-actions">{isAdministrator(session) && <button type="button" aria-label={`${t("edit")}: ${person.displayName}`} onClick={() => { setEditing(person); setSaved(false); }}>{t("edit")}</button>}{person.phone && !person.phoneVerified && person.active !== false && (isAdministrator(session) || person.id === session.user.id) && <button type="button" onClick={() => setVerifying(person)}>{t("verifyPhone")}</button>}</div></td></tr>)}</tbody></table></div>}
  </>;
}

export function VerifyPhone({ person, language, onCancel, onVerified, selfProfile = false }: { person: Person; language: Language; onCancel(): void; onVerified(): void; selfProfile?: boolean }) {
  const [sent, setSent] = useState(false);
  const [developmentCode, setDevelopmentCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const t = (key: Parameters<typeof tr>[1]) => tr(language, key);
  async function send() {
    setBusy(true); setError("");
    try {
      const result = await relayRequest<{ sent: boolean; simulated: boolean; developmentCode?: string }>(`/people/${encodeURIComponent(person.id)}/verification/start`, { method: "POST", body: {} });
      setSent(result.sent); setDevelopmentCode(result.simulated ? result.developmentCode ?? null : null);
    } catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false); }
  }
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try { await relayRequest(`/people/${encodeURIComponent(person.id)}/verification/confirm`, { method: "POST", body: { code: form.get("code") } }); onVerified(); }
    catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false); }
  }
  return <section className="relay-card"><h2>{t("verifyPhone")}: {person.displayName}</h2><p>{person.phone}</p><p className="relay-muted">{selfProfile ? language === "fr" ? "En demandant un code, vous acceptez de recevoir un texto de vérification au numéro ci-dessus. Aucun code n’est envoyé avant votre confirmation ci-dessous." : "By requesting a code, you agree to receive a verification text at the number above. No code is sent until you choose Send verification code." : t("verificationConsent")}</p>
    {error && <p className="relay-error" role="alert">{error}</p>}
    {!sent ? <button className="relay-primary" type="button" disabled={busy} onClick={() => void send()}>{t(busy ? "loading" : "sendCode")}</button> : <form onSubmit={(event) => void confirm(event)}>
      {developmentCode && <p className="relay-warning">{t("testCode")}: <code>{developmentCode}</code></p>}
      <label>{t("verificationCode")}<input autoFocus required name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} /></label>
      <div className="relay-actions"><button className="relay-primary" type="submit" disabled={busy}>{t(busy ? "saving" : "confirm")}</button><button type="button" disabled={busy} onClick={() => void send()}>{t("sendCode")}</button></div>
    </form>}
    <button className="relay-text-button" disabled={busy} type="button" onClick={onCancel}>{t("cancel")}</button>
  </section>;
}

export function PersonForm({ session, language, person, onSaved, onCancel, selfProfile = false }: { session: Session; language: Language; person: Person | null; onSaved(): void; onCancel(): void; selfProfile?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const t = (key: Parameters<typeof tr>[1]) => tr(language, key);
  const manageAccount = isAdministrator(session) && !selfProfile;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    const common = { displayName: String(data.get("displayName")).trim(), phone: String(data.get("phone") ?? "").trim() || null };
    try {
      await relayRequest(person ? `/people/${encodeURIComponent(person.id)}` : "/people", {
        method: person ? "PATCH" : "POST",
        body: person ? { ...common, ...(manageAccount ? { active: data.get("active") === "on" } : {}) } : { ...common, email: data.get("email"), password: data.get("password"), role: data.get("role"), branchId: data.get("branchId") },
      });
      onSaved();
    } catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false); }
  }
  return <section className="relay-card" aria-labelledby="relay-person-title"><h2 id="relay-person-title">{t(selfProfile ? "editProfile" : person ? "edit" : "addPerson")}</h2><form onSubmit={(event) => void submit(event)}>
    {error && <p className="relay-error" role="alert">{error}</p>}
    <div className="relay-form-grid"><label>{t("name")}<input autoFocus required name="displayName" defaultValue={person?.displayName} maxLength={160} /></label>
      <label>{t("phone")}<input name="phone" type="tel" defaultValue={person?.phone ?? ""} pattern="\+[1-9][0-9]{7,14}" placeholder="+16045550123" /><small>{t("phoneHelp")}</small></label>
      {!person && <><label>{t("email")}<input required name="email" type="email" autoComplete="off" maxLength={254} /></label><label>{t("initialPassword")}<input required name="password" type="password" minLength={12} autoComplete="new-password" /><small>{t("passwordHelp")}</small></label>
        <label>{t("role")}<select name="role" defaultValue="on_call_responder">{["on_call_responder", "branch_dispatcher", "organization_admin"].map((role) => <option key={role} value={role}>{stateLabel(language, role)}</option>)}</select></label>
        <label>{t("branch")}<select name="branchId" defaultValue={session.user.branchId || session.branches[0]?.id}>{session.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label></>}
      {person && manageAccount && <label className="relay-check"><input type="checkbox" name="active" defaultChecked={person.active !== false} disabled={person.id === session.user.id} />{t("active")}{person.id === session.user.id && <input type="hidden" name="active" value="on" />}</label>}
    </div>{!person && <p className="relay-muted">{t("newAccountHelp")}</p>}<p className="relay-muted">{t("phoneVerification")}</p><div className="relay-actions"><button className="relay-primary" type="submit" disabled={busy}>{t(busy ? "saving" : "save")}</button><button type="button" disabled={busy} onClick={onCancel}>{t("cancel")}</button></div>
  </form></section>;
}

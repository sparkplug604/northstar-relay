import { useEffect, useState, type FormEvent } from "react";
import { relayRequest, type Session } from "./api.js";
import { errorLabel, tr, type Language } from "./i18n.js";

interface Connection { id: string; branchId: string; name: string; active: boolean }
export function Connections({ session, language }: { session: Session; language: Language }) {
  const [items, setItems] = useState<Connection[] | null>(null);
  const [credentials, setCredentials] = useState<{ token: string; url: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const t = (word: Parameters<typeof tr>[1]) => tr(language, word);
  async function load() {
    try { setItems((await relayRequest<{ items: Connection[] }>("/intake/connections")).items); setError(""); }
    catch (failure) { setError(errorLabel(language, failure)); }
  }
  useEffect(() => { void load(); }, [session.organization.id]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await relayRequest<{ id: string; token: string; url: string }>("/intake/connections", { method: "POST", body: { branchId: form.get("branchId"), name: form.get("name") } });
      setCredentials({ token: result.token, url: result.url }); await load();
    } catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false); }
  }
  async function revoke() {
    if (!revokeId) return;
    setBusy(true); setError("");
    try { await relayRequest(`/intake/connections/${encodeURIComponent(revokeId)}`, { method: "PATCH", body: { active: false } }); setRevokeId(null); await load(); }
    catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false); }
  }
  return <section className="relay-card"><h2>{t("connections")}</h2><p className="relay-muted">{t("connectionHelp")}</p>
    {error && <p className="relay-error" role="alert">{error} <button type="button" onClick={() => void load()}>{t("retry")}</button></p>}
    {credentials ? <div className="relay-warning"><p>{t("connectionTokenHelp")}</p><label>{t("connectionUrl")}<input value={credentials.url} readOnly onFocus={(event) => event.target.select()} /></label><label>{t("connectionToken")}<textarea value={credentials.token} readOnly rows={2} onFocus={(event) => event.target.select()} /></label><button type="button" onClick={() => setCredentials(null)}>{t("credentialsSaved")}</button></div>
      : <form onSubmit={(event) => void create(event)}><div className="relay-form-grid"><label>{t("connectionName")}<input name="name" required maxLength={100} /></label><label>{t("branch")}<select name="branchId" defaultValue={session.user.branchId || session.branches[0]?.id}>{session.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label></div><button className="relay-primary" disabled={busy} type="submit">{t(busy ? "saving" : "createConnection")}</button></form>}
    {items && items.length > 0 && <ul className="relay-list">{items.map((item) => <li key={item.id}><div><strong>{item.name}</strong><small>{session.branches.find((branch) => branch.id === item.branchId)?.name} · {t(item.active ? "active" : "inactive")}</small></div>{item.active && (revokeId === item.id ? <div className="relay-actions"><button className="relay-danger" type="button" disabled={busy} onClick={() => void revoke()}>{t("confirmRevoke")}</button><button type="button" disabled={busy} onClick={() => setRevokeId(null)}>{t("cancel")}</button></div> : <button type="button" onClick={() => setRevokeId(item.id)}>{t("revoke")}</button>)}</li>)}</ul>}
  </section>;
}


import { useEffect, useState, type FormEvent } from "react";
import { canDispatch, relayRequest, type Channel, type Person, type Session, type Settings } from "./api.js";
import { errorLabel, tr, type Language } from "./i18n.js";
import { Schedule } from "./Schedule.js";

export function OnCall({ session, language }: { session: Session; language: Language }) {
  const [branchId, setBranchId] = useState(session.user.branchId || session.branches[0]?.id || "");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const t = (word: Parameters<typeof tr>[1]) => tr(language, word);
  const editable = canDispatch(session);
  async function load() {
    setSettings(null); setError(""); setSaved(false);
    try {
      const [configuration, contacts] = await Promise.all([
        relayRequest<Settings>(`/settings?branchId=${encodeURIComponent(branchId)}`),
        relayRequest<{ items: Person[] }>("/people"),
      ]);
      setSettings(configuration); setPeople(contacts.items);
    } catch (failure) { setError(errorLabel(language, failure)); }
  }
  useEffect(() => { if (branchId) void load(); }, [branchId]);
  function update(patch: Partial<Settings>) { if (settings) { setSettings({ ...settings, ...patch }); setSaved(false); } }
  function move(index: number, delta: number) {
    if (!settings) return;
    const list = [...settings.recipientIds];
    const value = list[index]; const other = list[index + delta];
    if (value === undefined || other === undefined) return;
    list[index] = other; list[index + delta] = value; update({ recipientIds: list });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!settings) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      const updated = await relayRequest<Settings>("/settings", { method: "PUT", body: { branchId, expectedVersion: settings.version, recipientIds: settings.recipientIds, intervalSeconds: settings.intervalSeconds, channels: settings.channels, timezone: settings.timezone } });
      setSettings(updated); setSaved(true);
    }
    catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false); }
  }
  const eligible = people.filter((person) => person.active !== false && person.branchId === branchId && person.phone && person.phoneVerified);
  return <>
    <div className="relay-section-heading"><h1>{t("onCall")}</h1></div>
    <label className="relay-branch-picker">{t("branch")}<select value={branchId} onChange={(event) => setBranchId(event.target.value)} disabled={busy}>{session.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
    {error && <p className="relay-error" role="alert">{error} <button type="button" onClick={() => void load()}>{t("retry")}</button></p>}
    {saved && <p className="relay-notice" role="status">{t("changeSaved")}</p>}
    {!settings ? !error && <p role="status">{t("loading")}</p> : <section className="relay-card"><h2>{t("contactOrder")}</h2><p className="relay-muted">{t("settingsHelp")}</p>
      <form onSubmit={(event) => void save(event)}>
        {settings.recipientIds.length === 0 && <p className="relay-warning">{t("noContacts")}</p>}
        <ol className="relay-contact-order">{settings.recipientIds.map((id, index) => {
          const person = people.find((item) => item.id === id);
          return <li key={id}><span className="relay-step-number">{index + 1}</span><div><strong>{person?.displayName ?? id}</strong><small>{person?.phone ?? t("emptyPhone")}{!person?.phoneVerified && ` · ${t("unverified")}`}{person?.active === false && ` · ${t("inactive")}`}</small></div>{editable && <div className="relay-actions"><button type="button" disabled={index === 0 || busy} aria-label={`${t("moveUp")}: ${person?.displayName ?? id}`} onClick={() => move(index, -1)}>↑</button><button type="button" disabled={index === settings.recipientIds.length - 1 || busy} aria-label={`${t("moveDown")}: ${person?.displayName ?? id}`} onClick={() => move(index, 1)}>↓</button><button type="button" disabled={busy} aria-label={`${t("remove")}: ${person?.displayName ?? id}`} onClick={() => update({ recipientIds: settings.recipientIds.filter((value) => value !== id) })}>{t("remove")}</button></div>}</li>;
        })}</ol>
        {editable && <label>{t("addContact")}<select value="" disabled={busy} onChange={(event) => { if (event.target.value) update({ recipientIds: [...settings.recipientIds, event.target.value] }); }}><option value="">{t("choosePerson")}</option>{eligible.filter((person) => !settings.recipientIds.includes(person.id)).map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select><small>{t("verifiedContactsOnly")}</small></label>}
        <div className="relay-form-grid"><label>{t("interval")}<input type="number" min={0.25} max={60} step={0.25} required disabled={!editable || busy} value={settings.intervalSeconds / 60} onChange={(event) => update({ intervalSeconds: Number(event.target.value) * 60 })} /></label>
          <label>{t("timezone")}<select disabled={!editable || busy} value={settings.timezone} onChange={(event) => update({ timezone: event.target.value })}>{[...new Set([settings.timezone, "America/Vancouver", "America/Edmonton", "America/Regina", "America/Winnipeg", "America/Toronto", "America/Halifax", "America/St_Johns"])].map((zone) => <option key={zone}>{zone}</option>)}</select></label></div>
        <fieldset><legend>{t("channels")}</legend><div className="relay-actions">{(["voice", "sms"] as Channel[]).map((channel) => <label className="relay-check" key={channel}><input type="checkbox" checked={settings.channels.includes(channel)} disabled={!editable || busy} onChange={(event) => update({ channels: event.target.checked ? [...settings.channels, channel] : settings.channels.filter((value) => value !== channel) })} />{t(channel)}</label>)}</div></fieldset>
        {editable && <button className="relay-primary" type="submit" disabled={busy || settings.recipientIds.length === 0 || settings.channels.length === 0}>{t(busy ? "saving" : "save")}</button>}
      </form>
    </section>}
    {settings && <Schedule key={`${branchId}:${settings.version}`} branchId={branchId} timezone={settings.timezone} people={people} language={language} editable={editable} />}
  </>;
}

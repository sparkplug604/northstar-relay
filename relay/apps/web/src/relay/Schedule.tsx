import { useEffect, useState, type FormEvent } from "react";
import { relayRequest, type Person } from "./api.js";
import { dateLabel, errorLabel, tr, type Language } from "./i18n.js";

interface Override { id: string; startsAt: string; endsAt: string; recipientIds: string[]; reason: string }
interface WeeklyRule { id: string; weekday: number; startTime: string; endTime: string; recipientIds: string[] }
interface ScheduleData { branchId: string; version: number; overrides: Override[]; weeklyRules: WeeklyRule[] }
type NewOverride = Omit<Override, "id">;
type NewRule = Omit<WeeklyRule, "id">;

export function Schedule({ branchId, timezone, people, language, editable }: { branchId: string; timezone: string; people: Person[]; language: Language; editable: boolean }) {
  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(false);
  const [mode, setMode] = useState<"dated" | "weekly" | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [endOfDay, setEndOfDay] = useState(false);
  const t = (word: Parameters<typeof tr>[1]) => tr(language, word);
  const days = language === "fr" ? ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"] : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const eligible = people.filter((person) => person.active !== false && person.branchId === branchId && person.phone && person.phoneVerified);
  const names = (ids: string[]) => ids.map((id) => people.find((person) => person.id === id)?.displayName ?? id).join(" → ");
  async function load() {
    try { setSchedule(await relayRequest<ScheduleData>(`/schedules?branchId=${encodeURIComponent(branchId)}`)); setError(""); }
    catch (failure) { setError(errorLabel(language, failure)); }
  }
  useEffect(() => { setSchedule(null); setMode(null); setRecipients([]); void load(); }, [branchId]);
  async function save(overrides: (Override | NewOverride)[], weeklyRules: (WeeklyRule | NewRule)[]): Promise<boolean> {
    if (!schedule) return false;
    setBusy(true); setNotice(false); setError("");
    try {
      await relayRequest("/schedules", { method: "PUT", body: { branchId, expectedVersion: schedule.version, overrides, weeklyRules } });
      await load(); setNotice(true); return true;
    } catch (failure) { setError(errorLabel(language, failure)); return false; }
    finally { setBusy(false); }
  }
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!schedule || recipients.length === 0) return;
    const form = new FormData(event.currentTarget); let success = false;
    if (mode === "weekly") {
      success = await save(schedule.overrides, [...schedule.weeklyRules, { weekday: Number(form.get("weekday")), startTime: String(form.get("startTime")), endTime: endOfDay ? "24:00" : String(form.get("endTime")), recipientIds: recipients }]);
    } else {
      const starts = new Date(String(form.get("startsAt"))); const ends = new Date(String(form.get("endsAt")));
      if (!Number.isFinite(starts.getTime()) || !Number.isFinite(ends.getTime()) || starts >= ends) { setError(t("invalidInput")); return; }
      success = await save([...schedule.overrides, { startsAt: starts.toISOString(), endsAt: ends.toISOString(), recipientIds: recipients, reason: String(form.get("reason")) }], schedule.weeklyRules);
    }
    if (success) { setMode(null); setRecipients([]); }
  }
  function changeMode(value: "weekly" | "dated") { setMode(value); setEndOfDay(false); setRecipients([]); setNotice(false); setError(""); }
  function move(index: number, delta: number) {
    const ids = [...recipients]; const item = ids[index]; const other = ids[index + delta];
    if (item === undefined || other === undefined) return;
    ids[index] = other; ids[index + delta] = item; setRecipients(ids);
  }
  return <section className="relay-card"><h2>{t("schedule")}</h2><p className="relay-muted">{t("scheduleHelp")}</p>
    {error && <p className="relay-error" role="alert">{error} <button type="button" disabled={busy} onClick={() => void load()}>{t("refresh")}</button></p>}
    {notice && <p className="relay-notice" role="status">{t("changeSaved")}</p>}
    {!schedule ? !error && <p role="status">{t("loading")}</p> : <>
      <h3>{t("weeklyCoverage")}</h3>{schedule.weeklyRules.length === 0 ? <p className="relay-muted">{t("fallbackCoverage")}</p> : <ul className="relay-list">{schedule.weeklyRules.map((rule) => <li key={rule.id}><div><strong>{days[rule.weekday]} · {rule.startTime}–{rule.endTime}</strong><small>{timezone} · {names(rule.recipientIds)}</small></div>{editable && <button disabled={busy} type="button" onClick={() => void save(schedule.overrides, schedule.weeklyRules.filter((item) => item.id !== rule.id))}>{t("remove")}</button>}</li>)}</ul>}
      <h3>{t("datedOverrides")}</h3>{schedule.overrides.length === 0 ? <p className="relay-muted">{t("noOverrides")}</p> : <ul className="relay-list">{schedule.overrides.map((override) => <li key={override.id}><div><strong>{dateLabel(language, override.startsAt)} – {dateLabel(language, override.endsAt)}</strong><small>{names(override.recipientIds)}</small><small>{override.reason}</small></div>{editable && <button disabled={busy} type="button" onClick={() => void save(schedule.overrides.filter((item) => item.id !== override.id), schedule.weeklyRules)}>{t("remove")}</button>}</li>)}</ul>}
      {editable && <div className="relay-actions"><button type="button" disabled={busy} onClick={() => changeMode("weekly")}>{t("addWeeklyRule")}</button><button type="button" disabled={busy} onClick={() => changeMode("dated")}>{t("addOverride")}</button></div>}
      {mode && <form className="relay-schedule-form" onSubmit={(event) => void add(event)}><h3>{t(mode === "weekly" ? "addWeeklyRule" : "addOverride")}</h3>
        <div className="relay-form-grid">{mode === "weekly" ? <><label>{t("weekday")}<select name="weekday" defaultValue="1">{days.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label><span /><label>{t("starts")}<input type="time" name="startTime" required /></label><div><label>{t("ends")}<input type="time" name="endTime" required={!endOfDay} disabled={endOfDay} /></label><label className="relay-check"><input type="checkbox" checked={endOfDay} onChange={(event) => setEndOfDay(event.target.checked)} />{t("endOfDay")}</label></div><p className="relay-muted relay-wide">{t("weeklyTimeHelp")} {timezone}</p></>
          : <><label>{t("starts")}<input type="datetime-local" name="startsAt" required /></label><label>{t("ends")}<input type="datetime-local" name="endsAt" required /></label><p className="relay-muted relay-wide">{t("localTimeHelp")} {Intl.DateTimeFormat().resolvedOptions().timeZone}</p><label className="relay-wide">{t("reason")}<input name="reason" required minLength={3} maxLength={500} /></label></>}
        </div><fieldset><legend>{t("contactOrder")}</legend><div className="relay-contact-choices">{eligible.map((person) => <label className="relay-check" key={person.id}><input type="checkbox" checked={recipients.includes(person.id)} onChange={(event) => setRecipients(event.target.checked ? [...recipients, person.id] : recipients.filter((id) => id !== person.id))} />{person.displayName}</label>)}</div><small>{t("verifiedContactsOnly")}</small>
          {recipients.length > 0 && <ol className="relay-contact-order">{recipients.map((id, index) => <li key={id}><span className="relay-step-number">{index + 1}</span><div>{people.find((person) => person.id === id)?.displayName}</div><div className="relay-actions"><button disabled={index === 0} type="button" aria-label={`${t("moveUp")}: ${names([id])}`} onClick={() => move(index, -1)}>↑</button><button disabled={index === recipients.length - 1} type="button" aria-label={`${t("moveDown")}: ${names([id])}`} onClick={() => move(index, 1)}>↓</button></div></li>)}</ol>}
        </fieldset><div className="relay-actions"><button className="relay-primary" disabled={busy || recipients.length === 0} type="submit">{t(busy ? "saving" : "save")}</button><button disabled={busy} type="button" onClick={() => setMode(null)}>{t("cancel")}</button></div>
      </form>}
    </>}
  </section>;
}

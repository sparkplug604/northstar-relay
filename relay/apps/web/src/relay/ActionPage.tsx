import { useEffect, useRef, useState } from "react";
import { commandKey, relayRequest } from "./api.js";
import { errorLabel, tr, type Language } from "./i18n.js";

export function ActionPage({ token, language, setLanguage }: { token: string; language: Language; setLanguage(value: Language): void }) {
  const [state, setState] = useState<"loading" | "available" | "unavailable" | "accepted" | "declined">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const actionKey = useRef({ acknowledge: commandKey(), decline: commandKey() });
  const path = `/action/${encodeURIComponent(token)}`;
  const t = (key: Parameters<typeof tr>[1]) => tr(language, key);
  async function load() {
    setError("");
    try {
      const result = await relayRequest<{ status: "available" | "unavailable"; locale: Language }>(path);
      setState(result.status); if (result.locale === "en" || result.locale === "fr") setLanguage(result.locale);
    } catch { setState("unavailable"); }
  }
  useEffect(() => { void load(); }, [token]);
  async function respond(action: "acknowledge" | "decline") {
    setBusy(true); setError("");
    try {
      const result = await relayRequest<{ status: "accepted" | "declined" | "unavailable" }>(path, { method: "POST", body: { action }, key: actionKey.current[action], unauthenticated: true });
      setState(result.status);
    } catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false); }
  }
  return <section className="relay-auth relay-card" aria-labelledby="relay-action-page-title"><h1 id="relay-action-page-title">{t("actionTitle")}</h1>
    {error && <p className="relay-error" role="alert">{error}</p>}
    {state === "loading" ? <p role="status">{t("loading")}</p> : state === "available" ? <><p>{t("actionHelp")}</p><p className="relay-muted">{t("ownershipHelp")}</p><div className="relay-actions"><button className="relay-primary" type="button" disabled={busy} onClick={() => void respond("acknowledge")}>{t(busy ? "saving" : "takeOwnership")}</button><button type="button" disabled={busy} onClick={() => void respond("decline")}>{t("decline")}</button></div><p className="relay-muted">{t("actionNoDetails")}</p></>
      : state === "unavailable" ? <p role="status">{t("invalidLink")}</p> : <p className="relay-notice" role="status">{t("actionAccepted")}</p>}
    <a className="relay-text-button" href="/relay" referrerPolicy="no-referrer">{t("signInLink")}</a>
  </section>;
}


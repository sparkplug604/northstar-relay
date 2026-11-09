import { useState, type FormEvent } from "react";
import { isMfaChallenge, relayRequest, useSessionToken, type AuthResult, type Session } from "./api.js";
import { errorLabel, tr, type Language } from "./i18n.js";

export function Auth({ language, onSession }: { language: Language; onSession(session: Session): void }) {
  const [mode, setMode] = useState<"login" | "setup">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mfa, setMfa] = useState<"enroll" | "confirm" | null>(null);
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<{ session: Session | null; codes: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const t = (key: Parameters<typeof tr>[1]) => tr(language, key);

  const demoLogin = mode === "login" && import.meta.env.VITE_RELAY_PLANNING_DEMO === "true" &&
    window.location.origin === "http://127.0.0.1:3004";

  async function authenticate(action: typeof mode | "demo", body: object) {
    setBusy(true); setError("");
    try {
      const result = await relayRequest<AuthResult>(`/auth/${action}`, { method: "POST", body, unauthenticated: true });
      if (isMfaChallenge(result)) { useSessionToken(result); setMfa(result.enrollmentRequired ? "enroll" : "confirm"); }
      else onSession(await relayRequest<Session>("/session"));
    } catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void authenticate(mode, Object.fromEntries(new FormData(event.currentTarget)));
  }
  async function enroll() {
    setBusy(true); setError("");
    try {
      const result = await relayRequest<{ secret: string; uri: string }>("/auth/mfa/enroll", { method: "POST", body: {} });
      setSecret(result.secret); setMfa("confirm");
    } catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false); }
  }
  async function confirmMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await relayRequest<{ csrfToken: string; recoveryCodes?: string[] }>("/auth/mfa/confirm", { method: "POST", body: { totpCode: code.trim() } });
      useSessionToken(result);
      if (result.recoveryCodes?.length) setRecovery({ session: null, codes: result.recoveryCodes });
      const session = await relayRequest<Session>("/session");
      setSecret(""); setCode("");
      if (result.recoveryCodes?.length) setRecovery({ session, codes: result.recoveryCodes });
      else onSession(session);
    } catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false); }
  }
  async function copyText(value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(true); }
    catch { setCopied(false); }
  }
  async function finishRecovery() {
    if (!recovery) return;
    setBusy(true); setError("");
    try { onSession(recovery.session ?? await relayRequest<Session>("/session")); }
    catch (failure) { setError(errorLabel(language, failure)); }
    finally { setBusy(false); }
  }

  if (recovery) return <section className="relay-auth relay-card" aria-labelledby="relay-recovery-title">
    <h1 id="relay-recovery-title">{t("recoveryTitle")}</h1><p>{t("recoveryHelp")}</p>
    {error && <p className="relay-error" role="alert">{error}</p>}
    <pre className="relay-secret">{recovery.codes.join("\n")}</pre>
    <button type="button" onClick={() => void copyText(recovery.codes.join("\n"))}>{t(copied ? "copied" : "copy")}</button>
    <button className="relay-primary" disabled={busy} type="button" onClick={() => void finishRecovery()}>{t(busy ? "loading" : "recoverySaved")}</button>
  </section>;

  if (mfa) return <section className="relay-auth relay-card" aria-labelledby="relay-mfa-title">
    <h1 id="relay-mfa-title">{t("mfaTitle")}</h1>
    {error && <p className="relay-error" role="alert">{error}</p>}
    {mfa === "enroll" ? <><p>{t("mfaHelp")}</p><button className="relay-primary" disabled={busy} type="button" onClick={() => void enroll()}>{t(busy ? "loading" : "mfaGenerate")}</button></>
      : <form onSubmit={(event) => void confirmMfa(event)}>
        <p>{t(secret ? "mfaHelp" : "mfaSignIn")}</p>
        {secret && <><code className="relay-secret">{secret}</code><button type="button" onClick={() => void copyText(secret)}>{t(copied ? "copied" : "copy")}</button></>}
        <label>{t(secret ? "mfaCode" : "mfaOrRecovery")}<input autoFocus required name="totpCode" autoComplete="one-time-code" inputMode={secret ? "numeric" : "text"} pattern={secret ? "[0-9]{6}" : undefined} minLength={6} maxLength={secret ? 6 : 80} value={code} onChange={(event) => setCode(event.target.value)} /></label>
        <button className="relay-primary" disabled={busy} type="submit">{t(busy ? "loading" : "confirm")}</button>
      </form>}
  </section>;

  return <section className="relay-auth relay-card" aria-labelledby="relay-auth-title">
    <h1 id="relay-auth-title">{t(mode === "login" ? "signIn" : "setup")}</h1>
    {error && <p className="relay-error" role="alert">{error}</p>}
    {demoLogin && <div className="relay-demo-login">
      <p>{language === "fr" ? "Essayer le compte de démonstration" : "Try the synthetic demo account"}</p>
      <small><code>dispatch@relay-demo.invalid</code></small>
      <button className="relay-primary" type="button" disabled={busy} onClick={() => void authenticate("demo", {})}>
        {busy ? t("loading") : language === "fr" ? "Se connecter comme Drew Dispatcher" : "Sign in as Drew Dispatcher"}
      </button>
      <a href="https://github.com/sparkplug604/northstar-relay/blob/main/docs/getting-started.md">{language === "fr" ? "Guide de démarrage" : "Getting Started"}</a>
    </div>}
    <form key={mode} onSubmit={submit}>
      {mode === "setup" && <>
        <p className="relay-muted">{t("setupHelp")}</p>
        <label>{t("setupToken")}<input name="setupToken" type="password" required autoComplete="off" /></label>
        <label>{t("organization")}<input name="organizationName" required maxLength={160} autoComplete="organization" /></label>
        <label>{t("branch")}<input name="branchName" required maxLength={160} /></label>
        <label>{t("timezone")}<select name="timezone" defaultValue="America/Vancouver">{["America/Vancouver", "America/Edmonton", "America/Regina", "America/Winnipeg", "America/Toronto", "America/Halifax", "America/St_Johns"].map((zone) => <option key={zone}>{zone}</option>)}</select></label>
        <label>{t("name")}<input name="displayName" required maxLength={160} autoComplete="name" /></label>
      </>}
      <label>{t("email")}<input autoFocus name="email" type="email" required autoComplete="username" maxLength={254} /></label>
      <label>{t("password")}<input name="password" type="password" required minLength={mode === "setup" ? 12 : undefined} autoComplete={mode === "setup" ? "new-password" : "current-password"} />{mode === "setup" && <small>{t("passwordHelp")}</small>}</label>
      <button className={demoLogin ? undefined : "relay-primary"} disabled={busy} type="submit">{t(busy ? "loading" : mode === "login" ? "signIn" : "createAccount")}</button>
    </form>
    <button className="relay-text-button" type="button" disabled={busy} onClick={() => { setMode(mode === "login" ? "setup" : "login"); setError(""); }}>{t(mode === "login" ? "setup" : "backLogin")}</button>
  </section>;
}

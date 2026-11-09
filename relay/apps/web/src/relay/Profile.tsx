import { useEffect, useState } from "react";
import { relayRequest, type Person, type Session } from "./api.js";
import { PersonForm, VerifyPhone } from "./People.js";
import { errorLabel, stateLabel, tr, type Language } from "./i18n.js";
import "./profile.css";

const words = {
  title: ["My profile", "Mon profil"],
  introduction: ["Your account and the phone number used to reach you.", "Votre compte et le numéro utilisé pour vous joindre."],
  account: ["Account details", "Renseignements du compte"],
  managedDetails: ["Your email, role and branch are managed by your organization.", "Votre organisation gère votre courriel, votre rôle et votre succursale."],
  contact: ["My contact number", "Mon numéro de contact"],
  contactHelp: ["Keep this number up to date so your team can reach you. Changing it requires verification again.", "Gardez ce numéro à jour afin que votre équipe puisse vous joindre. Tout changement nécessite une nouvelle vérification."],
  addPhoneHelp: ["Add a phone number in Edit my details, then verify it here.", "Ajoutez un numéro dans Modifier mes renseignements, puis vérifiez-le ici."],
  verifyHelp: ["Verify this number before it can be used in an on-call contact order.", "Vérifiez ce numéro avant de l’utiliser dans un ordre des contacts de garde."],
  missingProfile: ["Your profile could not be found. Refresh your details or contact your organization administrator.", "Votre profil est introuvable. Actualisez vos renseignements ou contactez l’administrateur de votre organisation."],
  verifiedSaved: ["Phone verification saved.", "Vérification du numéro enregistrée."],
} as const;

export function Profile({ session, language, onSessionChanged }: { session: Session; language: Language; onSessionChanged?: () => void }) {
  const [person, setPerson] = useState<Person | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [saved, setSaved] = useState<"details" | "phone" | null>(null);
  const t = (key: Parameters<typeof tr>[1]) => tr(language, key);
  const copy = (key: keyof typeof words) => words[key][language === "fr" ? 1 : 0];

  async function refresh(signal?: AbortSignal) {
    setLoading(true); setError("");
    try {
      const result = await relayRequest<{ items: Person[] }>("/people", signal ? { signal } : {});
      if (signal?.aborted) return;
      const current = result.items.find((item) => item.id === session.user.id) ?? null;
      setPerson(current);
      if (!current) setError(copy("missingProfile"));
    } catch (failure) {
      if (!signal?.aborted) setError(errorLabel(language, failure));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setPerson(null); setEditing(false); setVerifying(false); setSaved(null);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [session.organization.id, session.user.id]);

  function afterSave(kind: "details" | "phone") {
    setEditing(false); setVerifying(false); setSaved(kind); setPerson(null);
    void refresh();
    onSessionChanged?.();
  }

  const displayedPerson = person ?? session.user;
  const branch = session.branches.find((item) => item.id === displayedPerson.branchId);
  return <div className="relay-profile">
    <div className="relay-section-heading"><div><h1>{copy("title")}</h1><p>{copy("introduction")}</p></div>
      {!editing && <button className="relay-primary" type="button" disabled={loading || !person || verifying} onClick={() => { setEditing(true); setSaved(null); }}>{t("editProfile")}</button>}
    </div>
    {error && <p className="relay-error" role="alert">{error} <button type="button" disabled={loading} onClick={() => void refresh()}>{t("retry")}</button></p>}
    {saved && <p className="relay-notice" role="status">{saved === "phone" ? copy("verifiedSaved") : t("changeSaved")}</p>}
    {editing && person && <PersonForm session={session} language={language} person={person} selfProfile onCancel={() => setEditing(false)} onSaved={() => afterSave("details")} />}
    {verifying && person && <VerifyPhone key={`${person.id}:${person.phone}`} person={person} language={language} selfProfile onCancel={() => setVerifying(false)} onVerified={() => afterSave("phone")} />}
    <div className="relay-profile-grid">
      <section className="relay-card" aria-labelledby="relay-profile-account"><h2 id="relay-profile-account">{copy("account")}</h2>
        <dl className="relay-profile-facts">
          <div><dt>{t("name")}</dt><dd>{displayedPerson.displayName}</dd></div>
          <div><dt>{t("email")}</dt><dd>{displayedPerson.email}</dd></div>
          <div><dt>{t("organization")}</dt><dd>{session.organization.name}</dd></div>
          <div><dt>{t("branch")}</dt><dd>{branch?.name ?? "—"}</dd></div>
          <div><dt>{t("role")}</dt><dd>{stateLabel(language, displayedPerson.role)}</dd></div>
        </dl><p className="relay-muted">{copy("managedDetails")}</p>
      </section>
      <section className="relay-card relay-profile-contact" aria-labelledby="relay-profile-contact" aria-busy={loading}><h2 id="relay-profile-contact">{copy("contact")}</h2>
        {loading ? <p role="status">{t("loading")}</p> : person && <>
          <p className="relay-profile-phone">{person.phone ?? t("emptyPhone")}</p>
          {person.phone && <p><span className={`relay-status ${person.phoneVerified ? "relay-status-owned" : "relay-status-active"}`}>{t(person.phoneVerified ? "verified" : "unverified")}</span></p>}
          <p className="relay-muted">{copy("contactHelp")}</p>
          {!person.phone ? <p className="relay-muted">{copy("addPhoneHelp")}</p> : !person.phoneVerified && <><p className="relay-muted">{copy("verifyHelp")}</p><button type="button" disabled={editing || verifying || person.active === false} onClick={() => { setVerifying(true); setSaved(null); }}>{t("verifyPhone")}</button></>}
          <p className="relay-muted relay-profile-verification-note">{t("phoneVerification")}</p>
        </>}
      </section>
    </div>
  </div>;
}

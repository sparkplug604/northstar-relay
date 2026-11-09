import { RelayApiError } from "./api.js";

export type Language = "en" | "fr";
const words = {
  loading: ["Loading…", "Chargement…"], retry: ["Try again", "Réessayer"], refresh: ["Refresh", "Actualiser"],
  signIn: ["Sign in", "Connexion"], signOut: ["Sign out", "Déconnexion"], email: ["Email", "Courriel"], password: ["Password", "Mot de passe"],
  setup: ["Set up an organization", "Configurer une organisation"], setupToken: ["Setup token", "Jeton de configuration"],
  setupHelp: ["Use the setup token provided by your Northstar administrator.", "Utilisez le jeton fourni par votre administrateur Northstar."],
  organization: ["Organization", "Organisation"], branch: ["Branch", "Succursale"], timezone: ["Time zone", "Fuseau horaire"],
  name: ["Full name", "Nom complet"], createAccount: ["Create organization", "Créer l’organisation"], backLogin: ["Back to sign in", "Retour à la connexion"],
  passwordHelp: ["Use at least 12 characters.", "Utilisez au moins 12 caractères."],
  mfaTitle: ["Secure your account", "Sécurisez votre compte"], mfaHelp: ["Add this key to your authenticator app, then enter its six-digit code.", "Ajoutez cette clé à votre application d’authentification, puis entrez son code à six chiffres."],
  mfaGenerate: ["Set up authenticator", "Configurer l’authentificateur"], mfaCode: ["Authenticator code", "Code d’authentification"],
  mfaOrRecovery: ["Authenticator or recovery code", "Code d’authentification ou de récupération"],
  mfaSignIn: ["Enter your authenticator code to continue.", "Entrez votre code d’authentification pour continuer."],
  confirm: ["Confirm", "Confirmer"], copy: ["Copy", "Copier"], copied: ["Copied", "Copié"],
  recoveryTitle: ["Save your recovery codes", "Conservez vos codes de récupération"],
  recoveryHelp: ["These codes are shown once. Store them securely before continuing.", "Ces codes ne sont affichés qu’une fois. Conservez-les dans un endroit sûr avant de continuer."],
  recoverySaved: ["I have saved these codes", "J’ai conservé ces codes"],
  queue: ["Work queue", "File de travail"], onCall: ["On call", "Garde"], people: ["People", "Personnes"], history: ["History", "Historique"],
  create: ["New work order", "Nouvel ordre de travail"], cancel: ["Cancel", "Annuler"], save: ["Save", "Enregistrer"], saving: ["Saving…", "Enregistrement…"],
  externalId: ["Work-order number", "Numéro de l’ordre"], customer: ["Customer / site reference", "Référence du client ou du site"], priority: ["Priority", "Priorité"],
  urgent: ["Urgent", "Urgent"], high: ["High", "Élevée"], normal: ["Normal", "Normale"], dueAt: ["Ownership deadline", "Échéance de prise en charge"],
  localTimeHelp: ["Enter the time in your device’s time zone:", "Entrez l’heure dans le fuseau de votre appareil :"], note: ["Note (optional)", "Note (facultatif)"],
  createHelp: ["Saving starts the configured contact sequence. Check the deadline and on-call settings first.", "L’enregistrement démarre la séquence de contact configurée. Vérifiez d’abord l’échéance et la garde."],
  saveWork: ["Create and start relay", "Créer et démarrer le relais"], search: ["Search work orders", "Rechercher des ordres"],
  allBranches: ["All branches", "Toutes les succursales"], noWork: ["No work orders here.", "Aucun ordre de travail ici."], noMatch: ["No work orders match your search.", "Aucun ordre ne correspond à votre recherche."],
  order: ["Work order", "Ordre de travail"], owner: ["Owner", "Responsable"], noOwner: ["Unassigned", "Non attribué"], deadline: ["Deadline", "Échéance"], status: ["Status", "État"],
  overdue: ["Overdue", "En retard"], remaining: ["remaining", "restantes"], details: ["Work-order details", "Détails de l’ordre"],
  backQueue: ["Back to work queue", "Retour à la file"], takeOwnership: ["Take ownership", "Prendre en charge"], decline: ["Decline", "Refuser"],
  recordOwner: ["Record an owner", "Enregistrer un responsable"], recordOwnerHelp: ["Only record a person who has agreed to take responsibility.", "Enregistrez uniquement une personne qui a accepté la responsabilité."],
  ownershipHelp: ["Taking ownership stops the Relay contact sequence. Accept the job in the source portal separately if required.", "La prise en charge arrête la séquence de contact Relay. Acceptez séparément le travail dans le portail source, au besoin."],
  reason: ["Reason", "Motif"], reasonHelp: ["Explain what happened for the audit history.", "Expliquez la situation pour l’historique d’audit."],
  cancelWork: ["Cancel acknowledgement", "Annuler la prise en charge"], closeWork: ["Close handoff", "Clore le transfert"],
  fulfill: ["Complete handoff", "Terminer le transfert"], fulfillHelp: ["Confirm that ownership and source acceptance have been recorded. This does not certify that repairs are complete.", "Confirmez que la prise en charge et l’acceptation source sont enregistrées. Cela ne certifie pas que les réparations sont terminées."],
  source: ["Source-portal acceptance", "Acceptation dans le portail source"], sourceHelp: ["Recorded by your team; not verified with the source portal.", "Déclarée par votre équipe; non vérifiée auprès du portail source."],
  recordSource: ["Record source status", "Enregistrer l’état source"], timeline: ["Activity", "Activité"], noEvents: ["No activity recorded.", "Aucune activité enregistrée."],
  attempts: ["Contact attempts", "Tentatives de contact"], noAttempts: ["No contact attempts yet.", "Aucune tentative de contact pour le moment."],
  changeSaved: ["Saved.", "Enregistré."], workCreated: ["Work order created.", "Ordre créé."],
  simulated: ["Simulated communications — no real calls or messages are sent.", "Communications simulées — aucun appel ni message réel n’est envoyé."],
  live: ["Live communications", "Communications réelles"],
  contactOrder: ["Contact order", "Ordre des contacts"], settingsHelp: ["The listed people are contacted in order. Changes apply to new work orders.", "Les personnes sont contactées dans cet ordre. Les modifications s’appliquent aux nouveaux ordres."],
  addContact: ["Add a contact", "Ajouter un contact"], choosePerson: ["Choose a person", "Choisir une personne"],
  remove: ["Remove", "Retirer"], moveUp: ["Move up", "Monter"], moveDown: ["Move down", "Descendre"],
  interval: ["Minutes between contacts", "Minutes entre les contacts"], channels: ["Contact methods", "Moyens de contact"], voice: ["Phone call", "Appel téléphonique"], sms: ["Text message", "Texto"],
  noContacts: ["No contact chain configured. Add eligible contacts before creating work orders.", "Aucune chaîne de contact configurée. Ajoutez des contacts admissibles avant de créer des ordres."],
  verifiedContactsOnly: ["Only active people in this branch with a verified phone are listed.", "Seules les personnes actives de cette succursale ayant un numéro vérifié sont affichées."],
  noPeople: ["No people have been added.", "Aucune personne ajoutée."], addPerson: ["Add person", "Ajouter une personne"], role: ["Role", "Rôle"], phone: ["Phone number", "Numéro de téléphone"],
  phoneHelp: ["Use international format, for example +16045550123.", "Utilisez le format international, par exemple +16045550123."],
  active: ["Active", "Actif"], inactive: ["Inactive", "Inactif"], edit: ["Edit", "Modifier"], verified: ["Verified", "Vérifié"], unverified: ["Not verified", "Non vérifié"],
  phoneVerification: ["A saved phone number is not proof that the person can receive calls.", "Un numéro enregistré ne confirme pas que la personne peut recevoir des appels."],
  verifyPhone: ["Verify phone", "Vérifier le numéro"], sendCode: ["Send verification code", "Envoyer le code de vérification"], verificationCode: ["Verification code", "Code de vérification"],
  verificationConsent: ["Send a code only when this person has agreed to receive it.", "Envoyez un code uniquement si cette personne a accepté de le recevoir."],
  testCode: ["Local simulated test code — no message was sent", "Code de test local simulé — aucun message envoyé"],
  intake: ["Email intake", "Réception de courriels"], rawEmail: ["Raw email (.eml)", "Courriel brut (.eml)"], uploadEmail: ["Choose an .eml file", "Choisir un fichier .eml"],
  intakeHelp: ["Recognized emails create a work order and start the contact sequence automatically. Uncertain fields go to review. Check the branch and on-call settings before processing.", "Les courriels reconnus créent un ordre et démarrent automatiquement la séquence de contact. Les champs incertains passent en vérification. Vérifiez la succursale et la garde avant de traiter le courriel."],
  parseEmail: ["Process and route email", "Traiter et acheminer le courriel"], noIntake: ["No email records yet.", "Aucun courriel enregistré pour le moment."], review: ["Review", "Vérifier"],
  reviewTitle: ["Review source fields", "Vérifier les champs source"], sourceReceived: ["Original source time", "Heure source d’origine"],
  promote: ["Confirm and create work order", "Confirmer et créer l’ordre"], sourceDeadlineHelp: ["Preserve the source deadline, even if this email arrived late.", "Conservez l’échéance source, même si ce courriel est arrivé en retard."],
  fileTooLarge: ["Choose an .eml file smaller than 256 KB.", "Choisissez un fichier .eml de moins de 256 Ko."],
  connections: ["Source connections", "Connexions source"], connectionHelp: ["Create a connection for an approved email forwarding integration. Revoking it stops new intake through that connection.", "Créez une connexion pour une intégration approuvée de transfert de courriels. Sa révocation arrête la réception par cette connexion."],
  connectionName: ["Connection name", "Nom de la connexion"], createConnection: ["Create connection", "Créer la connexion"], connectionUrl: ["Intake endpoint", "Adresse de réception"],
  connectionToken: ["Connection token", "Jeton de connexion"], connectionTokenHelp: ["Save this token securely for the forwarding integration. It is shown only once. This is an integration endpoint, not an email address.", "Conservez ce jeton de façon sécurisée pour l’intégration de transfert. Il n’est affiché qu’une fois. Il s’agit d’une adresse d’intégration, pas d’une adresse courriel."],
  credentialsSaved: ["I have saved the connection details", "J’ai conservé les renseignements de connexion"], revoke: ["Revoke", "Révoquer"], confirmRevoke: ["Confirm revocation", "Confirmer la révocation"],
  schedule: ["Coverage schedule", "Horaire de garde"], scheduleHelp: ["A dated override takes priority, then weekly coverage, then the fallback contact order. Existing work orders keep their original contacts.", "Une dérogation datée a priorité, suivie de la garde hebdomadaire, puis de l’ordre des contacts de secours. Les ordres existants conservent leurs contacts d’origine."],
  weeklyCoverage: ["Weekly coverage", "Garde hebdomadaire"], fallbackCoverage: ["No weekly rules. The fallback contact order applies.", "Aucune règle hebdomadaire. L’ordre des contacts de secours s’applique."],
  endOfDay: ["End of day (midnight)", "Fin de journée (minuit)"], editProfile: ["Edit my details", "Modifier mes renseignements"],
  datedOverrides: ["Dated overrides", "Dérogations datées"], noOverrides: ["No dated overrides.", "Aucune dérogation datée."], addWeeklyRule: ["Add weekly coverage", "Ajouter une garde hebdomadaire"], addOverride: ["Add a dated override", "Ajouter une dérogation datée"],
  weekday: ["Day", "Jour"], starts: ["Starts", "Début"], ends: ["Ends", "Fin"], weeklyTimeHelp: ["Times are in the branch time zone. Use separate rules for each side of midnight:", "Les heures suivent le fuseau de la succursale. Utilisez des règles distinctes de chaque côté de minuit :"],
  emptyPhone: ["No phone", "Aucun numéro"], initialPassword: ["Initial password", "Mot de passe initial"],
  newAccountHelp: ["The account is created immediately. No invitation email is sent; share the initial password privately.", "Le compte est créé immédiatement. Aucun courriel d’invitation n’est envoyé; transmettez le mot de passe initial de manière confidentielle."],
  accessError: ["Your session expired. Sign in again.", "Votre session a expiré. Reconnectez-vous."],
  credentialsError: ["Email or password was not accepted.", "Le courriel ou le mot de passe n’a pas été accepté."], mfaError: ["The code was not accepted. Check the code and try again.", "Le code n’a pas été accepté. Vérifiez-le et réessayez."],
  recipientsRequired: ["Configure an on-call contact order before creating work orders.", "Configurez l’ordre des contacts de garde avant de créer des ordres."],
  invalidRecipients: ["Choose active, verified contacts in this branch.", "Choisissez des contacts actifs et vérifiés dans cette succursale."],
  rateLimited: ["Too many attempts. Wait a minute before trying again.", "Trop de tentatives. Attendez une minute avant de réessayer."],
  sourceRequired: ["Record source acceptance or mark it not required before completing the handoff.", "Enregistrez l’acceptation source ou indiquez qu’elle n’est pas requise avant de terminer le transfert."],
  overlapError: ["This coverage overlaps an existing entry. Adjust its times or remove the other entry.", "Cette garde chevauche une entrée existante. Modifiez ses heures ou retirez l’autre entrée."],
  windowError: ["The end must follow the start. Split weekly overnight coverage at midnight.", "La fin doit suivre le début. Divisez la garde hebdomadaire de nuit à minuit."],
  policyChanged: ["The on-call settings changed. Refresh before saving again.", "Les paramètres de garde ont changé. Actualisez avant d’enregistrer à nouveau."],
  alreadyExists: ["This work order or account already exists. Check the existing record before trying again.", "Cet ordre ou ce compte existe déjà. Vérifiez l’entrée existante avant de réessayer."],
  actionUnavailable: ["This action is no longer available. Refresh to see the current status.", "Cette action n’est plus disponible. Actualisez pour voir l’état actuel."],
  policyTooLong: ["The contact sequence extends past the deadline. Shorten the intervals in On call or check the source deadline.", "La séquence de contact dépasse l’échéance. Raccourcissez les intervalles de garde ou vérifiez l’échéance source."],
  deadlineFuture: ["The deadline has already passed. Preserve the original deadline and ask a dispatcher to review this order.", "L’échéance est déjà passée. Conservez l’échéance d’origine et demandez à un répartiteur de vérifier cet ordre."],
  forbidden: ["You do not have permission for this action.", "Vous n’avez pas l’autorisation d’effectuer cette action."],
  conflict: ["This work order changed. Refresh and check its current status.", "Cet ordre a changé. Actualisez pour vérifier son état."],
  invalidInput: ["Check the entered information and try again.", "Vérifiez les renseignements saisis et réessayez."],
  unavailable: ["Relay is unavailable. Try again or contact your administrator.", "Relay est indisponible. Réessayez ou contactez votre administrateur."],
  networkError: ["Could not connect. Your action has not been confirmed; check the connection and retry.", "Connexion impossible. Votre action n’est pas confirmée; vérifiez la connexion et réessayez."],
  actionTitle: ["Respond to Relay", "Répondre à Relay"], actionHelp: ["Confirm whether you can take responsibility for this request.", "Confirmez si vous pouvez prendre en charge cette demande."],
  actionAccepted: ["Your response was recorded.", "Votre réponse a été enregistrée."], invalidLink: ["This link is unavailable or expired. Sign in to view your assigned work.", "Ce lien est indisponible ou expiré. Connectez-vous pour voir vos tâches."],
  signInLink: ["Open Relay", "Ouvrir Relay"], actionNoDetails: ["Work-order details are available after signing in.", "Les détails de l’ordre sont accessibles après connexion."],
} as const;
export type TextKey = keyof typeof words;
export function tr(language: Language, key: TextKey): string { return words[key][language === "fr" ? 1 : 0]; }
const states: Record<string, readonly [string, string]> = {
  scheduled: ["Scheduled", "Planifié"], active: ["Awaiting owner", "En attente d’un responsable"], owned: ["Owned", "Pris en charge"],
  fulfilled: ["Fulfilled", "Terminé"], breached: ["Deadline missed", "Échéance dépassée"], closed: ["Closed", "Clos"], cancelled: ["Cancelled", "Annulé"],
  pending: ["Pending", "En attente"], unknown: ["Unknown", "Inconnu"], accepted: ["Accepted", "Accepté"], declined: ["Declined", "Refusé"], not_required: ["Not required", "Non requis"],
  queued: ["Queued", "En file"], processing: ["Processing", "En cours"], submitted: ["Submitted", "Soumis"], sent: ["Sent", "Envoyé"], delivered: ["Delivered", "Livré"],
  answered: ["Answered", "Répondu"], completed: ["Completed", "Terminé"], failed: ["Failed", "Échec"], uncertain: ["Needs reconciliation", "À rapprocher"],
  suppressed: ["Suppressed", "Supprimé"], expired: ["Expired", "Expiré"], "no-answer": ["No answer", "Sans réponse"], busy: ["Busy", "Occupé"],
  received: ["Received", "Reçu"], parsed: ["Parsed", "Analysé"], needs_review: ["Needs review", "À vérifier"], review: ["Needs review", "À vérifier"], promoted: ["Work order created", "Ordre créé"], rejected: ["Rejected", "Rejeté"],
  missing_deadline: ["Missing deadline", "Échéance manquante"], missing_external_id: ["Missing work-order number", "Numéro d’ordre manquant"], missing_customer: ["Missing customer", "Client manquant"], unsupported_format: ["Unsupported email format", "Format de courriel non pris en charge"],
  malformed_mime: ["Email could not be read", "Courriel illisible"], sender_not_allowed: ["Sender not allowed", "Expéditeur non autorisé"], unsupported_template: ["Unrecognized source template", "Modèle source non reconnu"],
  attachments_require_review: ["Attachments need review", "Pièces jointes à vérifier"], plain_text_required: ["Plain-text body required", "Corps en texte brut requis"], deadline_not_after_source_time: ["Deadline must follow source time", "L’échéance doit suivre l’heure source"],
  future_source_time: ["Source time is in the future", "L’heure source est dans le futur"], sending: ["Sending", "Envoi en cours"], exhausted: ["Contact unsuccessful", "Contact infructueux"], acknowledged: ["Acknowledged", "Confirmé"],
  recipients_required: ["On-call contacts are required", "Contacts de garde requis"], recipient_invalid: ["Contact eligibility needs review", "Admissibilité des contacts à vérifier"], invalid_command: ["Deadline and contact policy need review", "Échéance et politique de contact à vérifier"],
  work_order_exists: ["Work order already exists", "L’ordre existe déjà"],
  organization_admin: ["Organization administrator", "Administrateur d’organisation"], branch_dispatcher: ["Dispatcher", "Répartiteur"],
  on_call_responder: ["Responder", "Intervenant"], auditor: ["Auditor", "Auditeur"], platform_admin: ["Platform administrator", "Administrateur de plateforme"],
  commitment_created: ["Work order created", "Ordre créé"], commitment_activated: ["Contact sequence started", "Séquence de contact démarrée"],
  escalation_step_scheduled: ["Contact step scheduled", "Étape de contact planifiée"], commitment_declined: ["Response declined", "Prise en charge refusée"],
  commitment_acknowledged: ["Ownership accepted", "Prise en charge acceptée"], commitment_breached: ["Deadline missed", "Échéance dépassée"],
  source_acceptance_recorded: ["Source status recorded", "État source enregistré"], commitment_fulfilled: ["Commitment fulfilled", "Engagement rempli"],
  commitment_closed: ["Work order closed", "Ordre clos"], commitment_cancelled: ["Work order cancelled", "Ordre annulé"],
};
export function stateLabel(language: Language, state: string): string {
  const [kind, field] = state.split(":");
  if (field && (kind === "missing_field" || kind === "duplicate_field" || kind === "invalid_field")) {
    const fieldKeys: Record<string, TextKey> = { "work-order": "externalId", customer: "customer", priority: "priority", "due-at": "dueAt", "source-received-at": "sourceReceived", note: "note" };
    const label = fieldKeys[field] ? tr(language, fieldKeys[field]) : field;
    const reason = kind === "missing_field" ? ["Missing", "Manquant"] : kind === "duplicate_field" ? ["Duplicate", "En double"] : ["Invalid", "Invalide"];
    return `${label}: ${reason[language === "fr" ? 1 : 0]}`;
  }
  return states[state]?.[language === "fr" ? 1 : 0] ?? state.replaceAll("_", " ");
}
export function dateLabel(language: Language, value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(language === "fr" ? "fr-CA" : "en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
export function errorLabel(language: Language, error: unknown): string {
  if (error instanceof RelayApiError) {
    if (error.code === "invalid_credentials") return tr(language, "credentialsError");
    if (error.code === "invalid_mfa_code" || error.code === "invalid_verification_code") return tr(language, "mfaError");
    if (error.code === "recipients_required") return tr(language, "recipientsRequired");
    if (error.code === "recipient_invalid") return tr(language, "invalidRecipients");
    if (error.code === "source_acceptance_required") return tr(language, "sourceRequired");
    if (error.code === "invalid_command" && error.message.includes("after the commitment deadline")) return tr(language, "policyTooLong");
    if (error.code === "invalid_command" && error.message.includes("dueAt must be later")) return tr(language, "deadlineFuture");
    if (error.code === "overlapping_overrides" || error.code === "overlapping_weekly_rules") return tr(language, "overlapError");
    if (error.code === "invalid_override_window" || error.code === "invalid_weekly_window" || error.code === "invalid_source_deadline") return tr(language, "windowError");
    if (error.code === "policy_version_conflict") return tr(language, "policyChanged");
    if (error.code === "already_exists" || error.code === "work_order_exists") return tr(language, "alreadyExists");
    if (["action_unavailable", "commitment_not_actionable", "commitment_already_owned", "commitment_not_cancellable", "commitment_not_closable"].includes(error.code)) return tr(language, "actionUnavailable");
    if (error.status === 429) return tr(language, "rateLimited");
    if (error.status === 401) return tr(language, "accessError");
    if (error.status === 403) return tr(language, "forbidden");
    if (error.status === 409) return tr(language, "conflict");
    if (error.status === 400 || error.status === 422) return tr(language, "invalidInput");
    return tr(language, "unavailable");
  }
  return tr(language, "networkError");
}

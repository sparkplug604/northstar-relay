import {errorLabel,type Language} from './i18n.js';
import {RelayApiError} from './api.js';
const words={
  requestSource:['Request source','Source de la demande'],sourceManual:['Manual entry','Saisie manuelle'],sourceEmail:['Email','Courriel'],viewSource:['View source in Inbox','Voir la source dans la boîte de réception'],
  inbox:['Work Order Inbox','Boîte de réception des bons de travail'],myCommitments:['My commitments','Mes engagements'],allCommitments:['All commitments','Tous les engagements'],returnCorrection:['Return for correction','Retourner pour correction'],
  timesIn:['Times shown in','Heures affichées en'],exactTimeHelp:['Focus a timestamp for its exact UTC value.','Sélectionnez une heure pour sa valeur UTC exacte.'],
  of:['of','sur'],previousPage:['Previous page','Page précédente'],nextPage:['Next page','Page suivante'],filters:['Filters','Filtres'],clearFilters:['Clear filters','Effacer les filtres'],allStatuses:['All statuses','Tous les états'],allPeople:['All people','Toutes les personnes'],
  jobOnlyHelp:['Create a job without starting calls or messages. An acknowledgement can be requested separately.','Créez un travail sans déclencher d’appels ni de messages. La prise en charge peut être demandée séparément.'],
  saveJob:['Create job','Créer le travail'],closeDraft:['Close draft','Fermer le brouillon'],draftHelp:['Your draft stays in this session until you create the job, clear it or sign out.','Votre brouillon reste dans cette session jusqu’à la création, son effacement ou la déconnexion.'],clearDraft:['Clear draft','Effacer le brouillon'],
  noAck:['No acknowledgement requested','Aucune prise en charge demandée'],startAck:['Request acknowledgement','Demander une prise en charge'],startAckHelp:['This starts the configured contact sequence. Review the deadline and recipient readiness before confirming.','Cela démarre la séquence de contact configurée. Vérifiez l’échéance et les destinataires avant de confirmer.'],
  ackReady:['Fallback contacts pass configuration checks. Scheduled coverage can override this list; actual recipients are checked when you submit. This is not a delivery guarantee.','Les contacts de secours satisfont aux vérifications de configuration. La garde planifiée peut remplacer cette liste; les destinataires réels sont vérifiés à l’envoi. La livraison n’est pas garantie.'],ackNotReady:['Fallback contacts need review. Scheduled coverage may override this list; the server checks actual recipients before starting.','Les contacts de secours nécessitent une vérification. La garde planifiée peut remplacer cette liste; le serveur vérifie les destinataires réels avant de démarrer.'],fallbackContacts:['Fallback contacts only','Contacts de secours seulement'],
  reviewConfiguration:['Review on-call configuration','Vérifier la configuration de garde'],showAck:['Acknowledgement and delivery','Prise en charge et livraison'],
  due:['Due','Échéance'],emptyCommitments:['No commitments match these filters.','Aucun engagement ne correspond à ces filtres.'],yourPromise:['Your commitment','Votre engagement'],openJob:['Open job','Ouvrir le travail'],completionReview:['Completion to review','Fin à vérifier'],
  missed_start:['Scheduled start missed','Début planifié dépassé'],acknowledgement_unowned:['Acknowledgement needs an owner','Prise en charge sans responsable'],acknowledgement_overdue:['Acknowledgement deadline missed','Échéance de prise en charge dépassée'],delivery_problem:['Contact delivery needs review','Livraison des contacts à vérifier'],completion_review:['Completion needs review','Fin à vérifier'],overdue_commitment:['Job commitment overdue','Engagement du travail en retard'],
  configuration:['Configuration','Configuration'],diagnostics:['Delivery diagnostics','Diagnostic de livraison'],configurationHelp:['Configuration checks are not a live health check. Review each acknowledgement for actual contact results.','Ces vérifications de configuration ne sont pas un contrôle de santé en direct. Consultez chaque prise en charge pour les résultats réels.'],
  usefulDiagnostics:['Failed or uncertain contacts require review. Delivered or answered does not mean someone accepted ownership.','Les contacts échoués ou incertains nécessitent une vérification. Livré ou répondu ne signifie pas qu’une personne a accepté la responsabilité.'],
  noDetails:['No safe diagnostic code is available. Review the provider console with your administrator.','Aucun code de diagnostic sûr n’est disponible. Consultez la console du fournisseur avec votre administrateur.'],
  jobs:['Jobs','Travaux'],jobDetails:['Job details','Détails du travail'],newJob:['New job','Nouveau travail'],activeJobs:['Active jobs','Travaux actifs'],completedJobs:['Completed jobs','Travaux terminés'],allJobs:['All jobs','Tous les travaux'],
  attention:['Needs attention','À traiter'],mine:['Assigned to me','Mes travaux'],all:['All','Tous'],job:['Job','Travail'],status:['Job status','État du travail'],
  back:['Back to jobs','Retour aux travaux'],view:['View job','Voir le travail'],empty:['No jobs match this view.','Aucun travail ne correspond à cette vue.'],
  acknowledgements:['Work Order Acknowledgements','Prises en charge des bons de travail'],ackHistory:['Handoff history','Historique des transferts'],ackHelp:['Ownership and source acceptance are separate from actual work completion.','La prise en charge et l’acceptation source sont distinctes de l’exécution du travail.'],
  openAck:['Open acknowledgement and contact history','Voir la prise en charge et les contacts'],assigned:['Assigned to','Attribué à'],unassigned:['Unassigned','Non attribué'],
  nextDue:['Next job commitment due','Prochain engagement du travail'],noDue:['No open job commitments','Aucun engagement de travail ouvert'],scheduledAt:['Scheduled for','Date planifiée'],
  commitments:['Commitments','Engagements'],inApp:['Job commitments are tracked in Relay only. They do not trigger calls or texts.','Les engagements du travail sont suivis dans Relay seulement. Ils ne déclenchent ni appels ni textos.'],
  noCommitments:['No job commitments yet.','Aucun engagement pour ce travail.'],overdue:['Overdue','En retard'],open:['Open','Ouvert'],completed:['Completed','Terminé'],cancelled:['Cancelled','Annulé'],
  requested:['Requested','Demandé'],scheduled:['Scheduled','Planifié'],in_progress:['In progress','En cours'],blocked:['Blocked','Bloqué'],completion_reported:['Completion reported','Fin déclarée'],
  assign_visit:['Assign technician and time','Attribuer une personne et une heure'],job_visit_assigned:['Technician and visit time assigned','Technicien et heure attribués'],
  dispatch_details:['Dispatch details','Détails de répartition'],job_dispatch_details_updated:['Dispatch details updated','Détails de répartition mis à jour'],
  manageAssignment:['Manage assignment','Gérer l’attribution'],changeAssignment:['Change assignee','Changer de personne'],assignSomeone:['Assign someone','Attribuer à une personne'],
  unassign:['Remove assignment','Retirer l’attribution'],unassignHelp:['This will remove the assigned person from the job. The work order acknowledgement stays in place.','La personne sera retirée du travail. La prise en charge du bon de travail reste en place.'],
  job_unassigned:['Assignment removed','Attribution retirée'],previousAssignee:['Previously assigned to','Attribué auparavant à'],
  noWorkDetails:['No work details provided','Aucun détail sur le travail'],noSchedule:['No time set','Aucune heure fixée'],
  acceptancePending:['No one has accepted','Personne n’a accepté'],acceptBy:['Accept by','À accepter avant'],
  viewWorkOrderAck:['View work order acknowledgement','Voir la prise en charge du bon de travail'],moreJobActions:['More actions','Autres actions'],
  assign:['Assign person','Attribuer une personne'],schedule:['Schedule / change time','Planifier / modifier l’heure'],start:['Start work','Commencer le travail'],block:['Report blocker','Signaler un blocage'],update_blocker:['Update blocker details','Mettre à jour le blocage'],resume:['Resume work','Reprendre le travail'],
  report_completion:['Report work completed','Déclarer le travail terminé'],confirm_completion:['Confirm completion','Confirmer la fin'],reopen:['Reopen job','Rouvrir le travail'],cancel:['Cancel job','Annuler le travail'],
  add_update:['Add update','Ajouter une note'],add_milestone:['Add commitment','Ajouter un engagement'],reschedule_milestone:['Change deadline','Modifier l’échéance'],complete_milestone:['Complete commitment','Terminer l’engagement'],cancel_milestone:['Cancel commitment','Annuler l’engagement'],
  title:['Commitment title','Titre de l’engagement'],note:['What happened / next steps','Situation / prochaines étapes'],optionalNote:['Note (optional)','Note (facultative)'],
  history:['Job history','Historique du travail'],completion:['Work completion','Fin du travail'],reportedAt:['Reported by','Déclarée par'],confirmedAt:['Confirmed by','Confirmée par'],
  notCompleted:['Work has not been confirmed complete.','La fin du travail n’a pas été confirmée.'],pendingConfirmation:['A dispatcher must review and confirm the completion report.','Un répartiteur doit vérifier et confirmer la déclaration de fin.'],
  completionHelp:['Describe the work actually completed. A dispatcher must confirm this report.','Décrivez le travail réellement effectué. Un répartiteur doit confirmer cette déclaration.'],
  confirmHelp:['Confirm only after reviewing the completion report and job history. This records your confirmation, not independent verification.','Confirmez après avoir vérifié la déclaration et l’historique. Cela enregistre votre confirmation, pas une vérification indépendante.'],
  cancelHelp:['Cancelling the job cancels its open job commitments. The separate acknowledgement is not changed.','L’annulation du travail annule ses engagements ouverts. La prise en charge distincte reste inchangée.'],
  reopenHelp:['Explain why the job needs more work. Previous completion records remain in the history.','Expliquez pourquoi le travail doit reprendre. Les déclarations précédentes restent dans l’historique.'],
  resolveFirst:['Resolve all open commitments before reporting work completed.','Résolvez tous les engagements ouverts avant de déclarer la fin du travail.'],
  stale:['This job changed. Refresh, review its current state, then submit again. Your form is retained.','Ce travail a changé. Actualisez, vérifiez son état, puis renvoyez le formulaire conservé.'],
  ackUnresolved:['Resolve or cancel the acknowledgement before confirming completion or cancelling the job. Its contact sequence is still independent.','Résolvez ou annulez la prise en charge avant de confirmer la fin ou d’annuler le travail. Sa séquence de contact reste indépendante.'],
  futureTime:['Choose a future date and time.','Choisissez une date et une heure futures.'],noteRequired:['Enter an explanation of at least three characters.','Saisissez une explication d’au moins trois caractères.'],
  invalidAssignee:['Choose an active, eligible person in this branch.','Choisissez une personne active et admissible de cette succursale.'],
  jobChanged:['This action is unavailable in the current state. Refresh and review the job.','Cette action est indisponible dans l’état actuel. Actualisez et vérifiez le travail.'],
  limited:['Counts and filters apply to loaded jobs. More jobs are available.','Les nombres et filtres portent sur les travaux chargés. D’autres travaux sont disponibles.'],loadMore:['Load more jobs','Charger d’autres travaux'],
  noPeople:['No eligible active people in this branch. Check Team before assigning work.','Aucune personne active admissible dans cette succursale. Vérifiez l’équipe avant d’attribuer le travail.'],
  peopleError:['People could not be loaded. Assignments are unavailable until you retry.','Impossible de charger les personnes. Réessayez avant d’attribuer le travail.'],
  created:['Created','Créé'],updated:['Last update','Dernière mise à jour'],shownAt:['Updated from server','Actualisé depuis le serveur'],oldDeadline:['Previous deadline','Échéance précédente'],newDeadline:['New deadline','Nouvelle échéance'],
  previousSchedule:['Previous scheduled time','Heure planifiée précédente'],completedLate:['Completed after its deadline','Terminé après son échéance'],
  job_created:['Job created','Travail créé'],job_assigned:['Person assigned','Personne attribuée'],job_scheduled:['Schedule recorded','Planification enregistrée'],job_started:['Work started','Travail commencé'],job_blocked:['Blocker reported','Blocage signalé'],job_blocker_updated:['Blocker updated','Blocage mis à jour'],job_resumed:['Work resumed','Travail repris'],completion_confirmed:['Completion confirmed','Fin confirmée'],job_reopened:['Job reopened','Travail rouvert'],job_cancelled:['Job cancelled','Travail annulé'],update_added:['Update added','Note ajoutée'],milestone_added:['Commitment added','Engagement ajouté'],milestone_rescheduled:['Commitment rescheduled','Engagement replanifié'],milestone_completed:['Commitment completed','Engagement terminé'],milestone_cancelled:['Commitment cancelled','Engagement annulé'],
}as const;
export type JobText=keyof typeof words;
export function jt(language:Language,key:JobText):string{return words[key][language==='fr'?1:0];}
export function jobEventLabel(language:Language,key:string):string{return key in words?jt(language,key as JobText):key.replaceAll('_',' ');}
export function jobErrorLabel(language:Language,error:unknown):string{
  if(error instanceof RelayApiError){
    if(['settings_not_ready','recipients_required','contacts_not_ready'].includes(error.code))return jt(language,'ackNotReady');
    if(error.code==='acknowledgement_exists')return jt(language,'jobChanged');
    if(error.code==='acknowledgement_unresolved')return jt(language,'ackUnresolved');
    if(error.code==='job_version_conflict'||error.code==='idempotency_conflict')return jt(language,'stale');
    if(error.code==='future_time_required')return jt(language,'futureTime');
    if(error.code==='note_required')return jt(language,'noteRequired');
    if(error.code==='unresolved_milestones')return jt(language,'resolveFirst');
    if(['assignee_required','assignee_invalid','milestone_invalid'].includes(error.code))return jt(language,'invalidAssignee');
    if(['invalid_job_state','job_closed','completion_review_pending','milestone_closed','milestone_not_found'].includes(error.code))return jt(language,'jobChanged');
  }
  return errorLabel(language,error);
}

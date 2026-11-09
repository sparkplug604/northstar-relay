import type { Language } from './i18n.js';
import type { RelayRole } from './api.js';
const words={
  home:['Home','Accueil'],profile:['My profile','Mon profil'],workspace:['Open my workspace','Ouvrir mon espace'],
  myWork:['My work','Mes demandes'],dispatch:['Dispatch','Répartition'],adminWorkspace:['Operations','Opérations'],
  signedIn:['Signed in as','Connecté en tant que'],summary:['Current work','Travail en cours'],
  unowned:['Awaiting an owner','Sans responsable'],overdue:['Overdue, unowned','En retard, sans responsable'],mine:['Owned by me','Pris en charge par moi'],all:['All open','Tous les ordres ouverts'],
  openSummary:['Open work orders','Ordres ouverts'],review:['Intake to review','Réception à vérifier'],
  latest:['Last updated','Mis à jour'],unknown:['Status unavailable','État indisponible'],refreshHelp:['Could not refresh. Showing the last received information.','Actualisation impossible. Les dernières données reçues sont affichées.'],
  setupAttention:['Setup needs attention','Configuration à vérifier'],unverified:['People without a verified phone','Personnes sans numéro vérifié'],fallbackMissing:['Branches without a fallback list','Succursales sans liste de secours'],
  configurationOnly:['These are configuration checks, not proof of live call delivery or complete coverage.','Ces contrôles de configuration ne prouvent ni la livraison des appels ni une couverture complète.'],
  adminHelp:['Manage your team, coverage and outstanding work.','Gérez votre équipe, la garde et les demandes en cours.'],dispatchHelp:['Find an owner for each incoming request.','Trouvez un responsable pour chaque demande reçue.'],responderHelp:['Review assigned requests and the work you have accepted.','Consultez vos demandes et les tâches prises en charge.'],
  yourAssignment:['Requests assigned to you','Demandes qui vous sont attribuées'],filter:['Show','Afficher'],
  loadMore:['Load more','Afficher la suite'],loaded:['Work orders shown','Ordres affichés'],emptyFilter:['No work orders in this view.','Aucun ordre dans cette vue.'],clear:['Clear filters','Effacer les filtres'],
  countsScope:['Counts cover all work you can access. Branch and search filters apply to the list below.','Les totaux couvrent toutes les demandes auxquelles vous avez accès. Les filtres de succursale et de recherche s’appliquent à la liste ci-dessous.'],
  sourceUnknown:['Source status unconfirmed','État source non confirmé'],viewOrder:['Open work order','Ouvrir l’ordre'],
  team:['Team','Équipe'],tools:['Team tools','Outils de l’équipe'],noPermission:['This page is not available for your role.','Cette page n’est pas accessible avec votre rôle.'],notFound:['Page not found','Page introuvable'],
  roleHelp:['Your role controls the actions available in your workspace.','Votre rôle détermine les actions disponibles dans votre espace.'],
  account:['Account','Compte'],backHome:['Back to home','Retour à l’accueil'],
} as const;
export type UxKey=keyof typeof words;
export const ux=(language:Language,key:UxKey)=>words[key][language==='fr'?1:0];
export type WorkFilter='all'|'unowned'|'overdue'|'mine';
export function parseWorkFilter(value:string|null):WorkFilter {return ['all','unowned','overdue','mine'].includes(value??'')?value as WorkFilter:'all';}
export function workspaceTitle(role:RelayRole):UxKey {return role==='on_call_responder'?'myWork':role==='branch_dispatcher'?'dispatch':'adminWorkspace';}
export function workspaceHelp(role:RelayRole):UxKey {return role==='on_call_responder'?'responderHelp':role==='branch_dispatcher'?'dispatchHelp':'adminHelp';}

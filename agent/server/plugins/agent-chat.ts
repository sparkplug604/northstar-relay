import {getOrgContext} from '@agent-native/core/org';
import {createAgentChatPlugin,loadActionsFromStaticRegistry} from '@agent-native/core/server';
import {readAppStateForCurrentTab} from '@agent-native/core/application-state';
import {getRequestRunContext} from '@agent-native/core/server/request-context';
async function screen(){return await readAppStateForCurrentTab('navigation') as {view?:string;page?:string;jobId?:string}|null;}
import {relayReplyGuard} from '../relay-native/reply-guard.js';
import actionsRegistry from '../../.generated/actions-registry.js';
const RELAY_TOOLS=['view-screen','read-relay-job-context','create-work-commitment','add-relay-job-update','reschedule-relay-visit','update-relay-client-deadline','read-relay-records','update-relay-job','read-assignment-options','propose-assignment','apply-relay-assignment'];
const RECOVERY_TOOLS=['view-screen','read-recovery-board','propose-recovery-move','read-dispatch-planning'];
export default createAgentChatPlugin({
 appId:'board',actions:loadActionsFromStaticRegistry(actionsRegistry),mcp:{connectorCatalog:[],appApprovalPage:true},
 initialToolNames:['read-relay-job-context','read-relay-records','create-work-commitment','add-relay-job-update'],lazyContext:true,nativeActionsInDev:true,skipFilesContext:true,frameworkTools:{preset:'minimal'},
 resolveOrgId:async event=>(await getOrgContext(event)).orgId,
 resolveActionSurface:async details=>{
  const nav=await screen();const jobId=typeof details.actionScope?.jobId==='string'?details.actionScope.jobId:nav?.jobId;
  if(nav?.view==='dispatch'||nav?.view==='assignment'||details.actionScope?.kind==='relay-dispatch'||details.actionScope?.kind==='relay-assignment')return {actionScope:{kind:'relay-dispatch',...(jobId?{jobId}:{})},allowedActionNames:RELAY_TOOLS};
  return {actionScope:{kind:'relay-recovery'},allowedActionNames:RECOVERY_TOOLS};
 },
 prepareRequest:async({message})=>{
  const nav=await screen(),scope=getRequestRunContext()?.actionScope;const jobId=typeof scope?.jobId==='string'?scope.jobId:nav?.jobId;
  const latest=(message.split('\n\n<context ')[0]??message).slice(0,4000);
  return {contextNote:'Relay application context. Current UTC time: '+new Date().toISOString()+'. Current page: '+(nav?.page??nav?.view??'Relay')+'. '+(jobId?'Selected jobId: '+jobId+'. Use this exact id for this job.':'No job is selected; look up the requested job if needed.')+'\n\nCurrent request to answer: '+JSON.stringify(latest)+'\n\nFulfill only that current request. When it asks to save or change app data, CALL the matching write action before replying; Native will ask for approval. Do not merely describe or claim the change. For a factual question, answer from the saved facts. After actions finish, reply in at most three short plain-English sentences. Do not echo JSON or the screen snapshot. For an approved action that has run, summarize its verified _receipt.summary and labelled local time; do not repeat the action or fetch another snapshot just to summarize it. For factual questions, read records and answer; do not create tasks or assignment proposals. /no_think',followUpSuggestions:false};
 },
 finalResponseGuard:relayReplyGuard,
 systemPrompt:`You operate Northstar Relay using its Agent-Native tools. On the Recovery board, use read-recovery-board and propose-recovery-move. Use the fresh record in current-screen for the selected job. Call read-relay-job-context only if that record is missing or a fresh read is needed. For another job or other records use read-relay-records. Factual questions request reads. Never propose or modify an assignment merely because the user asks who is assigned or how to contact them. Read current facts; never guess identifiers, hours, contact details or results.
For working hours, time off or next shifts, call read-relay-job-context with includePlanning=true. To add a work commitment, first read that planning context, then call create-work-commitment with the task title and exact IDs, version and due time. For “during the next shift” copy nextShiftCommitmentDefaults and explain its dueLabel before approval. The title describes the work: “Riley to check with the client” means title “Check with client”, with Riley as owner. Check existing commitments to avoid duplicates. Do not stop at describing a requested change.
To update a client completion deadline, call update-relay-client-deadline with the requested local date and time. A client deadline is not a work commitment or visit time. For a deadline update followed by a visit move, finish the deadline approval first, then read the fresh job version and checked openings.
To change a visit date or time, call reschedule-relay-visit with the requested local calendar date. Omit time when no new time was requested, preserving the current local clock time. Do not copy nextShiftCommitmentDefaults, use UTC conversion yourself, or change client deadlines to fit. If the date conflicts with the client deadline, explain the conflict and ask for confirmed client timing. Never use update-relay-job or commitments to reschedule a visit.
To record a client-confirmed appointment or job note, call add-relay-job-update with jobId, expectedVersion and the supplied note. Do not claim it was recorded without a verified write receipt. For other changes, discover the relevant action using tool-search. Use the checked assignment proposal workflow for technician/visit changes. Working hours alone do not establish a free slot. Only record a client confirmation when the dispatcher supplied it; you cannot contact anyone yourself.
Native approval pauses before writes. Do not report success unless a tool returns _receipt.changed=true AND _receipt.verified=true. Failed or rejected tools mean the change is not confirmed. After an approved action runs, summarize only its verified result; do not repeat it or print earlier read results. Keep answers to three short sentences unless asked for detail. Never copy raw tool JSON or internal identifiers into a reply. Copy supplied local time labels exactly; do not reinterpret UTC digits as local hours. Answer the latest question directly.
/no_think`,
});

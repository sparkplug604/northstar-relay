import {z} from 'zod';
import {rankJob,profileSummary,type Triage,type TriageJob} from './triage.js';
import {staffTopic} from './staff.js';
import type {DispatchJobs} from './dispatch-job.js';
export const planSchema=z.object({
 topic:z.enum(['attention','blocker','assignment','acceptance','schedule','deadline','work','history','commitments','availability','priorities','team','client_update','contacts','resolution','working_hours','time_off','skills','general']),
 scope:z.enum(['current','named','all','unknown']),jobIds:z.array(z.string()).max(3),personName:z.string().nullable(),
});
export type DispatchPlan=z.infer<typeof planSchema>;
export function jobAction(id:string,plan=false,label=plan?'Plan assignment':'Open job'){
 const resolve=label==='Open job to resolve blocker';
 return '['+(resolve?'Resolve with Relay':label)+'](http://127.0.0.1:3004/relay/jobs/'+encodeURIComponent(id)+(resolve?'?resolveBlocker=1':plan?'?jobAction=assign':'')+')';
}
const title=(value:string)=>value.replace(/[\[\]<>*_#]/g,'');
type DispatchJob=DispatchJobs['jobs'][number];
export function contactDetails(item:DispatchJob){
 const contact=item.contacts?.technician;
 const tech=title(contact?.name??item.assigneeName??'Assigned technician');
 const phone=contact?.phone?.trim(),email=contact?.email?.trim();
 const technician=(contact||item.assigneeName?'**'+tech+'**':'No technician is assigned.')+(phone||email?': '+[phone,email].filter(Boolean).map(value=>title(value!)).join(' · '):contact||item.assigneeName?' — no phone or email is saved.':'');
 const client=item.contacts?.client;
 const clientDetails=client&&[client.phone,client.email].some(Boolean)?'**Client — '+title(client.name)+'**: '+[client.phone,client.email].filter(Boolean).map(value=>title(value!)).join(' · '):'No client phone or email is saved for this job.';
 return technician+'\n\n'+clientDetails;
}
export function unknownAnswer(item?:DispatchJob){
 return '**I don’t know from the saved details**\n\n'+(item?'Check with '+title(item.assigneeName??'the assigned technician')+' or the client, then tell me what they confirm.\n\n'+contactDetails(item):'Tell me which job you mean so I can check its technician and any saved contact details.');
}
export function blockerHelp(item:DispatchJob,needsFacts=false){
 const supplier=/supplier|part|fan|delivery/i.test(item.job.blocker??'');
 const unknown=supplier&&/(?:not|no|unknown|unconfirmed|waiting)/i.test(item.job.blocker??'')?'I don’t know when the part will arrive or whether work can resume. I don’t have a confirmed update.':'I can’t tell from the saved details whether the blocker is cleared and work can resume.';
 const part=/\bfan\b/i.test(item.job.blocker??'')?'replacement fan':'replacement part';
 const clearingCondition=supplier?'The '+part+' must be on site, and '+title(item.assigneeName??'the assigned technician')+' must confirm the repair can restart.':'The exact clearing condition is not saved. Ask '+title(item.assigneeName??'the assigned technician')+' what must change before work can restart.';
 const next=supplier?'Ask '+title(item.assigneeName??'the assigned technician')+' to confirm whether the '+part+' is on site and the repair can restart. If it has not arrived, ask for the delivery time so you can update the client.':'I don’t know how to clear this from the saved details. Ask '+title(item.assigneeName??'the assigned technician')+' what is needed to restart the job, or check with the client about access and timing.';
 return '**What’s blocked**\n\n'+(item.job.blocker??'Work is marked blocked, but no reason is saved.')+'\n\n**What I don’t know**\n\n'+unknown+'\n\n**What would clear this blocker**\n\n'+clearingCondition+'\n\n**Next step**\n\n'+next+'\n\n'+contactDetails(item)+'\n\n'+(needsFacts?'Tell me what changed. ':'Tell me what they confirm. ')+'I can prepare the update here for your approval.';
}
export function resolutionHelp(item:DispatchJob){
 if(item.job.status==='blocked')return blockerHelp(item);
 const job=item.job,ranked=rankJob(job),tasks=item.commitments.filter(task=>task.status==='open');
 const needsAssignment=ranked.canAssign&&(!job.assigneeId||!job.scheduledAt||ranked.reasons.some(reason=>/client deadline|Emergency repair/.test(reason)));
 const next=job.status==='completion_reported'?'Check the finished work against the client’s request before confirming completion.':
  tasks.length?'Ask '+title(tasks[0]!.ownerName??item.assigneeName??'the technician')+' whether the task is done. If it is not, confirm what is holding it up and when it can be finished. Check with the client if the repair timing needs to change.':
  needsAssignment?'Compare checked technician openings and visit times against the client deadline before approving an assignment.':
  'Ask '+title(item.assigneeName??'the technician')+' for the current work status and confirm the next visit time with the client.';
 const unknown=tasks.length?'These tasks are still marked open. I don’t know whether they have been done but not recorded.':'I don’t have a fresh update from the technician or client. I can only use the saved job details.';
 return '**What needs attention**\n\n'+(ranked.reasons.length?ranked.reasons.map(reason=>'- '+reason).join('\n'):'No current priority flags are saved for this job.')+
  (tasks.length?'\n\n**Open tasks**\n\n'+tasks.slice(0,3).map(task=>'- **'+title(task.title)+'** · '+title(task.ownerName??'No owner recorded')+' · Due '+task.dueLabel).join('\n'):'')+
  '\n\n**What I don’t know**\n\n'+unknown+'\n\n**Next step**\n\n'+next+'\n\n'+contactDetails(item)+
  (needsAssignment?'\n\n'+jobAction(job.id,true):'\n\nTell me what they confirm and I’ll help you choose the next step.');
}
export function factualAnswer(plan:DispatchPlan,data:DispatchJobs):string|null{
 if(data.jobs.length!==1)return null;
 const item=data.jobs[0]!,job=item.job,client=title(job.customerReference);
 const link=jobAction(job.id);
 switch(plan.topic){
 case 'resolution':return resolutionHelp(item);
 case 'blocker':return job.status==='blocked'?blockerHelp(item):'**Job status**\n\nNo current work blocker is recorded for **'+client+'**. The job is **'+job.status.replace(/_/g,' ')+'**.\n\n'+link;
 case 'contacts':return '**Who to contact**\n\n'+contactDetails(item);
 case 'attention':{
  const ranked=rankJob(job);const reasons=ranked.reasons;
  const assignment=ranked.canAssign&&(!job.assigneeId||!job.scheduledAt||reasons.some(reason=>/client deadline|Emergency repair/.test(reason)));
  const steps=job.status==='blocked'?(job.blocker&&/supplier/i.test(job.blocker)?['Ask the supplier to confirm when the replacement part will arrive.','Record their answer on the job and review the visit time against the client deadline.']:['Confirm what will clear the blocker and record the next step on the job.']):
   job.status==='completion_reported'?['Review the finished work and confirm completion if it meets the client’s request.']:
   assignment?['Compare available technicians and visit times. Review the proposal before approving it.']:
   ['Open the job and review the flagged tasks with the technician.'];
  return '**What’s wrong**\n\n'+(reasons.length?reasons.map(reason=>'- '+reason).join('\n'):'No current priority flags are recorded for **'+client+'**.')+(job.serviceWindow?.completeBy?'\n\n**Client deadline:** '+(job.clientTiming?.completeByLabel??job.serviceWindow.completeBy):'')+'\n\n**What to do next**\n\n'+steps.map(step=>'- '+step).join('\n')+'\n\n'+jobAction(job.id,Boolean(assignment),job.status==='blocked'?'Open job to resolve blocker':assignment?'Plan assignment':'Open job');
 }
 case 'assignment':return '**Who’s assigned**\n\n'+(item.assigneeName?'**'+item.assigneeName+'** is assigned to **'+client+'**.':item.assignmentRecorded?'An assignment is recorded, but the person’s display name could not be resolved.':'No technician is assigned to **'+client+'**.')+(item.acceptance&&!item.acceptance.accepted?'\n\nThe work order has **not been accepted** yet. Assignment and acceptance are separate.':'')+'\n\n'+(item.assignmentRecorded?link:jobAction(job.id,['requested','scheduled'].includes(job.status)));
 case 'acceptance':return '**Work order acceptance**\n\n'+(!item.acceptance?'This job does not have a work order acknowledgement.':item.acceptance.accepted?(item.acceptance.acceptedBy?'**'+item.acceptance.acceptedBy+'** has accepted the work order.':'The work order has been accepted; the person’s name could not be resolved.'):'No one has accepted the work order yet. **Accept by:** '+item.acceptance.dueLabel+'.')+'\n\n'+link;
 case 'schedule':return '**Scheduled visit**\n\n'+(item.scheduledLabel?'**'+client+'** is scheduled for **'+item.scheduledLabel+'**.':'No visit time is set for **'+client+'**.')+(job.estimatedMinutes?'\n\n**Estimated visit:** '+job.estimatedMinutes+' minutes.':'\n\nVisit length has not been recorded.')+'\n\n'+(item.scheduledLabel?link:jobAction(job.id,['requested','scheduled'].includes(job.status)));
 case 'deadline':{
  const flags=rankJob(job).reasons.filter(reason=>/client deadline|finished within/.test(reason));
  return '**Client deadline**\n\n'+(job.serviceWindow?.completeBy?'**'+(job.clientTiming?.completeByLabel??job.serviceWindow.completeBy)+'**.':job.serviceWindow?'The client has no fixed completion deadline.':'The client’s completion deadline has not been recorded.')+(flags.length?'\n\n**What puts it at risk**\n\n'+flags.map(reason=>'- '+reason).join('\n'):'')+'\n\n'+link;
 }
 case 'availability':{
  const availability=item.availability;
  if(!availability)return '**Technician availability**\n\nOpenings cannot be checked for this job’s current state.\n\n'+link;
  const person=plan.personName?.toLowerCase();
  const unavailable=person?availability.unavailable.find(candidate=>candidate.name.toLowerCase().includes(person)):null;
  const options=availability.options.filter(option=>!person||option.name.toLowerCase().includes(person));
  const answer=unavailable?'**'+unavailable.name+'** does not fit the recorded checks:\n\n'+(unavailable.reasons.length?unavailable.reasons.map(reason=>'- '+reason).join('\n'):'No checked opening is available for this job.'):
   options.length?'Checked openings for **'+client+'**:\n\n'+options.slice(0,3).map(option=>'- **'+option.name+'** · '+option.start+' to '+option.end).join('\n'):
   'No checked opening matches '+(plan.personName?'**'+plan.personName+'**':'this job')+'.';
  return '**Technician availability**\n\n'+answer+(!availability.schedulingAllowed?'\n\nThe job is **'+job.status+'**; assignment changes are not available in this state.':'\n\nThese are checked options, not approved assignments.')+'\n\n'+jobAction(job.id,availability.schedulingAllowed);
 }
 case 'work':return '**Work requested**\n\n'+(!job.description||job.description.startsWith('Synthetic example.')?'No detailed work description is recorded. The job title is **'+client+'**.':job.description)+'\n\n'+link;
 case 'history':return '**Recent job history**\n\n'+(item.history.length?item.history.slice(0,5).map(event=>'- **'+event.kind.replace(/^job_/,'').replace(/_/g,' ')+'** · '+event.atLabel+(event.actorName?' · '+event.actorName:'')+(event.note?'\n  '+event.note:'')).join('\n'):'No job history is recorded.')+'\n\n'+link;
 case 'commitments':return '**Job commitments**\n\n'+(item.commitments.length?item.commitments.map(commitment=>'- **'+commitment.title+'** · '+commitment.status+'\n  '+(commitment.ownerName??'No owner recorded')+' · Due '+commitment.dueLabel).join('\n'):'There are no recorded commitments for this job.')+'\n\n'+link;
 default:return null;
 }
}
export function resolveQuestionPlan(raw:DispatchPlan,question:string,catalog:TriageJob[],conversationJobId?:string,pageJobId?:string,people:string[]=[],previousStaffTopic?:string):DispatchPlan{
 const text=question.toLowerCase();
 // Job titles are record identifiers, not the user's question intent.
 let intent=text;for(const job of catalog){intent=intent.split(job.customerReference.toLowerCase()).join(' ').split(job.customerReference.split(' — ')[0]!.toLowerCase()).join(' ');}
 const topic=staffTopic(intent,previousStaffTopic)??(/\bhelp me resolve\b/.test(intent)?'resolution':
  /\b(?:contact details|contact information|phone|email|how (?:can|do) i (?:reach|contact)|who (?:should|can) i (?:call|contact))\b/.test(intent)?'contacts':
  /\b(?:draft|write|compose)\b/.test(intent)?'client_update':
  /\b(?:accepted|acceptance|acknowledged)\b/.test(intent)?'acceptance':
  /\b(?:availability|available|unavailable|suitable)\b|\bwho\b.*\b(?:can|could)\b|\b(?:can|could)\b.*\b(?:take|handle|replace|fit)\b/.test(intent)?'availability':
  /\bwho\b.*\b(?:assigned|on|handling|doing|working|responsible)\b/.test(intent)?'assignment':
  /\b(?:history|recent changes|what changed|last update)\b/.test(intent)?'history':
  /\b(?:commitments|promised tasks)\b/.test(intent)?'commitments':
  /\bwhen\b.*\b(?:scheduled|visit|going|coming|start)\b|\bwhat time\b/.test(intent)?'schedule':
  /\b(?:what|when)\b.*\b(?:client deadline|completion deadline|deadline)\b|\bwhen\b.*\bclient\b.*\b(?:need|expect)\b/.test(intent)?'deadline':
  /(?:prioriti[sz]e|focus on|jobs.*first|first.*jobs|priorities|which.*deadlines.*risk|which.*jobs.*(?:attention|risk))/.test(intent)?'priorities':
  /\b(?:blocked|blockers?|blocking|stuck)\b/.test(intent)?'blocker':
  /\b(?:attention|issues?|problems?|risks?)\b|what.*wrong|what.*next|next step|(?:holding|held|hold).{0,20}up|stopping.{0,20}(?:repair|work|job)/.test(intent)?'attention':
  /(?:what|which).*(?:fixing|fix|repair|work requested)|work description|work request/.test(intent)?'work':
  /(?:prioriti[sz]e|focus on|jobs.*first|first.*jobs|priorities)/.test(intent)?'priorities':
  /(?:team profiles|technician profiles|team.*skills|working hours|time off)/.test(intent)?'team':'general');
 const unique=[...new Map(catalog.map(job=>[job.id,job])).values()];
 const clients=unique.map(job=>({job,name:job.customerReference.split(' — ')[0]!.toLowerCase()}));
 // A technician's first name is not a business alias (Riley vs Riley Park Café).
 const personNames=new Set([...people,...(raw.personName?[raw.personName]:[])].map(name=>name.toLowerCase().split(' ')[0]));
 const mentioned=clients.filter(({job,name})=>text.includes(name)||text.includes(job.externalId.toLowerCase())||
  (name.split(' ')[0]!.length>=4&&!personNames.has(name.split(' ')[0]!)&&clients.filter(other=>other.name.split(' ')[0]===name.split(' ')[0]).length===1&&text.split(/[^a-z0-9]+/).includes(name.split(' ')[0]!))).map(item=>item.job.id);
 const plan:DispatchPlan={...raw,topic,jobIds:[]};
 const explicitCurrent=/\b(?:this|current) job\b/.test(text);
 const namedBusiness=/\b(?:to|at|for)\s+(?:[a-z]+\s+){0,3}(?:hotel|foods|grocery|market|shop|deli|bakery|grocer)\b/.test(text);
 // A Resolve prompt refers to its trusted selected job, even when a client has several jobs.
 if(['working_hours','time_off','skills'].includes(topic))return {...plan,scope:'all',jobIds:[]};
 if(topic==='resolution'&&explicitCurrent&&pageJobId&&!/\b(?:compare|versus|vs|difference)\b/.test(text))return {...plan,scope:'current',jobIds:[pageJobId]};
 if(mentioned.length>3)return {...plan,scope:'unknown'};
 if(mentioned.length){
  plan.scope='named';plan.jobIds=mentioned;
  if(/\b(?:compare|versus|vs|difference)\b/.test(text)&&conversationJobId&&!plan.jobIds.includes(conversationJobId))plan.jobIds.push(conversationJobId);
 }else if(explicitCurrent&&pageJobId){plan.scope='current';plan.jobIds=[pageJobId];}
 else if(namedBusiness)plan.scope='unknown';
 else if(topic==='priorities'||topic==='team'||(!conversationJobId&&['attention','blocker'].includes(topic))){plan.scope='all';}
 else if(conversationJobId){plan.scope='current';plan.jobIds=[conversationJobId];}
 else if(raw.scope==='unknown'||['attention','blocker','assignment','acceptance','schedule','deadline','work','history','commitments','availability'].includes(topic))plan.scope='unknown';
 else plan.scope='all';
 return plan;
}

export interface ReplyEvidence {id:string;text:string}
export function replyEvidence(plan:DispatchPlan,state:Triage,data:DispatchJobs|null):ReplyEvidence[]{
 const facts:ReplyEvidence[]=[];
 const add=(id:string,text:string)=>facts.push({id,text});
 for(const item of data?.jobs??[]){
  const job=item.job,prefix=job.id,client=title(job.customerReference);
  add(prefix+':contacts',contactDetails(item));
  add(prefix+':assignment',item.assigneeName?item.assigneeName+' is assigned to '+client+'.':item.assignmentRecorded?'An assignment exists for '+client+', but the person’s display name could not be resolved.':'No technician is assigned to '+client+'.');
  add(prefix+':schedule',item.scheduledLabel?client+' has a visit scheduled for '+item.scheduledLabel+'.':'No visit time is recorded for '+client+'.');
  add(prefix+':deadline',job.serviceWindow?.completeBy?'The client completion deadline for '+client+' is '+(job.clientTiming?.completeByLabel??job.serviceWindow.completeBy)+'.':job.serviceWindow?client+' has no fixed completion deadline.':'No client completion deadline is recorded for '+client+'.');
  if(job.status==='blocked')add(prefix+':blocker',job.blocker??'Work is blocked, but no reason is recorded.');
  else add(prefix+':status',client+' is '+job.status.replace(/_/g,' ')+'.');
  if(job.description&&!job.description.startsWith('Synthetic example.'))add(prefix+':work',job.description);
  for(const [index,reason] of rankJob(job).reasons.entries())if(!reason.startsWith('Blocked:'))add(prefix+':risk:'+index,client+': '+reason+'.');
  if(item.acceptance)add(prefix+':acceptance',item.acceptance.accepted?(item.acceptance.acceptedBy??'Someone')+' has accepted the work order.':'The work order has not been accepted yet. Accept by '+item.acceptance.dueLabel+'.');
  for(const [index,task] of item.commitments.entries())add(prefix+':task:'+index,task.title+' · '+task.status+' · '+(task.ownerName??'No owner recorded')+' · due '+task.dueLabel+'.');
 }
 if(!data)for(const [index,job] of (plan.topic==='blocker'?state.items.filter(job=>job.status==='blocked'):state.items).slice(0,5).entries())
  add('priority:'+index,job.customerReference+': '+job.reasons.join('; ')+'. Next step: '+job.nextAction+'.');
 if(plan.topic==='team')for(const person of state.team)add('person:'+person.personId,person.displayName+': '+profileSummary(person.profile));
 return facts;
}
export const evidenceAnswerSchema=z.object({factIds:z.array(z.string()).max(4),nextStep:z.string().max(500).nullable(),action:z.enum(['open_job','plan_assignment','open_team','open_jobs','none'])});
export function renderEvidenceAnswer(choice:z.infer<typeof evidenceAnswerSchema>,facts:ReplyEvidence[],plan:DispatchPlan,data:DispatchJobs|null,question:string){
 const selected=choice.factIds.map(id=>facts.find(fact=>fact.id===id)).filter((fact):fact is ReplyEvidence=>Boolean(fact));
 if(!selected.length)return unknownAnswer(data?.jobs.length===1?data.jobs[0]:undefined);
 const short=/one sentence|briefly|short answer/i.test(question);
 const answer=short?selected[0]!.text:selected.length===1?selected[0]!.text:selected.map(fact=>'- '+fact.text).join('\n');
 let next=choice.nextStep;
 // Model advice may suggest an action, but must not introduce a new recorded status.
 if(next&&/deadline.{0,25}(?:missed|passed|exceeded)|(?:has|have|was|were|is) (?:not )?(?:arrived|sent|saved|approved)|(?:I've|I have|we have)\b/i.test(next))next=null;
 const item=data?.jobs[0];
 const link=choice.action==='open_team'?'[Open team profiles](http://127.0.0.1:3004/relay/people)':choice.action==='open_jobs'?'[Open jobs](http://127.0.0.1:3004/relay/jobs)':
  item&&choice.action!=='none'?jobAction(item.job.id,choice.action==='plan_assignment'&&['requested','scheduled'].includes(item.job.status)):'';
 return '**Answer**\n\n'+answer+(!short&&next?'\n\n**What to do next**\n\n'+next:'')+(!short&&link?'\n\n'+link:'');
}

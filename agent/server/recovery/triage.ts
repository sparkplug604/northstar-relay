import {z} from 'zod';
import {relay} from './relay.js';
export const triageJobSchema=z.object({
 id:z.string(),version:z.number(),customerReference:z.string(),externalId:z.string(),description:z.string(),priority:z.string(),status:z.string(),
 assigneeId:z.string().nullable(),scheduledAt:z.string().nullable(),estimatedMinutes:z.number().optional(),blocker:z.string().nullable().optional(),
 serviceWindow:z.object({earliestStart:z.string().nullable(),completeBy:z.string().nullable()}).optional(),
 clientTiming:z.object({completeByLabel:z.string().nullable()}).passthrough().optional(),attentionReasons:z.array(z.string()).optional(),
}).passthrough();
export type TriageJob=z.infer<typeof triageJobSchema>;
export function rankJob(job:TriageJob,now=Date.now()){
 if(['completed','cancelled'].includes(job.status))return {...job,score:0,reasons:[job.status==='completed'?'Job completed':'Job cancelled'],canAssign:false,nextAction:'Review job history'};
 const reasons:string[]=[];let score=0;
 const add=(points:number,reason:string)=>{score=Math.max(score,points);reasons.push(reason);};
 if(job.priority==='urgent')add(120,'Emergency repair');
 const due=job.serviceWindow?.completeBy?Date.parse(job.serviceWindow.completeBy):null;
 if(due!==null&&job.status!=='completion_reported'){
  if(due<=now)add(110,'Client deadline has passed');
  else if(job.estimatedMinutes&&Math.max(now,job.scheduledAt?Date.parse(job.scheduledAt):now)+job.estimatedMinutes*60000>due)add(95,'Estimated finish is after the client deadline');
  else if(due-now<=86400000)add(85,'Client needs it finished within 24 hours');
 }
 if(job.status==='blocked')add(90,job.blocker?'Blocked: '+job.blocker:'Work is blocked');
 if(job.priority==='high')add(70,'Urgent repair');
 if(job.status==='completion_reported')add(65,'Finished work needs your confirmation');
 if(job.attentionReasons?.includes('overdue_commitment'))add(80,'A promised job task is overdue');
 if(job.attentionReasons?.includes('acknowledgement_overdue'))add(75,'No one accepted before the acceptance deadline');
 else if(job.attentionReasons?.includes('acknowledgement_unowned'))add(60,'Waiting for someone to accept');
 if(job.attentionReasons?.includes('missed_start'))add(75,'The scheduled start was missed');
 if(!job.assigneeId)add(55,'No technician assigned');
 if(!job.scheduledAt&&['requested','scheduled'].includes(job.status))add(50,'Visit time not set');
 if(job.attentionReasons?.includes('delivery_problem'))add(65,'Trouble reaching the team');
 return {...job,score,reasons,canAssign:['requested','scheduled'].includes(job.status),nextAction:job.status==='blocked'?'Resolve the blocker':job.status==='completion_reported'?'Review finished work':!job.assigneeId||!job.scheduledAt?'Plan assignment':'Review the job'};
}
const rankedSchema=triageJobSchema.extend({score:z.number(),reasons:z.array(z.string()),canAssign:z.boolean(),nextAction:z.string()});
export const triageSchema=z.object({checkedAt:z.string(),total:z.number(),truncated:z.boolean(),items:z.array(rankedSchema),selected:rankedSchema.nullable(),
 catalog:z.array(triageJobSchema).optional(),
 team:z.array(z.object({personId:z.string(),displayName:z.string(),profile:z.unknown().optional()}).passthrough())});
export type Triage=z.infer<typeof triageSchema>;
export async function readTriage(jobId?:string){
 const items:TriageJob[]=[];let offset:number|null=0;let total=0;
 while(offset!==null&&items.length<1000){
  const page:{items:unknown[];nextOffset:number|null;total:number}=await relay('/jobs?view=active&offset='+offset);
  items.push(...page.items.map(job=>triageJobSchema.parse(job)));total=page.total;
  const next:number|null=page.nextOffset;offset=next!==null&&next>offset?next:null;
 }
 const checkedAt=new Date().toISOString();
 const ranked=items.map(job=>rankJob(job,Date.parse(checkedAt))).filter(job=>job.score>0).sort((a,b)=>b.score-a.score||(Date.parse(a.serviceWindow?.completeBy??'')||Infinity)-(Date.parse(b.serviceWindow?.completeBy??'')||Infinity)||a.id.localeCompare(b.id));
 const selected=jobId?rankJob(triageJobSchema.parse((await relay<{job:unknown}>('/jobs/'+encodeURIComponent(jobId))).job),Date.parse(checkedAt)):null;
 const [team]=await Promise.all([
  relay<{items:unknown[]}>('/technicians'),
  ...ranked.slice(0,3).filter(job=>job.serviceWindow?.completeBy&&!job.clientTiming?.completeByLabel).map(async job=>{
   const detail=await relay<{job:unknown}>('/jobs/'+encodeURIComponent(job.id));
   const current=triageJobSchema.parse(detail.job);
   if(current.version===job.version&&current.clientTiming)job.clientTiming=current.clientTiming;
  }),
 ]);
 return triageSchema.parse({checkedAt,total,truncated:offset!==null,items:ranked,selected,catalog:items,team:team.items});
}
export function triageSummary(state:Triage,page='home'){
 const jobs=state.selected?[state.selected]:state.items.slice(0,3);
 if(page==='team'||page==='people')return "**What’s wrong**\n\nA profile alone does not confirm that a technician is free for a particular job.\n\n"+state.team.map(person=>'**'+person.displayName+'**\n\n'+profileSummary(person.profile)).join('\n\n')+"\n\n**What to do next**\n\nReview missing profile details, then use Plan assignment on the job to compare checked openings.\n\n[Open team profiles](http://127.0.0.1:3004/relay/people)\n\n_No changes applied._";
 if(!jobs.length)return "**What’s wrong**\n\nNo active jobs currently match the priority checks.\n\n**What to do next**\n\nReview the full job list if you want to check other work.\n\n[Open jobs](http://127.0.0.1:3004/relay/jobs)\n\n_No changes applied._";
 return jobs.map(job=>{
  const assignment=job.canAssign&&(!job.assigneeId||!job.scheduledAt||job.reasons.some(reason=>/client deadline|Emergency repair/.test(reason)));
  const next=job.status==='blocked'
   ? /supplier/i.test(job.blocker??'')?'Ask the supplier when the part will arrive. Record their answer on the job and check the client deadline.':'Open the job, record what will clear the blocker, and update the client.'
   :job.status==='completion_reported'?'Review the finished work. Confirm completion if it meets the client’s request.'
   :assignment?'Compare available technicians and visit times. Review the proposal before approving the assignment.'
   :job.reasons.some(reason=>/overdue/.test(reason))?'Open the job and check the overdue task or acceptance. Record what needs to happen next.'
   :'Review the job details and confirm the next step with the technician.';
  const action=assignment?'Plan assignment':job.status==='blocked'?'Resolve with Relay':job.status==='completion_reported'?'Review finished work':'Open job';
  const href='http://127.0.0.1:3004/relay/jobs/'+encodeURIComponent(job.id)+(assignment?'?jobAction=assign':job.status==='blocked'?'?resolveBlocker=1':'');
  return '### '+job.customerReference.replace(/[\[\]<>*_#]/g,'')+"\n\n**What’s wrong**\n\n"+(job.reasons.length?job.reasons.map(reason=>'- '+reason).join('\n'):'No priority flags are recorded.')+(job.serviceWindow?.completeBy?'\n\n**Client deadline:** '+(job.clientTiming?.completeByLabel??job.serviceWindow.completeBy):'')+"\n\n**What to do next**\n\n"+next+'\n\n['+action+']('+href+')';
 }).join('\n\n---\n\n')+'\n\n_No changes applied._';
}

export function profileSummary(value:unknown){
 const profile=z.object({skills:z.array(z.string()),timezone:z.string(),workingHours:z.array(z.object({weekday:z.number(),start:z.string(),end:z.string()})),timeOff:z.array(z.object({start:z.string(),end:z.string()}))}).safeParse(value);
 if(!profile.success)return 'Skills and availability not fully recorded';
 const p=profile.data,days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
 return 'Skills: '+(p.skills.join(', ')||'No special skills')+'. Hours ('+p.timezone+'): '+p.workingHours.map(period=>(days[period.weekday%7]??period.weekday)+' '+period.start+'–'+period.end).join(', ')+'. '+p.timeOff.length+' time-off period(s) recorded';
}

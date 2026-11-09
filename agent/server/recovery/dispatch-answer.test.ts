import {expect,it} from 'vitest';
import {factualAnswer,resolveQuestionPlan,replyEvidence,renderEvidenceAnswer,type DispatchPlan} from './dispatch-answer.js';
import type {DispatchJobs} from './dispatch-job.js';
const data:DispatchJobs={checkedAt:'2026-11-08T07:00:00Z',jobs:[{
 job:{id:'pine',version:2,customerReference:'Pine Grocery',externalId:'PINE',description:'Replace the fan',priority:'high',status:'blocked',assigneeId:'private-person-id',scheduledAt:'2026-11-09T17:00:00Z',blocker:'Waiting for the supplier'},
 assigneeName:'Riley Technician',assignmentRecorded:true,scheduledLabel:'Nov 9, 10:00 AM GMT-7',acceptance:null,commitments:[],history:[],availability:null,
}]};
const plan=(topic:DispatchPlan['topic']):DispatchPlan=>({topic,scope:'current',jobIds:['pine'],personName:null});
it('answers who is assigned directly without repeating the blocker report',()=>{
 const answer=factualAnswer(plan('assignment'),data)!;
 expect(answer).toContain('Riley Technician');expect(answer).not.toContain('Waiting for the supplier');expect(answer).not.toContain('private-person-id');
});
it('answers the visit time differently from the assignment question',()=>{
 const answer=factualAnswer(plan('schedule'),data)!;
 expect(answer).toContain('Nov 9, 10:00 AM GMT-7');expect(answer).not.toContain('Riley Technician');
 expect(answer).not.toBe(factualAnswer(plan('assignment'),data));
});
it('does not confuse an assigned technician with work order acceptance',()=>{
 const item={...data.jobs[0]!,acceptance:{status:'breached',accepted:false,acceptedBy:null,dueLabel:'Nov 8, 9:00 AM GMT-7'}};
 expect(factualAnswer(plan('assignment'),{...data,jobs:[item]})).toContain('not been accepted');
 expect(factualAnswer(plan('acceptance'),{...data,jobs:[item]})).toContain('No one has accepted');
});
it('does not invent an assignee name when a lookup is missing',()=>{
 const answer=factualAnswer(plan('assignment'),{...data,jobs:[{...data.jobs[0]!,assigneeName:null}]})!;
 expect(answer).toContain('could not be resolved');expect(answer).not.toContain('No technician is assigned');
});
it('leaves open-ended explanations and comparisons to grounded synthesis',()=>{
 expect(factualAnswer(plan('general'),data)).toBeNull();
});

it('binds a current-job question to the page rather than an invented model choice',()=>{
 const jobs=[{...data.jobs[0]!.job,score:90,reasons:[],canAssign:false,nextAction:'Review'}];
 const result=resolveQuestionPlan({topic:'general',scope:'current',jobIds:['wrong-id'],personName:null},'Who is on this job?',jobs,'pine','pine');
 expect(result.topic).toBe('assignment');expect(result.jobIds).toEqual(['pine']);
});
it('keeps a follow-up on the last discussed job but an explicit current job uses the page',()=>{
 const jobs=[{...data.jobs[0]!.job,score:90,reasons:[],canAssign:false,nextAction:'Review'}];
 expect(resolveQuestionPlan(plan('general'),'And when are they going?',jobs,'parkside','pine').jobIds).toEqual(['parkside']);
 expect(resolveQuestionPlan(plan('general'),'Who is on this job?',jobs,'parkside','pine').jobIds).toEqual(['pine']);
});
it('does not answer for the current job when an unknown business was named',()=>{
 const jobs=[{...data.jobs[0]!.job,score:90,reasons:[],canAssign:false,nextAction:'Review'}];
 expect(resolveQuestionPlan(plan('assignment'),'Who is assigned to Moonbeam Hotel?',jobs,'pine','pine').scope).toBe('unknown');
});

it.each([
 ['Why does Pine Grocery — replacement fan required need attention, and what should I do next?','work','attention'],
 ['Who is on Pine Grocery?','work','assignment'],
 ['What is the issue?','work','attention'],
 ['Is anything blocked?','assignment','blocker'],
 ['Any blockers?','assignment','blocker'],
 ["What's holding this up?",'assignment','attention'],
 ['Describe the obstacle in one sentence.','assignment','general'],
])('routes the latest question instead of repeating a previous topic: %s',(question,previousTopic,expected)=>{
 const job={...data.jobs[0]!.job,customerReference:'Pine Grocery — replacement fan required'};
 const resolved=resolveQuestionPlan({...plan(previousTopic as DispatchPlan['topic'])},question,[job],'pine','pine');
 expect(resolved.topic).toBe(expected);expect(resolved.jobIds).toEqual(['pine']);
 const answer=factualAnswer(resolved,{...data,jobs:[{...data.jobs[0]!,job}]});
 if(expected==='blocker'||expected==='attention'){
  expect(answer).toContain('Waiting for the supplier');expect(answer).not.toContain('Who’s assigned');expect(answer).not.toContain('No detailed work description');
 }
});
it('a broad blocker question without a selected job checks all jobs',()=>{
 expect(resolveQuestionPlan(plan('assignment'),'Is anything blocked?',[]).scope).toBe('all');
});

it('open-ended facts come from records rather than invented model prose',()=>{
 const selected={...data.jobs[0]!.job,score:90,reasons:[],canAssign:false,nextAction:'Review'};
 const state={checkedAt:data.checkedAt,total:1,truncated:false,items:[selected],selected,team:[]};
 const facts=replyEvidence(plan('general'),state,data);
 const rendered=renderEvidenceAnswer({factIds:['pine:blocker'],nextStep:'The client deadline has been exceeded.',action:'none'},facts,plan('general'),data,'Describe the obstacle in one sentence.');
 expect(rendered).toContain('Waiting for the supplier');expect(rendered).not.toContain('exceeded');expect(rendered).not.toContain('has not arrived');
});
it('unrecognized evidence IDs cannot introduce made-up facts',()=>{
 const rendered=renderEvidenceAnswer({factIds:['invented'],nextStep:null,action:'none'},[],plan('general'),data,'What is happening?');
 expect(rendered).toContain('I don’t know from the saved details');
});

it('does not mistake the technician Riley for Riley Park Café during blocker resolution',()=>{
 const jobs=[
  {...data.jobs[0]!.job,customerReference:'Pine Grocery — replacement fan required'},
  {...data.jobs[0]!.job,id:'cafe',externalId:'CAFE-12',customerReference:'Riley Park Café — Dishwasher service'},
 ];
 const question='The replacement fan has arrived and Riley is ready to resume work. Please clear the blocker.';
 const resolved=resolveQuestionPlan({...plan('general'),personName:'Riley Technician'},question,jobs,'pine','pine',['Riley Technician']);
 expect(resolved.topic).toBe('blocker');expect(resolved.jobIds).toEqual(['pine']);
 expect(resolveQuestionPlan(plan('general'),'Who is assigned to Riley Park Café?',jobs,'pine','pine',['Riley Technician']).jobIds).toEqual(['cafe']);
});

it('blocker help admits the missing confirmation and gives only saved technician contacts',()=>{
 const item={...data.jobs[0]!,contacts:{technician:{name:'Riley Technician',phone:'+15550102020',email:'riley@relay-demo.invalid'},client:null}};
 const answer=factualAnswer(plan('blocker'),{...data,jobs:[item]})!;
 expect(answer).toContain('I don’t know');expect(answer).toContain('Ask Riley Technician');
 expect(answer).toContain('+15550102020');expect(answer).toContain('riley@relay-demo.invalid');
 expect(answer).toContain('No client phone or email is saved');
 expect(answer).not.toContain('resolveBlocker=1');expect(answer).not.toContain('Open job to resolve');
});
it('unknown answers give a human follow-up without pretending a resolution is known',()=>{
 const rendered=renderEvidenceAnswer({factIds:[],nextStep:null,action:'none'},[],plan('general'),data,'Does the client have a spare fan in stock?');
 expect(rendered).toContain('I don’t know from the saved details');expect(rendered).toContain('Riley Technician or the client');
 expect(rendered).toContain('no phone or email is saved');expect(rendered).not.toContain('has a spare');
});
it('contact questions resolve contacts without making up client details',()=>{
 const jobs=[data.jobs[0]!.job];
 const question=resolveQuestionPlan(plan('general'),'What is Riley’s phone number?',jobs,'pine','pine',['Riley Technician']);
 expect(question.topic).toBe('contacts');
 expect(factualAnswer(question,data)).toContain('No client phone or email is saved');
});

it('Resolve handles an overdue task without claiming the job is blocked',()=>{
 const job={...data.jobs[0]!.job,customerReference:'Oak Bakery — oven temperature repair',status:'in_progress',blocker:null,attentionReasons:['overdue_commitment']};
 const item={...data.jobs[0]!,job,commitments:[{title:'Send diagnostic findings to dispatch',ownerName:'Riley Technician',dueLabel:'Nov 5, 4:17 p.m. GMT-7',status:'open'}]};
 const resolved=resolveQuestionPlan(plan('general'),'Help me resolve what needs attention on this job. What is confirmed, what is still unknown, and what should I ask the assigned technician or client?',[job],'pine','pine');
 expect(resolved.topic).toBe('resolution');
 const answer=factualAnswer(resolved,{...data,jobs:[item]})!;
 expect(answer).toContain('Send diagnostic findings to dispatch');expect(answer).toContain('Ask Riley Technician whether the task is done');
 expect(answer).toContain('I don’t know whether they have been done');expect(answer).not.toContain('What’s blocked');expect(answer).not.toContain('part will arrive');
});

it('a Resolve prompt stays on the selected job when a client has multiple jobs',()=>{
 const jobs=[
  {...data.jobs[0]!.job,id:'request',customerReference:'Cedar Shop — new service request'},
  {...data.jobs[0]!.job,id:'callback',customerReference:'Cedar Shop — post-repair follow-up'},
 ];
 const resolved=resolveQuestionPlan(plan('general'),'Help me resolve what needs attention on this job (Cedar Shop — new service request).',jobs,'callback','request');
 expect(resolved.scope).toBe('current');expect(resolved.jobIds).toEqual(['request']);
});

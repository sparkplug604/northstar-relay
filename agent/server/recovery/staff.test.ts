import {expect,it} from 'vitest';
import {staffAnswer,staffTopic,workPeriods} from './staff.js';
import {resolveQuestionPlan,type DispatchPlan} from './dispatch-answer.js';
const now=Date.parse('2026-11-08T09:00:00Z');
const profile={timezone:'America/Vancouver',skills:['electrical','refrigeration'],workingHours:[1,2,3,4,5].map(weekday=>({weekday,start:'08:00',end:'18:00'})),timeOff:[{start:'2026-11-09T08:00:00-08:00',end:'2026-11-09T12:00:00-08:00'}]};
const people=[{personId:'riley',displayName:'Riley Technician',profile},{personId:'casey',displayName:'Casey Technician',profile:{...profile,timeOff:[]}}];
const plan:DispatchPlan={topic:'general',scope:'current',jobIds:['pine'],personName:'Riley Technician'};
it.each([
 'Do you know when Riley will be on shift?',
 'When is Riley on duty?',
 'What hours does Riley work?',
 'Does Riley work weekends?',
])('retrieves staff data instead of Pine job evidence: %s',question=>{
 const resolved=resolveQuestionPlan(plan,question,[],'pine','pine',people.map(person=>person.displayName));
 expect(resolved.topic).toBe('working_hours');expect(resolved.jobIds).toEqual([]);expect(resolved.scope).toBe('all');
 const answer=staffAnswer('working_hours',people,question,'Riley Technician',now);
 expect(answer).toContain('Riley Technician — working hours');expect(answer).not.toContain('Supplier');
});
it('subtracts time off as instants using the same permanent UTC-7 rules as Relay',()=>{
 expect(workPeriods(profile,'2026-11-09')).toEqual([
  {start:Date.parse('2026-11-09T15:00Z'),end:Date.parse('2026-11-09T16:00Z')},
  {start:Date.parse('2026-11-09T20:00Z'),end:Date.parse('2026-11-10T01:00Z')},
 ]);
 const answer=staffAnswer('working_hours',people,'Do you know when Riley will be on shift?','Riley Technician',now);
 expect(answer).toContain('Next working period');expect(answer).toContain('Nov 9, 8:00 a.m. GMT-7');expect(answer).toContain('Nov 9, 1:00 p.m. GMT-7');
 expect(answer).toContain('not confirmation they are free for another job');
});
it('starts the next work period after time off when the person is currently off',()=>{
 const answer=staffAnswer('working_hours',people,'When is Riley next on shift?',undefined,Date.parse('2026-11-09T17:00Z'));
 expect(answer).toContain('Next working period');expect(answer).not.toContain('Currently within');
 expect(answer.indexOf('Nov 9, 1:00 p.m.')).toBeLessThan(answer.indexOf('Usual hours'));
});
it('retains the profile topic only for a direct follow-up',()=>{
 expect(staffTopic('tomorrow?','working_hours')).toBe('working_hours');
 expect(staffTopic('what about casey?','working_hours')).toBe('working_hours');
 expect(staffTopic('what time does he start?','working_hours')).toBe('working_hours');
 expect(staffTopic('is anything blocked?','working_hours')).toBeUndefined();
 expect(staffTopic('why?','working_hours')).toBeUndefined();
 expect(staffAnswer('working_hours',people,'Tomorrow?','Riley Technician',now)).toContain('requested day');
 expect(staffAnswer('working_hours',people,'What about Casey?','Riley Technician',now)).toContain('Casey Technician — working hours');
});
it('does not substitute the current assignee for an explicitly unknown technician',()=>{
 for(const question of ['When will Morgan be on shift?','What hours does Morgan work?']){
  const answer=staffAnswer('working_hours',people,question,'Riley Technician',now);
  expect(answer).toContain('profile for **Morgan**');expect(answer).not.toContain('Riley Technician —');
 }
});
it('does not infer hours from a missing or empty profile',()=>{
 expect(staffAnswer('working_hours',[{personId:'riley',displayName:'Riley Technician',profile:null}],'When is Riley on shift?',undefined,now)).toContain('don’t have a complete');
 expect(staffAnswer('working_hours',[{personId:'riley',displayName:'Riley Technician',profile:{...profile,workingHours:[]}}],'When is Riley on shift?',undefined,now)).toContain('No working hours are recorded');
});
it('time off and skills use staff fields without a job-specific availability claim',()=>{
 expect(staffTopic('what skills does riley have?')).toBe('skills');expect(staffTopic('does riley have time off?')).toBe('time_off');
 expect(staffAnswer('skills',people,'What skills does Riley have?',undefined,now)).toContain('refrigeration');
 expect(staffAnswer('time_off',people,'Does Riley have time off?',undefined,now)).toContain('Nov 9, 9:00 a.m. GMT-7');
});
it('converts another timezone with its DST rule rather than reusing Vancouver offsets',()=>{
 const eastern={...profile,timezone:'America/Toronto',timeOff:[]};
 expect(workPeriods(eastern,'2026-11-09')[0]?.start).toBe(Date.parse('2026-11-09T13:00Z'));
});

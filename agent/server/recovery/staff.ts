import {z} from 'zod';
import {displayTime,workingTimezone} from './dispatch-time.js';
export const staffTopics=['working_hours','time_off','skills'] as const;
export type StaffTopic=typeof staffTopics[number];
const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const profileSchema=z.object({timezone:z.string(),skills:z.array(z.string()),workingHours:z.array(z.object({weekday:z.number().int().min(0).max(7),start:time,end:time.or(z.literal('24:00'))})),timeOff:z.array(z.object({start:z.string(),end:z.string()}))});
type Profile=z.infer<typeof profileSchema>;
type Technician={personId:string;displayName:string;profile:unknown};
export function staffTopic(question:string,previous?:string):StaffTopic|undefined{
 if(/\b(?:time off|vacation|holiday|leave|pto)\b/.test(question))return 'time_off';
 if(/\b(?:skills?|qualifications?|certifications?|trained|training)\b/.test(question))return 'skills';
 if(/\b(?:shifts?|on duty|off duty|working hours|work hours)\b|\b(?:work|working)\b.*\b(?:hours|today|tomorrow|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:when|hours)\b.*\b(?:works?|working)\b/.test(question))return 'working_hours';
 if(staffTopics.includes(previous as StaffTopic)&&(/^(?:and|what about|how about)\s+[a-z]+(?: technician)?\s*[?.!]*$/.test(question)||/^(?:(?:and|what about|how about)\s+)?(?:today|tomorrow|next week|(?:next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\s*[?.!]*$/.test(question)))return previous as StaffTopic;
 if(previous==='working_hours'&&/\b(?:he|she|they|his|her|their)\b.*\b(?:start|finish|end|hours)\b/.test(question))return 'working_hours';
 return undefined;
}
const safe=(value:string)=>value.replace(/[\[\]<>*_#]/g,'');
export function localDay(instant:number,timezone:string){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:workingTimezone(timezone,instant),year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(instant);
 const part=(key:string)=>parts.find(item=>item.type===key)!.value;
 return part('year')+'-'+part('month')+'-'+part('day');
}
export function addDays(day:string,count:number){return new Date(Date.parse(day+'T00:00:00Z')+count*86400000).toISOString().slice(0,10);}
function wallTime(day:string,time:string,timezone:string):number|null{
 const target=Date.parse(day+'T'+time+':00Z');let instant=target;
 for(let attempt=0;attempt<4;attempt++){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:workingTimezone(timezone,instant),year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(instant);
  const value=(key:string)=>Number(parts.find(item=>item.type===key)!.value);
  const wall=Date.UTC(value('year'),value('month')-1,value('day'),value('hour'),value('minute'));
  if(wall===target)return instant;
  instant+=target-wall;
 }
 return null;
}
export function workPeriods(profile:Profile,day:string){
 const weekday=new Date(day+'T00:00:00Z').getUTCDay();
 let periods=profile.workingHours.filter(hours=>hours.weekday%7===weekday).flatMap(hours=>{
  const start=wallTime(day,hours.start,profile.timezone),end=wallTime(day,hours.end,profile.timezone);
  return start!==null&&end!==null&&end>start?[{start,end}]:[];
 });
 for(const off of profile.timeOff){const start=Date.parse(off.start),end=Date.parse(off.end);
  periods=periods.flatMap(period=>end<=period.start||start>=period.end?[period]:[
   ...(start>period.start?[{start:period.start,end:Math.min(start,period.end)}]:[]),
   ...(end<period.end?[{start:Math.max(end,period.start),end:period.end}]:[]),
  ]);
 }
 return periods.sort((a,b)=>a.start-b.start);
}
function requestedDays(question:string,timezone:string,now:number){
 const today=localDay(now,timezone);
 if(/\btomorrow\b/i.test(question))return [addDays(today,1)];
 if(/\btoday\b/i.test(question))return [today];
 if(/\bnext week\b/i.test(question)){const weekday=new Date(today+'T00:00:00Z').getUTCDay();const monday=addDays(today,(8-weekday)%7||7);return Array.from({length:7},(_,index)=>addDays(monday,index));}
 const names=weekdays.map((name,index)=>({name,index})).filter(day=>new RegExp('\\b'+day.name+'\\b','i').test(question));
 if(names.length){const current=new Date(today+'T00:00:00Z').getUTCDay();return names.map(day=>addDays(today,(day.index-current+7)%7||(/\bnext\b/i.test(question)?7:0)));}
 if(/\bweekends?\b/i.test(question)){const current=new Date(today+'T00:00:00Z').getUTCDay();const saturday=addDays(today,(6-current+7)%7);return [saturday,addDays(saturday,1)];}
 return null;
}
export function staffAnswer(topic:StaffTopic,technicians:Technician[],question:string,personName?:string,now=Date.now()){
 const tokens=question.toLowerCase().split(/[^a-z0-9]+/);
 const named=technicians.filter(person=>tokens.includes(person.displayName.toLowerCase().split(' ')[0]!));
 // An explicit but unknown name must not silently fall back to the job's assignee.
 const candidate=/\bwhen\s+([a-z]+)\s+(?:will|works?|is)\b|\bwhen (?:will|does|is)\s+([a-z]+)\b|\b([a-z]+)[’']s\s+(?:hours|shift|skills|time off)|\b(?:does|will|is)\s+([a-z]+)\s+(?:work|working|be|start|finish)\b/i.exec(question);
 const unknown=candidate?.slice(1).find(Boolean);
 if(!named.length&&unknown&&!['he','she','they','the','a','this','his','her','their','my'].includes(unknown.toLowerCase())&&!technicians.some(person=>person.displayName.toLowerCase().split(' ')[0]===unknown.toLowerCase()))return 'I don’t have a technician profile for **'+safe(unknown)+'**. Check the name in Team → People.';
 const selected=named.length?named:personName?technicians.filter(person=>person.displayName===personName):/\b(?:who|team|everyone|technicians)\b/i.test(question)?technicians:[];
 if(!selected.length)return '**Which technician do you mean?**\n\nTell me their name so I can check saved working hours, time off or skills.';
 return selected.map(person=>{
  const parsed=profileSchema.safeParse(person.profile);
  if(!parsed.success)return '**'+safe(person.displayName)+'**\n\nI don’t have a complete working-hours profile for this technician. Check with them and update Team → People.';
  const profile=parsed.data,label=(instant:number)=>displayTime(new Date(instant).toISOString(),profile.timezone);
  const heading='**'+safe(person.displayName)+' — '+(topic==='skills'?'skills':topic==='time_off'?'time off':'working hours')+'**';
  if(topic==='skills')return heading+'\n\n'+(profile.skills.length?profile.skills.map(skill=>'- '+safe(skill)).join('\n'):'No skills are recorded. Check with the technician.');
  const days=requestedDays(question,profile.timezone,now);
  const off=profile.timeOff.filter(period=>days?days.some(day=>{const start=wallTime(day,'00:00',profile.timezone),end=wallTime(addDays(day,1),'00:00',profile.timezone);return start!==null&&end!==null&&Date.parse(period.end)>start&&Date.parse(period.start)<end;}):Date.parse(period.end)>now);
  if(topic==='time_off')return heading+'\n\n'+(off.length?off.map(period=>'- '+label(Date.parse(period.start))+' to '+label(Date.parse(period.end))).join('\n'):'No upcoming time off is recorded.')+'\n\nTimezone: '+profile.timezone+'.';
  if(!profile.workingHours.length)return heading+'\n\nNo working hours are recorded. Check with the technician and update Team → People.';
  const windows=(days??Array.from({length:15},(_,index)=>addDays(localDay(now,profile.timezone),index))).flatMap(day=>workPeriods(profile,day)).filter(period=>days||period.end>now);
  const periods=windows.slice(0,days?8:2);
  const result=periods.length?(days?'**Work periods for the requested day:**':periods[0]!.start<=now?'**Currently within saved working hours:**':'**Next working period:**')+'\n\n'+periods.map(period=>'- '+label(period.start)+' to '+label(period.end)).join('\n'):days?'No working period is recorded for that day after time off is taken into account.':'No working period is recorded in the next 14 days after time off is taken into account.';
  const weekly=profile.workingHours.map(hours=>weekdays[hours.weekday%7]+' '+hours.start+'–'+hours.end).join('; ');
  return heading+'\n\n'+result+'\n\n**Usual hours:** '+weekly+' ('+profile.timezone+').'+(off.length?'\n\n**Time off:**\n\n'+off.slice(0,3).map(period=>'- '+label(Date.parse(period.start))+' to '+label(Date.parse(period.end))).join('\n'):'')+'\n\nThese are saved working hours, not confirmation they are free for another job. Use Plan assignment to check bookings and travel.';
 }).join('\n\n');
}

export function nextWorkPeriods(value:unknown,now=Date.now()){
 const parsed=profileSchema.safeParse(value);if(!parsed.success)return [];
 const profile=parsed.data;return Array.from({length:15},(_,index)=>addDays(localDay(now,profile.timezone),index)).flatMap(day=>workPeriods(profile,day)).filter(period=>period.end>now).slice(0,6).map(period=>({start:new Date(period.start).toISOString(),end:new Date(period.end).toISOString(),startLabel:displayTime(new Date(period.start).toISOString(),profile.timezone),endLabel:displayTime(new Date(period.end).toISOString(),profile.timezone)}));
}

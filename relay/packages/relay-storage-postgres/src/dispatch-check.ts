import {DateTime} from 'luxon';
import {dispatchZone} from './timezone.js';
import type {Job,JobSite,TechnicianPlanning,TechnicianProfile,TechnicianCandidate,TravelEstimate} from '@northstar/relay-domain';
import {roadTravel} from './travel.js';

export const overlaps=(start:number,end:number,otherStart:number,otherEnd:number)=>start<otherEnd&&end>otherStart;
type Route=(from:JobSite,to:JobSite)=>Promise<TravelEstimate>;

export function workingPeriods(profile:TechnicianProfile|null,from:number,to:number){
  const periods:{start:number;end:number}[]=[];
  if(!profile)return periods;
  let day=DateTime.fromMillis(from,{zone:dispatchZone(profile.timezone)}).startOf('day');
  for(let index=0;index<18&&day.toMillis()<=to;index++,day=day.plus({days:1})){
    for(const window of profile.workingHours.filter(window=>window.weekday===day.weekday)){
      const [sh,sm]=window.start.split(':').map(Number),[eh,em]=window.end.split(':').map(Number);
      periods.push({start:day.set({hour:sh!,minute:sm!}).toMillis(),
        end:eh===24?day.plus({days:1}).toMillis():day.set({hour:eh!,minute:em!}).toMillis()});
    }
  }
  periods.sort((a,b)=>a.start-b.start);
  const windows:{start:number;end:number}[]=[];
  for(const period of periods){
    const previous=windows.at(-1);
    if(previous&&period.start<=previous.end)previous.end=Math.max(previous.end,period.end);
    else windows.push({...period});
  }
  return windows;
}

export async function checkTechnician(job:Job,technician:TechnicianPlanning,jobs:Job[],now:string,route:Route=roadTravel):Promise<TechnicianCandidate>{
  const candidate:TechnicianCandidate={personId:technician.personId,displayName:technician.displayName,
    profileVersion:technician.version,status:'available',reasons:[],travel:[]};
  let blocked=false,unknown=false;
  const block=(message:string)=>{blocked=true;candidate.reasons.push(message);};
  const check=(message:string)=>{unknown=true;candidate.reasons.push(message);};
  const profile=technician.profile;
  if(!profile)check('Working hours, skills and time off have not been recorded.');
  if(job.requiredSkills===undefined)check('Required skills have not been recorded for this job.');
  else if(profile){
    const missing=job.requiredSkills.filter(skill=>!profile.skills.includes(skill));
    if(missing.length)block('Missing required skills: '+missing.join(', ')+'.');
    else candidate.reasons.push('Required skills match.');
  }
  const start=job.scheduledAt?Date.parse(job.scheduledAt):NaN;
  const duration=job.estimatedMinutes;
  if(!Number.isFinite(start))check('Set a scheduled time for this job.');
  else if(start<Date.parse(now))block('The scheduled start is in the past.');
  if(!duration)check('Record an estimated visit length.');
  if(!Number.isFinite(start)||!duration){candidate.status=blocked?'blocked':'needs_check';return candidate;}
  const end=start+duration*60000;
  if(job.serviceWindow?.earliestStart&&start<Date.parse(job.serviceWindow.earliestStart))block('The client cannot start before the requested time.');
  if(job.serviceWindow?.completeBy&&end>Date.parse(job.serviceWindow.completeBy))block('The visit would finish after the client deadline.');
  const local=DateTime.fromMillis(start,{zone:dispatchZone(profile?.timezone??'UTC')});
  const windows=workingPeriods(profile,start-86400000,end+86400000);
  const window=windows.find(window=>window.start<=start&&window.end>=end);
  if(profile&&!window)block('The visit falls outside working hours.');
  if(profile?.timeOff.some(off=>overlaps(start,end,Date.parse(off.start),Date.parse(off.end))))block('Time off overlaps this visit.');
  const busy=jobs.filter(other=>other.id!==job.id&&other.assigneeId===technician.personId&&
    !['completed','cancelled','completion_reported'].includes(other.status));
  let previous:Job|undefined,next:Job|undefined;
  let previousEnd=-Infinity,nextStart=Infinity;
  for(const other of busy){
    if(!other.scheduledAt){
      if(['in_progress','blocked'].includes(other.status))check('An active job has no scheduled start: '+other.customerReference+'.');
      continue;
    }
    const otherStart=Date.parse(other.scheduledAt);
    if(!other.estimatedMinutes){
      if(otherStart<end)check('Another assigned job has no visit length: '+other.customerReference+'.');
      continue;
    }
    const otherEnd=otherStart+other.estimatedMinutes*60000;
    if(overlaps(start,end,otherStart,otherEnd))block('Conflicts with '+other.customerReference+'.');
    const sameDay=window?otherEnd>=window.start&&otherStart<=window.end:DateTime.fromMillis(otherStart,{zone:dispatchZone(profile?.timezone??'UTC')}).hasSame(local,'day');
    if(otherEnd<=start&&otherEnd>previousEnd&&sameDay){previous=other;previousEnd=otherEnd;}
    if(otherStart>=end&&otherStart<nextStart&&sameDay){next=other;nextStart=otherStart;}
    if(['in_progress','blocked'].includes(other.status)&&otherEnd<=Date.parse(now))check('Confirm that the earlier active job has finished: '+other.customerReference+'.');
  }
  const beforeSite=previous?previous.site:profile?.base;
  const afterSite=next?next.site:profile?.base;
  const earliestDeparture=previous?previousEnd:window?.start;
  const departure=earliestDeparture===undefined?undefined:Math.max(earliestDeparture,Date.parse(now));
  const deadline=next?nextStart:window?.end;
  if(!job.site)check('The job location has not been recorded.');
  if(!blocked&&job.site){
    for(const leg of [
      {direction:'before' as const,from:beforeSite,to:job.site,limit:departure===undefined?undefined:(start-departure)/60000},
      {direction:'after' as const,from:job.site,to:afterSite,limit:deadline===undefined?undefined:(deadline-end)/60000},
    ]){
      if(!leg.from||!leg.to){check('Record '+(leg.direction==='before'?'the previous job or starting':'the next job or return')+' location to check travel.');continue;}
      const estimate=await route(leg.from,leg.to);
      candidate.travel.push({direction:leg.direction,from:leg.from.label,to:leg.to.label,minutes:estimate.minutes,source:estimate.source});
      if(estimate.minutes===null)check('Road travel could not be estimated. Check the route before assigning.');
      else if(leg.limit!==undefined&&estimate.minutes+10>leg.limit)block('Not enough time for '+(leg.direction==='before'?'travel to this job':'travel after this job')+' including a 10-minute buffer.');
      if(profile&&estimate.minutes!==null){
        const a=leg.direction==='before'?start-(estimate.minutes+10)*60000:end;
        const b=leg.direction==='before'?start:end+(estimate.minutes+10)*60000;
        if(profile.timeOff.some(off=>overlaps(a,b,Date.parse(off.start),Date.parse(off.end))))block('Time off overlaps required travel.');
      }
    }
  }
  if(!blocked&&!unknown)candidate.reasons.push('Working hours, time off, booked visits and estimated travel fit.');
  candidate.status=blocked?'blocked':unknown?'needs_check':'available';
  return candidate;
}

import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Job,TechnicianPlanning,TravelEstimate} from '@northstar/relay-domain';
import {checkTechnician} from '../packages/relay-storage-postgres/src/dispatch-check.js';
import {dispatchZone} from '../packages/relay-storage-postgres/src/timezone.js';
import {DateTime} from 'luxon';
import {newStandaloneJob} from '@northstar/relay-domain';
import {technicianProfileSchema} from '../apps/api/src/relay/dispatchSchema.js';

const site={label:'Depot',latitude:49.26,longitude:-123.12};
const now='2026-11-02T15:00:00Z'; // Monday, 07:00 Pacific after DST ends.
const job:Job={...newStandaloneJob({branchId:'branch',externalId:'REPAIR',customerReference:'Cooler repair',priority:'normal',description:'Fix the cooler'},'job',now),
  requiredSkills:['refrigeration'],site,estimatedMinutes:60,scheduledAt:'2026-11-02T18:00:00Z'};
const tech:TechnicianPlanning={personId:'sam',displayName:'Sam',branchId:'branch',version:1,
  profile:{timezone:'America/Los_Angeles',skills:['refrigeration'],workingHours:[{weekday:1,start:'08:00',end:'18:00'}],timeOff:[],base:site}};
const route=async():Promise<TravelEstimate>=>({minutes:10,source:'OSRM',checkedAt:now});
test('availability requires skills, shift hours, time off, scheduled work and both travel legs',async()=>{
  assert.equal((await checkTechnician(job,tech,[],now,route)).status,'available');
  assert.equal((await checkTechnician(job,{...tech,profile:{...tech.profile!,skills:[]}},[],now,route)).status,'blocked');
  assert.equal((await checkTechnician({...job,scheduledAt:'2026-11-02T15:30:00Z'},tech,[],now,route)).status,'blocked');
  assert.equal((await checkTechnician(job,{...tech,profile:{...tech.profile!,timeOff:[{start:'2026-11-02T18:10:00Z',end:'2026-11-02T18:30:00Z'}]}},[],now,route)).status,'blocked');
  const other={...job,id:'other',assigneeId:'sam',scheduledAt:'2026-11-02T18:30:00Z'};
  assert.equal((await checkTechnician(job,tech,[other],now,route)).status,'blocked');
  assert.equal((await checkTechnician(job,tech,[{...other,status:'cancelled'}],now,route)).status,'available');
});
test('adjacent visits still need driving time and a buffer before and after the job',async()=>{
  const before={...job,id:'before',assigneeId:'sam',scheduledAt:'2026-11-02T17:00:00Z'};
  const after={...job,id:'after',assigneeId:'sam',scheduledAt:'2026-11-02T19:00:00Z'};
  assert.equal((await checkTechnician(job,tech,[before],now,route)).status,'blocked');
  assert.equal((await checkTechnician(job,tech,[after],now,route)).status,'blocked');
  const timeOff={...tech,profile:{...tech.profile!,timeOff:[{start:'2026-11-02T17:40:00Z',end:'2026-11-02T17:50:00Z'}]}};
  assert.equal((await checkTechnician(job,timeOff,[],now,route)).status,'blocked');
});
test('missing legacy data and failed routing never become a positive recommendation',async()=>{
  const noRoute=async():Promise<TravelEstimate>=>({minutes:null,source:'unknown',checkedAt:now});
  assert.equal((await checkTechnician(job,tech,[],now,noRoute)).status,'needs_check');
  assert.equal((await checkTechnician(job,{...tech,profile:null},[],now,route)).status,'needs_check');
  const legacy={...job};delete legacy.requiredSkills;
  assert.equal((await checkTechnician(legacy,tech,[],now,route)).status,'needs_check');
  const missingLength={...job,id:'old',assigneeId:'sam'};delete missingLength.estimatedMinutes;
  assert.equal((await checkTechnician(job,tech,[missingLength],now,route)).status,'needs_check');
  const unfinished={...job,id:'old',assigneeId:'sam',status:'in_progress' as const,scheduledAt:null};
  assert.equal((await checkTechnician(job,tech,[unfinished],now,route)).status,'needs_check');
});
test('shift checks use the technician timezone across DST and preserve back-to-back boundaries',async()=>{
  const summer={...job,scheduledAt:'2026-07-06T16:00:00Z'};
  assert.equal((await checkTechnician(summer,tech,[],'2026-07-06T14:00:00Z',route)).status,'available');
  const atEnd={...job,scheduledAt:'2026-11-03T01:00:00Z'}; // 17:00–18:00 local, no return buffer.
  assert.equal((await checkTechnician(atEnd,tech,[],now,route)).status,'blocked');
});
test('profile schema rejects invalid timezones, hours, coordinates and time-off ranges',()=>{
  assert.equal(technicianProfileSchema.safeParse(tech.profile).success,true);
  for(const patch of [{timezone:'Mars/Crater'},{workingHours:[{weekday:1,start:'17:00',end:'08:00'}]},
    {timeOff:[{start:'2026-11-02T19:00:00Z',end:'2026-11-02T18:00:00Z'}]},{base:{...site,latitude:91}}]){
    assert.equal(technicianProfileSchema.safeParse({...tech.profile,...patch}).success,false);
  }
});

test('split overnight working periods join at midnight across a DST shift',async()=>{
  const overnight={...tech,profile:{...tech.profile!,workingHours:[
    {weekday:6,start:'20:00',end:'24:00'},{weekday:7,start:'00:00',end:'08:00'},
  ]}};
  // 23:30 PDT Saturday through the repeated hour on Sunday.
  const visit={...job,scheduledAt:'2026-11-01T06:30:00Z',estimatedMinutes:180};
  assert.equal((await checkTechnician(visit,overnight,[],'2026-11-01T03:00:00Z',route)).status,'available');
});


test('Vancouver uses packaged IANA rules for permanent Pacific time after March 2026',()=>{
  assert.equal(DateTime.fromISO('2026-11-09T08:30:00',{zone:dispatchZone('America/Vancouver')}).toUTC().toISO(),'2026-11-09T15:30:00.000Z');
});

test('a same-day opening allows enough driving time from now, not just shift start',async()=>{
  const visit={...job,scheduledAt:'2026-11-02T18:00:00Z'};
  const evaluated=await checkTechnician(visit,tech,[],'2026-11-02T17:55:00Z',route);
  assert.equal(evaluated.status,'blocked');
  assert.ok(evaluated.reasons.some(reason=>reason.includes('travel to this job')));
});

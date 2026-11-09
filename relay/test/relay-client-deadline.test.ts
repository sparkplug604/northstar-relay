import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clientDeadlineStatus} from '../apps/web/src/relay/deadlineStatus.js';
import type {Job} from '../apps/web/src/relay/jobsModel.js';
const now=Date.parse('2026-11-09T16:00:00Z');
const job={status:'scheduled',assigneeId:'tech',scheduledAt:'2026-11-09T16:30:00Z',estimatedMinutes:60,
  serviceWindow:{earliestStart:null,completeBy:'2026-11-09T18:00:00Z'},completionReportedAt:null,completedAt:null} as Job;
test('deadline passed without a finish report is missed',()=>{
  assert.equal(clientDeadlineStatus(job,now+3*3600000).label,'Client deadline missed');
});
test('a scheduled visit that ends after the client deadline is at risk',()=>{
  assert.equal(clientDeadlineStatus({...job,scheduledAt:'2026-11-09T17:30:00Z'},now).label,'At risk — visit finishes late');
});
test('a late start cannot imply that the old scheduled finish still fits',()=>{
  assert.equal(clientDeadlineStatus(job,Date.parse('2026-11-09T17:30:00Z')).label,'At risk — not enough time');
});
test('finish reports prevent an already finished job becoming overdue',()=>{
  assert.equal(clientDeadlineStatus({...job,status:'completed',completionReportedAt:'2026-11-09T17:00:00Z',completedAt:'2026-11-10T18:00:00Z'},now+2*86400000).tone,'neutral');
});
test('missing duration and missing deadline do not imply the plan fits',()=>{
  const noDuration={...job};delete noDuration.estimatedMinutes;
  const noDeadline={...job};delete noDeadline.serviceWindow;
  assert.equal(clientDeadlineStatus(noDuration,now).label,'Finish time needs checking');
  assert.equal(clientDeadlineStatus(noDeadline,now).label,'Client deadline not recorded');
});

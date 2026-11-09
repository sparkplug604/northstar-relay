import type {Job} from './jobsModel.js';

export function clientDeadlineStatus(job:Job,now=Date.now()){
  const deadline=job.serviceWindow?.completeBy;
  if(!deadline)return {tone:'neutral',label:job.serviceWindow?'No fixed deadline':'Client deadline not recorded',detail:job.serviceWindow?'':'Ask the client when the work needs to be finished.'};
  const due=Date.parse(deadline);
  if(job.status==='cancelled')return {tone:'neutral',label:'Job cancelled',detail:''};
  const finished=job.completionReportedAt??job.completedAt;
  if(finished)return Date.parse(finished)>due
    ?{tone:'danger',label:'Work reported finished late',detail:'The recorded finish is after the client deadline.'}
    :{tone:'neutral',label:'Work reported finished by deadline',detail:''};
  if(now>=due)return {tone:'danger',label:'Client deadline missed',detail:'The deadline has passed and work has not been reported finished.'};
  const duration=(job.estimatedMinutes??0)*60000;
  if(duration&&now+duration>due)return {tone:'danger',label:'At risk — not enough time',detail:'The estimated visit would finish late even if work started now.'};
  if(job.scheduledAt&&duration&&Math.max(Date.parse(job.scheduledAt),now)+duration>due)
    return {tone:'danger',label:'At risk — visit finishes late',detail:'The scheduled start plus the estimated visit runs past the client deadline.'};
  if(job.status==='blocked')return {tone:'warning',label:'At risk — work is blocked',detail:'Resolve the blocker to protect the client deadline.'};
  if(!job.assigneeId||!job.scheduledAt)return {tone:'warning',label:'At risk — visit not arranged',detail:!job.assigneeId?'Assign a technician and confirm a visit time.':'Confirm a visit time before the client deadline.'};
  if(!duration)return {tone:'warning',label:'Finish time needs checking',detail:'Add an estimated visit length to check the client deadline.'};
  if(due-now<=24*3600000)return {tone:'warning',label:'Due within 24 hours',detail:'Check that the technician can finish before this time.'};
  return {tone:'neutral',label:'Client completion deadline',detail:'The planned visit fits before this deadline. Availability and travel still need checking.'};
}

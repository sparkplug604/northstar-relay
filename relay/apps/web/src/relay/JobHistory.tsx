import {dateLabel,tr,type Language} from './i18n.js';
import {jt,jobEventLabel} from './jobsI18n.js';
import type {JobEvent} from './jobsModel.js';
import {DateTime} from './DateTime.js';

export function JobHistory({events,language,personName}:{events:JobEvent[];language:Language;personName(id:string|null):string}){
  return <section className="relay-card"><h2>{jt(language,'history')}</h2><ol className="relay-timeline">
    {[...events].sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt)).map(event=>{
      const details=event.details;
      return <li key={event.id}>
        <strong>{jobEventLabel(language,event.kind)}</strong>
        <div><DateTime value={event.occurredAt} language={language}/> · {personName(event.actorId)}</div>
        {event.note&&<p className="relay-event-reason">{event.note}</p>}
        {typeof details.title==='string'&&<small>{details.title}</small>}
        {event.kind==='job_unassigned'&&typeof details.previousAssigneeId==='string'&&<small>{jt(language,'previousAssignee')}: {personName(details.previousAssigneeId)}</small>}
        {typeof details.assigneeId==='string'&&<small>{jt(language,'assigned')}: {personName(details.assigneeId)}</small>}
        {typeof details.oldDueAt==='string'&&<small>{jt(language,'oldDeadline')}: {dateLabel(language,details.oldDueAt)}</small>}
        {typeof details.newDueAt==='string'?<small>{jt(language,'newDeadline')}: {dateLabel(language,details.newDueAt)}</small>:typeof details.dueAt==='string'&&<small>{tr(language,'deadline')}: {dateLabel(language,details.dueAt)}</small>}
        {typeof details.previousScheduledAt==='string'&&<small>{jt(language,'previousSchedule')}: {dateLabel(language,details.previousScheduledAt)}</small>}
        {typeof details.scheduledAt==='string'&&<small>{jt(language,'scheduledAt')}: {dateLabel(language,details.scheduledAt)}</small>}
        {details.completedLate===true&&<small className="relay-overdue">{jt(language,'completedLate')}</small>}
      </li>;
    })}
  </ol></section>;
}

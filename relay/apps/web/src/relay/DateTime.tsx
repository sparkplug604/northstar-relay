import {dateLabel,type Language} from './i18n.js';
import {jt} from './jobsI18n.js';
export function displayTimezone():string{return Intl.DateTimeFormat().resolvedOptions().timeZone;}
export function DateTime({value,language}:{value:string|null|undefined;language:Language}){
  if(!value||!Number.isFinite(Date.parse(value)))return <>—</>;
  const exact=new Date(value).toISOString();return <time className="relay-audit-time" tabIndex={0} dateTime={value} title={`${displayTimezone()} · ${exact}`} aria-label={`${dateLabel(language,value)} · ${displayTimezone()} · ${exact}`}>{dateLabel(language,value)}<span className="relay-exact-time" aria-hidden="true">{exact}</span></time>;
}
export function TimezoneNotice({language}:{language:Language}){return <small className="relay-timezone">{jt(language,'timesIn')}: {displayTimezone()} · {jt(language,'exactTimeHelp')}</small>;}

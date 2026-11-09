import type {Session} from './api.js';
import {tr,type Language} from './i18n.js';
import {jt} from './jobsI18n.js';
import {ux} from './ux.js';
import {useOverview} from './useOverview.js';
import {DateTime} from './DateTime.js';
export function Settings({session,language,navigate}:{session:Session;language:Language;navigate(path:string):void}){
  const {data,error,loading,refresh}=useOverview(session),t=(key:Parameters<typeof tr>[1])=>tr(language,key),j=(key:Parameters<typeof jt>[1])=>jt(language,key),u=(key:Parameters<typeof ux>[1])=>ux(language,key);
  return <>
    <div className="relay-section-heading"><h1>{language==='fr'?'Paramètres':'Settings'}</h1><button type="button" disabled={loading} onClick={()=>void refresh()}>{t(loading?'loading':'refresh')}</button></div>
    <div className="relay-team-tools"><button type="button" className="relay-card" onClick={()=>navigate('/relay/connections')}><strong>{t('connections')}</strong><span aria-hidden="true">→</span></button></div>
    <section className="relay-card"><h2>{j('configuration')}</h2><p className="relay-muted">{j('configurationHelp')}</p>{error&&<p className="relay-warning" role="alert">{u(data?'refreshHelp':'unknown')}</p>}{data?<><dl className="relay-facts"><div><dt>{u('fallbackMissing')}</dt><dd>{data.counts.missingFallback}</dd></div><div><dt>{u('unverified')}</dt><dd>{data.counts.unverifiedContacts}</dd></div></dl><small>{j('shownAt')}: <DateTime value={data.asOf} language={language}/></small></>:loading&&<p role="status">{t('loading')}</p>}</section>
    <section className="relay-card"><h2>{j('diagnostics')}</h2><p>{t(session.providerMode==='live'?'live':'simulated')}</p><p className="relay-muted">{j('usefulDiagnostics')}</p><button type="button" onClick={()=>navigate('/relay/jobs?filter=attention')}>{j('attention')} →</button></section>
  </>;
}

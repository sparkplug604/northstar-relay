import {tr,type Language} from './i18n.js';
import {jt} from './jobsI18n.js';
import {ux} from './ux.js';

export function Team({language,navigate}:{language:Language;navigate(path:string):void}){
  const t=(key:Parameters<typeof tr>[1])=>tr(language,key),j=(key:Parameters<typeof jt>[1])=>jt(language,key);
  const links=[{label:t('people'),path:'/relay/people'},{label:t('onCall'),path:'/relay/on-call'},{label:j('ackHistory'),path:'/relay/history'}];
  return <>
    <div className="relay-section-heading"><h1>{ux(language,'tools')}</h1></div>
    <div className="relay-team-tools">{links.map(link=><button type="button" className="relay-card" key={link.path} onClick={()=>navigate(link.path)}><strong>{link.label}</strong><span aria-hidden="true">→</span></button>)}</div>
  </>;
}

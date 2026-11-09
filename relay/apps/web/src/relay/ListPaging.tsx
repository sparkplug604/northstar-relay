import {jt,type JobText} from './jobsI18n.js';
import type {Language} from './i18n.js';
export function ListPaging({offset,total,count,hasMore,nextOffset,loading,language,onPage}:{offset:number;total:number;count:number;hasMore:boolean;nextOffset:number|null;loading:boolean;language:Language;onPage(offset:number):void}){
  const j=(key:JobText)=>jt(language,key);
  return <div className="relay-list-footer"><small>{count?`${offset+1}–${offset+count}`:'0'} {j('of')} {total}</small><div className="relay-actions"><button type="button" disabled={loading||offset===0} onClick={()=>onPage(Math.max(0,offset-200))}>{j('previousPage')}</button><button type="button" disabled={loading||!hasMore||nextOffset===null} onClick={()=>{if(nextOffset!==null)onPage(nextOffset);}}>{j('nextPage')}</button></div></div>;
}

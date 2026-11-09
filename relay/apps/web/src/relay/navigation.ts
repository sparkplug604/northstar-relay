export interface NavigationOptions {replace?:boolean;restoreScroll?:boolean}
export type RelayNavigate=(path:string,options?:NavigationOptions)=>void;
const listPaths=new Set(['/relay/jobs','/relay/commitments','/relay/intake','/relay/work','/relay/history']);
export function safeReturnTo(value:string|null|undefined,fallback='/relay/jobs'):string{
  if(!value||!value.startsWith('/relay/')||value.startsWith('//'))return fallback;
  try{const url=new URL(value,'http://relay.local');return url.origin==='http://relay.local'&&listPaths.has(url.pathname)?url.pathname+url.search:fallback;}catch{return fallback;}
}
export function withReturnTo(path:string,returnTo:string):string{
  const [pathname,query='']=path.split('?');const params=new URLSearchParams(query);params.set('returnTo',safeReturnTo(returnTo));return `${pathname}?${params}`;
}
export function restoreListScroll():void{
  if(typeof window!=='undefined')requestAnimationFrame(()=>window.scrollTo(0,Number(window.history.state?.relayScrollY)||0));
}
let pendingMutations=0;
export function navigationPending():boolean{return pendingMutations>0;}
export function beginPendingNavigation():()=>void{pendingMutations++;let finished=false;return()=>{if(!finished){pendingMutations=Math.max(0,pendingMutations-1);finished=true;}};}
export function queryOffset(params:URLSearchParams):number{const value=Number(params.get('offset')??0);return Number.isSafeInteger(value)&&value>=0?Math.min(value,1000000):0;}
export function updateListQuery(path:string,params:URLSearchParams,patch:Record<string,string|number|null>):string{
  const next=new URLSearchParams(params);for(const [key,value]of Object.entries(patch)){if(value===null||value==='')next.delete(key);else next.set(key,String(value));}
  const query=next.toString();return path+(query?`?${query}`:'');
}

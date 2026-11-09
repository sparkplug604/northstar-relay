import {useCallback,useEffect,useRef,useState} from 'react';
import {relayRequest,type Session} from './api.js';
export interface Overview {counts:{open:number;awaitingOwner:number;overdue:number;ownedByMe:number;review:number;unverifiedContacts:number;missingFallback:number};asOf:string}
export function useOverview(session:Session) {
  const [data,setData]=useState<Overview|null>(null),[error,setError]=useState(false),[loading,setLoading]=useState(true);
  const request=useRef<AbortController|null>(null);
  const refresh=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);
    try {const value=await relayRequest<Overview>('/overview',{signal:controller.signal});if(!controller.signal.aborted){setData(value);setError(false);}}
    catch {if(!controller.signal.aborted)setError(true);}
    finally {if(!controller.signal.aborted)setLoading(false);}
  },[session.organization.id,session.user.id]);
  useEffect(()=>{setData(null);void refresh();const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},30000);return()=>{clearInterval(timer);request.current?.abort();};},[refresh]);
  return {data,error,loading,refresh};
}

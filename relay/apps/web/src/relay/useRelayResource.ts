import {useCallback,useEffect,useRef,useState} from 'react';
import {relayRequest} from './api.js';
function loadResource<T>(path:string,signal:AbortSignal){return relayRequest<T>(path,{signal});}
export function useRelayResource<T>(path:string,identity:string,load=loadResource<T>){
  const [data,setData]=useState<T|null>(null),[error,setError]=useState<unknown>(null),[loading,setLoading]=useState(true);
  const request=useRef<AbortController|null>(null);
  const refresh=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);
    try{const value=await load(path,controller.signal);if(!controller.signal.aborted){setData(value);setError(null);}}
    catch(failure){if(!controller.signal.aborted)setError(failure);}
    finally{if(!controller.signal.aborted)setLoading(false);}
  },[path,identity,load]);
  useEffect(()=>{setData(null);setError(null);void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},30000);const updated=()=>{if(/^\/(?:jobs|job-commitments)(?:[/?]|$)/.test(path))void refresh();};window.addEventListener('relay-job-updated',updated);return()=>{clearInterval(timer);window.removeEventListener('relay-job-updated',updated);request.current?.abort();};},[refresh]);
  return {data,error,loading,refresh};
}

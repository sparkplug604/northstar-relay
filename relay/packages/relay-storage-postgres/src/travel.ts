import type {JobSite,TravelEstimate} from '@northstar/relay-domain';

type Cached={expires:number;value:TravelEstimate};
const cache=new Map<string,Cached>();
let queue=Promise.resolve();
let lastRequest=0;

/** Configured by the operator. Public OSRM is enabled only by the isolated demo launcher. */
export function roadTravel(from:JobSite,to:JobSite):Promise<TravelEstimate>{
  const endpoint=process.env.RELAY_ROUTING_URL;
  const unknown=():TravelEstimate=>({minutes:null,source:'unknown',checkedAt:new Date().toISOString()});
  if(!endpoint)return Promise.resolve(unknown());
  const key=JSON.stringify([endpoint,from.longitude,from.latitude,to.longitude,to.latitude]);
  const saved=cache.get(key);
  if(saved&&saved.expires>Date.now())return Promise.resolve(saved.value);
  let result:TravelEstimate;
  const operation=queue.then(async()=>{
    const recent=cache.get(key);
    if(recent&&recent.expires>Date.now()){result=recent.value;return;}
    const delay=Math.max(0,1000-(Date.now()-lastRequest));
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    lastRequest=Date.now();
    try{
      const url=new URL(endpoint);
      if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw Error('Invalid routing endpoint');
      url.pathname=url.pathname.replace(/\/$/,'')+'/route/v1/driving/'+
        [from,to].map(point=>point.longitude+','+point.latitude).join(';');
      url.search='overview=false&steps=false';
      const response=await fetch(url,{signal:AbortSignal.timeout(4000)});
      if(!response.ok)throw Error('Routing unavailable');
      const body=await response.json() as {code?:string;routes?:{duration?:number}[];waypoints?:{distance?:number}[]};
      const duration=body.routes?.[0]?.duration;
      if(body.code!=='Ok'||typeof duration!=='number'||!Number.isFinite(duration)||duration<0||
        body.waypoints?.some(point=>typeof point.distance!=='number'||point.distance>1000))throw Error('No nearby drivable route');
      result={minutes:Math.ceil(duration/60),source:'OSRM',checkedAt:new Date().toISOString()};
    }catch{result=unknown();}
    if(cache.size>=256)cache.delete(cache.keys().next().value!);
    cache.set(key,{expires:Date.now()+(result.minutes===null?30000:900000),value:result});
  });
  queue=operation.catch(()=>{});
  return operation.then(()=>result);
}

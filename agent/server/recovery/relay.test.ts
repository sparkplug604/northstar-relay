import {beforeEach,afterEach,expect,it,vi} from 'vitest';
const runtime=globalThis as typeof globalThis&{__relaySyntheticAuthV1?:unknown};
beforeEach(()=>{delete runtime.__relaySyntheticAuthV1;vi.resetModules();vi.stubEnv('RELAY_DEMO_DISPATCHER_PASSWORD','test-only-placeholder');});
afterEach(()=>{delete runtime.__relaySyntheticAuthV1;vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('shares a single login across hot-reloaded native modules',async()=>{
 let logins=0;
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>{
  if(input.endsWith('/auth/login')){logins++;return new Response(JSON.stringify({csrfToken:'test-csrf'}),{headers:{'set-cookie':'test-session=placeholder; Path=/'}});}
  return new Response(JSON.stringify({ok:true}));
 }));
 const first=await import('./relay.js');await first.relay('/jobs');
 vi.resetModules();const reloaded=await import('./relay.js');
 await Promise.all([first.relay('/jobs'),reloaded.relay('/technicians')]);
 expect(logins).toBe(1);
});
it('does not hammer the login endpoint after a rate limit',async()=>{
 const fetcher=vi.fn(async()=>new Response('{}',{status:429}));vi.stubGlobal('fetch',fetcher);
 const {relay}=await import('./relay.js');
 await expect(relay('/jobs')).rejects.toThrow('rate-limited');
 await expect(relay('/jobs')).rejects.toThrow('rate-limited');
 expect(fetcher).toHaveBeenCalledTimes(1);
});

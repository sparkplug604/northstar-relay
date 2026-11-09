import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { buildRelayApp } from './relay/app.js';
import { createRelayStore } from '../../../packages/relay-storage-postgres/src/index.js';
import { RelayTwilioProvider, MAX_BACKUP_RETENTION_DAYS } from '../../../packages/relay-adapters/src/index.js';
import { registerRelayIntegrations, type RelayIntegrationOptions } from './relay-integrations.js';
import { registerRelayIntake } from './relay-intake.js';

function required(name:string):string {
  const value=process.env[name]?.trim();
  if(!value) throw new Error(`${name} is required`);
  return value;
}
const production=process.env.NODE_ENV==='production';
const mode=required('RELAY_PROVIDER_MODE');
if(!['live','simulated'].includes(mode)) throw new Error('RELAY_PROVIDER_MODE must be explicitly live or simulated');
if(production && mode!=='live') throw new Error('Production cannot simulate successful communication');
const publicOrigin=required('RELAY_PUBLIC_ORIGIN');
const localDevelopment=process.env.RELAY_LOCAL_DEVELOPMENT==='true';
const host=process.env.RELAY_HOST ?? '127.0.0.1';
if(localDevelopment && (production || !['127.0.0.1','localhost'].includes(new URL(publicOrigin).hostname) || host!=='127.0.0.1')) throw new Error('Development verification codes require a loopback-only development server');
const backupDays=Number(process.env.RELAY_BACKUP_RETENTION_DAYS ?? MAX_BACKUP_RETENTION_DAYS);
if(!Number.isInteger(backupDays)||backupDays<1||backupDays>30) throw new Error('Backup retention must be at most 30 days');
const store=createRelayStore(required('RELAY_DATABASE_URL'));
const twilioConfig=mode==='live'?{
  accountSid:required('TWILIO_ACCOUNT_SID'),authToken:required('TWILIO_AUTH_TOKEN'),fromNumber:required('TWILIO_FROM_NUMBER'),
  publicOrigin,allowedNumbers:required('TWILIO_ALLOWED_TO_NUMBERS').split(',').map(value=>value.trim()).filter(Boolean),
}:null;
const options:RelayIntegrationOptions={store,publicOrigin,authEncryptionKey:required('RELAY_AUTH_ENCRYPTION_KEY'),secureCookies:new URL(publicOrigin).protocol==='https:',localDevelopment,twilio:twilioConfig?new RelayTwilioProvider(twilioConfig):null,twilioConfig};
const app=await buildRelayApp({...options,setupToken:process.env.RELAY_SETUP_TOKEN,production,providerMode:mode,logger:false});
await app.register(formbody);
await registerRelayIntegrations(app,options);
await registerRelayIntake(app,options);
app.addHook('onSend',async(_request,reply,payload)=>{
  reply.header('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  return payload;
});
const webRoot=resolve(process.cwd(),'dist-web');
if(existsSync(webRoot)) {
  await app.register(fastifyStatic,{root:webRoot,index:false});
  app.get('/',async(_request,reply)=>reply.redirect('/relay'));
  app.get('/relay',async(_request,reply)=>reply.sendFile('index.html'));
  app.get('/relay/*',async(_request,reply)=>reply.sendFile('index.html'));
}
let closing=false;
async function close(){if(closing)return;closing=true;await app.close();await store.close();}
process.once('SIGINT',()=>void close()); process.once('SIGTERM',()=>void close());
await app.listen({host,port:Number(process.env.RELAY_PORT??3001)});
process.stdout.write(`Relay web server ready at ${publicOrigin}/relay (${mode}). Start the separate Relay worker to process deadlines.\n`);

import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

const sites={
  'REQUEST-201':['Kitsilano',49.267,-123.166,45],
  'SCHEDULE-202':['Coal Harbour',49.290,-123.130,60],
  'SERVICE-203':['Mount Pleasant',49.262,-123.101,75],
  'DELAY-204':['Hastings-Sunrise',49.281,-123.046,90],
  'REVIEW-205':['Fairview',49.263,-123.125,45],
  'FOLLOWUP-206':['Kitsilano',49.266,-123.164,30],
  'INBOX-JOB-208':['Commercial Drive',49.269,-123.070,75],
  'PLAN-301':['West End',49.285,-123.135,60],
  'PLAN-302':['Grandview-Woodland',49.276,-123.068,90],
  'PLAN-303':['Riley Park',49.246,-123.101,45],
  'PLAN-304':['Kerrisdale',49.234,-123.154,60],
};

export async function seedPlanning({pool,origin,password,hashPassword}){
  if(origin!=='http://127.0.0.1:3004')throw Error('Expected isolated Relay planning demo');
  const {DateTime}=createRequire(join(process.cwd(),'package.json'))('luxon');
  const {rows:[scope]}=await pool.query(`SELECT m.tenant_id,m.branch_id FROM relay.memberships m
    JOIN relay.people p ON p.id=m.person_id JOIN relay.organizations o ON o.id=m.tenant_id
    WHERE p.email='dispatch@relay-demo.invalid' AND o.name='Relay Jobs · Synthetic Demo'`);
  if(!scope)throw Error('Synthetic dispatch tenant is missing');
  const {tenant_id:tenant,branch_id:branch}=scope;
  const {rows:[riley]}=await pool.query(`SELECT p.id FROM relay.people p JOIN relay.memberships m ON m.person_id=p.id
    WHERE m.tenant_id=$1 AND p.email='tech@relay-demo.invalid'`,[tenant]);
  if(!riley)throw Error('Synthetic Riley fixture is missing');
  const samId='relay-planning-sam';
  const caseyId='relay-planning-casey';
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`INSERT INTO relay.people(id,email,display_name,password_hash)
      VALUES($1,'sam-planning@relay-demo.invalid','Sam Technician',$2) ON CONFLICT(id) DO NOTHING`,[samId,await hashPassword(password)]);
    await client.query(`INSERT INTO relay.memberships(tenant_id,person_id,branch_id,role)
      VALUES($1,$2,$3,'on_call_responder') ON CONFLICT DO NOTHING`,[tenant,samId,branch]);
    await client.query(`INSERT INTO relay.people(id,email,display_name,password_hash)
      VALUES($1,'casey-planning@relay-demo.invalid','Casey Technician',$2) ON CONFLICT(id) DO NOTHING`,[caseyId,await hashPassword(password)]);
    await client.query(`INSERT INTO relay.memberships(tenant_id,person_id,branch_id,role)
      VALUES($1,$2,$3,'on_call_responder') ON CONFLICT DO NOTHING`,[tenant,caseyId,branch]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}

  const auth=await fetch(origin+'/api/relay/v1/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'dispatch@relay-demo.invalid',password})});
  if(!auth.ok)throw Error('Planning fixture sign-in failed: '+auth.status);
  const {csrfToken}=await auth.json();
  const headers={origin,cookie:auth.headers.get('set-cookie').split(';')[0],'x-csrf-token':csrfToken,'content-type':'application/json'};
  async function post(path,body){
    const result=await fetch(origin+'/api/relay/v1'+path,{method:'POST',headers:{...headers,'idempotency-key':randomUUID()},body:JSON.stringify(body)});
    if(!result.ok)throw Error('Planning fixture '+path+' failed: '+await result.text());
    return result.json();
  }
  const {dispatchZone}=await import(join(process.cwd(),'dist/packages/relay-storage-postgres/src/timezone.js'));
  const now=DateTime.now().setZone(dispatchZone('America/Vancouver'));
  const nextHour=now.plus({hours:1}).startOf('hour');
  const tomorrow=now.plus({days:1}).set({hour:10,minute:0,second:0,millisecond:0});
  const monday=now.startOf('week').plus({weeks:1}).set({hour:9});
  const visits=[
    ['PLAN-301','West End Bakery — Oven thermostat check','Check the oven thermostat and confirm it holds the set temperature.',riley.id,nextHour],
    ['PLAN-302','Grandview Deli — Ice maker repair','Find and repair the leak beneath the ice maker.',samId,nextHour.plus({minutes:30})],
    ['PLAN-303','Riley Park Café — Dishwasher service','Clear the drain and run a wash cycle to check for backups.',samId,tomorrow],
    ['PLAN-304','Kerrisdale Grocer — Display cooler service','Inspect the display cooler door seal and replace it if it is damaged.',riley.id,monday],
  ];
  const workingHours=[1,2,3,4,5].map(weekday=>({weekday,start:'08:00',end:'18:00'}));
  const base={label:'Demo service depot · Mount Pleasant',latitude:49.263,longitude:-123.115};
  const technicians=(await (await fetch(origin+'/api/relay/v1/technicians',{headers})).json()).items;
  for(const [personId,skills,timeOff] of [
    [riley.id,['refrigeration','electrical'],[{start:monday.startOf('day').set({hour:8}).toISO(),end:monday.startOf('day').set({hour:12}).toISO()}]],
    [samId,['plumbing','commercial kitchen'],[]],
    [caseyId,['refrigeration','electrical'],[]],
  ]){
    const person=technicians.find(person=>person.personId===personId);
    if(person?.version===0)await post('/technicians/'+personId+'/planning',{expectedVersion:0,profile:{timezone:'America/Vancouver',skills,workingHours,timeOff,base}});
  }
  for(const [externalId,customerReference,description,assigneeId,scheduledAt] of visits){
    const {rows:[existing]}=await pool.query(`SELECT snapshot FROM relay.jobs WHERE tenant_id=$1 AND snapshot->>'externalId'=$2`,[tenant,externalId]);
    let job=existing?.snapshot;
    if(!job)({job}=await post('/jobs',{externalId,customerReference,description,branchId:branch,priority:'normal'}));
    if(job.status==='requested'){
      if(!job.assigneeId)({job}=await post('/jobs/'+job.id+'/actions',{action:'assign',expectedVersion:job.version,assigneeId}));
      await post('/jobs/'+job.id+'/actions',{action:'schedule',expectedVersion:job.version,scheduledAt:scheduledAt.toISO(),note:'Scheduled synthetic demo visit'});
    }
  }
  const jobSkills={'REQUEST-201':['electrical'],'SCHEDULE-202':['refrigeration'],'SERVICE-203':['commercial kitchen'],
    'DELAY-204':['refrigeration'],'REVIEW-205':['refrigeration'],'FOLLOWUP-206':['electrical'],'INBOX-JOB-208':['refrigeration'],
    'PLAN-301':['electrical'],'PLAN-302':['plumbing'],'PLAN-303':['plumbing'],'PLAN-304':['refrigeration']};
  for(const [reference,skills] of Object.entries(jobSkills)){
    await pool.query(`UPDATE relay.jobs SET snapshot=snapshot || $1::jsonb
      WHERE tenant_id=$2 AND snapshot->>'externalId'=$3 AND NOT (snapshot ? 'requiredSkills')`,
      [JSON.stringify({requiredSkills:skills}),tenant,reference]);
  }
  const clientDue=monday.startOf('day').set({hour:17});
  for(const reference of Object.keys(sites)){
    const completeBy=(reference==='INBOX-JOB-208'||reference==='PLAN-304'?clientDue:now.plus({days:7}).set({hour:17,minute:0,second:0,millisecond:0})).toISO();
    await pool.query(`UPDATE relay.jobs SET snapshot=snapshot || $1::jsonb
      WHERE tenant_id=$2 AND snapshot->>'externalId'=$3 AND NOT (snapshot ? 'serviceWindow')`,
      [JSON.stringify({serviceWindow:{earliestStart:now.toISO(),completeBy},
        ...(reference==='INBOX-JOB-208'?{priority:'high'}:{})}),tenant,reference]);
  }
  for(const [reference,[label,latitude,longitude,estimatedMinutes]] of Object.entries(sites)){
    await pool.query(`UPDATE relay.jobs SET snapshot=snapshot || $1::jsonb
      WHERE tenant_id=$2 AND snapshot->>'externalId'=$3 AND NOT (snapshot ? 'site')`,
      [JSON.stringify({site:{label,latitude,longitude},estimatedMinutes}),tenant,reference]);
  }
}

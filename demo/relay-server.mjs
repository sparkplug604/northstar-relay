import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRelayApp } from '../relay/dist/apps/api/src/relay/app.js';
import { registerRelayIntegrations } from '../relay/dist/apps/api/src/relay-integrations.js';
import { registerRelayIntake } from '../relay/dist/apps/api/src/relay-intake.js';
import { bootstrapRelay, hashPassword } from '../relay/dist/apps/api/src/relay/auth.js';
import { migrateRelay, RelayPostgresStore } from '../relay/dist/packages/relay-storage-postgres/src/index.js';
import { dispatcherEmail, postgresPort, relayOrigin, relayRoot, runtime } from './constants.mjs';
import { seedScenario } from './seed-scenario.mjs';

const require = createRequire(join(relayRoot, 'package.json'));
const { Pool } = require('pg');
const database = new URL(process.env.RELAY_DEMO_DATABASE_URL);
const dbName = database.pathname.slice(1);
if (database.hostname !== '127.0.0.1' || Number(database.port) !== postgresPort ||
    !/^relay_demo_[a-f0-9]{12}$/.test(dbName)) {
  throw new Error('Expected a generated loopback demo database.');
}
const isNew = process.env.RELAY_DEMO_CREATE === 'true';
const password = process.env.RELAY_DEMO_DISPATCHER_PASSWORD;
const authEncryptionKey = process.env.RELAY_DEMO_AUTH_KEY;
if (!password || !authEncryptionKey) throw new Error('Start the demo through ./demo.sh.');

if (isNew) {
  const adminUrl = new URL('/postgres', database);
  const admin = new Pool({ connectionString: adminUrl.toString() });
  try {
    // Without a manifest, only this checkout's partially seeded database can exist.
    await admin.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)');
    await admin.query('CREATE DATABASE "' + dbName + '"');
  } finally {
    await admin.end();
  }
}

const pool = new Pool({ connectionString: database.toString() });
const store = new RelayPostgresStore(pool);
let app;
try {
  await migrateRelay(pool);
  let fixture;
  let responderId;
  if (isNew) {
    fixture = await bootstrapRelay(store, {
      organizationName: 'Relay Jobs · Synthetic Demo', branchName: 'Vancouver', timezone: 'America/Vancouver',
      displayName: 'Drew Dispatcher', email: dispatcherEmail, password,
    });
    await pool.query("UPDATE relay.memberships SET role='branch_dispatcher' WHERE tenant_id=$1", [fixture.tenantId]);
    const passwordHash = await hashPassword(password);
    responderId = 'responder-' + randomBytes(6).toString('hex');
    const adminId = 'admin-' + randomBytes(6).toString('hex');
    const people = [
      [responderId, 'tech@relay-demo.invalid', 'Riley Technician', 'on_call_responder'],
      [adminId, 'admin@relay-demo.invalid', 'Avery Admin', 'organization_admin'],
    ];
    for (const [id, email, name, role] of people) {
      await pool.query('INSERT INTO relay.people(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)',
        [id, email, name, passwordHash]);
      await pool.query('INSERT INTO relay.memberships(tenant_id,person_id,branch_id,role) VALUES($1,$2,$3,$4)',
        [fixture.tenantId, id, fixture.branchId, role]);
    }
    await pool.query("INSERT INTO relay.contacts(tenant_id,person_id,phone,phone_verified_at) VALUES($1,$2,'+16045550100',clock_timestamp())",
      [fixture.tenantId, responderId]);
    await pool.query('INSERT INTO relay.contacts(tenant_id,person_id) VALUES($1,$2)', [fixture.tenantId, adminId]);
    await pool.query('UPDATE relay.settings SET recipient_ids=$3 WHERE tenant_id=$1 AND branch_id=$2',
      [fixture.tenantId, fixture.branchId, JSON.stringify([responderId])]);
  }

  const options = {
    store, publicOrigin: relayOrigin, secureCookies: false, authEncryptionKey,
    localDevelopment: true, twilio: null, twilioConfig: null,
  };
  app = await buildRelayApp({ ...options, setupToken: undefined, providerMode: 'simulated' });
  await app.register(require('@fastify/formbody'));
  await registerRelayIntegrations(app, options);
  await registerRelayIntake(app, options);
  await app.register(require('@fastify/static'), { root: join(relayRoot, 'dist-web'), index: false });
  app.get('/', (_request, reply) => reply.redirect('/relay'));
  app.get('/relay', (_request, reply) => reply.sendFile('index.html'));
  app.get('/relay/*', (_request, reply) => reply.sendFile('index.html'));
  await app.listen({ host: '127.0.0.1', port: Number(new URL(relayOrigin).port) });

  if (fixture) {
    const scenario = await seedScenario({ pool, branchId: fixture.branchId, responderId, password, hashPassword });
    const manifest = join(runtime, 'manifest.json');
    await writeFile(manifest + '.next', JSON.stringify({ databaseName: dbName, ...scenario }, null, 2) + '\n', { mode: 0o600 });
    await rename(manifest + '.next', manifest);
  }
  console.log('Synthetic Relay ready: ' + relayOrigin + '/relay');
} catch (error) {
  await app?.close();
  await store.close();
  throw error;
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    await app.close();
    await store.close();
  });
}

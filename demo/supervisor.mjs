import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { agentRoot, dispatcherEmail, nativeOrigin, ollamaOrigin, postgresPort, relayOrigin, relayRoot, root, runtime } from './constants.mjs';
import { prepareNative, warmModel } from './native.mjs';

const exec = promisify(execFile);
const require = createRequire(join(relayRoot, 'package.json'));
const self = fileURLToPath(import.meta.url);
const logs = join(runtime, 'logs');
const configFile = join(runtime, 'private.json');
const manifestFile = join(runtime, 'manifest.json');
const stateFile = join(runtime, 'state.json');
const exists = path => access(path).then(() => true, () => false);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function safeEnv() {
  const keys = ['HOME', 'PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'RELAY_ROUTING_URL'];
  return Object.fromEntries(keys.filter(key => process.env[key]).map(key => [key, process.env[key]]));
}

async function saveState(value) {
  await writeFile(stateFile + '.next', JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(stateFile + '.next', stateFile);
}

async function config(create = false) {
  if (create) {
    await mkdir(logs, { recursive: true, mode: 0o700 });
    const data = {
      owner: resolve(root), databaseName: 'relay_demo_' + randomBytes(6).toString('hex'),
      dbPassword: randomBytes(24).toString('hex'), dispatcherPassword: randomBytes(16).toString('base64url'),
      authKey: randomBytes(32).toString('base64'), nativeKey: randomBytes(32).toString('base64'),
    };
    try {
      await writeFile(configFile, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const data = await readJson(configFile);
  if (data.owner !== resolve(root) || !/^relay_demo_[a-f0-9]{12}$/.test(data.databaseName)) {
    throw new Error('This demo data belongs to another checkout.');
  }
  return data;
}

async function manager() {
  const state = await readJson(stateFile).catch(() => null);
  if (!state?.pid || !alive(state.pid)) return null;
  const { stdout } = await exec('ps', ['-p', String(state.pid), '-o', 'command=']).catch(() => ({ stdout: '' }));
  return stdout.includes(self + ' serve') ? state : null;
}

async function http(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(4000) })).ok; } catch { return false; }
}

async function waitFor(label, ready, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await ready()) return;
    await sleep(300);
  }
  throw new Error(label + ' did not become ready. See runtime/logs/.');
}

async function start() {
  for (const path of [join(relayRoot, 'dist-web/index.html'), join(agentRoot, 'node_modules/vite/bin/vite.js')]) {
    if (!(await exists(path))) throw new Error('Run ./demo.sh install first.');
  }
  await config(true);
  const current = await manager();
  if (current?.phase !== 'ready') {
    const log = await open(join(logs, 'supervisor.log'), 'a', 0o600);
    const child = current ?? spawn(process.execPath, [self, 'serve'], {
      cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], env: safeEnv(),
    });
    if (!current) child.unref();
    await log.close();
    await waitFor('Demo startup', async () => {
      const state = await readJson(stateFile).catch(() => null);
      if (state?.pid !== child.pid) return false;
      if (state.phase === 'failed') throw new Error(state.error);
      return state.phase === 'ready' && alive(state.pid);
    }, 180_000);
  }
  const manifest = await readJson(manifestFile);
  console.log('Relay: ' + relayOrigin + '/relay');
  console.log('Parkside Foods: ' + manifest.parksideUrl);
  console.log('Harbour Market: ' + manifest.harbourUrl);
  console.log('Parkside target date: ' + manifest.targetDate + ' by 6 p.m. Vancouver time');
  console.log('Use ./demo.sh credentials for the local synthetic login.');
}

async function stop() {
  const state = await manager();
  if (state) {
    process.kill(state.pid, 'SIGTERM');
    await waitFor('Demo shutdown', async () => !(await manager()), 30_000);
  }
  console.log('Demo stopped. Local data is saved in runtime/ and agent/data/.');
}

async function serve() {
  const data = await config();
  const children = [];
  let database;
  let stopping = false;
  const finish = async error => {
    if (stopping) return;
    stopping = true;
    for (const child of [...children].reverse()) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
    await Promise.all(children.map(async child => {
      for (let attempt = 0; attempt < 50 && alive(child.pid); attempt++) await sleep(100);
      if (alive(child.pid)) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }));
    const postgres = database?.process;
    if (postgres?.exitCode === null && postgres.signalCode === null) {
      await database.stop().catch(() => {});
    }
    const message = error && [data.dbPassword, data.dispatcherPassword, data.authKey, data.nativeKey]
      .reduce((safe, secret) => safe.replaceAll(secret, '<redacted>'), String(error.message ?? error));
    await saveState({ pid: error ? process.pid : null, phase: error ? 'failed' : 'stopped', ...(message ? { error: message } : {}) });
    if (message) console.error(message);
    process.exit(error ? 1 : 0);
  };
  const child = async (name, command, args, cwd, env = {}) => {
    const log = await open(join(logs, name + '.log'), 'a', 0o600);
    const service = spawn(command, args, {
      cwd, detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...safeEnv(), ...env },
    });
    children.push(service);
    service.once('error', error => void finish(new Error(name + ': ' + error.message)));
    service.once('exit', code => {
      if (!stopping) void finish(new Error(name + ' exited (' + code + '). See runtime/logs/' + name + '.log.'));
    });
    await log.close();
  };

  await saveState({ pid: process.pid, phase: 'starting' });
  try {
    if (await http(relayOrigin + '/relay') || await http(nativeOrigin + '/')) {
      throw new Error('A service already uses Relay port 3004 or Agent-Native port 3005.');
    }
    const postgresPackage = require.resolve('embedded-postgres');
    const EmbeddedPostgres = (await import(postgresPackage)).default;
    // The demo owns service shutdown order, including when PostgreSQL startup fails.
    const postgresExitHooks = createRequire(postgresPackage)('async-exit-hook');
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      postgresExitHooks.unhookEvent(signal);
      process.once(signal, () => void finish());
    }
    const cluster = join(runtime, 'postgres');
    database = new EmbeddedPostgres({
      databaseDir: cluster, user: 'relay_test', password: data.dbPassword, port: postgresPort,
      persistent: true, authMethod: 'scram-sha-256', createPostgresUser: false,
      postgresFlags: ['-h', '127.0.0.1', '-k', ''], onLog: () => {}, onError: () => {},
    });
    if (!(await exists(join(cluster, 'PG_VERSION')))) await database.initialise();
    await database.start();
    database.process.once('exit', () => {
      if (!stopping) void finish(new Error('The demo PostgreSQL process exited.'));
    });
    const dispatcherEnv = { RELAY_DEMO_DISPATCHER_PASSWORD: data.dispatcherPassword };
    const reuse = await exists(manifestFile);
    if (reuse && (await readJson(manifestFile)).databaseName !== data.databaseName) {
      throw new Error('Manifest does not match the demo database.');
    }
    await child('relay', process.execPath, [join(root, 'demo/relay-server.mjs')], relayRoot, {
      ...dispatcherEnv, RELAY_ROUTING_URL: process.env.RELAY_ROUTING_URL ?? 'https://router.project-osrm.org',
      RELAY_DEMO_AUTH_KEY: data.authKey, RELAY_DEMO_CREATE: String(!reuse),
      RELAY_DEMO_DATABASE_URL: 'postgresql://relay_test:' + data.dbPassword + '@127.0.0.1:' + postgresPort + '/' + data.databaseName,
    });
    await waitFor('Relay seed', async () => await exists(manifestFile) && await http(relayOrigin + '/relay'));
    if (!(await http(ollamaOrigin + '/api/tags'))) {
      await child('qwen', 'ollama', ['serve'], root, {
        OLLAMA_HOST: new URL(ollamaOrigin).host, OLLAMA_CONTEXT_LENGTH: '8192',
        OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0',
        OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1',
      });
    }
    await waitFor('Ollama', () => http(ollamaOrigin + '/api/tags'));
    await warmModel();
    await child('agent', process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '3005', '--strictPort'], agentRoot, {
      OLLAMA_BASE_URL: ollamaOrigin,
      WORKSPACE_SECRETS_ENCRYPTION_KEY: data.nativeKey, AGENT_NATIVE_TELEMETRY_DISABLED: '1',
    });
    await waitFor('Agent-Native', () => http(nativeOrigin + '/'));
    await prepareNative((await readJson(manifestFile)).parksideId, data.dispatcherPassword);
    await saveState({ pid: process.pid, phase: 'ready' });
    setInterval(() => {}, 30_000);
  } catch (error) {
    await finish(error);
  }
}

try {
  switch (process.argv[2]) {
    case 'start': await start(); break;
    case 'serve': await serve(); break;
    case 'stop': await stop(); break;
    case 'status': console.log((await manager())?.phase ?? 'stopped'); break;
    case 'credentials': console.log(dispatcherEmail + '\n' + (await config()).dispatcherPassword); break;
    default: throw new Error('Use ./demo.sh install | start | status | stop | credentials.');
  }
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Start the demo to generate its local data.' : error.message);
  process.exitCode = 1;
}

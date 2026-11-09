import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentRoot, relayOrigin, relayRoot, root, runtime } from './constants.mjs';

const installState = join(runtime, 'install.json');
const paths = [
  join(relayRoot, 'dist-web/index.html'),
  join(relayRoot, 'dist/apps/api/src/relay/app.js'),
  join(agentRoot, 'node_modules/vite/bin/vite.js'),
];

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(command + ' exited with ' + (signal ?? code) + '.'));
    });
  });
}

async function fingerprint() {
  const files = [
    join(relayRoot, 'package-lock.json'), join(relayRoot, 'package.json'),
    join(agentRoot, 'pnpm-lock.yaml'), join(agentRoot, 'package.json'),
    join(agentRoot, 'pnpm-workspace.yaml'),
  ];
  const hash = createHash('sha256').update([process.version, process.platform, process.arch].join(':'));
  for (const file of files) hash.update(await readFile(file));
  return hash.digest('hex');
}

async function alreadyInstalled(version) {
  try {
    await Promise.all(paths.map(path => access(path)));
    return JSON.parse(await readFile(installState, 'utf8')).version === version;
  } catch { return false; }
}

async function install(version) {
  const { packageManager } = JSON.parse(await readFile(join(agentRoot, 'package.json'), 'utf8'));
  console.log('Installing Relay dependencies and building the web app…');
  await run('npm', ['ci', '--no-audit', '--no-fund'], relayRoot);
  await run('npm', ['run', 'build:all'], relayRoot);
  console.log('Installing the locked Ask Relay dependencies…');
  await run('npm', ['exec', '--yes', '--package=' + packageManager, '--', 'pnpm', 'install', '--frozen-lockfile'], agentRoot);
  await Promise.all(paths.map(path => access(path)));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await writeFile(installState, JSON.stringify({ version }) + '\n', { mode: 0o600 });
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 22)) {
    throw new Error('Install Node.js 24 LTS, or Node.js 22.22 or newer.');
  }
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error('On Windows, run the Linux launcher inside Ubuntu on WSL2. See docs/getting-started.md.');
  }
  if (process.getuid?.() === 0) throw new Error('Run Northstar Relay from a regular user account.');
  const launch = process.argv[2] === 'launch';
  if (launch) {
    try { await run('ollama', ['--version']); }
    catch { throw new Error('Install Ollama and make its CLI available in your terminal. See docs/getting-started.md.'); }
  }
  const version = await fingerprint();
  if (!launch || !(await alreadyInstalled(version))) await install(version);
  if (launch) {
    await run(process.execPath, ['demo/supervisor.mjs', 'start']);
    if (process.platform === 'darwin' && !process.argv.includes('--no-browser')) {
      await run('open', [relayOrigin + '/relay/sign-in']).catch(() => {
        console.log('Open ' + relayOrigin + '/relay/sign-in in your browser.');
      });
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

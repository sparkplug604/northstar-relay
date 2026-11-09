import { bootstrapRelay } from '../apps/api/src/relay/auth.js';
import { createRelayStore } from '../packages/relay-storage-postgres/src/index.js';

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
const store = createRelayStore(required('RELAY_DATABASE_URL'));
try {
  const password = required('RELAY_BOOTSTRAP_PASSWORD');
  if (password.length < 12) throw new Error('Bootstrap password must contain at least 12 characters');
  const timezone = process.env.RELAY_BOOTSTRAP_TIMEZONE ?? 'America/Vancouver';
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  await bootstrapRelay(store, {
    organizationName: required('RELAY_BOOTSTRAP_ORGANIZATION'), branchName: required('RELAY_BOOTSTRAP_BRANCH'), timezone,
    displayName: required('RELAY_BOOTSTRAP_NAME'), email: required('RELAY_BOOTSTRAP_EMAIL'), password,
  });
  process.stdout.write('Initial organization created. Sign in to enroll administrator MFA.\n');
} finally { await store.close(); }

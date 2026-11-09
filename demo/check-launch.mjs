import assert from 'node:assert/strict';
import { dispatcherEmail, relayOrigin } from './constants.mjs';

const api = relayOrigin + '/api/relay/v1';
const signIn = origin => fetch(api + '/auth/demo', {
  method: 'POST',
  headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json' },
  body: '{}',
  signal: AbortSignal.timeout(15_000),
});

assert.equal((await fetch(relayOrigin + '/relay/sign-in')).status, 200);
for (const origin of [undefined, 'https://example.invalid']) {
  assert.equal((await signIn(origin)).status, 403, 'Reject demo sign-in from other origins');
}
const login = await signIn(relayOrigin);
assert.equal(login.status, 200, 'Synthetic sign-in is available on the local origin');
const account = await login.json();
assert.equal(account.mfaRequired, false);
assert.equal(Object.hasOwn(account, 'password'), false);
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie, 'Synthetic sign-in returns a Relay session cookie');

const read = async path => {
  const response = await fetch(api + path, { headers: { cookie }, signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, path);
  return response.json();
};
const { user, providerMode } = await read('/session');
assert.equal(user.displayName, 'Drew Dispatcher');
assert.equal(user.email, dispatcherEmail);
assert.equal(providerMode, 'simulated');
for (const [reference, client] of [['INBOX-JOB-208', 'Parkside Foods'], ['SCHEDULE-202', 'Harbour Market']]) {
  const { items } = await read('/jobs?search=' + reference);
  assert.ok(items.some(job => job.customerReference.startsWith(client)), 'Seeded job for ' + client);
}
console.log('Ready: synthetic sign-in, cross-origin rejection, Parkside Foods and Harbour Market.');

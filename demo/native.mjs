import { engine, model, nativeOrigin, ollamaOrigin } from './constants.mjs';

export async function prepareNative(parksideId, dispatcherPassword) {
  const api = nativeOrigin + '/_agent-native';
  const headers = { origin: nativeOrigin, 'content-type': 'application/json' };
  const auth = await fetch(api + '/auth/local-dev', {
    method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(30_000),
  });
  if (!auth.ok) throw new Error('Agent-Native local sign-in failed (' + auth.status + ').');
  headers.cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const vault = await fetch(api + '/secrets/adhoc', {
    method: 'POST', headers, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      name: 'RELAY_SYNTHETIC_DISPATCHER', value: dispatcherPassword,
      scope: 'workspace', description: 'Generated local Relay demo dispatcher',
    }),
  });
  if (!vault.ok) throw new Error('Local dispatcher vault setup failed (' + vault.status + ').');
  const defaults = api + '/agent-model-defaults?appId=board';
  let response = await fetch(defaults, { headers });
  let selected = await response.json();
  if (selected.engine !== engine || selected.model !== model) {
    const provider = await fetch(api + '/agent-engine/api-key', {
      method: 'POST', headers, body: JSON.stringify({ provider: 'ollama', baseUrl: ollamaOrigin, scope: 'org' }),
    });
    if (!provider.ok) throw new Error('Local Ollama configuration failed (' + provider.status + ').');
    response = await fetch(defaults, {
      method: 'PUT', headers, body: JSON.stringify({ engine, model }),
    });
    if (!response.ok) throw new Error('Qwen model selection failed (' + response.status + ').');
    selected = await response.json();
    if (selected.engine !== engine || selected.model !== model) {
      throw new Error('Agent-Native did not select ' + model + '.');
    }
  }
  const bridge = await fetch(api + '/actions/read-relay-records?resource=jobs&search=INBOX-JOB-208', {
    headers, signal: AbortSignal.timeout(30_000),
  });
  if (!bridge.ok || !(await bridge.json()).data?.items?.some(job => job.id === parksideId)) {
    throw new Error('Ask Relay cannot read the synthetic Parkside job.');
  }
}

export async function warmModel() {
  const tags = await (await fetch(ollamaOrigin + '/api/tags')).json();
  if (!tags.models.some(item => item.name === model)) {
    throw new Error('Missing ' + model + '. Follow the model setup in README.md.');
  }
  const warm = await fetch(ollamaOrigin + '/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: '30m' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!warm.ok) throw new Error('Ollama could not load ' + model + '.');
  await warm.json();
}

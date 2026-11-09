import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dispatcherEmail, relayOrigin, relayRoot } from './constants.mjs';
import { seedPlanning } from './seed-planning.mjs';
import { seedRelayUxExamples } from '../relay/scripts/relay-ux-demo-seed.mjs';
import { dispatchZone } from '../relay/dist/packages/relay-storage-postgres/src/timezone.js';

const { DateTime } = createRequire(relayRoot + 'package.json')('luxon');
const branchZone = dispatchZone('America/Vancouver');

function nextWorkday(date) {
  let day = date.plus({ days: 1 }).startOf('day');
  while (day.weekday > 5) day = day.plus({ days: 1 });
  return day;
}

export async function seedScenario({ pool, branchId, responderId, password, hashPassword }) {
  const base = relayOrigin + '/api/relay/v1';
  const auth = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { origin: relayOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: dispatcherEmail, password }),
  });
  if (!auth.ok) throw new Error('Synthetic dispatcher sign-in failed.');
  const { csrfToken } = await auth.json();
  const headers = {
    origin: relayOrigin, cookie: auth.headers.get('set-cookie').split(';')[0],
    'content-type': 'application/json', 'x-csrf-token': csrfToken,
  };
  const request = {
    async post(url, { headers: requestHeaders, data }) {
      const response = await fetch(url, { method: 'POST', headers: requestHeaders, body: JSON.stringify(data) });
      return { ok: () => response.ok, json: () => response.json(), text: () => response.clone().text() };
    },
  };
  const seed = await seedRelayUxExamples({ origin: relayOrigin, branchId, responderId, request, headers });
  const future = minutes => new Date(Date.now() + minutes * 60_000).toISOString();
  const change = async (detail, action, data) => {
    const response = await request.post(base + '/jobs/' + detail.job.id + '/actions', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { action, expectedVersion: detail.job.version, ...data },
    });
    if (!response.ok()) throw new Error('Seed action ' + action + ' failed: ' + await response.text());
    return response.json();
  };
  const cedar = await change(seed.requested, 'assign', { assigneeId: responderId });
  await change(cedar, 'schedule', { scheduledAt: future(100), note: 'Synthetic second visit for recovery' });
  await change(seed.blocked, 'add_milestone', {
    title: 'Call customer with repair ETA', ownerId: responderId, dueAt: future(130),
  });
  await seedPlanning({ pool, origin: relayOrigin, password, hashPassword });

  const readJob = async reference => {
    const response = await fetch(base + '/jobs?search=' + reference, { headers });
    if (!response.ok) throw new Error('Cannot read seeded job ' + reference);
    const { items } = await response.json();
    const job = items.find(item => item.externalId === reference);
    if (!job) throw new Error('Missing seeded job ' + reference);
    const detail = await fetch(base + '/jobs/' + job.id, { headers });
    if (!detail.ok) throw new Error('Cannot read seeded job details for ' + reference);
    return detail.json();
  };

  const baselineDay = nextWorkday(DateTime.now().setZone(branchZone));
  const targetDay = nextWorkday(baselineDay);
  const initialDeadline = baselineDay.set({ hour: 18 }).toUTC().toISO();
  const targetDeadline = targetDay.set({ hour: 18 }).toUTC().toISO();
  const initialVisit = baselineDay.set({ hour: 9, minute: 30 }).toUTC().toISO();
  const harbourVisit = targetDay.set({ hour: 11 }).toUTC().toISO();

  let parkside = await readJob('INBOX-JOB-208');
  parkside = await change(parkside, 'dispatch_details', {
    priority: 'high',
    serviceWindow: { earliestStart: parkside.job.serviceWindow?.earliestStart ?? null, completeBy: initialDeadline },
    site: parkside.job.site, estimatedMinutes: 75, requiredSkills: ['refrigeration'],
  });
  parkside = await change(parkside, 'assign', { assigneeId: 'relay-planning-casey', checkAvailability: false });
  parkside = await change(parkside, 'schedule', {
    scheduledAt: initialVisit, note: 'Synthetic Parkside rehearsal starting visit',
  });

  let harbour = await readJob('SCHEDULE-202');
  harbour = await change(harbour, 'assign', { assigneeId: 'relay-planning-casey', checkAvailability: false });
  harbour = await change(harbour, 'schedule', {
    scheduledAt: harbourVisit, note: 'Synthetic Harbour Market rehearsal starting visit',
  });

  return {
    parksideId: parkside.job.id, parksideUrl: relayOrigin + '/relay/jobs/' + parkside.job.id,
    harbourId: harbour.job.id, harbourUrl: relayOrigin + '/relay/jobs/' + harbour.job.id,
    initialVersion: parkside.job.version, initialDeadline, initialVisit,
    targetDate: targetDay.toISODate(), targetDeadline, harbourVisit,
  };
}

// Browser rehearsal against this checkout's synthetic records. It saves both demo workflows.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { dispatcherEmail, engine, model, nativeOrigin, relayOrigin, relayRoot, runtime } from './constants.mjs';
import { dispatchZone } from '../relay/dist/packages/relay-storage-postgres/src/timezone.js';

const require = createRequire(join(relayRoot, 'package.json'));
const { chromium, expect } = require('@playwright/test');
const { DateTime } = require('luxon');
const [manifest, config] = await Promise.all(['manifest.json', 'private.json'].map(async file =>
  JSON.parse(await readFile(join(runtime, file), 'utf8'))));
const zone = dispatchZone('America/Vancouver');
const local = value => DateTime.fromISO(value).setZone(zone);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Vancouver' });
  const relayApi = relayOrigin + '/api/relay/v1';
  const nativeApi = nativeOrigin + '/_agent-native';
  const read = async url => {
    const response = await page.request.get(url, { timeout: 10_000 });
    if (!response.ok()) throw new Error('Rehearsal read failed (HTTP ' + response.status() + ').');
    return response.json();
  };
  const job = id => read(relayApi + '/jobs/' + id);
  const signIn = async () => {
    await page.goto(relayOrigin + '/relay/sign-in');
    await page.locator('[name=email]').fill(dispatcherEmail);
    await page.locator('[name=password]').fill(config.dispatcherPassword);
    await Promise.all([
      page.waitForURL(/\/relay\/?$/),
      page.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ]);
  };
  await signIn();
  const { items: people } = await read(relayApi + '/people');
  const casey = people.find(person => person.displayName === 'Casey Technician');
  const riley = people.find(person => person.displayName === 'Riley Technician');
  const parkside = await job(manifest.parksideId);
  const harbour = await job(manifest.harbourId);
  expect(parkside.job.version).toBe(manifest.initialVersion);
  expect(parkside.job.assigneeId).toBe(casey.id);
  expect(parkside.job.scheduledAt).toBe(manifest.initialVisit);
  expect(parkside.job.serviceWindow.completeBy).toBe(manifest.initialDeadline);
  expect(harbour.job.assigneeId).toBe(casey.id);
  expect(harbour.job.scheduledAt).toBe(manifest.harbourVisit);

  let threadId;
  const threads = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/_agent-native/agent-chat') {
      threadId = request.postDataJSON().threadId;
      threads.push(threadId);
    }
  });
  const runState = async () => {
    if (!threadId) return null;
    return read(nativeApi + '/agent-chat/runs/active?threadId=' + threadId).catch(() => null);
  };
  const waitDone = previous => expect.poll(async () => {
    const state = await runState();
    return !!state?.runId && state.runId !== previous && !state.active;
  }, { timeout: 150_000, intervals: [500, 1000] }).toBe(true);
  const calls = async () => {
    const thread = JSON.parse((await read(nativeApi + '/agent-chat/threads/' + threadId)).threadData);
    return thread.agentKit.toolCalls ?? [];
  };
  const openChat = async () => {
    await page.getByRole('button', { name: '✳ Ask Relay', exact: true }).click();
    const frame = page.frameLocator('iframe[title="Ask Relay assistant"]');
    const chat = frame.getByRole('region', { name: 'Ask Relay conversation' });
    const composer = frame.getByRole('textbox', { name: 'Message agent...' });
    await expect(composer).toBeVisible({ timeout: 60_000 });
    await expect(chat).not.toHaveAttribute('inert', '', { timeout: 30_000 });
    const selected = await read(nativeApi + '/agent-model-defaults?appId=board');
    expect(selected.engine).toBe(engine);
    expect(selected.model).toBe(model);
    const approve = frame.getByRole('button', { name: /^Approve( once)?$/ });
    const send = async (message, expectsApproval = false) => {
      const previous = (await runState())?.runId;
      await composer.fill(message);
      await frame.getByRole('button', { name: 'Send message', exact: true }).click();
      if (expectsApproval) {
        await expect(approve).toBeVisible({ timeout: 120_000 }).catch(async error => {
          console.error((await chat.innerText()).slice(-1500));
          throw error;
        });
      } else {
        await waitDone(previous);
      }
    };
    return { send, chat, approve };
  };

  console.log('Parkside: request the client deadline change.');
  await page.goto(manifest.parksideUrl);
  const parksideChat = await openChat();
  const target = DateTime.fromISO(manifest.targetDate, { zone }).toFormat('MMMM d, yyyy');
  const deadlinePrompt = 'Set Parkside Foods’ client completion deadline to ' + target +
    ' at 6 p.m. Vancouver time. Keep the visit time, technician, priority and all other dispatch details unchanged. Show the deadline change for my approval.';
  await parksideChat.send(deadlinePrompt, true);
  await expect(parksideChat.approve).toBeVisible({ timeout: 10_000 });
  const deadline = (await calls()).find(tool => tool.name === 'update-relay-client-deadline');
  expect(deadline?.input).toMatchObject({
    jobId: manifest.parksideId, date: manifest.targetDate, time: '18:00', expectedVersion: parkside.job.version,
  });
  expect((await job(manifest.parksideId)).job.version).toBe(parkside.job.version);
  await parksideChat.approve.click();
  await expect.poll(async () => (await job(manifest.parksideId)).job.serviceWindow.completeBy,
    { timeout: 45_000 }).toBe(manifest.targetDeadline);
  await expect(parksideChat.approve).toBeHidden({ timeout: 45_000 });
  const afterDeadline = await job(manifest.parksideId);
  expect(afterDeadline.job.version).toBe(parkside.job.version + 1);
  expect(afterDeadline.job.scheduledAt).toBe(parkside.job.scheduledAt);
  expect(afterDeadline.job.assigneeId).toBe(casey.id);

  console.log('Parkside: check Casey’s availability and approve the visit in the same chat.');
  await parksideChat.send('Now check Casey Technician’s available openings on ' + target +
    ', and move Parkside Foods to an earlier available visit that finishes before the new 6 p.m. client deadline. Keep Casey assigned. Request approval to apply the exact checked visit, rather than only saving a proposal.', true);
  await expect(parksideChat.approve).toBeVisible({ timeout: 10_000 });
  const visit = (await calls()).find(tool =>
    ['reschedule-relay-visit', 'apply-relay-assignment'].includes(tool.name) && tool.input?.jobId === manifest.parksideId);
  expect(visit).toBeDefined();
  expect((await job(manifest.parksideId)).job.version).toBe(afterDeadline.job.version);
  await parksideChat.approve.click();
  await expect.poll(async () => (await job(manifest.parksideId)).job.version,
    { timeout: 60_000 }).toBe(parkside.job.version + 2);
  await expect(parksideChat.approve).toBeHidden({ timeout: 45_000 });
  const saved = await job(manifest.parksideId);
  expect(saved.job.assigneeId).toBe(casey.id);
  expect(saved.job.serviceWindow.completeBy).toBe(manifest.targetDeadline);
  expect(local(saved.job.scheduledAt).toISODate()).toBe(manifest.targetDate);
  expect(local(saved.job.scheduledAt).plus({ minutes: saved.job.estimatedMinutes }).toMillis())
    .toBeLessThanOrEqual(Date.parse(manifest.targetDeadline));
  const events = saved.events.slice(parkside.events.length);
  expect(events.map(event => event.kind)).toEqual(['job_dispatch_details_updated', 'job_visit_assigned']);
  expect(new Set(threads).size).toBe(1);
  await page.getByRole('button', { name: 'Close Ask Relay', exact: true }).click();
  const history = page.locator('details').filter({ has: page.getByText('Job history', { exact: true }) });
  await history.locator('summary').click();
  await expect(history.getByText(events[1].note, { exact: true })).toBeVisible();
  console.log('PASS Parkside: two separate approvals, one chat, and both history events.');

  console.log('Harbour Market: save the reassignment in Relay and read it back in Ask Relay.');
  await page.goto(manifest.harbourUrl);
  await page.getByText('Manage assignment', { exact: true }).click();
  await page.getByRole('button', { name: 'Change assignee', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Change assignee', exact: true });
  await dialog.getByText('Choose a person manually', { exact: true }).click();
  await dialog.locator('select[name=assigneeId]').selectOption(riley.id);
  await dialog.locator('button[type=submit]').click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  const changed = await job(manifest.harbourId);
  expect(changed.job.version).toBe(harbour.job.version + 1);
  expect(changed.job.assigneeId).toBe(riley.id);
  expect(changed.job.scheduledAt).toBe(harbour.job.scheduledAt);
  expect(changed.events.slice(harbour.events.length).map(event => event.kind)).toEqual(['job_assigned']);
  threadId = undefined;
  const harbourChat = await openChat();
  await harbourChat.send('Check this job’s saved schedule. Who is assigned now, and when is the visit? Just read the current job.');
  await expect(harbourChat.chat).toContainText('Riley Technician', { timeout: 15_000 });
  await expect(harbourChat.chat).toContainText('11:00');
  expect((await calls()).some(tool =>
    tool.input?.jobId === manifest.harbourId && /^read-relay-(job-context|records)$/.test(tool.name))).toBe(true);
  expect((await job(manifest.harbourId)).job.version).toBe(changed.job.version);
  console.log('PASS Harbour Market: manual change, saved visit, and scoped read with no additional write.');
} finally {
  await browser.close();
}

// Synthetic records only; call from the isolated browser rehearsal, never production.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function seedRelayUxExamples({ request, origin, headers, branchId, responderId }) {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const time = minutes => new Date(Date.now() + minutes * 60000).toISOString();
  async function write(path, data) {
    const response = await request.post(`${origin}/api/relay/v1${path}`, { headers: { ...headers, 'idempotency-key': randomUUID() }, data });
    assert.ok(response.ok(), `Synthetic seed ${path}: ${await response.text()}`);
    return response.json();
  }
  async function create(externalId, customerReference) {
    return write('/jobs', { externalId, customerReference, branchId, priority: 'normal', description: 'Synthetic example. No real customer or service.' });
  }
  async function act(detail, action, fields = {}) {
    return write(`/jobs/${detail.job.id}/actions`, { action, expectedVersion: detail.job.version, ...fields });
  }
  const requested = await create('REQUEST-201', 'Cedar Shop — new service request');
  let scheduled = await create('SCHEDULE-202', 'Harbour Market — planned equipment service');
  scheduled = await act(scheduled, 'assign', { assigneeId: responderId });
  scheduled = await act(scheduled, 'schedule', { scheduledAt: time(60), note: 'Customer agreed to the afternoon service window' });
  let active = await create('SERVICE-203', 'Oak Bakery — oven temperature repair');
  active = await act(active, 'assign', { assigneeId: responderId });
  active = await act(active, 'start', { note: 'Technician arrived and began diagnosis' });
  active = await act(active, 'add_milestone', { title: 'Send diagnostic findings to dispatch', ownerId: responderId, dueAt: time(30) });
  let blocked = await create('DELAY-204', 'Pine Grocery — replacement fan required');
  blocked = await act(blocked, 'assign', { assigneeId: responderId });
  blocked = await act(blocked, 'start', { note: 'Fault identified during the initial visit' });
  blocked = await act(blocked, 'add_milestone', { title: 'Confirm replacement part ETA', ownerId: responderId, dueAt: time(-30) });
  blocked = await act(blocked, 'block', { note: 'Supplier has not confirmed when the replacement fan will arrive' });
  let review = await create('REVIEW-205', 'Maple Cafe — refrigerator restored');
  review = await act(review, 'assign', { assigneeId: responderId });
  review = await act(review, 'start', { note: 'Technician inspecting the refrigerator' });
  review = await act(review, 'report_completion', { note: 'Thermostat replaced; unit maintained 3 C during testing. Awaiting dispatcher review.' });
  let overdue = await create('FOLLOWUP-206', 'Cedar Shop — post-repair follow-up');
  overdue = await act(overdue, 'assign', { assigneeId: responderId });
  overdue = await act(overdue, 'start', { note: 'Repair completed; follow-up and customer confirmation still needed' });
  overdue = await act(overdue, 'add_milestone', { title: 'Confirm equipment remains operational', ownerId: responderId, dueAt: time(-5) });
  function email(externalId, recognized, note) {
    return `From: dispatcher@example.invalid\r\nTo: relay@example.invalid\r\nMessage-ID: <${externalId}@example.invalid>\r\n${recognized ? 'X-Northstar-Template: relay-v1\r\n' : ''}Content-Type: text/plain\r\n\r\nWork-Order: ${externalId}\r\nCustomer: Parkside Foods\r\nPriority: normal\r\nDue-At: ${time(60)}\r\nSource-Received-At: ${time(-1)}\r\nNote: ${note}`;
  }
  const intakeReview = await write('/intake', { branchId, rawEmail: email('INBOX-REVIEW-207', false, 'Repair the loading dock door. It stops halfway down and will not close fully.') });
  const intakeJob = await write('/intake', { branchId, rawEmail: email('INBOX-JOB-208', true, 'Repair the walk-in cooler behind the deli. It is holding at 8°C and will not cool to 4°C.') });
  assert.equal(intakeReview.status, 'needs_review');
  assert.equal(intakeJob.status, 'promoted');
  return { requested, scheduled, active, blocked, review, overdue, intakeReview, intakeJob };
}

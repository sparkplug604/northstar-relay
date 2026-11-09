import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { applyJobAction, createStandaloneJob, getJob, jobsOverview, listJobCommitments, listJobs, startJobAcknowledgement, type JobScope, type RelayPostgresStore } from '../../../../packages/relay-storage-postgres/src/index.js';
import type { JobAction } from '@northstar/relay-domain';
import type { RelayAuth } from './auth.js';
import { relayIdempotencyKey } from './app.js';
import { resolveOnCallRecipients } from './schedules.js';

import {jobSiteSchema,skillList,serviceWindowSchema} from './dispatchSchema.js';

const note = z.string().trim().min(3).max(10000);
const date = z.string().datetime({ offset: true });
const id = z.string().min(1).max(200);
const version = { expectedVersion: z.number().int().positive() };
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign'), assigneeId: id, checkAvailability:z.boolean().optional(), ...version }).strict(),
  z.object({action:z.literal('dispatch_details'),priority:z.enum(['urgent','high','normal','low']).optional(),serviceWindow:serviceWindowSchema.optional(),site:jobSiteSchema.nullable(),estimatedMinutes:z.number().int().min(1).max(1440),requiredSkills:skillList,...version}).strict(),
  z.object({ action: z.literal('unassign'), ...version }).strict(),
  z.object({ action: z.literal('schedule'), scheduledAt: date, note, ...version }).strict(),
  z.object({ action: z.literal('start'), note, ...version }).strict(),
  z.object({ action: z.literal('block'), note, ...version }).strict(),
  z.object({action:z.literal('update_blocker'),blocker:note,note,...version}).strict(),
  z.object({ action: z.literal('resume'), note, ...version }).strict(),
  z.object({ action: z.literal('report_completion'), note, ...version }).strict(),
  z.object({ action: z.literal('confirm_completion'), note, ...version }).strict(),
  z.object({ action: z.literal('reopen'), note, ...version }).strict(),
  z.object({ action: z.literal('cancel'), note, ...version }).strict(),
  z.object({ action: z.literal('add_update'), note, ...version }).strict(),
  z.object({ action: z.literal('add_milestone'), title: z.string().trim().min(3).max(200), ownerId: id, dueAt: date, ...version }).strict(),
  z.object({ action: z.literal('reschedule_milestone'), milestoneId: id, dueAt: date, note, ...version }).strict(),
  z.object({ action: z.literal('complete_milestone'), milestoneId: id, note, ...version }).strict(),
  z.object({ action: z.literal('cancel_milestone'), milestoneId: id, note, ...version }).strict(),
]);

function scope(auth: RelayAuth): JobScope {
  return { tenantId: auth.organization.id, actorId: auth.user.id, role: auth.user.role, branchId: auth.user.branchId };
}
function jobId(request: FastifyRequest): string { return id.parse((request.params as { id: unknown }).id); }

export function registerJobRoutes(app: FastifyInstance, store: RelayPostgresStore): void {
  const base = '/api/relay/v1/jobs';
  app.get(base, async (request) => {
    const auth = await app.relayAuthorize(request);
    const query = z.object({ view: z.enum(['active', 'completed', 'all']).default('active'), offset: z.coerce.number().int().min(0).max(1000000).default(0),
      search: z.string().trim().max(200).default(''), branchId: id.optional(), ownerId: id.optional(), filter: z.enum(['all', 'mine', 'attention']).default('all'),
      status: z.enum(['requested','scheduled','in_progress','blocked','completion_reported','completed','cancelled']).optional(),
    }).strict().parse(request.query);
    return listJobs(store, scope(auth), query);
  });
  app.get(`${base}/overview`, async (request) => {
    const auth = await app.relayAuthorize(request);
    const query = z.object({ branchId: id.optional() }).strict().parse(request.query);
    return jobsOverview(store, scope(auth), query.branchId);
  });
  app.post(base, async (request, reply) => {
    const auth = await app.relayAuthorize(request, { roles: ['organization_admin', 'branch_dispatcher'] }); app.relayCsrf(request, auth);
    const input = z.object({ externalId: z.string().trim().min(1).max(200), customerReference: z.string().trim().min(1).max(200), branchId: id,
      priority: z.string().trim().min(1).max(80), description: z.string().max(10000).optional(),serviceWindow:serviceWindowSchema.optional() }).strict().parse(request.body);
    return reply.code(201).send(await createStandaloneJob(store, scope(auth), input, relayIdempotencyKey(request)));
  });
  app.get('/api/relay/v1/job-commitments', async (request) => {
    const auth = await app.relayAuthorize(request);
    const query = z.object({ view: z.enum(['open', 'completed', 'all']).default('open'), filter: z.enum(['all','mine']).default('all'),
      search: z.string().trim().max(200).default(''), branchId: id.optional(), offset: z.coerce.number().int().min(0).max(1000000).default(0),
    }).strict().parse(request.query);
    return listJobCommitments(store, scope(auth), query);
  });
  app.get(`${base}/:id`, async (request) => {
    const auth = await app.relayAuthorize(request);
    return getJob(store, scope(auth), jobId(request));
  });
  app.post(`${base}/:id/actions`, async (request) => {
    const auth = await app.relayAuthorize(request);
    app.relayCsrf(request, auth);
    const input: JobAction = actionSchema.parse(request.body);
    return applyJobAction(store, scope(auth), jobId(request), input, relayIdempotencyKey(request));
  });
  app.post(`${base}/:id/acknowledgement`, async (request) => {
    const auth = await app.relayAuthorize(request, { roles: ['organization_admin', 'branch_dispatcher'] }); app.relayCsrf(request, auth);
    const input = z.object({ expectedVersion: version.expectedVersion, dueAt: date }).strict().parse(request.body);
    return startJobAcknowledgement(store, scope(auth), jobId(request), input, relayIdempotencyKey(request), resolveOnCallRecipients);
  });
}

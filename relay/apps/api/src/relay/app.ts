import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { RelayPostgresStore, RelayStoreError } from '../../../../packages/relay-storage-postgres/src/index.js';
import { RelayAuthentication, bootstrapRelay, hashPassword, secretEqual, type RelayAuth, type RelayUserRole } from './auth.js';
import { actOnWorkOrder, authorizeBranch, createWorkOrder, requireWorkOrder } from './work-orders.js';
import { registerScheduleRoutes } from './schedules.js';
import { registerOverview, pagedWorkOrders } from './overview.js';
import {registerDispatchRoutes} from './dispatch.js';
import { registerJobRoutes } from './jobs.js';

export interface RelayAppOptions {
  store: RelayPostgresStore; publicOrigin: string; secureCookies: boolean; setupToken: string | undefined;
  authEncryptionKey: string; providerMode?: string; logger?: boolean; production?: boolean;
}
declare module 'fastify' {
  interface FastifyInstance {
    relayAuthorize(request: FastifyRequest, rules?: { allowPending?: boolean; roles?: readonly RelayUserRole[] }): Promise<RelayAuth>;
    relayCsrf(request: FastifyRequest, auth: RelayAuth): void;
  }
}
const passwordSchema = z.string().min(12).max(256);
const emailSchema = z.string().email().max(254).transform((value) => value.toLowerCase());
const nameSchema = z.string().trim().min(1).max(150);
const timezoneSchema = z.string().max(80).refine((value) => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Use an IANA timezone');
const phoneSchema = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use international format such as +16045550100');
const roleSchema = z.enum(['organization_admin', 'branch_dispatcher', 'on_call_responder']);
const setupSchema = z.object({ setupToken: z.string().max(256), organizationName: nameSchema, branchName: nameSchema, timezone: timezoneSchema, displayName: nameSchema, email: emailSchema, password: passwordSchema }).strict();
export const workOrderSchema = z.object({ branchId: z.string().min(1), externalId: z.string().trim().min(1).max(200), customerReference: z.string().trim().min(1).max(200), priority: z.string().trim().min(1).max(80), dueAt: z.string().datetime({ offset: true }), note: z.string().max(10000).optional(), recipientIds: z.array(z.string().min(1)).min(1).max(50).optional() }).strict();
function parameter(request: FastifyRequest, name: string): string { return z.string().min(1).parse((request.params as Record<string, unknown>)[name]); }
export function relayIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || value.length < 8 || value.length > 160 || !/^[A-Za-z0-9:_.-]+$/.test(value)) throw new RelayStoreError('idempotency_key_required', 'Send an Idempotency-Key of 8–160 letters, digits, or separators', 400);
  return value;
}

export async function buildRelayApp(options: RelayAppOptions): Promise<FastifyInstance> {
  const publicUrl = new URL(options.publicOrigin);
  if (publicUrl.origin !== options.publicOrigin) throw new Error('RELAY_PUBLIC_ORIGIN must be an origin without a path');
  if (options.production && (publicUrl.protocol !== 'https:' || !options.secureCookies)) throw new Error('Production Relay requires HTTPS and secure cookies');
  if (options.production) await options.store.assertRestrictedRuntime();
  // Action capabilities live in paths; never emit automatic URL access logs.
  const app = Fastify({ logController: new Fastify.LogController({ disableRequestLogging: true }), logger: options.logger ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-csrf-token', 'res.headers.set-cookie'] } : false, bodyLimit: 65536 });
  const authentication = new RelayAuthentication(options);
  app.decorate('relayAuthorize', authentication.authorize.bind(authentication));
  app.decorate('relayCsrf', authentication.csrf.bind(authentication));
  await registerOverview(app, options.store);
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (options.secureCookies) reply.header('strict-transport-security', 'max-age=31536000');
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RelayStoreError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid_request', message: 'Check the form fields', issues: error.issues.map(({ path, message }) => ({ path, message })) });
    if ((error as { code?: string }).code === '23505') return reply.code(409).send({ error: 'already_exists', message: 'This record already exists' });
    app.log.error({ name: error instanceof Error ? error.name : 'Error', code: (error as { code?: string }).code }, 'Relay request failed');
    return reply.code(500).send({ error: 'internal_error', message: 'The request could not be completed' });
  });
  const base = '/api/relay/v1';
  const sessionResponse = async (auth: RelayAuth) => ({
    user: auth.user, organization: auth.organization,
    branches: (await options.store.pool.query('SELECT id,name,timezone FROM relay.branches WHERE tenant_id=$1 AND ($2::boolean OR id=$3) ORDER BY name', [auth.organization.id, auth.user.role === 'organization_admin', auth.user.branchId])).rows,
    csrfToken: auth.csrfToken, providerMode: options.providerMode ?? 'simulated',
  });
  app.get('/health', async (_request, reply) => {
    try { await options.store.pool.query('SELECT 1 FROM relay.organizations LIMIT 1'); return { status: 'ok', storage: 'postgres', product: 'relay' }; }
    catch { return reply.code(503).send({ status: 'unavailable', storage: 'postgres' }); }
  });
  app.get(`${base}/session`, async (request) => sessionResponse(await authentication.authorize(request)));
  app.post(`${base}/auth/setup`, async (request, reply) => {
    authentication.requireOrigin(request);
    await authentication.limit(`setup:${request.ip}`, 5);
    const input = setupSchema.parse(request.body);
    if (!options.setupToken || !secretEqual(input.setupToken, options.setupToken)) throw new RelayStoreError('setup_not_authorized', 'Setup token was not accepted', 403);
    await bootstrapRelay(options.store, input);
    const result = await authentication.login(input.email, input.password);
    authentication.cookie(reply, result.token);
    return { mfaRequired: result.mfaRequired, enrollmentRequired: result.enrollmentRequired, csrfToken: result.csrfToken };
  });
  app.post(`${base}/auth/login`, async (request, reply) => {
    authentication.requireOrigin(request);
    const input = z.object({ email: emailSchema, password: z.string().max(256), totpCode: z.string().max(80).optional() }).strict().parse(request.body);
    await authentication.limit(`login-ip:${request.ip}`, 30);
    await authentication.limit(`login-account:${input.email}`);
    const result = await authentication.login(input.email, input.password);
    authentication.cookie(reply, result.token);
    if (input.totpCode && result.mfaRequired && !result.enrollmentRequired) {
      const pending = await authentication.authorize({ ...request, headers: { ...request.headers, cookie: `northstar_relay_session=${result.token}` } } as FastifyRequest, { allowPending: true });
      const confirmed = await authentication.confirm(pending, input.totpCode);
      authentication.cookie(reply, confirmed.token);
      return { mfaRequired: false, csrfToken: confirmed.csrfToken };
    }
    return { mfaRequired: result.mfaRequired, enrollmentRequired: result.enrollmentRequired, csrfToken: result.csrfToken };
  });
  app.post(`${base}/auth/mfa/enroll`, async (request) => {
    const auth = await authentication.authorize(request, { allowPending: true }); authentication.csrf(request, auth);
    return authentication.enroll(auth);
  });
  app.post(`${base}/auth/mfa/confirm`, async (request, reply) => {
    const auth = await authentication.authorize(request, { allowPending: true }); authentication.csrf(request, auth);
    await authentication.limit(`mfa:${auth.user.id}`);
    const input = z.object({ totpCode: z.string().min(6).max(80) }).strict().parse(request.body);
    const result = await authentication.confirm(auth, input.totpCode);
    authentication.cookie(reply, result.token);
    return { mfaRequired: false, csrfToken: result.csrfToken, ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}) };
  });
  app.post(`${base}/auth/logout`, async (request, reply) => {
    const auth = await authentication.authorize(request, { allowPending: true }); authentication.csrf(request, auth);
    await options.store.pool.query('DELETE FROM relay.sessions WHERE token_hash=$1', [auth.tokenHash]);
    authentication.clearCookie(reply);
    return reply.code(204).send();
  });
  app.get(`${base}/work-orders`, async (request) => {
    if ((request.query as {view?:unknown}).view !== undefined) return pagedWorkOrders(app,options.store,request);
    const auth = await authentication.authorize(request);
    return { items: await options.store.listCommitments(auth.organization.id, auth.user.role === 'organization_admin' ? undefined : auth.user.branchId) };
  });
  app.post(`${base}/work-orders`, async (request, reply) => {
    const auth = await authentication.authorize(request, { roles: ['organization_admin', 'branch_dispatcher'] }); authentication.csrf(request, auth);
    const result = await createWorkOrder(options.store, auth, workOrderSchema.parse(request.body), relayIdempotencyKey(request));
    return reply.code(201).send(result);
  });
  app.get(`${base}/work-orders/:id`, async (request) => {
    const auth = await authentication.authorize(request); const id = parameter(request, 'id');
    const commitment = await requireWorkOrder(options.store, auth, id);
    return options.store.tenantTx(auth.organization.id, async (client) => ({
      commitment,
      note: (await client.query('SELECT note FROM relay.commitments WHERE tenant_id=$1 AND commitment_id=$2', [auth.organization.id, id])).rows[0]?.note ?? '',
      events: (await client.query('SELECT envelope FROM relay.events WHERE tenant_id=$1 AND commitment_id=$2 ORDER BY aggregate_version', [auth.organization.id, id])).rows.map((row) => row.envelope),
      attempts: (await client.query('SELECT attempt_id,step_index,recipient_id,person_id,channel,status,attempts,provider_reference,last_error,created_at,updated_at FROM relay.attempts WHERE tenant_id=$1 AND commitment_id=$2 ORDER BY created_at', [auth.organization.id, id])).rows,
    }));
  });
  app.post(`${base}/work-orders/:id/actions`, async (request) => {
    const auth = await authentication.authorize(request); authentication.csrf(request, auth);
    const input = z.object({ action: z.enum(['acknowledge', 'decline', 'cancel', 'source_acceptance', 'fulfill', 'close']), reason: z.string().max(2000).optional(), sourceStatus: z.enum(['pending', 'accepted', 'declined', 'not_required']).optional(), recipientId: z.string().min(1).optional() }).strict().parse(request.body);
    return actOnWorkOrder(options.store, auth, parameter(request, 'id'), input, relayIdempotencyKey(request));
  });
  app.get(`${base}/people`, async (request) => {
    const auth = await authentication.authorize(request);
    return options.store.tenantTx(auth.organization.id, async (client) => ({ items: (await client.query(`SELECT p.id,p.display_name AS "displayName",p.email,p.active,m.role,m.branch_id AS "branchId",c.phone,(c.phone_verified_at IS NOT NULL) AS "phoneVerified"
      FROM relay.memberships m JOIN relay.people p ON p.id=m.person_id LEFT JOIN relay.contacts c ON c.tenant_id=m.tenant_id AND c.person_id=p.id
      WHERE m.tenant_id=$1 AND ($2::boolean OR m.branch_id=$3) ORDER BY p.display_name`, [auth.organization.id, auth.user.role === 'organization_admin', auth.user.branchId])).rows }));
  });
  app.post(`${base}/people`, async (request, reply) => {
    const auth = await authentication.authorize(request, { roles: ['organization_admin'] }); authentication.csrf(request, auth);
    const input = z.object({ displayName: nameSchema, email: emailSchema, password: passwordSchema, role: roleSchema, branchId: z.string().min(1), phone: phoneSchema.nullable().optional() }).strict().parse(request.body);
    const passwordHash = await hashPassword(input.password); const id = randomUUID();
    await options.store.tenantTx(auth.organization.id, async (client) => {
      if (!(await client.query('SELECT 1 FROM relay.branches WHERE tenant_id=$1 AND id=$2', [auth.organization.id, input.branchId])).rowCount) throw new RelayStoreError('branch_not_found', 'Branch not found', 404);
      await client.query('INSERT INTO relay.people(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [id, input.email, input.displayName, passwordHash]);
      await client.query('INSERT INTO relay.memberships(tenant_id,person_id,branch_id,role) VALUES($1,$2,$3,$4)', [auth.organization.id, id, input.branchId, input.role]);
      await client.query('INSERT INTO relay.contacts(tenant_id,person_id,phone) VALUES($1,$2,$3)', [auth.organization.id, id, input.phone ?? null]);
      await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,'person_created',$3)", [auth.organization.id, auth.user.id, { personId: id, role: input.role, branchId: input.branchId }]);
    });
    return reply.code(201).send({ id, displayName: input.displayName, email: input.email, role: input.role, branchId: input.branchId, phone: input.phone ?? null, phoneVerified: false, active: true });
  });
  app.patch(`${base}/people/:id`, async (request) => {
    const auth = await authentication.authorize(request); authentication.csrf(request, auth); const id = parameter(request, 'id');
    const input = z.object({ phone: phoneSchema.nullable().optional(), displayName: nameSchema.optional(), active: z.boolean().optional() }).strict().parse(request.body);
    if (auth.user.role !== 'organization_admin' && (id !== auth.user.id || input.active !== undefined)) throw new RelayStoreError('forbidden', 'You cannot change this person', 403);
    if (id === auth.user.id && input.active === false) throw new RelayStoreError('cannot_disable_self', 'You cannot deactivate your own account', 422);
    await options.store.tenantTx(auth.organization.id, async (client) => {
      const target = (await client.query('SELECT m.person_id,m.branch_id FROM relay.memberships m WHERE tenant_id=$1 AND person_id=$2 FOR UPDATE', [auth.organization.id, id])).rows[0];
      if (!target) throw new RelayStoreError('person_not_found', 'Person not found', 404);
      authorizeBranch(auth, target.branch_id);
      if (input.displayName !== undefined) await client.query('UPDATE relay.people SET display_name=$2 WHERE id=$1', [id, input.displayName]);
      if (input.active !== undefined) { await client.query('UPDATE relay.people SET active=$2 WHERE id=$1', [id, input.active]); if (!input.active) await client.query('DELETE FROM relay.sessions WHERE person_id=$1', [id]); }
      if (input.phone !== undefined) await client.query('UPDATE relay.contacts SET phone=$3,phone_verified_at=NULL,verification_token_hash=NULL,verification_expires_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND person_id=$2 AND phone IS DISTINCT FROM $3', [auth.organization.id, id, input.phone]);
      await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,'person_updated',$3)", [auth.organization.id, auth.user.id, { personId: id, fields: Object.keys(input) }]);
    });
    return { updated: true };
  });
  const settingsResponse = async (auth: RelayAuth, branchId: string) => {
    authorizeBranch(auth, branchId);
    return options.store.tenantTx(auth.organization.id, async (client) => {
      const row = (await client.query('SELECT s.*,b.timezone FROM relay.settings s JOIN relay.branches b ON b.tenant_id=s.tenant_id AND b.id=s.branch_id WHERE s.tenant_id=$1 AND s.branch_id=$2', [auth.organization.id, branchId])).rows[0];
      if (!row) throw new RelayStoreError('branch_not_found', 'Branch not found', 404);
      return { branchId, version: row.version, recipientIds: row.recipient_ids, intervalSeconds: row.interval_seconds, channels: row.channels, timezone: row.timezone };
    });
  };
  app.get(`${base}/settings`, async (request) => {
    const auth = await authentication.authorize(request);
    const query = z.object({ branchId: z.string().optional() }).parse(request.query);
    return settingsResponse(auth, query.branchId ?? auth.user.branchId);
  });
  app.put(`${base}/settings`, async (request) => {
    const auth = await authentication.authorize(request, { roles: ['organization_admin', 'branch_dispatcher'] }); authentication.csrf(request, auth);
    const input = z.object({ branchId: z.string().min(1), expectedVersion: z.number().int().positive().optional(), recipientIds: z.array(z.string().min(1)).max(50), intervalSeconds: z.number().int().min(15).max(3600), channels: z.array(z.enum(['sms', 'voice'])).min(1).max(2), timezone: timezoneSchema.optional() }).strict().parse(request.body);
    authorizeBranch(auth, input.branchId);
    if (new Set(input.recipientIds).size !== input.recipientIds.length || new Set(input.channels).size !== input.channels.length) throw new RelayStoreError('duplicate_settings', 'Recipients and channels must be unique', 422);
    await options.store.tenantTx(auth.organization.id, async (client) => {
      const current = (await client.query('SELECT version FROM relay.settings WHERE tenant_id=$1 AND branch_id=$2 FOR UPDATE', [auth.organization.id, input.branchId])).rows[0];
      if (!current) throw new RelayStoreError('branch_not_found', 'Branch not found', 404);
      if (input.expectedVersion !== undefined && input.expectedVersion !== Number(current.version)) throw new RelayStoreError('policy_version_conflict', 'The on-call policy changed. Reload it before saving.');
      const count = await client.query('SELECT 1 FROM relay.memberships m JOIN relay.people p ON p.id=m.person_id WHERE tenant_id=$1 AND branch_id=$2 AND person_id=ANY($3::text[]) AND p.active', [auth.organization.id, input.branchId, input.recipientIds]);
      if (count.rowCount !== input.recipientIds.length) throw new RelayStoreError('recipient_invalid', 'Choose active recipients in this branch', 422);
      const changed = await client.query('UPDATE relay.settings SET recipient_ids=$3,interval_seconds=$4,channels=$5,version=version+1 WHERE tenant_id=$1 AND branch_id=$2', [auth.organization.id, input.branchId, JSON.stringify(input.recipientIds), input.intervalSeconds, JSON.stringify(input.channels)]);
      if (changed.rowCount !== 1) throw new RelayStoreError('branch_not_found', 'Branch not found', 404);
      if (input.timezone) await client.query('UPDATE relay.branches SET timezone=$3 WHERE tenant_id=$1 AND id=$2', [auth.organization.id, input.branchId, input.timezone]);
      await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,'settings_updated',$3)", [auth.organization.id, auth.user.id, { branchId: input.branchId, recipientCount: input.recipientIds.length }]);
    });
    return settingsResponse(auth, input.branchId);
  });
  registerScheduleRoutes(app, options.store);
  registerJobRoutes(app, options.store);
  registerDispatchRoutes(app, options.store);
  return app;
}

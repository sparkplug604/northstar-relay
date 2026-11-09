import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { RelayCommitment, RelayCommand } from '@northstar/relay-domain';
import {
  actionTokenHash, constantTimeTextEqual, dtmfAction, relayVoiceResult,
  verifyRelayTwilioCallback, type RelayTwilioProvider, type RelayTwilioConfig,
} from '../../../packages/relay-adapters/src/index.js';
import { RelayPostgresStore, RelayStoreError, requestDigest } from '../../../packages/relay-storage-postgres/src/index.js';
import { RelayAuthentication, sha256 } from './relay/auth.js';

export interface RelayIntegrationOptions {
  store: RelayPostgresStore;
  publicOrigin: string;
  authEncryptionKey: string;
  secureCookies: boolean;
  localDevelopment: boolean;
  twilio: RelayTwilioProvider | null;
  twilioConfig: RelayTwilioConfig | null;
}
interface Attempt {
  tenant_id: string; branch_id: string; attempt_id: string; commitment_id: string;
  person_id: string; recipient_id: string; phone: string; channel: string; status: string;
  provider_reference: string | null; acknowledgement_token_hash: string | null;
  acknowledgement_expires_at: Date | null;
}

function parameter(request: FastifyRequest, name: string): string {
  return z.string().min(1).max(200).parse((request.params as Record<string, unknown>)[name]);
}
export function relayIdempotencyKey(request: FastifyRequest): string {
  return z.string().min(8).max(160).parse(request.headers['idempotency-key']);
}
async function findAttempt(store: RelayPostgresStore, column: 'attempt_id' | 'acknowledgement_token_hash', value: string): Promise<Attempt | null> {
  // Opaque capability lookup, never a caller-provided tenant selector.
  const tenants = (await store.pool.query('SELECT id FROM relay.organizations o WHERE NOT EXISTS(SELECT 1 FROM relay.deletion_tombstones d WHERE d.tenant_id=o.id) ORDER BY id')).rows;
  for (const tenant of tenants) {
    const row = await store.tenantTx(String(tenant.id), async client => (await client.query(`SELECT * FROM relay.attempts WHERE tenant_id=$1 AND ${column}=$2`, [tenant.id, value])).rows[0]);
    if (row) return row as Attempt;
  }
  return null;
}
async function eligibleAttempt(client: PoolClient, attempt: Attempt, state: RelayCommitment | null, now: string): Promise<void> {
  const current = (await client.query('SELECT * FROM relay.attempts WHERE tenant_id=$1 AND attempt_id=$2 FOR UPDATE', [attempt.tenant_id, attempt.attempt_id])).rows[0];
  const contact = (await client.query('SELECT p.active,c.phone,c.phone_verified_at FROM relay.people p JOIN relay.contacts c ON c.person_id=p.id WHERE c.tenant_id=$1 AND p.id=$2', [attempt.tenant_id, attempt.person_id])).rows[0];
  if (!state || !current || !['sending','submitted','delivered','answered','uncertain'].includes(String(current.status))
    || !contact?.active || !contact?.phone_verified_at || contact.phone !== current.phone
    || state.ownerRecipientId !== null || !['active','breached'].includes(state.status)
    || state.declinedRecipientIds.includes(attempt.recipient_id)
    || !current.acknowledgement_expires_at || current.acknowledgement_expires_at.getTime() < Date.parse(now)) {
    throw new RelayStoreError('action_unavailable', 'This action is no longer available', 409);
  }
}

export async function registerRelayIntegrations(app: FastifyInstance, config: RelayIntegrationOptions): Promise<void> {
  const { store } = config;
  const auth = new RelayAuthentication(config);
  const base = '/api/relay/v1';

  app.post(`${base}/people/:id/verification/start`, async request => {
    const actor = await auth.authorize(request);
    auth.csrf(request, actor);
    const personId = parameter(request, 'id');
    if (actor.user.role !== 'organization_admin' && actor.user.id !== personId) throw new RelayStoreError('forbidden', 'Only your own number can be verified', 403);
    const code = String(randomInt(100000, 1000000));
    const hash = sha256(`${config.authEncryptionKey}:${personId}:${code}`);
    const phone = await store.tenantTx(actor.organization.id, async client => {
      const contact = (await client.query('SELECT c.*,p.active FROM relay.contacts c JOIN relay.people p ON p.id=c.person_id WHERE c.tenant_id=$1 AND c.person_id=$2 FOR UPDATE OF c', [actor.organization.id, personId])).rows[0];
      if (!contact?.active || !contact.phone) throw new RelayStoreError('phone_required', 'An active person and phone number are required', 422);
      if (contact.verification_requested_at && Date.now() - contact.verification_requested_at.getTime() < 60_000) throw new RelayStoreError('verification_rate_limited', 'Wait one minute before requesting another code', 429);
      await client.query('UPDATE relay.contacts SET verification_token_hash=$3,verification_expires_at=clock_timestamp()+interval \'5 minutes\',verification_requested_at=clock_timestamp(),verification_attempts=0 WHERE tenant_id=$1 AND person_id=$2', [actor.organization.id, personId, hash]);
      return String(contact.phone);
    });
    if (config.twilio) {
      try { await config.twilio.sendVerification(phone, code); }
      catch { throw new RelayStoreError('verification_delivery_failed', 'The verification message could not be confirmed. Check the provider configuration and retry later.', 502); }
      return { sent: true, simulated: false };
    }
    if (!config.localDevelopment) throw new RelayStoreError('verification_unavailable', 'Live phone verification is not configured', 503);
    return { sent: true, simulated: true, developmentCode: code };
  });

  app.post(`${base}/people/:id/verification/confirm`, async request => {
    const actor = await auth.authorize(request); auth.csrf(request, actor);
    const personId = parameter(request, 'id');
    if (actor.user.role !== 'organization_admin' && actor.user.id !== personId) throw new RelayStoreError('forbidden', 'Only your own number can be verified', 403);
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).strict().parse(request.body);
    const valid = await store.tenantTx(actor.organization.id, async client => {
      const row = (await client.query('SELECT *,clock_timestamp() AS now FROM relay.contacts WHERE tenant_id=$1 AND person_id=$2 FOR UPDATE', [actor.organization.id, personId])).rows[0];
      if (!row?.verification_token_hash || !row.verification_expires_at || row.verification_expires_at < row.now || row.verification_attempts >= 5) return false;
      await client.query('UPDATE relay.contacts SET verification_attempts=verification_attempts+1 WHERE tenant_id=$1 AND person_id=$2', [actor.organization.id, personId]);
      if (!constantTimeTextEqual(row.verification_token_hash, sha256(`${config.authEncryptionKey}:${personId}:${code}`))) return false;
      await client.query('UPDATE relay.contacts SET phone_verified_at=clock_timestamp(),verification_token_hash=NULL,verification_expires_at=NULL WHERE tenant_id=$1 AND person_id=$2', [actor.organization.id, personId]);
      await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,'phone_verified',$3)", [actor.organization.id, actor.user.id, { personId, mechanism: config.twilio ? 'sms_code' : 'local_simulation' }]);
      return true;
    });
    if (!valid) throw new RelayStoreError('invalid_verification_code', 'The code is invalid, expired, or locked', 422);
    return { verified: true };
  });

  app.get(`${base}/action/:token`, async (request, reply) => {
    reply.header('cache-control','no-store').header('referrer-policy','no-referrer');
    const token = parameter(request, 'token');
    const attempt = await findAttempt(store, 'acknowledgement_token_hash', actionTokenHash(token));
    if (!attempt) return { status: 'unavailable', locale: 'en' };
    try {
      const state = await store.getCommitment(attempt.tenant_id, attempt.commitment_id);
      await store.tenantTx(attempt.tenant_id, client => eligibleAttempt(client, attempt, state, new Date().toISOString()));
      return { status: 'available', locale: 'en' };
    } catch { return { status: 'unavailable', locale: 'en' }; }
  });

  async function recipientAction(attempt: Attempt, action: 'acknowledge' | 'decline', key: string, guardExtra?: (client: PoolClient) => Promise<void>) {
    const membership = await store.tenantTx(attempt.tenant_id, async client => (await client.query('SELECT m.role,p.active FROM relay.memberships m JOIN relay.people p ON p.id=m.person_id WHERE m.tenant_id=$1 AND m.person_id=$2', [attempt.tenant_id,attempt.person_id])).rows[0]);
    if (!membership?.active) throw new RelayStoreError('action_unavailable','This action is no longer available',403);
    const actorRole = z.enum(['on_call_responder','branch_dispatcher','organization_admin']).parse(membership.role);
    const commandBase = {
      commandId: key, tenantId: attempt.tenant_id, commitmentId: attempt.commitment_id,
      actorId: attempt.person_id, actorRole,
      occurredAt: await store.now(), correlationId: key,
    };
    const command: RelayCommand = action === 'acknowledge'
      ? { ...commandBase, type: 'acknowledge_commitment', ownerRecipientId: attempt.recipient_id, mechanism: guardExtra ? 'dtmf' : 'web', attemptId: attempt.attempt_id }
      : { ...commandBase, type: 'decline_commitment', recipientId: attempt.recipient_id, attemptId: attempt.attempt_id };
    const result = await store.applyCommand(command, requestDigest({ action, attemptId: attempt.attempt_id }), '', async (client, state, now) => {
      const replay = (await client.query('SELECT 1 FROM relay.commands WHERE tenant_id=$1 AND command_id=$2', [attempt.tenant_id,key])).rowCount;
      if (!replay) await eligibleAttempt(client, attempt, state, now);
      if (guardExtra) await guardExtra(client);
    });
    if (result.status !== 'accepted' && result.status !== 'duplicate') throw new RelayStoreError('action_unavailable', 'This action is no longer available');
    return { status: action === 'acknowledge' ? 'accepted' : 'declined' };
  }

  app.post(`${base}/action/:token`, async request => {
    auth.requireOrigin(request);
    const { action } = z.object({ action: z.enum(['acknowledge','decline']) }).strict().parse(request.body);
    const token = parameter(request,'token');
    const attempt = await findAttempt(store,'acknowledgement_token_hash',actionTokenHash(token));
    if (!attempt) throw new RelayStoreError('action_unavailable','This action is no longer available',404);
    return recipientAction(attempt, action, `web:${attempt.attempt_id}:${relayIdempotencyKey(request)}`);
  });

  function validatedFields(request: FastifyRequest): Record<string, string> {
    const fields = z.record(z.string(), z.string()).parse(request.body);
    const signature = request.headers['x-twilio-signature'];
    if (!config.twilioConfig || typeof signature !== 'string' || !verifyRelayTwilioCallback(config.twilioConfig, request.url, signature, fields)) throw new RelayStoreError('invalid_provider_signature','Provider signature is invalid',403);
    return fields;
  }
  async function providerAttempt(request: FastifyRequest, fields: Record<string,string>): Promise<Attempt> {
    const attempt = await findAttempt(store,'attempt_id',parameter(request,'id'));
    const sid = fields.CallSid ?? fields.MessageSid;
    if (!attempt || !sid || !/^(CA|SM|MM)[a-f0-9]{32}$/i.test(sid) || fields.To !== attempt.phone || fields.From !== config.twilioConfig?.fromNumber
      || (attempt.provider_reference !== null && attempt.provider_reference !== sid)) throw new RelayStoreError('provider_attempt_mismatch','Provider event does not match this attempt',403);
    if ((fields.CallSid && attempt.channel !== 'voice') || (fields.MessageSid && attempt.channel !== 'sms')) throw new RelayStoreError('provider_channel_mismatch','Provider channel does not match',403);
    return attempt;
  }

  app.post(`${base}/providers/twilio/:id/gather`, async (request, reply) => {
    const fields = validatedFields(request);
    const attempt = await providerAttempt(request,fields);
    if (attempt.channel !== 'voice' || !fields.CallSid || fields.MessageSid) throw new RelayStoreError('provider_channel_mismatch','DTMF requires a voice call',403);
    const action = dtmfAction(fields.Digits);
    reply.type('text/xml');
    if (!action) return relayVoiceResult('no_input');
    try {
      const result = await recipientAction(attempt, action, `dtmf:${attempt.attempt_id}:${fields.CallSid}:${fields.Digits}`, async client => {
        const current = (await client.query('SELECT provider_reference FROM relay.attempts WHERE tenant_id=$1 AND attempt_id=$2 FOR UPDATE',[attempt.tenant_id,attempt.attempt_id])).rows[0];
        if (current.provider_reference !== null && current.provider_reference !== fields.CallSid) throw new RelayStoreError('provider_attempt_mismatch','Call does not match');
        await client.query('UPDATE relay.attempts SET provider_reference=$3 WHERE tenant_id=$1 AND attempt_id=$2',[attempt.tenant_id,attempt.attempt_id,fields.CallSid]);
        await client.query("INSERT INTO relay.provider_events(provider,event_id,payload_digest) VALUES('twilio',$1,$2) ON CONFLICT DO NOTHING",[`gather:${attempt.attempt_id}:${fields.CallSid}:${fields.Digits}`,requestDigest(fields)]);
      });
      return relayVoiceResult(result.status === 'accepted' ? 'accepted' : 'declined');
    } catch (error) {
      if (error instanceof RelayStoreError) return relayVoiceResult('unavailable');
      throw error;
    }
  });

  app.post(`${base}/providers/twilio/:id/status`, async (request, reply) => {
    const fields = validatedFields(request); const attempt = await providerAttempt(request,fields);
    const sid = fields.CallSid ?? fields.MessageSid!;
    const providerStatus = fields.CallStatus ?? fields.MessageStatus ?? 'unknown';
    const statuses: Record<string,string> = { queued:'submitted', initiated:'submitted', ringing:'submitted', 'in-progress':'answered', answered:'answered', completed:'delivered', sent:'submitted', delivered:'delivered', busy:'exhausted', 'no-answer':'exhausted', failed:'exhausted', undelivered:'exhausted', canceled:'cancelled' };
    const state = statuses[providerStatus];
    const key = `status:${attempt.attempt_id}:${sid}:${providerStatus}:${fields.SequenceNumber ?? ''}`;
    await store.tenantTx(attempt.tenant_id, async client => {
      const inserted = await client.query("INSERT INTO relay.provider_events(provider,event_id,payload_digest) VALUES('twilio',$1,$2) ON CONFLICT DO NOTHING RETURNING event_id",[key,requestDigest(fields)]);
      if (!inserted.rowCount || !state) return;
      const current = (await client.query('SELECT status,provider_reference FROM relay.attempts WHERE tenant_id=$1 AND attempt_id=$2 FOR UPDATE',[attempt.tenant_id,attempt.attempt_id])).rows[0];
      if (!current || (current.provider_reference && current.provider_reference !== sid)) throw new RelayStoreError('provider_attempt_mismatch','Provider event does not match',403);
      if (!current.provider_reference) await client.query('UPDATE relay.attempts SET provider_reference=$3 WHERE tenant_id=$1 AND attempt_id=$2',[attempt.tenant_id,attempt.attempt_id,sid]);
      const ranks: Record<string,number> = { sending:0, uncertain:0, submitted:1, answered:2, delivered:3, exhausted:3, cancelled:4, acknowledged:4 };
      if ((ranks[String(current.status)] ?? 4) >= (ranks[state] ?? 0)) return;
      await client.query('UPDATE relay.attempts SET status=$3,provider_reference=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND attempt_id=$2',[attempt.tenant_id,attempt.attempt_id,state,sid]);
    });
    return reply.code(204).send();
  });
}

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { TOTP, Secret } from 'otpauth';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { RelayPostgresStore, RelayStoreError } from '../../../../packages/relay-storage-postgres/src/index.js';

const scryptAsync = promisify(scrypt);
export type RelayUserRole = 'organization_admin' | 'branch_dispatcher' | 'on_call_responder';
export interface RelayAuth {
  tokenHash: string; csrfToken: string; mfaVerified: boolean; totpConfirmed: boolean;
  user: { id: string; displayName: string; email: string; role: RelayUserRole; branchId: string };
  organization: { id: string; name: string };
}
export interface RelayAuthOptions {
  store: RelayPostgresStore; publicOrigin: string; secureCookies: boolean; authEncryptionKey: string;
}
export const sessionCookieName = 'northstar_relay_session';
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const secretEqual = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, hash] = encoded.split(':');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;
  const derived = await scryptAsync(password, salt, 64) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
export function encryptSecret(value: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}
function decryptSecret(value: string, key: string): string {
  const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !ciphertext) throw new Error('Invalid encrypted authentication secret');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
function tokenFromRequest(request: FastifyRequest): string | null {
  const cookies = (request.headers.cookie ?? '').split(';').map((item) => item.trim());
  const match = cookies.find((item) => item.startsWith(`${sessionCookieName}=`));
  if (!match) return null;
  const token = match.slice(sessionCookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export class RelayAuthentication {
  private readonly dummyPassword: Promise<string>;
  constructor(public readonly options: RelayAuthOptions) {
    if (Buffer.from(options.authEncryptionKey, 'base64').length !== 32) throw new Error('RELAY_AUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    this.dummyPassword = hashPassword(randomBytes(32).toString('hex'));
  }
  async authorize(request: FastifyRequest, rules: { allowPending?: boolean; roles?: readonly RelayUserRole[] } = {}): Promise<RelayAuth> {
    const token = tokenFromRequest(request);
    if (!token) throw new RelayStoreError('authentication_required', 'Please sign in', 401);
    const result = await this.options.store.pool.query(`SELECT s.token_hash,s.csrf_token,s.mfa_verified,p.id,p.email,p.display_name,p.totp_confirmed,m.tenant_id,m.branch_id,m.role,o.name
      FROM relay.sessions s JOIN relay.people p ON p.id=s.person_id JOIN relay.memberships m ON m.person_id=p.id JOIN relay.organizations o ON o.id=m.tenant_id
      WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp() AND p.active AND NOT EXISTS(SELECT 1 FROM relay.deletion_tombstones d WHERE d.tenant_id=m.tenant_id) ORDER BY m.tenant_id LIMIT 1`, [sha256(token)]);
    const row = result.rows[0];
    if (!row) throw new RelayStoreError('authentication_required', 'Please sign in', 401);
    const auth: RelayAuth = {
      tokenHash: row.token_hash, csrfToken: row.csrf_token, mfaVerified: row.mfa_verified, totpConfirmed: row.totp_confirmed,
      user: { id: row.id, displayName: row.display_name, email: row.email, role: row.role, branchId: row.branch_id },
      organization: { id: row.tenant_id, name: row.name },
    };
    if (!rules.allowPending && !auth.mfaVerified) throw new RelayStoreError('mfa_required', 'Complete authentication to continue', 401);
    if (rules.roles && !rules.roles.includes(auth.user.role)) throw new RelayStoreError('forbidden', 'Your role cannot perform this action', 403);
    return auth;
  }
  csrf(request: FastifyRequest, auth: RelayAuth): void {
    this.requireOrigin(request);
    const csrf = request.headers['x-csrf-token'];
    if (typeof csrf !== 'string' || !secretEqual(csrf, auth.csrfToken)) throw new RelayStoreError('csrf_rejected', 'Refresh the page and try again', 403);
  }
  requireOrigin(request: FastifyRequest): void {
    if (request.headers.origin !== this.options.publicOrigin) throw new RelayStoreError('origin_rejected', 'Request origin is not permitted', 403);
  }
  cookie(reply: FastifyReply, token: string): void {
    reply.header('set-cookie', `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${this.options.secureCookies ? '; Secure' : ''}`);
  }
  clearCookie(reply: FastifyReply): void {
    reply.header('set-cookie', `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.options.secureCookies ? '; Secure' : ''}`);
  }
  async limit(key: string, maximum = 10): Promise<void> {
    const row = (await this.options.store.pool.query(`INSERT INTO relay.auth_limits(key,attempts) VALUES($1,1)
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN relay.auth_limits.window_start < clock_timestamp()-interval '10 minutes' THEN 1 ELSE relay.auth_limits.attempts+1 END,
      window_start=CASE WHEN relay.auth_limits.window_start < clock_timestamp()-interval '10 minutes' THEN clock_timestamp() ELSE relay.auth_limits.window_start END RETURNING attempts`, [sha256(key)])).rows[0];
    if (Number(row.attempts) > maximum) throw new RelayStoreError('rate_limited', 'Too many attempts. Try again later.', 429);
  }
  async issue(client: PoolClient, personId: string, verified: boolean): Promise<{ token: string; csrfToken: string }> {
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(24).toString('hex');
    await client.query(`INSERT INTO relay.sessions(token_hash,person_id,csrf_token,mfa_verified,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+$5::interval)`, [sha256(token), personId, csrfToken, verified, verified ? '8 hours' : '10 minutes']);
    return { token, csrfToken };
  }
  async login(email: string, password: string): Promise<{ token: string; csrfToken: string; mfaRequired: boolean; enrollmentRequired: boolean }> {
    const row = (await this.options.store.pool.query('SELECT p.*,m.role,m.tenant_id FROM relay.people p JOIN relay.memberships m ON m.person_id=p.id WHERE email=$1 ORDER BY m.tenant_id LIMIT 1', [email.toLowerCase()])).rows[0];
    const valid = await verifyPassword(password, row?.password_hash ?? await this.dummyPassword);
    if (!row || !valid || !row.active) throw new RelayStoreError('invalid_credentials', 'Email or password was not accepted', 401);
    const mfaRequired = row.role === 'organization_admin' || row.totp_confirmed;
    const issued = await this.options.store.tenantTx(String(row.tenant_id ?? ''), (client) => this.issue(client, row.id, !mfaRequired));
    return { ...issued, mfaRequired, enrollmentRequired: mfaRequired && !row.totp_confirmed };
  }
  async enroll(auth: RelayAuth): Promise<{ secret: string; uri: string }> {
    return this.options.store.tenantTx(auth.organization.id, async (client) => {
      const row = (await client.query('SELECT totp_confirmed,email FROM relay.people WHERE id=$1 FOR UPDATE', [auth.user.id])).rows[0];
      if (row?.totp_confirmed) throw new RelayStoreError('mfa_already_enrolled', 'An authenticator is already enrolled');
      const totp = new TOTP({ issuer: 'Northstar Relay', label: auth.user.email, secret: new Secret({ size: 20 }), algorithm: 'SHA1', digits: 6, period: 30 });
      await client.query('UPDATE relay.people SET totp_secret=$2 WHERE id=$1', [auth.user.id, encryptSecret(totp.secret.base32, this.options.authEncryptionKey)]);
      return { secret: totp.secret.base32, uri: totp.toString() };
    });
  }
  async confirm(auth: RelayAuth, code: string): Promise<{ token: string; csrfToken: string; recoveryCodes?: string[] }> {
    return this.options.store.tenantTx(auth.organization.id, async (client) => {
      const row = (await client.query('SELECT * FROM relay.people WHERE id=$1 FOR UPDATE', [auth.user.id])).rows[0];
      if (!row?.totp_secret) throw new RelayStoreError('mfa_not_enrolled', 'Enroll your authenticator first', 422);
      const totp = new TOTP({ secret: Secret.fromBase32(decryptSecret(row.totp_secret, this.options.authEncryptionKey)), algorithm: 'SHA1', digits: 6, period: 30 });
      const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime() as number;
      const delta = totp.validate({ token: code, timestamp: now, window: 1 });
      const counter = TOTP.counter({ timestamp: now, period: 30 }) + (delta ?? 0);
      const recoveryHashes = row.recovery_hashes as string[];
      const isRecovery = Boolean(row.totp_confirmed) && recoveryHashes.includes(sha256(code));
      if (!isRecovery && (delta === null || (row.last_totp_counter !== null && counter <= Number(row.last_totp_counter)))) throw new RelayStoreError('invalid_mfa_code', 'Authenticator code was not accepted', 401);
      const recoveryCodes = !row.totp_confirmed ? Array.from({ length: 8 }, () => randomBytes(12).toString('hex')) : undefined;
      await client.query('UPDATE relay.people SET totp_confirmed=true,last_totp_counter=$2,recovery_hashes=$3 WHERE id=$1', [auth.user.id, isRecovery ? row.last_totp_counter : counter, JSON.stringify(recoveryCodes?.map(sha256) ?? recoveryHashes.filter((hash) => !isRecovery || hash !== sha256(code)))]);
      if (isRecovery) await client.query('DELETE FROM relay.sessions WHERE person_id=$1', [auth.user.id]);
      else await client.query('DELETE FROM relay.sessions WHERE token_hash=$1', [auth.tokenHash]);
      const issued = await this.issue(client, auth.user.id, true);
      await client.query('INSERT INTO relay.audit(tenant_id,actor_id,action) VALUES($1,$2,$3)', [auth.organization.id, auth.user.id, isRecovery ? 'mfa_recovery_used' : 'mfa_verified']);
      return recoveryCodes ? { ...issued, recoveryCodes } : issued;
    });
  }
}

export async function bootstrapRelay(store: RelayPostgresStore, input: { organizationName: string; branchName: string; timezone: string; displayName: string; email: string; password: string }): Promise<{ tenantId: string; branchId: string; personId: string }> {
  const passwordHash = await hashPassword(input.password);
  const tenantId = randomUUID(); const branchId = randomUUID(); const personId = randomUUID();
  return store.tenantTx(tenantId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('relay-first-organization'))");
    if ((await client.query('SELECT 1 FROM relay.organizations LIMIT 1')).rowCount) throw new RelayStoreError('setup_complete', 'Initial setup is already complete');
    await client.query('INSERT INTO relay.organizations(id,name) VALUES($1,$2)', [tenantId, input.organizationName]);
    await client.query('INSERT INTO relay.branches(tenant_id,id,name,timezone) VALUES($1,$2,$3,$4)', [tenantId, branchId, input.branchName, input.timezone]);
    await client.query('INSERT INTO relay.people(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [personId, input.email.toLowerCase(), input.displayName, passwordHash]);
    await client.query("INSERT INTO relay.memberships(tenant_id,person_id,branch_id,role) VALUES($1,$2,$3,'organization_admin')", [tenantId, personId, branchId]);
    await client.query('INSERT INTO relay.contacts(tenant_id,person_id) VALUES($1,$2)', [tenantId, personId]);
    await client.query('INSERT INTO relay.settings(tenant_id,branch_id) VALUES($1,$2)', [tenantId, branchId]);
    await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action) VALUES($1,$2,'organization_created')", [tenantId, personId]);
    return { tenantId, branchId, personId };
  });
}

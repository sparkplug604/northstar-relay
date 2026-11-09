import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { RelayPostgresStore, RelayStoreError } from '../../../../packages/relay-storage-postgres/src/index.js';
import { authorizeBranch } from './scope.js';

const recipients = z.array(z.string().min(1)).min(1).max(50).refine((ids) => new Set(ids).size === ids.length, 'Recipients must be unique');
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const endTime = z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/);
const overrideSchema = z.object({ id: z.string().min(1).max(100).optional(), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), recipientIds: recipients, reason: z.string().trim().min(1).max(1000) }).strict();
const weeklySchema = z.object({ id: z.string().min(1).max(100).optional(), weekday: z.number().int().min(0).max(6), startTime: time, endTime, recipientIds: recipients }).strict();

export async function resolveOnCallRecipients(client: PoolClient, tenantId: string, branchId: string, fallback: string[], at: string): Promise<{ recipientIds: string[]; routingSource: string }> {
  const override = (await client.query('SELECT id,recipient_ids FROM relay.on_call_overrides WHERE tenant_id=$1 AND branch_id=$2 AND starts_at <= $3 AND ends_at > $3 ORDER BY starts_at DESC LIMIT 1', [tenantId, branchId, at])).rows[0];
  if (override) return { recipientIds: override.recipient_ids as string[], routingSource: `override:${String(override.id)}` };
  const branch = (await client.query('SELECT timezone FROM relay.branches WHERE tenant_id=$1 AND id=$2', [tenantId, branchId])).rows[0];
  if (!branch) throw new RelayStoreError('branch_not_found', 'Branch not found', 404);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: branch.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
  const localTime = `${part('hour')}:${part('minute')}`;
  const rule = (await client.query('SELECT id,recipient_ids FROM relay.weekly_on_call_rules WHERE tenant_id=$1 AND branch_id=$2 AND weekday=$3 AND start_time <= $4 AND end_time > $4 ORDER BY start_time LIMIT 1', [tenantId, branchId, weekday, localTime])).rows[0];
  return rule ? { recipientIds: rule.recipient_ids as string[], routingSource: `weekly:${String(rule.id)}` } : { recipientIds: fallback, routingSource: 'fallback' };
}

export function registerScheduleRoutes(app: FastifyInstance, store: RelayPostgresStore): void {
  const snapshot = async (tenantId: string, branchId: string) => store.tenantTx(tenantId, async (client) => {
    const settings = (await client.query('SELECT version FROM relay.settings WHERE tenant_id=$1 AND branch_id=$2', [tenantId, branchId])).rows[0];
    if (!settings) throw new RelayStoreError('branch_not_found', 'Branch not found', 404);
    return {
      branchId, version: settings.version,
      overrides: (await client.query('SELECT id,starts_at AS "startsAt",ends_at AS "endsAt",recipient_ids AS "recipientIds",reason FROM relay.on_call_overrides WHERE tenant_id=$1 AND branch_id=$2 ORDER BY starts_at', [tenantId, branchId])).rows,
      weeklyRules: (await client.query('SELECT id,weekday,start_time AS "startTime",end_time AS "endTime",recipient_ids AS "recipientIds" FROM relay.weekly_on_call_rules WHERE tenant_id=$1 AND branch_id=$2 ORDER BY weekday,start_time', [tenantId, branchId])).rows,
    };
  });
  app.get('/api/relay/v1/schedules', async (request) => {
    const auth = await app.relayAuthorize(request);
    const query = z.object({ branchId: z.string().optional() }).parse(request.query);
    const branchId = query.branchId ?? auth.user.branchId; authorizeBranch(auth, branchId);
    return snapshot(auth.organization.id, branchId);
  });
  app.put('/api/relay/v1/schedules', async (request) => {
    const auth = await app.relayAuthorize(request, { roles: ['organization_admin', 'branch_dispatcher'] }); app.relayCsrf(request, auth);
    const input = z.object({ branchId: z.string().min(1), expectedVersion: z.number().int().positive(), overrides: z.array(overrideSchema).max(100), weeklyRules: z.array(weeklySchema).max(100).optional() }).strict().parse(request.body);
    authorizeBranch(auth, input.branchId);
    for (const [i, override] of input.overrides.entries()) {
      if (Date.parse(override.endsAt) <= Date.parse(override.startsAt)) throw new RelayStoreError('invalid_override_window', 'Override end must be after its start', 422);
      if (input.overrides.slice(i + 1).some((other) => Date.parse(override.startsAt) < Date.parse(other.endsAt) && Date.parse(other.startsAt) < Date.parse(override.endsAt))) throw new RelayStoreError('overlapping_overrides', 'Dated overrides cannot overlap', 422);
    }
    for (const [i, rule] of (input.weeklyRules ?? []).entries()) {
      if (rule.startTime >= rule.endTime) throw new RelayStoreError('invalid_weekly_window', 'Weekly shifts must start and end on the same day; split overnight shifts into two rules', 422);
      if (input.weeklyRules!.slice(i + 1).some((other) => rule.weekday === other.weekday && rule.startTime < other.endTime && other.startTime < rule.endTime)) throw new RelayStoreError('overlapping_weekly_rules', 'Weekly windows on the same day cannot overlap', 422);
    }
    await store.tenantTx(auth.organization.id, async (client) => {
      const settings = (await client.query('SELECT version FROM relay.settings WHERE tenant_id=$1 AND branch_id=$2 FOR UPDATE', [auth.organization.id, input.branchId])).rows[0];
      if (!settings) throw new RelayStoreError('branch_not_found', 'Branch not found', 404);
      if (Number(settings.version) !== input.expectedVersion) throw new RelayStoreError('policy_version_conflict', 'The on-call policy changed. Reload it before saving.');
      const ids = [...new Set([...input.overrides.flatMap((override) => override.recipientIds), ...(input.weeklyRules ?? []).flatMap((rule) => rule.recipientIds)])];
      const count = (await client.query('SELECT 1 FROM relay.memberships m JOIN relay.people p ON p.id=m.person_id WHERE m.tenant_id=$1 AND m.branch_id=$2 AND p.active AND m.person_id=ANY($3::text[])', [auth.organization.id, input.branchId, ids])).rowCount;
      if (count !== ids.length) throw new RelayStoreError('recipient_invalid', 'Schedule recipients must be active members of this branch', 422);
      await client.query('DELETE FROM relay.on_call_overrides WHERE tenant_id=$1 AND branch_id=$2', [auth.organization.id, input.branchId]);
      for (const override of input.overrides) await client.query('INSERT INTO relay.on_call_overrides(tenant_id,branch_id,id,starts_at,ends_at,recipient_ids,reason) VALUES($1,$2,$3,$4,$5,$6,$7)', [auth.organization.id, input.branchId, override.id ?? randomUUID(), override.startsAt, override.endsAt, JSON.stringify(override.recipientIds), override.reason]);
      if (input.weeklyRules !== undefined) {
        await client.query('DELETE FROM relay.weekly_on_call_rules WHERE tenant_id=$1 AND branch_id=$2', [auth.organization.id, input.branchId]);
        for (const rule of input.weeklyRules) await client.query('INSERT INTO relay.weekly_on_call_rules(tenant_id,branch_id,id,weekday,start_time,end_time,recipient_ids) VALUES($1,$2,$3,$4,$5,$6,$7)', [auth.organization.id, input.branchId, rule.id ?? randomUUID(), rule.weekday, rule.startTime, rule.endTime, JSON.stringify(rule.recipientIds)]);
      }
      await client.query('UPDATE relay.settings SET version=version+1 WHERE tenant_id=$1 AND branch_id=$2', [auth.organization.id, input.branchId]);
      await client.query("INSERT INTO relay.audit(tenant_id,actor_id,action,details) VALUES($1,$2,'on_call_schedule_updated',$3)", [auth.organization.id, auth.user.id, { branchId: input.branchId, version: input.expectedVersion + 1, overrideCount: input.overrides.length, weeklyRuleCount: input.weeklyRules?.length ?? null }]);
    });
    return snapshot(auth.organization.id, input.branchId);
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RelayPostgresStore } from '../../../../packages/relay-storage-postgres/src/index.js';
import { authorizeBranch } from './scope.js';

// Counts are taken across the permitted scope, never inferred from a truncated UI list.
export async function registerOverview(app: FastifyInstance, store: RelayPostgresStore) {
  app.get('/api/relay/v1/overview', async request => {
    const actor=await app.relayAuthorize(request);
    const admin=actor.user.role==='organization_admin';
    const dispatch=admin||actor.user.role==='branch_dispatcher';
    return store.tenantTx(actor.organization.id,async client=>{
      const args=[actor.organization.id,admin?null:actor.user.branchId,dispatch?null:actor.user.id,actor.user.id];
      const work=(await client.query(`WITH visible AS (
        SELECT snapshot,status FROM relay.commitments WHERE tenant_id=$1 AND ($2::text IS NULL OR branch_id=$2)
        AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'recipients') r WHERE r->>'personId'=$3))
      ), open AS (SELECT * FROM visible WHERE status NOT IN ('closed','fulfilled','cancelled'))
      SELECT COUNT(*)::int AS open,
      COUNT(*) FILTER(WHERE snapshot->>'ownerRecipientId' IS NULL)::int AS "awaitingOwner",
      COUNT(*) FILTER(WHERE snapshot->>'ownerRecipientId' IS NULL AND (snapshot->>'dueAt')::timestamptz < clock_timestamp())::int AS overdue,
      COUNT(*) FILTER(WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'recipients') r WHERE r->>'recipientId'=snapshot->>'ownerRecipientId' AND r->>'personId'=$4))::int AS "ownedByMe"
      FROM open`,args)).rows[0];
      const contact=(await client.query(`SELECT COUNT(*)::int AS count FROM relay.contacts c JOIN relay.people p ON p.id=c.person_id
        JOIN relay.memberships m ON m.tenant_id=c.tenant_id AND m.person_id=c.person_id
        WHERE c.tenant_id=$1 AND p.active AND ($2::text IS NULL OR m.branch_id=$2) AND ($3::text IS NULL OR c.person_id=$3)
        AND (c.phone IS NULL OR c.phone_verified_at IS NULL)`,args.slice(0,3))).rows[0].count;
      let review=0,missingFallback=0;
      if(dispatch) {
        review=(await client.query("SELECT COUNT(*)::int AS count FROM relay.intake WHERE tenant_id=$1 AND ($2::text IS NULL OR branch_id=$2) AND status='needs_review'",args.slice(0,2))).rows[0].count;
        missingFallback=(await client.query("SELECT COUNT(*)::int AS count FROM relay.settings WHERE tenant_id=$1 AND ($2::text IS NULL OR branch_id=$2) AND jsonb_array_length(recipient_ids)=0",args.slice(0,2))).rows[0].count;
      }
      return {counts:{...work,review,unverifiedContacts:contact,missingFallback},asOf:await store.now()};
    });
  });
}

export const queueQuery=z.object({view:z.enum(['open','history']),offset:z.coerce.number().int().min(0).max(100000).default(0),filter:z.enum(['all','unowned','overdue','mine']).default('all'),search:z.string().trim().max(200).default(''),branchId:z.string().min(1).optional()});
export async function pagedWorkOrders(app:FastifyInstance, store:RelayPostgresStore, request:Parameters<FastifyInstance['relayAuthorize']>[0]) {
  const actor=await app.relayAuthorize(request),input=queueQuery.parse(request.query);
  const admin=actor.user.role==='organization_admin';
  const responder=actor.user.role==='on_call_responder';
  if(input.branchId) authorizeBranch(actor,input.branchId);
  return store.tenantTx(actor.organization.id,async client=>{
    const rows=(await client.query(`SELECT snapshot,note FROM relay.commitments WHERE tenant_id=$1
      AND ($2::text IS NULL OR branch_id=$2)
      AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'recipients') r WHERE r->>'personId'=$3))
      AND (status IN ('closed','fulfilled','cancelled'))=$4
      AND ($6='all' OR ($6='unowned' AND snapshot->>'ownerRecipientId' IS NULL)
        OR ($6='overdue' AND snapshot->>'ownerRecipientId' IS NULL AND (snapshot->>'dueAt')::timestamptz<clock_timestamp())
        OR ($6='mine' AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'recipients') r WHERE r->>'recipientId'=snapshot->>'ownerRecipientId' AND r->>'personId'=$7)))
      AND ((snapshot->'workOrder'->>'externalId') ILIKE $8 OR (snapshot->'workOrder'->>'customerReference') ILIKE $8)
      ORDER BY CASE WHEN $4 THEN NULL ELSE CASE WHEN snapshot->>'ownerRecipientId' IS NULL THEN 0 ELSE 1 END END,
      CASE WHEN $4 THEN NULL ELSE (snapshot->>'dueAt')::timestamptz END,created_at DESC,commitment_id
      LIMIT 101 OFFSET $5`,[actor.organization.id,input.branchId??(admin?null:actor.user.branchId),responder?actor.user.id:null,input.view==='history',input.offset,input.filter,actor.user.id,`%${input.search.replace(/[\\%_]/g,'\\$&')}%`])).rows;
    return {items:rows.slice(0,100).map(row=>({commitment:row.snapshot,note:row.note})),hasMore:rows.length>100};
  });
}

import type { PoolClient } from 'pg';
import type { JobCommitmentListResult, JobListResult, JobOverview, JobStatus } from '@northstar/relay-domain';
import type { RelayPostgresStore } from './store.js';
import { assertJobScope, type JobScope } from './jobs.js';

export interface JobsQuery {
  view?: 'active' | 'completed' | 'all' | undefined; offset?: number | undefined;
  search?: string | undefined; branchId?: string | undefined; status?: JobStatus | undefined;
  filter?: 'all' | 'mine' | 'attention' | undefined; ownerId?: string | undefined;
}
export interface JobCommitmentsQuery {
  view?: 'open' | 'completed' | 'all' | undefined; filter?: 'all' | 'mine' | undefined;
  search?: string | undefined; branchId?: string | undefined; offset?: number | undefined;
}

async function queryContext(client: PoolClient, scope: JobScope, branchId?: string): Promise<{ asOf: string; branch: string | null }> {
  await assertJobScope(client, scope, branchId);
  const asOf: string = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  return { asOf, branch: branchId ?? (scope.role === 'organization_admin' ? null : scope.branchId) };
}

// Attention and ownership are calculated before filtering/pagination, from one database snapshot.
const visibleJobs = `WITH base AS (
  SELECT j.*,c.snapshot AS acknowledgement,
    COALESCE(m.open_count,0) AS open_count,COALESCE(m.overdue_count,0) AS overdue_count,
    m.next_due,COALESCE(m.owner_ids,ARRAY[]::text[]) AS owner_ids,
    c.status IN ('scheduled','active','breached') AND c.snapshot->>'ownerRecipientId' IS NULL AS ack_unowned,
    EXISTS(SELECT 1 FROM relay.attempts a WHERE a.tenant_id=j.tenant_id AND a.commitment_id=j.acknowledgement_id
      AND a.status IN ('failed','uncertain','exhausted')) AS delivery_problem
  FROM relay.jobs j LEFT JOIN relay.commitments c ON c.tenant_id=j.tenant_id AND c.commitment_id=j.acknowledgement_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER(WHERE m.status='open')::int AS open_count,
      COUNT(*) FILTER(WHERE m.status='open' AND m.due_at<$4::timestamptz)::int AS overdue_count,
      MIN(m.due_at) FILTER(WHERE m.status='open') AS next_due,
      ARRAY_AGG(DISTINCT m.snapshot->>'ownerId') FILTER(WHERE m.status='open') AS owner_ids
    FROM relay.job_milestones m WHERE m.tenant_id=j.tenant_id AND m.job_id=j.id
  ) m ON true WHERE j.tenant_id=$1 AND ($2::text IS NULL OR j.branch_id=$2)
), visible AS (
  SELECT base.*,
    snapshot->>'assigneeId'=$3 OR $3=ANY(owner_ids) AS mine,
    CASE WHEN status IN ('completed','cancelled') THEN ARRAY[]::text[] ELSE array_remove(ARRAY[
      CASE WHEN snapshot->>'assigneeId' IS NULL THEN 'unassigned' END,
      CASE WHEN status='scheduled' AND (snapshot->>'scheduledAt')::timestamptz<$4::timestamptz THEN 'missed_start' END,
      CASE WHEN ack_unowned THEN 'acknowledgement_unowned' END,
      CASE WHEN ack_unowned AND (acknowledgement->>'dueAt')::timestamptz<$4::timestamptz THEN 'acknowledgement_overdue' END,
      CASE WHEN ack_unowned AND delivery_problem THEN 'delivery_problem' END,
      CASE WHEN status='blocked' THEN 'blocked' END,
      CASE WHEN status='completion_reported' THEN 'completion_review' END,
      CASE WHEN overdue_count>0 THEN 'overdue_commitment' END
    ]::text[],NULL) END AS attention_reasons
  FROM base
)`;

export function listJobs(store: RelayPostgresStore, scope: JobScope, input: JobsQuery | 'active' | 'completed' | 'all' = {}, legacyOffset = 0): Promise<JobListResult> {
  const query: JobsQuery = typeof input === 'string' ? { view: input, offset: legacyOffset } : input;
  return store.tenantTx(scope.tenantId, async (client) => {
    const { asOf, branch } = await queryContext(client, scope, query.branchId);
    const offset = query.offset ?? 0;
    const row = (await client.query(`${visibleJobs}, filtered AS (
      SELECT * FROM visible WHERE ($5='all' OR ($5='active' AND status NOT IN ('completed','cancelled')) OR ($5='completed' AND status='completed'))
      AND ($6::text IS NULL OR status=$6) AND ($7='all' OR ($7='mine' AND mine) OR ($7='attention' AND cardinality(attention_reasons)>0))
      AND ($8::text IS NULL OR snapshot->>'assigneeId'=$8)
      AND strpos(lower(concat_ws(' ',snapshot->>'externalId',snapshot->>'customerReference')),lower($9))>0
    ), page AS (SELECT * FROM filtered ORDER BY updated_at DESC,id LIMIT 200 OFFSET $10)
    SELECT (SELECT COUNT(*)::int FROM filtered) AS total,COALESCE(jsonb_agg(snapshot || jsonb_build_object(
      'openMilestoneCount',open_count,'overdueMilestoneCount',overdue_count,'nextDueAt',next_due,
      'openMilestoneOwnerIds',owner_ids,'attentionReasons',attention_reasons) ORDER BY updated_at DESC,id),'[]'::jsonb) AS items FROM page`,
    [scope.tenantId, branch, scope.actorId, asOf, query.view ?? 'active', query.status ?? null, query.filter ?? 'all', query.ownerId ?? null, query.search ?? '', offset])).rows[0];
    const hasMore = offset + row.items.length < row.total;
    return { items: row.items, total: row.total, hasMore, nextOffset: hasMore ? offset + 200 : null, asOf };
  });
}

export function jobsOverview(store: RelayPostgresStore, scope: JobScope, branchId?: string): Promise<JobOverview> {
  return store.tenantTx(scope.tenantId, async (client) => {
    const { asOf, branch } = await queryContext(client, scope, branchId);
    const row = (await client.query(`${visibleJobs} SELECT COUNT(*)::int AS active,
      COUNT(*) FILTER(WHERE cardinality(attention_reasons)>0)::int AS attention,
      COUNT(*) FILTER(WHERE mine)::int AS mine,
      COUNT(*) FILTER(WHERE status='completion_reported')::int AS "completionReview"
      FROM visible WHERE status NOT IN ('completed','cancelled')`, [scope.tenantId, branch, scope.actorId, asOf])).rows[0];
    return { ...row, asOf } as JobOverview;
  });
}

export function listJobCommitments(store: RelayPostgresStore, scope: JobScope, query: JobCommitmentsQuery = {}): Promise<JobCommitmentListResult> {
  return store.tenantTx(scope.tenantId, async (client) => {
    const { asOf, branch } = await queryContext(client, scope, query.branchId);
    const offset = query.offset ?? 0;
    const row = (await client.query(`WITH filtered AS (
      SELECT m.snapshot AS milestone,m.due_at,m.id,j.version AS job_version,
        jsonb_build_object('id',j.id,'externalId',j.snapshot->>'externalId','customerReference',j.snapshot->>'customerReference',
          'branchId',j.branch_id,'status',j.status,'assigneeId',j.snapshot->>'assigneeId') AS job
      FROM relay.job_milestones m JOIN relay.jobs j ON j.tenant_id=m.tenant_id AND j.id=m.job_id
      WHERE j.tenant_id=$1 AND ($2::text IS NULL OR j.branch_id=$2)
      AND ($3='all' OR ($3='open' AND m.status='open' AND j.status NOT IN ('completed','cancelled')) OR ($3='completed' AND m.status='completed'))
      AND ($4='all' OR m.snapshot->>'ownerId'=$5)
      AND strpos(lower(concat_ws(' ',m.snapshot->>'title',j.snapshot->>'externalId',j.snapshot->>'customerReference')),lower($6))>0
    ), page AS (SELECT * FROM filtered ORDER BY due_at,id LIMIT 200 OFFSET $7)
    SELECT (SELECT COUNT(*)::int FROM filtered) AS total,COALESCE(jsonb_agg(jsonb_build_object('milestone',milestone,'job',job,'jobVersion',job_version) ORDER BY due_at,id),'[]'::jsonb) AS items FROM page`,
    [scope.tenantId, branch, query.view ?? 'open', query.filter ?? 'all', scope.actorId, query.search ?? '', offset])).rows[0];
    const hasMore = offset + row.items.length < row.total;
    return { items: row.items, total: row.total, hasMore, nextOffset: hasMore ? offset + 200 : null, asOf };
  });
}

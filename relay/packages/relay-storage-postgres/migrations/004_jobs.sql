-- Jobs describe work performed. A fulfilled acknowledgement never implies a completed job.
CREATE TABLE relay.jobs (
  tenant_id text NOT NULL, id text NOT NULL, branch_id text NOT NULL,
  acknowledgement_id text NOT NULL, status text NOT NULL CHECK(status IN ('requested','scheduled','in_progress','blocked','completion_reported','completed','cancelled')),
  version integer NOT NULL CHECK(version > 0), snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,acknowledgement_id),
  FOREIGN KEY(tenant_id,acknowledgement_id) REFERENCES relay.commitments(tenant_id,commitment_id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,branch_id) REFERENCES relay.branches(tenant_id,id)
);
CREATE INDEX relay_jobs_branch_status_idx ON relay.jobs(tenant_id,branch_id,status,updated_at DESC);
CREATE TABLE relay.job_milestones (
  tenant_id text NOT NULL, job_id text NOT NULL, id text NOT NULL,
  status text NOT NULL CHECK(status IN ('open','completed','cancelled')), due_at timestamptz NOT NULL, snapshot jsonb NOT NULL,
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,job_id) REFERENCES relay.jobs(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX relay_job_milestones_job_idx ON relay.job_milestones(tenant_id,job_id,status,due_at);
CREATE TABLE relay.job_events (
  tenant_id text NOT NULL, job_id text NOT NULL, id text NOT NULL, aggregate_version integer NOT NULL,
  envelope jsonb NOT NULL, occurred_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,job_id,aggregate_version),
  FOREIGN KEY(tenant_id,job_id) REFERENCES relay.jobs(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE relay.job_commands (
  tenant_id text NOT NULL, command_id text NOT NULL, job_id text NOT NULL,
  request_digest text NOT NULL, outcome jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,command_id), FOREIGN KEY(tenant_id,job_id) REFERENCES relay.jobs(tenant_id,id) ON DELETE CASCADE
);

-- Backfill under each tenant context: acknowledgement tables already enforce RLS.
DO $$ DECLARE tenant text; BEGIN
  FOR tenant IN SELECT id FROM relay.organizations LOOP
    PERFORM set_config('relay.tenant_id',tenant,true);
    INSERT INTO relay.jobs(tenant_id,id,branch_id,acknowledgement_id,status,version,snapshot,created_at,updated_at)
    SELECT c.tenant_id,c.commitment_id,c.branch_id,c.commitment_id,'requested',1,
      jsonb_build_object('id',c.commitment_id,'branchId',c.branch_id,'acknowledgementId',c.commitment_id,
        'externalId',c.external_id,'customerReference',c.snapshot->'workOrder'->>'customerReference',
        'priority',c.snapshot->'workOrder'->>'priority','description',c.note,'status','requested','version',1,
        'assigneeId',(SELECT r->>'personId' FROM jsonb_array_elements(c.snapshot->'recipients') r
          JOIN relay.memberships m ON m.tenant_id=c.tenant_id AND m.branch_id=c.branch_id AND m.person_id=r->>'personId'
          JOIN relay.people p ON p.id=m.person_id AND p.active
          WHERE r->>'recipientId'=c.snapshot->>'ownerRecipientId' LIMIT 1),
        'scheduledAt',NULL,'blocker',NULL,'completionNote',NULL,'completionReportedAt',NULL,'completionReportedBy',NULL,
        'completedAt',NULL,'completedBy',NULL,'createdAt',c.created_at,'updatedAt',clock_timestamp(),
        'openMilestoneCount',0,'overdueMilestoneCount',0,'nextDueAt',NULL),c.created_at,clock_timestamp()
    FROM relay.commitments c WHERE c.tenant_id=tenant;
    INSERT INTO relay.job_events(tenant_id,job_id,id,aggregate_version,envelope,occurred_at)
    SELECT tenant_id,id,'backfill:'||id,1,jsonb_build_object('id','backfill:'||id,'kind','job_created',
      'actorId','migration:004','occurredAt',updated_at,
      'note','Imported from acknowledgement history; work completion is not inferred.',
      'details',jsonb_build_object('acknowledgementId',acknowledgement_id,'backfilled',true)),updated_at
    FROM relay.jobs WHERE tenant_id=tenant;
  END LOOP;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['jobs','job_milestones','job_events','job_commands'] LOOP
    EXECUTE format('ALTER TABLE relay.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE relay.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON relay.%I USING (tenant_id = current_setting(''relay.tenant_id'',true)) WITH CHECK (tenant_id = current_setting(''relay.tenant_id'',true))',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON relay.%I TO relay_runtime',t);
  END LOOP;
END $$;
CREATE TRIGGER immutable_job_events BEFORE UPDATE OR DELETE ON relay.job_events FOR EACH ROW EXECUTE FUNCTION relay.reject_history_mutation();
CREATE TRIGGER immutable_job_commands BEFORE UPDATE OR DELETE ON relay.job_commands FOR EACH ROW EXECUTE FUNCTION relay.reject_history_mutation();
REVOKE UPDATE,DELETE ON relay.job_events,relay.job_commands FROM relay_runtime;

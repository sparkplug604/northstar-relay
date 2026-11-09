ALTER TABLE relay.attempts ADD COLUMN acknowledgement_expires_at timestamptz;
ALTER TABLE relay.contacts ADD COLUMN verification_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE relay.contacts ADD COLUMN verification_requested_at timestamptz;

CREATE TABLE relay.source_connections (
  tenant_id text NOT NULL, branch_id text NOT NULL, id text NOT NULL,
  name text NOT NULL, token_hash text NOT NULL UNIQUE, active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,branch_id) REFERENCES relay.branches(tenant_id,id)
);
CREATE TABLE relay.intake (
  tenant_id text NOT NULL, branch_id text NOT NULL, id text NOT NULL,
  connection_id text NOT NULL, receipt_id text NOT NULL, content_hash text NOT NULL,
  candidate jsonb NOT NULL, status text NOT NULL CHECK(status IN ('parsed','needs_review','promoted','rejected')),
  raw_encrypted text NOT NULL, commitment_id text, review_reason text,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,connection_id,receipt_id),
  FOREIGN KEY(tenant_id,branch_id) REFERENCES relay.branches(tenant_id,id)
);
CREATE INDEX relay_intake_review_idx ON relay.intake(tenant_id,status,received_at);

CREATE TABLE relay.deletion_tombstones (
  tenant_id text PRIMARY KEY, cancelled_at timestamptz NOT NULL,
  backup_delete_by timestamptz NOT NULL,
  active_purge_completed_at timestamptz,
  CHECK(backup_delete_by <= cancelled_at + interval '30 days')
);
REVOKE ALL ON relay.deletion_tombstones FROM PUBLIC;
GRANT SELECT ON relay.deletion_tombstones TO relay_runtime;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['source_connections','intake'] LOOP
    EXECUTE format('ALTER TABLE relay.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE relay.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON relay.%I USING (tenant_id = current_setting(''relay.tenant_id'',true)) WITH CHECK (tenant_id = current_setting(''relay.tenant_id'',true))',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON relay.%I TO relay_runtime',t);
  END LOOP;
END $$;

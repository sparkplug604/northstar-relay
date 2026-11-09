ALTER TABLE relay.settings ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
CREATE TABLE relay.on_call_overrides (
  tenant_id text NOT NULL, branch_id text NOT NULL, id text NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, recipient_ids jsonb NOT NULL,
  reason text NOT NULL, PRIMARY KEY(tenant_id,id),
  CHECK(ends_at>starts_at), FOREIGN KEY(tenant_id,branch_id) REFERENCES relay.branches(tenant_id,id)
);
CREATE INDEX relay_overrides_window_idx ON relay.on_call_overrides(tenant_id,branch_id,starts_at,ends_at);
CREATE TABLE relay.weekly_on_call_rules (
  tenant_id text NOT NULL, branch_id text NOT NULL, id text NOT NULL,
  weekday integer NOT NULL CHECK(weekday BETWEEN 0 AND 6),
  start_time text NOT NULL, end_time text NOT NULL, recipient_ids jsonb NOT NULL,
  PRIMARY KEY(tenant_id,id), CHECK(start_time<end_time),
  FOREIGN KEY(tenant_id,branch_id) REFERENCES relay.branches(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['on_call_overrides','weekly_on_call_rules'] LOOP
    EXECUTE format('ALTER TABLE relay.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE relay.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON relay.%I USING (tenant_id = current_setting(''relay.tenant_id'',true)) WITH CHECK (tenant_id = current_setting(''relay.tenant_id'',true))',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON relay.%I TO relay_runtime',t);
  END LOOP;
END $$;

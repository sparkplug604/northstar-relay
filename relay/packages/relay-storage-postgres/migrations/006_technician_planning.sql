CREATE TABLE relay.technician_planning (
  tenant_id text NOT NULL,
  person_id text NOT NULL,
  branch_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  profile jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,person_id),
  FOREIGN KEY (tenant_id,person_id) REFERENCES relay.memberships(tenant_id,person_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,branch_id) REFERENCES relay.branches(tenant_id,id)
);
CREATE TABLE relay.planning_commands (
  tenant_id text NOT NULL REFERENCES relay.organizations(id),
  command_id text NOT NULL,
  request_digest text NOT NULL,
  outcome jsonb NOT NULL,
  PRIMARY KEY (tenant_id,command_id)
);
ALTER TABLE relay.technician_planning ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.technician_planning FORCE ROW LEVEL SECURITY;
CREATE POLICY technician_planning_tenant ON relay.technician_planning
  USING (tenant_id=current_setting('relay.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('relay.tenant_id',true));
ALTER TABLE relay.planning_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.planning_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY planning_commands_tenant ON relay.planning_commands
  USING (tenant_id=current_setting('relay.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('relay.tenant_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON relay.technician_planning TO relay_runtime;
GRANT SELECT,INSERT ON relay.planning_commands TO relay_runtime;
CREATE TRIGGER immutable_planning_commands BEFORE UPDATE OR DELETE ON relay.planning_commands
  FOR EACH ROW EXECUTE FUNCTION relay.reject_history_mutation();

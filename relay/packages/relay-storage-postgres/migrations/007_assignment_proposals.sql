CREATE TABLE relay.assignment_proposals (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  proposal jsonb,
  PRIMARY KEY (tenant_id,job_id),
  FOREIGN KEY (tenant_id,job_id) REFERENCES relay.jobs(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE relay.assignment_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.assignment_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_proposal_tenant ON relay.assignment_proposals
  USING (tenant_id=current_setting('relay.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('relay.tenant_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON relay.assignment_proposals TO relay_runtime;

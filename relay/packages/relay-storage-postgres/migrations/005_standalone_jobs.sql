-- A work record need not start an acknowledgement/contact campaign.
ALTER TABLE relay.jobs ALTER COLUMN acknowledgement_id DROP NOT NULL;
CREATE INDEX relay_jobs_search_scope_idx ON relay.jobs(tenant_id,branch_id,updated_at DESC,id);

CREATE SCHEMA IF NOT EXISTS relay;

CREATE TABLE relay.organizations (
  id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE relay.branches (
  tenant_id text NOT NULL REFERENCES relay.organizations(id), id text NOT NULL,
  name text NOT NULL, timezone text NOT NULL, PRIMARY KEY (tenant_id,id)
);
CREATE TABLE relay.people (
  id text PRIMARY KEY, email text NOT NULL UNIQUE, display_name text NOT NULL,
  password_hash text NOT NULL, active boolean NOT NULL DEFAULT true,
  totp_secret text, totp_confirmed boolean NOT NULL DEFAULT false,
  last_totp_counter bigint, recovery_hashes jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE relay.memberships (
  tenant_id text NOT NULL REFERENCES relay.organizations(id), person_id text NOT NULL REFERENCES relay.people(id),
  branch_id text NOT NULL, role text NOT NULL CHECK (role IN ('organization_admin','branch_dispatcher','on_call_responder')),
  PRIMARY KEY(tenant_id,person_id), FOREIGN KEY(tenant_id,branch_id) REFERENCES relay.branches(tenant_id,id)
);
CREATE TABLE relay.sessions (
  token_hash text PRIMARY KEY, person_id text NOT NULL REFERENCES relay.people(id),
  csrf_token text NOT NULL, mfa_verified boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relay_sessions_person_idx ON relay.sessions(person_id);
CREATE TABLE relay.auth_limits (
  key text PRIMARY KEY, attempts integer NOT NULL DEFAULT 0, window_start timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE relay.contacts (
  tenant_id text NOT NULL, person_id text NOT NULL, phone text, phone_verified_at timestamptz,
  verification_token_hash text, verification_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,person_id),
  FOREIGN KEY(tenant_id,person_id) REFERENCES relay.memberships(tenant_id,person_id)
);
CREATE TABLE relay.settings (
  tenant_id text NOT NULL, branch_id text NOT NULL,
  recipient_ids jsonb NOT NULL DEFAULT '[]', interval_seconds integer NOT NULL DEFAULT 120 CHECK(interval_seconds BETWEEN 15 AND 3600),
  channels jsonb NOT NULL DEFAULT '["voice"]', PRIMARY KEY(tenant_id,branch_id),
  FOREIGN KEY(tenant_id,branch_id) REFERENCES relay.branches(tenant_id,id)
);
CREATE TABLE relay.commitments (
  tenant_id text NOT NULL, branch_id text NOT NULL, commitment_id text NOT NULL, work_order_id text NOT NULL,
  external_id text NOT NULL, source_kind text NOT NULL, source_message_id text NOT NULL,
  status text NOT NULL, version integer NOT NULL CHECK(version > 0), snapshot jsonb NOT NULL,
  note text NOT NULL DEFAULT '', next_action_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,commitment_id), UNIQUE(tenant_id,branch_id,source_kind,external_id),
  FOREIGN KEY(tenant_id,branch_id) REFERENCES relay.branches(tenant_id,id)
);
CREATE INDEX relay_commitments_due_idx ON relay.commitments(next_action_at) WHERE next_action_at IS NOT NULL;
CREATE TABLE relay.commands (
  tenant_id text NOT NULL, command_id text NOT NULL, commitment_id text NOT NULL,
  request_digest text NOT NULL, outcome jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,command_id)
);
CREATE TABLE relay.events (
  tenant_id text NOT NULL, event_id text NOT NULL, commitment_id text NOT NULL,
  command_id text NOT NULL, aggregate_version integer NOT NULL, event_type text NOT NULL,
  occurred_at timestamptz NOT NULL, envelope jsonb NOT NULL,
  PRIMARY KEY(tenant_id,event_id), UNIQUE(tenant_id,commitment_id,aggregate_version),
  FOREIGN KEY(tenant_id,commitment_id) REFERENCES relay.commitments(tenant_id,commitment_id)
);
CREATE TABLE relay.attempts (
  tenant_id text NOT NULL, branch_id text NOT NULL, attempt_id text NOT NULL,
  commitment_id text NOT NULL, step_index integer NOT NULL, recipient_id text NOT NULL, person_id text NOT NULL,
  channel text NOT NULL CHECK(channel IN ('sms','voice')), phone text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','sending','submitted','delivered','answered','acknowledged','failed','uncertain','cancelled','exhausted')),
  available_at timestamptz NOT NULL, lease_expires_at timestamptz, lease_token text,
  attempts integer NOT NULL DEFAULT 0, provider_reference text, last_error text,
  acknowledgement_token_hash text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,attempt_id), UNIQUE(tenant_id,commitment_id,step_index,recipient_id,channel),
  FOREIGN KEY(tenant_id,commitment_id) REFERENCES relay.commitments(tenant_id,commitment_id)
);
CREATE INDEX relay_attempts_due_idx ON relay.attempts(available_at) WHERE status IN ('pending','failed','leased');
CREATE UNIQUE INDEX relay_attempts_provider_idx ON relay.attempts(provider_reference) WHERE provider_reference IS NOT NULL;
CREATE UNIQUE INDEX relay_attempts_ack_idx ON relay.attempts(acknowledgement_token_hash) WHERE acknowledgement_token_hash IS NOT NULL;
CREATE TABLE relay.provider_events (
  provider text NOT NULL, event_id text NOT NULL, payload_digest text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,event_id)
);
CREATE TABLE relay.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id text NOT NULL,
  actor_id text NOT NULL, action text NOT NULL, details jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now()
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['contacts','settings','commitments','commands','events','attempts','audit'] LOOP
    EXECUTE format('ALTER TABLE relay.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE relay.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON relay.%I USING (tenant_id = current_setting(''relay.tenant_id'',true)) WITH CHECK (tenant_id = current_setting(''relay.tenant_id'',true))',t);
  END LOOP;
END $$;

CREATE FUNCTION relay.reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Relay history is append-only'; END $$;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON relay.events FOR EACH ROW EXECUTE FUNCTION relay.reject_history_mutation();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON relay.audit FOR EACH ROW EXECUTE FUNCTION relay.reject_history_mutation();

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='relay_runtime') THEN CREATE ROLE relay_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA relay TO relay_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA relay TO relay_runtime;
REVOKE UPDATE,DELETE ON relay.events,relay.audit,relay.commands FROM relay_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA relay TO relay_runtime;

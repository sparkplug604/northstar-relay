import { runMigrations } from "@agent-native/core/db";

export default runMigrations([{
  version: 1,
  name: "relay-recovery-draft",
  sql: `CREATE TABLE IF NOT EXISTS relay_recovery_drafts (
    id text PRIMARY KEY, revision integer NOT NULL, fields jsonb NOT NULL
  );
  INSERT INTO relay_recovery_drafts (id, revision, fields)
    VALUES ('pine-recovery', 0, '{"pins":[],"proposal":null}') ON CONFLICT DO NOTHING;`,
}, {
 version:2,name:'relay-blocker-drafts',
 sql:`CREATE TABLE IF NOT EXISTS relay_blocker_drafts (job_id text PRIMARY KEY, revision integer NOT NULL, proposal jsonb NOT NULL);`,
}], { table: "relay_recovery_migrations" });

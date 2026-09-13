ALTER TABLE automation_rule_versions
  ADD COLUMN IF NOT EXISTS source_graph jsonb,
  ADD COLUMN IF NOT EXISTS compiled_definition jsonb,
  ADD COLUMN IF NOT EXISTS compiler_version integer,
  ADD COLUMN IF NOT EXISTS definition_checksum text;

ALTER TABLE automation_rule_versions
  DROP CONSTRAINT IF EXISTS automation_rule_versions_compiler_version_check;
ALTER TABLE automation_rule_versions
  ADD CONSTRAINT automation_rule_versions_compiler_version_check
  CHECK(compiler_version IS NULL OR compiler_version BETWEEN 1 AND 1000);

CREATE INDEX IF NOT EXISTS automation_rule_versions_checksum_idx
  ON automation_rule_versions(organization_id,definition_checksum)
  WHERE definition_checksum IS NOT NULL;

ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS version_id uuid
    REFERENCES automation_rule_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS current_node_id text,
  ADD COLUMN IF NOT EXISTS limits_snapshot jsonb NOT NULL DEFAULT '{}';

UPDATE automation_runs run
SET version_id=version_row.id
FROM automation_rule_versions version_row
WHERE run.version_id IS NULL
  AND version_row.rule_id=run.rule_id
  AND version_row.version=run.version;

CREATE INDEX IF NOT EXISTS automation_runs_version_idx
  ON automation_runs(organization_id,version_id,started_at DESC);

ALTER TABLE automation_run_steps
  ADD COLUMN IF NOT EXISTS node_id text,
  ADD COLUMN IF NOT EXISTS node_version integer,
  ADD COLUMN IF NOT EXISTS selected_port text,
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS input_summary jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS output_summary jsonb NOT NULL DEFAULT '{}';

ALTER TABLE automation_run_steps
  DROP CONSTRAINT IF EXISTS automation_run_steps_attempt_check;
ALTER TABLE automation_run_steps
  ADD CONSTRAINT automation_run_steps_attempt_check
  CHECK(attempt BETWEEN 1 AND 100);

CREATE INDEX IF NOT EXISTS automation_run_steps_node_idx
  ON automation_run_steps(organization_id,run_id,node_id,created_at);

CREATE TABLE IF NOT EXISTS automation_continuations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL
    REFERENCES automation_runs(id) ON DELETE CASCADE,
  version_id uuid NOT NULL
    REFERENCES automation_rule_versions(id) ON DELETE RESTRICT,
  node_id text NOT NULL,
  node_version integer NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  continuation_type text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK(status IN('scheduled','resumed','cancelled','expired','failed')),
  resume_at timestamptz,
  cancellation_key_hash text,
  queue_job_id text,
  selected_port text,
  payload jsonb NOT NULL DEFAULT '{}',
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(run_id,node_id,generation)
);

CREATE INDEX IF NOT EXISTS automation_continuations_schedule_idx
  ON automation_continuations(status,resume_at,created_at)
  WHERE status='scheduled';

CREATE INDEX IF NOT EXISTS automation_continuations_cancel_idx
  ON automation_continuations(
    organization_id,cancellation_key_hash,status,created_at
  )
  WHERE cancellation_key_hash IS NOT NULL AND status='scheduled';

CREATE TABLE IF NOT EXISTS automation_side_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL
    REFERENCES automation_runs(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  node_version integer NOT NULL,
  effect_type text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'reserved'
    CHECK(status IN('reserved','completed','failed','blocked')),
  output jsonb NOT NULL DEFAULT '{}',
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(organization_id,idempotency_key)
);

CREATE INDEX IF NOT EXISTS automation_side_effects_run_idx
  ON automation_side_effects(organization_id,run_id,node_id,created_at);

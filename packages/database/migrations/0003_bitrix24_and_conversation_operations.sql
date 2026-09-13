ALTER TYPE conversation_status ADD VALUE IF NOT EXISTS 'snoozed';

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS muted_until timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS operation_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  public_id uuid NOT NULL DEFAULT gen_random_uuid(), provider text NOT NULL, name text NOT NULL, auth_mode text NOT NULL,
  portal_url text, member_id text, credentials_encrypted text, webhook_token_hash text, status text NOT NULL DEFAULT 'connected',
  settings jsonb NOT NULL DEFAULT '{}', last_health_at timestamptz, last_sync_at timestamptz, last_error_code text,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(public_id), UNIQUE(organization_id, provider, portal_url)
);
CREATE INDEX IF NOT EXISTS integration_connections_org_idx ON integration_connections(organization_id,status);

CREATE TABLE IF NOT EXISTS crm_entity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE, entity_type text NOT NULL, external_id text NOT NULL,
  match_source text NOT NULL DEFAULT 'manual', match_confidence numeric(4,3), unavailable_at timestamptz,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,entity_type,external_id), UNIQUE(connection_id,conversation_id,entity_type)
);
CREATE INDEX IF NOT EXISTS crm_entity_links_conversation_idx ON crm_entity_links(organization_id,conversation_id);

CREATE TABLE IF NOT EXISTS crm_user_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, local_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  external_user_id text NOT NULL, external_snapshot jsonb NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,external_user_id), UNIQUE(connection_id,local_user_id)
);
CREATE TABLE IF NOT EXISTS crm_field_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, entity_type text NOT NULL,
  local_field text NOT NULL, external_field text NOT NULL, direction text NOT NULL DEFAULT 'outbound', transform jsonb NOT NULL DEFAULT '{}', enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(connection_id,entity_type,local_field,direction)
);

CREATE TABLE IF NOT EXISTS crm_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, job_type text NOT NULL, aggregate_type text NOT NULL,
  aggregate_id text NOT NULL, idempotency_key text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz, locked_by text, last_error_code text, last_error_message text, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(connection_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS crm_sync_jobs_claim_idx ON crm_sync_jobs(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS crm_sync_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, job_id uuid REFERENCES crm_sync_jobs(id) ON DELETE SET NULL,
  level text NOT NULL, operation text NOT NULL, message text NOT NULL, details jsonb NOT NULL DEFAULT '{}', duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_sync_logs_feed_idx ON crm_sync_logs(organization_id,connection_id,created_at DESC);
CREATE TABLE IF NOT EXISTS crm_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, provider_event_key text NOT NULL,
  event_type text NOT NULL, auth jsonb NOT NULL DEFAULT '{}', payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0, last_error text, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  UNIQUE(connection_id,provider_event_key)
);
CREATE INDEX IF NOT EXISTS crm_webhook_events_claim_idx ON crm_webhook_events(status,received_at);
CREATE TABLE IF NOT EXISTS conversation_crm_context_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  link_id uuid REFERENCES crm_entity_links(id) ON DELETE SET NULL, context jsonb NOT NULL DEFAULT '{}', fetched_at timestamptz NOT NULL DEFAULT now(),
  stale_at timestamptz NOT NULL, last_error_code text, last_error_at timestamptz, UNIQUE(organization_id,conversation_id)
);
CREATE TABLE IF NOT EXISTS crm_pipeline_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, entity_type text NOT NULL,
  pipeline_external_id text NOT NULL, pipeline_name text NOT NULL, stage_external_id text NOT NULL, stage_name text NOT NULL,
  stage_order integer NOT NULL DEFAULT 0, semantics text, fetched_at timestamptz NOT NULL DEFAULT now(), stale_at timestamptz NOT NULL,
  UNIQUE(connection_id,entity_type,pipeline_external_id,stage_external_id)
);

CREATE TABLE IF NOT EXISTS assignment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL, priority integer NOT NULL DEFAULT 100, active boolean NOT NULL DEFAULT true, strategy text NOT NULL DEFAULT 'round_robin', config jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,name)
);
CREATE TABLE IF NOT EXISTS assignment_rule_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rule_id uuid NOT NULL REFERENCES assignment_rules(id) ON DELETE CASCADE,
  position integer NOT NULL, field text NOT NULL, operator text NOT NULL, value jsonb NOT NULL, UNIQUE(rule_id,position)
);
CREATE TABLE IF NOT EXISTS assignment_rule_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rule_id uuid NOT NULL REFERENCES assignment_rules(id) ON DELETE CASCADE,
  position integer NOT NULL, action text NOT NULL, value jsonb NOT NULL, UNIQUE(rule_id,position)
);
CREATE TABLE IF NOT EXISTS agent_capacity_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, capacity integer NOT NULL DEFAULT 20 CHECK(capacity >= 0), active_count integer NOT NULL DEFAULT 0 CHECK(active_count >= 0),
  availability text NOT NULL DEFAULT 'available', last_assigned_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,user_id)
);
CREATE TABLE IF NOT EXISTS conversation_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id uuid REFERENCES users(id), team_id uuid REFERENCES teams(id),
  origin text NOT NULL DEFAULT 'manual', version integer NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true, assigned_by uuid REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(), unassigned_by uuid REFERENCES users(id), unassigned_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_assignments_active_uq ON conversation_assignments(conversation_id) WHERE active;
CREATE TABLE IF NOT EXISTS assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, from_user_id uuid REFERENCES users(id), to_user_id uuid REFERENCES users(id),
  from_team_id uuid REFERENCES teams(id), to_team_id uuid REFERENCES teams(id), rule_id uuid REFERENCES assignment_rules(id) ON DELETE SET NULL,
  reason text NOT NULL, origin text NOT NULL, version integer NOT NULL, actor_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assignment_history_conversation_idx ON assignment_history(organization_id,conversation_id,created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL, color text NOT NULL, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,name)
);
CREATE TABLE IF NOT EXISTS conversation_label_assignments (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES conversation_labels(id) ON DELETE CASCADE, assigned_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(conversation_id,label_id)
);
CREATE INDEX IF NOT EXISTS conversation_label_filter_idx ON conversation_label_assignments(organization_id,label_id,conversation_id);
CREATE TABLE IF NOT EXISTS conversation_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, author_id uuid NOT NULL REFERENCES users(id), parent_note_id uuid REFERENCES conversation_notes(id) ON DELETE CASCADE,
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 10000), edited_at timestamptz, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_notes_thread_idx ON conversation_notes(organization_id,conversation_id,created_at);
CREATE TABLE IF NOT EXISTS conversation_note_mentions (
  note_id uuid NOT NULL REFERENCES conversation_notes(id) ON DELETE CASCADE, organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(note_id,user_id)
);
CREATE TABLE IF NOT EXISTS saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, name text NOT NULL, visibility text NOT NULL DEFAULT 'personal', filters jsonb NOT NULL DEFAULT '{}',
  sort jsonb NOT NULL DEFAULT '{}', position integer NOT NULL DEFAULT 0, is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,owner_user_id,name)
);
CREATE TABLE IF NOT EXISTS conversation_operation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, operation text NOT NULL, from_value jsonb NOT NULL DEFAULT '{}', to_value jsonb NOT NULL DEFAULT '{}',
  actor_id uuid REFERENCES users(id), origin text NOT NULL DEFAULT 'local', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_operation_history_idx ON conversation_operation_history(organization_id,conversation_id,created_at DESC);

CREATE INDEX IF NOT EXISTS conversations_ops_filter_idx ON conversations(organization_id,status,priority,last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_snooze_idx ON conversations(snoozed_until) WHERE snoozed_until IS NOT NULL;

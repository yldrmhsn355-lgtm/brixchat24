CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS bitrix_mode text NOT NULL DEFAULT 'crm_context';
ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS open_channels_status text NOT NULL DEFAULT 'disabled';
ALTER TABLE saved_views ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id) ON DELETE CASCADE;
ALTER TABLE saved_views ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'personal';

CREATE TABLE IF NOT EXISTS message_attachments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE, channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
 provider text NOT NULL, provider_media_id text, provider_mime_type text, provider_filename text, provider_file_size bigint, provider_sha256 text,
 attachment_type text NOT NULL DEFAULT 'unknown' CHECK(attachment_type IN('image','video','audio','voice','document','sticker','unknown')),
 storage_provider text, storage_bucket text, storage_key text, stored_mime_type text, stored_filename text, stored_size bigint, stored_sha256 text,
 processing_status text NOT NULL DEFAULT 'pending' CHECK(processing_status IN('pending','downloading','stored','failed','expired','deleted')),
 scan_status text NOT NULL DEFAULT 'not_scanned' CHECK(scan_status IN('not_scanned','pending','clean','infected','failed')),
 download_attempt_count integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error_code text, last_error_message text,
 provider_url_expires_at timestamptz, stored_at timestamptz, expires_at timestamptz, deleted_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS message_attachments_provider_uq ON message_attachments(channel_id,provider_media_id) WHERE provider_media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_attachments_message_idx ON message_attachments(organization_id,message_id);
CREATE INDEX IF NOT EXISTS message_attachments_filename_trgm_idx ON message_attachments USING gin(provider_filename gin_trgm_ops);

CREATE TABLE IF NOT EXISTS media_processing_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 attachment_id uuid NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE, job_type text NOT NULL, status text NOT NULL DEFAULT 'pending',
 attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 locked_at timestamptz, locked_by text, last_error text, trace_id uuid NOT NULL DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE(attachment_id,job_type)
);
CREATE INDEX IF NOT EXISTS media_processing_jobs_claim_idx ON media_processing_jobs(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS media_download_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 attachment_id uuid NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE, actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
 action text NOT NULL, ip_address text, user_agent text, outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contacts_display_name_trgm_idx ON contacts USING gin(display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS contacts_phone_trgm_idx ON contacts USING gin(normalized_phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS messages_body_search_idx ON messages USING gin(to_tsvector('simple',coalesce(body,'')));
CREATE INDEX IF NOT EXISTS messages_body_trgm_idx ON messages USING gin(body gin_trgm_ops);
CREATE INDEX IF NOT EXISTS conversation_notes_body_search_idx ON conversation_notes USING gin(to_tsvector('simple',coalesce(body,'')));

CREATE TABLE IF NOT EXISTS automation_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, name text NOT NULL, description text,
 status text NOT NULL DEFAULT 'draft', priority integer NOT NULL DEFAULT 100, stop_processing boolean NOT NULL DEFAULT false,
 execution_mode text NOT NULL DEFAULT 'first_match', created_by uuid REFERENCES users(id), updated_by uuid REFERENCES users(id),
 published_version integer, draft_version integer NOT NULL DEFAULT 1, last_run_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,name)
);
CREATE TABLE IF NOT EXISTS automation_rule_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 rule_id uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE, version integer NOT NULL, status text NOT NULL DEFAULT 'draft',
 permission_snapshot jsonb NOT NULL DEFAULT '{}', created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, UNIQUE(rule_id,version)
);
CREATE TABLE IF NOT EXISTS automation_rule_triggers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),version_id uuid NOT NULL REFERENCES automation_rule_versions(id) ON DELETE CASCADE,trigger_type text NOT NULL,config jsonb NOT NULL DEFAULT '{}',UNIQUE(version_id,trigger_type));
CREATE TABLE IF NOT EXISTS automation_rule_conditions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),version_id uuid NOT NULL REFERENCES automation_rule_versions(id) ON DELETE CASCADE,position integer NOT NULL,field text NOT NULL,operator text NOT NULL,value jsonb NOT NULL DEFAULT '{}',UNIQUE(version_id,position));
CREATE TABLE IF NOT EXISTS automation_rule_actions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),version_id uuid NOT NULL REFERENCES automation_rule_versions(id) ON DELETE CASCADE,position integer NOT NULL,action_type text NOT NULL,config jsonb NOT NULL DEFAULT '{}',UNIQUE(version_id,position));
CREATE TABLE IF NOT EXISTS automation_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,event_type text NOT NULL,
 aggregate_type text NOT NULL,aggregate_id uuid,conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,correlation_id uuid NOT NULL,
 origin text NOT NULL,depth integer NOT NULL DEFAULT 0,payload jsonb NOT NULL DEFAULT '{}',status text NOT NULL DEFAULT 'pending',next_attempt_at timestamptz NOT NULL DEFAULT now(),
 locked_at timestamptz,locked_by text,created_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,UNIQUE(organization_id,event_type,correlation_id,origin)
);
CREATE INDEX IF NOT EXISTS automation_events_claim_idx ON automation_events(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS automation_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,rule_id uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
 version integer NOT NULL,event_id uuid NOT NULL REFERENCES automation_events(id) ON DELETE CASCADE,conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
 correlation_id uuid NOT NULL,status text NOT NULL DEFAULT 'running',dry_run boolean NOT NULL DEFAULT false,action_count integer NOT NULL DEFAULT 0,error_code text,
 started_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,UNIQUE(rule_id,event_id)
);
CREATE TABLE IF NOT EXISTS automation_run_steps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,run_id uuid NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,position integer NOT NULL,step_type text NOT NULL,status text NOT NULL,input jsonb NOT NULL DEFAULT '{}',output jsonb NOT NULL DEFAULT '{}',error_code text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,UNIQUE(run_id,position));
CREATE TABLE IF NOT EXISTS automation_rate_limits (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,rule_id uuid REFERENCES automation_rules(id) ON DELETE CASCADE,conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,window_key text NOT NULL,count integer NOT NULL DEFAULT 0,resets_at timestamptz NOT NULL,UNIQUE(organization_id,rule_id,conversation_id,window_key));
CREATE TABLE IF NOT EXISTS automation_webhook_deliveries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,run_id uuid NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,url_host text NOT NULL,status text NOT NULL DEFAULT 'pending',attempt_count integer NOT NULL DEFAULT 0,response_status integer,last_error text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);

CREATE TABLE IF NOT EXISTS bitrix_open_channel_connectors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,integration_connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
 connector_id text NOT NULL,line_id text,status text NOT NULL DEFAULT 'registered',settings jsonb NOT NULL DEFAULT '{}',last_event_at timestamptz,last_success_at timestamptz,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(integration_connection_id)
);
CREATE TABLE IF NOT EXISTS bitrix_open_channel_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,integration_connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
 conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,connector_id text NOT NULL,line_id text,external_chat_id text NOT NULL,external_session_id text NOT NULL,
 external_user_code text,status text NOT NULL DEFAULT 'open',operator_external_id text,opened_at timestamptz NOT NULL DEFAULT now(),closed_at timestamptz,last_synced_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(integration_connection_id,conversation_id)
);
CREATE TABLE IF NOT EXISTS bitrix_open_channel_message_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 local_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,external_chat_id text NOT NULL,external_message_id text NOT NULL,direction text NOT NULL,source_marker text NOT NULL,
 status text NOT NULL DEFAULT 'synced',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,source_marker),UNIQUE(local_message_id,direction)
);
CREATE TABLE IF NOT EXISTS bitrix_open_channel_operator_mappings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,integration_connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,local_user_id uuid REFERENCES users(id) ON DELETE SET NULL,external_operator_id text NOT NULL,external_snapshot jsonb NOT NULL DEFAULT '{}',active boolean NOT NULL DEFAULT true,UNIQUE(integration_connection_id,external_operator_id));
CREATE TABLE IF NOT EXISTS bitrix_open_channel_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,integration_connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,provider_event_key text NOT NULL,event_type text NOT NULL,payload jsonb NOT NULL DEFAULT '{}',status text NOT NULL DEFAULT 'pending',attempt_count integer NOT NULL DEFAULT 0,last_error text,received_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,UNIQUE(integration_connection_id,provider_event_key));
CREATE TABLE IF NOT EXISTS bitrix_open_channel_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,integration_connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
 conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,local_message_id uuid REFERENCES messages(id) ON DELETE CASCADE,job_type text NOT NULL,idempotency_key text NOT NULL,payload jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'pending',attempt_count integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 5,next_attempt_at timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,locked_by text,
 last_error text,completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(integration_connection_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS bitrix_open_channel_jobs_claim_idx ON bitrix_open_channel_jobs(status,next_attempt_at);

CREATE TABLE IF NOT EXISTS organization_retention_settings (organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,message_retention_days integer NOT NULL DEFAULT 365,media_retention_days integer NOT NULL DEFAULT 180,raw_webhook_retention_days integer NOT NULL DEFAULT 30,audit_retention_days integer NOT NULL DEFAULT 365,sync_log_retention_days integer NOT NULL DEFAULT 90,deleted_user_anonymization boolean NOT NULL DEFAULT true,legal_hold boolean NOT NULL DEFAULT false,automatic_purge_enabled boolean NOT NULL DEFAULT false,updated_by uuid REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS retention_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,job_type text NOT NULL,dry_run boolean NOT NULL DEFAULT false,status text NOT NULL DEFAULT 'pending',eligible_count integer NOT NULL DEFAULT 0,deleted_count integer NOT NULL DEFAULT 0,attempt_count integer NOT NULL DEFAULT 0,last_error text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);
CREATE TABLE IF NOT EXISTS operational_metrics (metric_name text NOT NULL,label_key text NOT NULL DEFAULT '',metric_value numeric NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(metric_name,label_key));

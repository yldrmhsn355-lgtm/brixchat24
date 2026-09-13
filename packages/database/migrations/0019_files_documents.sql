CREATE TABLE IF NOT EXISTS storage_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  display_name text NOT NULL,
  account_email text,
  encrypted_credentials text,
  root_folder_id text,
  shared_drive_id text,
  granted_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('pending','connected','degraded','error','disconnected')),
  last_health_check_at timestamptz,
  last_synced_at timestamptz,
  token_expires_at timestamptz,
  last_error_code text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz
);
CREATE INDEX IF NOT EXISTS storage_connections_org_status_idx ON storage_connections(organization_id,status,provider);

CREATE TABLE IF NOT EXISTS storage_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  state_hash text NOT NULL UNIQUE,
  connection_id uuid REFERENCES storage_connections(id) ON DELETE CASCADE,
  redirect_path text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS storage_oauth_states_expiry_idx ON storage_oauth_states(provider,expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS file_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_connection_id uuid REFERENCES storage_connections(id) ON DELETE SET NULL,
  provider_file_id text,
  provider_folder_id text,
  internal_storage_key text,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  treatment_plan_id uuid,
  whatsapp_message_id text,
  provider_media_id text,
  original_name text NOT NULL,
  sanitized_name text NOT NULL,
  mime_type text NOT NULL,
  extension text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 text,
  category text NOT NULL DEFAULT 'other',
  direction text NOT NULL DEFAULT 'internal' CHECK (direction IN ('inbound','outbound','internal')),
  source text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DOWNLOADING','VALIDATING','SCANNING','CLASSIFYING','UPLOADING','READY','FAILED','RETRYING','QUARANTINED','ARCHIVED','DELETED')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','team','organization','sensitive')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS file_assets_whatsapp_media_uq ON file_assets(organization_id,whatsapp_message_id,provider_media_id) WHERE whatsapp_message_id IS NOT NULL AND provider_media_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS file_assets_provider_file_uq ON file_assets(organization_id,provider_connection_id,provider_file_id) WHERE provider_connection_id IS NOT NULL AND provider_file_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS file_assets_org_status_created_idx ON file_assets(organization_id,status,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS file_assets_org_contact_category_idx ON file_assets(organization_id,contact_id,category,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS file_assets_org_conversation_idx ON file_assets(organization_id,conversation_id,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS file_assets_org_checksum_idx ON file_assets(organization_id,contact_id,checksum_sha256) WHERE checksum_sha256 IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS contact_storage_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  provider_connection_id uuid NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  provider_folder_id text NOT NULL,
  folder_name text NOT NULL,
  category_folders jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_status text NOT NULL DEFAULT 'ready',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,contact_id,provider_connection_id)
);
CREATE INDEX IF NOT EXISTS contact_storage_folders_provider_idx ON contact_storage_folders(organization_id,provider_connection_id,provider_folder_id);

CREATE TABLE IF NOT EXISTS file_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_asset_id uuid NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  provider_file_id text,
  checksum_sha256 text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  status text NOT NULL DEFAULT 'READY',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(file_asset_id,version_number)
);
CREATE INDEX IF NOT EXISTS file_versions_org_asset_idx ON file_versions(organization_id,file_asset_id,version_number DESC);

CREATE TABLE IF NOT EXISTS storage_sync_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  channel_token_hash text NOT NULL,
  resource_id text,
  page_token text,
  expiration_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','renewing','expired','stopped','error')),
  last_notification_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,channel_id)
);
CREATE INDEX IF NOT EXISTS storage_sync_channels_renew_idx ON storage_sync_channels(status,expiration_at);

CREATE TABLE IF NOT EXISTS storage_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  sync_channel_id uuid REFERENCES storage_sync_channels(id) ON DELETE SET NULL,
  job_type text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','retry','completed','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS storage_sync_jobs_claim_idx ON storage_sync_jobs(status,next_attempt_at) WHERE status IN ('pending','retry','processing');

CREATE TABLE IF NOT EXISTS file_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_asset_id uuid REFERENCES file_assets(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS file_audit_logs_org_created_idx ON file_audit_logs(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS file_audit_logs_asset_created_idx ON file_audit_logs(file_asset_id,created_at DESC);

CREATE TABLE IF NOT EXISTS file_processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_asset_id uuid NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES storage_connections(id) ON DELETE SET NULL,
  job_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','retry','completed','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(file_asset_id,job_type)
);
CREATE INDEX IF NOT EXISTS file_processing_jobs_claim_idx ON file_processing_jobs(status,next_attempt_at) WHERE status IN ('pending','retry','processing');

ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS file_asset_id uuid REFERENCES file_assets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS message_attachments_file_asset_idx ON message_attachments(organization_id,file_asset_id) WHERE file_asset_id IS NOT NULL;

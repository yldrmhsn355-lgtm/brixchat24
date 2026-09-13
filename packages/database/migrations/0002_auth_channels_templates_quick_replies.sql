ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'tr',
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Europe/Istanbul',
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS notification_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE users SET first_name=split_part(full_name,' ',1), last_name=NULLIF(substring(full_name from position(' ' in full_name)+1),'') WHERE first_name IS NULL;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS industry text,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'configuration_required',
  ADD COLUMN IF NOT EXISTS health_code text,
  ADD COLUMN IF NOT EXISTS health_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_webhook_result text;

CREATE TABLE IF NOT EXISTS user_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  replaced_by_id uuid REFERENCES user_sessions(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoke_reason text,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_sessions_user_active_idx ON user_sessions(user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_sessions_family_idx ON user_sessions(family_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_user_idx ON password_reset_tokens(user_id, expires_at);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email_hash text NOT NULL,
  ip_hash text,
  success boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_lookup_idx ON login_attempts(normalized_email_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS user_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_security_events_user_idx ON user_security_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role member_role NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organization_invitations_org_idx ON organization_invitations(organization_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS organization_invitations_active_email_uq ON organization_invitations(organization_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS onboarding_progress (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  current_step integer NOT NULL DEFAULT 1,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(team_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_members_org_user_idx ON team_members(organization_id, user_id);

CREATE TABLE IF NOT EXISTS message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_template_id text,
  name text NOT NULL,
  language text NOT NULL,
  category text NOT NULL,
  status text NOT NULL,
  quality_score text,
  rejection_reason text,
  header_type text,
  header_text text,
  body_text text NOT NULL,
  footer_text text,
  buttons jsonb,
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel_id, name, language)
);
CREATE INDEX IF NOT EXISTS message_templates_org_filter_idx ON message_templates(organization_id, status, language, category);

CREATE TABLE IF NOT EXISTS message_template_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES message_templates(id) ON DELETE CASCADE,
  component_type text NOT NULL,
  position integer NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(template_id, component_type, position)
);

CREATE TABLE IF NOT EXISTS message_template_variables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES message_templates(id) ON DELETE CASCADE,
  component text NOT NULL,
  position integer NOT NULL,
  variable_name text NOT NULL,
  example_value text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(template_id, component, position)
);

CREATE TABLE IF NOT EXISTS template_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  status text NOT NULL,
  templates_received integer NOT NULL DEFAULT 0,
  templates_created integer NOT NULL DEFAULT 0,
  templates_updated integer NOT NULL DEFAULT 0,
  templates_archived integer NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS template_send_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES message_templates(id),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quick_reply_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  scope text NOT NULL CHECK(scope IN ('organization','team','personal')),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quick_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  shortcut text NOT NULL,
  content text NOT NULL,
  language text NOT NULL DEFAULT 'tr',
  scope text NOT NULL CHECK(scope IN ('organization','team','personal')),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES quick_reply_folders(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  usage_count integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quick_replies_org_idx ON quick_replies(organization_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS quick_replies_org_shortcut_uq ON quick_replies(organization_id, lower(shortcut)) WHERE scope='organization';
CREATE UNIQUE INDEX IF NOT EXISTS quick_replies_team_shortcut_uq ON quick_replies(organization_id, team_id, lower(shortcut)) WHERE scope='team';
CREATE UNIQUE INDEX IF NOT EXISTS quick_replies_personal_shortcut_uq ON quick_replies(organization_id, owner_user_id, lower(shortcut)) WHERE scope='personal';

CREATE TABLE IF NOT EXISTS quick_reply_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quick_reply_id uuid NOT NULL REFERENCES quick_replies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  rendered_content_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_feed_idx ON notifications(organization_id, user_id, created_at DESC);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address inet;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent text;

INSERT INTO user_credentials(user_id,password_hash)
SELECT id,password_hash FROM users
WHERE password_hash IS NOT NULL
ON CONFLICT(user_id) DO NOTHING;

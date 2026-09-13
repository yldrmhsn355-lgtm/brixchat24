-- Professional quick reply management center.
-- Additive migration: existing replies remain active and keep their identifiers.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS normalized_shortcut text,
  ADD COLUMN IF NOT EXISTS content_format text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS family_key text,
  ADD COLUMN IF NOT EXISTS fallback_language text,
  ADD COLUMN IF NOT EXISTS channel_id uuid REFERENCES channels(id) ON DELETE SET NULL;

UPDATE quick_replies
SET shortcut=lower(trim(both '/' FROM trim(shortcut))),
    normalized_shortcut=lower(trim(both '/' FROM trim(shortcut))),
    updated_by=COALESCE(updated_by,created_by),
    family_key=COALESCE(family_key,lower(trim(both '/' FROM trim(shortcut)))),
    status=CASE WHEN is_active THEN 'active' ELSE 'archived' END,
    archived_at=CASE WHEN is_active THEN NULL ELSE COALESCE(archived_at,updated_at) END
WHERE normalized_shortcut IS NULL
   OR updated_by IS NULL
   OR family_key IS NULL;

ALTER TABLE quick_replies
  ALTER COLUMN normalized_shortcut SET NOT NULL,
  ALTER COLUMN family_key SET NOT NULL;

-- Preserve authored replies and their audit history when identities or teams
-- are retired. Callers must explicitly re-scope/archive replies first.
ALTER TABLE quick_replies
  DROP CONSTRAINT IF EXISTS quick_replies_owner_user_id_fkey,
  DROP CONSTRAINT IF EXISTS quick_replies_team_id_fkey;
ALTER TABLE quick_replies
  ADD CONSTRAINT quick_replies_owner_user_id_fkey
    FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT quick_replies_team_id_fkey
    FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE RESTRICT;

ALTER TABLE quick_replies
  ADD CONSTRAINT quick_replies_status_check
    CHECK(status IN ('active','archived','deleted')),
  ADD CONSTRAINT quick_replies_content_format_check
    CHECK(content_format IN ('text','structured')),
  ADD CONSTRAINT quick_replies_scope_owner_check
    CHECK(
      (scope='organization' AND owner_user_id IS NULL AND team_id IS NULL)
      OR (scope='team' AND owner_user_id IS NULL AND team_id IS NOT NULL)
      OR (scope='personal' AND owner_user_id IS NOT NULL AND team_id IS NULL)
    );

DROP INDEX IF EXISTS quick_replies_org_shortcut_uq;
DROP INDEX IF EXISTS quick_replies_team_shortcut_uq;
DROP INDEX IF EXISTS quick_replies_personal_shortcut_uq;

CREATE UNIQUE INDEX quick_replies_org_shortcut_uq
  ON quick_replies(organization_id,normalized_shortcut,language)
  WHERE scope='organization' AND status<>'deleted';
CREATE UNIQUE INDEX quick_replies_team_shortcut_uq
  ON quick_replies(organization_id,team_id,normalized_shortcut,language)
  WHERE scope='team' AND status<>'deleted';
CREATE UNIQUE INDEX quick_replies_personal_shortcut_uq
  ON quick_replies(organization_id,owner_user_id,normalized_shortcut,language)
  WHERE scope='personal' AND status<>'deleted';
CREATE INDEX quick_replies_search_trgm_idx
  ON quick_replies USING gin (
    (coalesce(title,'') || ' ' || coalesce(normalized_shortcut,'') || ' ' || coalesce(content,'')) gin_trgm_ops
  )
  WHERE status<>'deleted';
CREATE INDEX quick_replies_list_idx
  ON quick_replies(organization_id,status,scope,language,updated_at DESC);

CREATE TABLE quick_reply_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  scope text NOT NULL CHECK(scope IN ('organization','team')),
  team_id uuid REFERENCES teams(id) ON DELETE RESTRICT,
  color text,
  icon text,
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(
    (scope='organization' AND team_id IS NULL)
    OR (scope='team' AND team_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX quick_reply_categories_identity_uq
  ON quick_reply_categories(organization_id,scope,coalesce(team_id,'00000000-0000-0000-0000-000000000000'::uuid),normalized_name)
  WHERE archived_at IS NULL;

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES quick_reply_categories(id) ON DELETE SET NULL;

CREATE TABLE quick_reply_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  color text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quick_reply_tags_identity_uq
  ON quick_reply_tags(organization_id,normalized_name);

CREATE TABLE quick_reply_tag_assignments (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quick_reply_id uuid NOT NULL REFERENCES quick_replies(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES quick_reply_tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(quick_reply_id,tag_id)
);

CREATE TABLE quick_reply_favorites (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quick_reply_id uuid NOT NULL REFERENCES quick_replies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(quick_reply_id,user_id)
);
CREATE INDEX quick_reply_favorites_user_idx
  ON quick_reply_favorites(organization_id,user_id,created_at DESC);

CREATE TABLE quick_reply_variables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quick_reply_id uuid NOT NULL REFERENCES quick_replies(id) ON DELETE CASCADE,
  variable_key text NOT NULL,
  label text NOT NULL,
  source text NOT NULL,
  data_type text NOT NULL DEFAULT 'text',
  formatter text,
  example_value text,
  default_value text,
  required boolean NOT NULL DEFAULT true,
  missing_policy text NOT NULL DEFAULT 'block'
    CHECK(missing_policy IN ('block','manual','default','remove')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(quick_reply_id,variable_key)
);

CREATE TABLE quick_reply_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quick_reply_id uuid NOT NULL REFERENCES quick_replies(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  attachment_type text NOT NULL,
  scan_status text NOT NULL DEFAULT 'pending',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(quick_reply_id,storage_key)
);

CREATE TABLE quick_reply_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quick_reply_id uuid NOT NULL REFERENCES quick_replies(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  changed_fields text[] NOT NULL DEFAULT '{}',
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(quick_reply_id,version)
);

ALTER TABLE quick_reply_usage_events
  ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'sent',
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS error_code text;

CREATE INDEX quick_reply_usage_analytics_idx
  ON quick_reply_usage_events(organization_id,quick_reply_id,event_type,created_at DESC);

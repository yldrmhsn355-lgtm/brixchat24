CREATE OR REPLACE FUNCTION normalize_conversation_label_name(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(regexp_replace(btrim(value), '\s+', ' ', 'g'))
$$;

CREATE TABLE IF NOT EXISTS label_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  description text,
  color text,
  sort_order integer NOT NULL DEFAULT 0,
  is_required_group boolean NOT NULL DEFAULT false,
  selection_mode text NOT NULL DEFAULT 'multiple'
    CHECK(selection_mode IN ('multiple','single')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS label_categories_name_uq
  ON label_categories(organization_id,normalized_name)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS label_categories_list_idx
  ON label_categories(organization_id,archived_at,sort_order,name);

ALTER TABLE conversation_labels
  ADD COLUMN IF NOT EXISTS normalized_name text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS icon text,
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES label_categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_protected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES conversation_labels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS usage_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS automation_usage_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

UPDATE conversation_labels
SET normalized_name=normalize_conversation_label_name(name)
WHERE normalized_name IS NULL;
ALTER TABLE conversation_labels ALTER COLUMN normalized_name SET NOT NULL;
ALTER TABLE conversation_labels
  DROP CONSTRAINT IF EXISTS conversation_labels_scope_check;
ALTER TABLE conversation_labels
  ADD CONSTRAINT conversation_labels_scope_check
  CHECK(scope IN ('workspace','team','channel'));
ALTER TABLE conversation_labels
  DROP CONSTRAINT IF EXISTS conversation_labels_status_check;
ALTER TABLE conversation_labels
  ADD CONSTRAINT conversation_labels_status_check
  CHECK(status IN ('active','archived','deleted','merged'));
ALTER TABLE conversation_labels
  DROP CONSTRAINT IF EXISTS conversation_labels_scope_target_check;
ALTER TABLE conversation_labels
  ADD CONSTRAINT conversation_labels_scope_target_check CHECK(
    (scope='workspace' AND team_id IS NULL AND channel_id IS NULL) OR
    (scope='team' AND team_id IS NOT NULL AND channel_id IS NULL) OR
    (scope='channel' AND channel_id IS NOT NULL AND team_id IS NULL)
  );

-- Preserve assignments while consolidating legacy case/whitespace duplicates.
WITH ranked AS (
  SELECT id,organization_id,normalized_name,
    first_value(id) OVER(
      PARTITION BY organization_id,normalized_name
      ORDER BY created_at,id
    ) keep_id,
    row_number() OVER(
      PARTITION BY organization_id,normalized_name
      ORDER BY created_at,id
    ) position
  FROM conversation_labels
), duplicates AS (
  SELECT id,keep_id FROM ranked WHERE position>1
)
INSERT INTO conversation_label_assignments(
  organization_id,conversation_id,label_id,assigned_by,created_at
)
SELECT a.organization_id,a.conversation_id,d.keep_id,a.assigned_by,a.created_at
FROM conversation_label_assignments a
JOIN duplicates d ON d.id=a.label_id
ON CONFLICT(conversation_id,label_id) DO NOTHING;

WITH ranked AS (
  SELECT id,
    row_number() OVER(
      PARTITION BY organization_id,normalized_name
      ORDER BY created_at,id
    ) position
  FROM conversation_labels
)
DELETE FROM conversation_labels l
USING ranked r
WHERE l.id=r.id AND r.position>1;

ALTER TABLE conversation_labels
  DROP CONSTRAINT IF EXISTS conversation_labels_organization_id_name_key;
DROP INDEX IF EXISTS conversation_labels_name_uq;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_labels_normalized_name_uq
  ON conversation_labels(organization_id,normalized_name)
  WHERE deleted_at IS NULL AND status<>'merged';
CREATE INDEX IF NOT EXISTS conversation_labels_list_idx
  ON conversation_labels(organization_id,status,scope,category_id,sort_order,name);
CREATE INDEX IF NOT EXISTS conversation_labels_team_idx
  ON conversation_labels(organization_id,team_id)
  WHERE status='active';
CREATE INDEX IF NOT EXISTS conversation_labels_channel_idx
  ON conversation_labels(organization_id,channel_id)
  WHERE status='active';

ALTER TABLE conversation_label_assignments
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS automation_id uuid REFERENCES automation_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS correlation_id uuid;
UPDATE conversation_label_assignments
SET assigned_at=created_at
WHERE assigned_at IS NULL;
ALTER TABLE conversation_label_assignments ALTER COLUMN assigned_at SET NOT NULL;
ALTER TABLE conversation_label_assignments
  DROP CONSTRAINT IF EXISTS conversation_label_assignments_source_check;
ALTER TABLE conversation_label_assignments
  ADD CONSTRAINT conversation_label_assignments_source_check
  CHECK(source IN ('manual','automation','bitrix','import','system'));
CREATE INDEX IF NOT EXISTS conversation_label_expiry_idx
  ON conversation_label_assignments(expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversation_label_source_idx
  ON conversation_label_assignments(organization_id,source,assigned_at DESC);

CREATE TABLE IF NOT EXISTS label_favorites (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES conversation_labels(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,user_id,label_id)
);

CREATE TABLE IF NOT EXISTS label_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES conversation_labels(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK(event_type IN ('assigned','removed','replaced','expired','merged')),
  source text NOT NULL DEFAULT 'manual',
  automation_id uuid REFERENCES automation_rules(id) ON DELETE SET NULL,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS label_usage_events_analytics_idx
  ON label_usage_events(organization_id,label_id,created_at DESC);
CREATE INDEX IF NOT EXISTS label_usage_events_actor_idx
  ON label_usage_events(organization_id,actor_id,created_at DESC);

CREATE TABLE IF NOT EXISTS label_bitrix_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES conversation_labels(id) ON DELETE CASCADE,
  integration_connection_id uuid REFERENCES integration_connections(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK(entity_type IN ('contact','deal')),
  field_id text NOT NULL,
  field_value text NOT NULL,
  sync_direction text NOT NULL DEFAULT 'bitrix_to_brixchat'
    CHECK(sync_direction IN ('brixchat_to_bitrix','bitrix_to_brixchat','bidirectional')),
  conflict_policy text NOT NULL DEFAULT 'external_wins'
    CHECK(conflict_policy IN ('external_wins','local_wins','newest_wins','manual')),
  enabled boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  last_synced_value text,
  last_external_event_id text,
  last_correlation_id uuid,
  last_error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,label_id,entity_type,field_id,field_value)
);
CREATE INDEX IF NOT EXISTS label_bitrix_mappings_sync_idx
  ON label_bitrix_mappings(organization_id,enabled,last_synced_at);

CREATE TABLE IF NOT EXISTS label_bulk_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK(operation IN ('add','remove','replace')),
  conversation_ids uuid[] NOT NULL,
  label_id uuid REFERENCES conversation_labels(id) ON DELETE SET NULL,
  replacement_label_id uuid REFERENCES conversation_labels(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','completed','partial','failed')),
  total_count integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  result jsonb NOT NULL DEFAULT '{}',
  error_code text,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(organization_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS label_bulk_jobs_claim_idx
  ON label_bulk_jobs(status,created_at)
  WHERE status='pending';

CREATE OR REPLACE FUNCTION refresh_conversation_label_usage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_label_id uuid;
BEGIN
  target_label_id := COALESCE(NEW.label_id,OLD.label_id);
  UPDATE conversation_labels
  SET usage_count=(
        SELECT count(*) FROM conversation_label_assignments
        WHERE label_id=target_label_id
      ),
      last_used_at=(
        SELECT max(assigned_at) FROM conversation_label_assignments
        WHERE label_id=target_label_id
      )
  WHERE id=target_label_id;
  RETURN COALESCE(NEW,OLD);
END
$$;
DROP TRIGGER IF EXISTS conversation_label_usage_refresh ON conversation_label_assignments;
CREATE TRIGGER conversation_label_usage_refresh
AFTER INSERT OR DELETE ON conversation_label_assignments
FOR EACH ROW EXECUTE FUNCTION refresh_conversation_label_usage();

UPDATE conversation_labels l
SET usage_count=counts.usage_count,last_used_at=counts.last_used_at
FROM (
  SELECT label_id,count(*)::int usage_count,max(assigned_at) last_used_at
  FROM conversation_label_assignments
  GROUP BY label_id
) counts
WHERE counts.label_id=l.id;

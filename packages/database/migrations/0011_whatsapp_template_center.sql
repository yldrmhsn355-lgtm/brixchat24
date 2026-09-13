-- WhatsApp template management center.
-- This migration is additive except for consolidating exact WABA/name/language
-- duplicates. Channel associations and send-event history are preserved before
-- duplicate rows are removed.

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS business_account_id text,
  ADD COLUMN IF NOT EXISTS normalized_name text,
  ADD COLUMN IF NOT EXISTS family_id uuid,
  ADD COLUMN IF NOT EXISTS previous_category text,
  ADD COLUMN IF NOT EXISTS components jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS parameter_format text NOT NULL DEFAULT 'positional',
  ADD COLUMN IF NOT EXISTS internal_label text,
  ADD COLUMN IF NOT EXISTS folder text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id) ON DELETE SET NULL;

UPDATE message_templates mt
SET business_account_id = ch.business_account_id,
    normalized_name = lower(regexp_replace(regexp_replace(trim(mt.name), '\s+', '_', 'g'), '[^a-zA-Z0-9_]', '', 'g'))
FROM channels ch
WHERE ch.id = mt.channel_id
  AND (mt.business_account_id IS NULL OR mt.normalized_name IS NULL);

CREATE TABLE IF NOT EXISTS message_template_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_account_id text NOT NULL,
  normalized_name text NOT NULL,
  default_language text NOT NULL,
  fallback_language text,
  internal_label text,
  folder text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, business_account_id, normalized_name)
);

INSERT INTO message_template_families (
  organization_id,business_account_id,normalized_name,default_language
)
SELECT organization_id,business_account_id,normalized_name,min(language)
FROM message_templates
WHERE business_account_id IS NOT NULL AND normalized_name IS NOT NULL
GROUP BY organization_id,business_account_id,normalized_name
ON CONFLICT (organization_id,business_account_id,normalized_name) DO NOTHING;

UPDATE message_templates mt
SET family_id = f.id
FROM message_template_families f
WHERE f.organization_id=mt.organization_id
  AND f.business_account_id=mt.business_account_id
  AND f.normalized_name=mt.normalized_name
  AND mt.family_id IS NULL;

ALTER TABLE message_templates
  ADD CONSTRAINT message_templates_family_fk
  FOREIGN KEY (family_id) REFERENCES message_template_families(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS message_template_channels (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES message_templates(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id,channel_id)
);

INSERT INTO message_template_channels (organization_id,template_id,channel_id)
SELECT organization_id,id,channel_id FROM message_templates
ON CONFLICT DO NOTHING;

-- Consolidate only records that have a real WABA identity. The canonical row is
-- deterministic; every channel link and send event is moved first.
CREATE TEMP TABLE template_duplicate_map ON COMMIT DROP AS
SELECT id duplicate_id,
       first_value(id) OVER (
         PARTITION BY organization_id,business_account_id,normalized_name,language
         ORDER BY created_at,id
       ) canonical_id,
       row_number() OVER (
         PARTITION BY organization_id,business_account_id,normalized_name,language
         ORDER BY created_at,id
       ) row_number
FROM message_templates
WHERE business_account_id IS NOT NULL
  AND normalized_name IS NOT NULL
  AND deleted_at IS NULL;

INSERT INTO message_template_channels (organization_id,template_id,channel_id)
SELECT mtc.organization_id,m.canonical_id,mtc.channel_id
FROM message_template_channels mtc
JOIN template_duplicate_map m ON m.duplicate_id=mtc.template_id
WHERE m.row_number > 1
ON CONFLICT DO NOTHING;

UPDATE template_send_events tse
SET template_id=m.canonical_id
FROM template_duplicate_map m
WHERE m.row_number > 1 AND tse.template_id=m.duplicate_id;

DELETE FROM message_templates mt
USING template_duplicate_map m
WHERE m.row_number > 1 AND mt.id=m.duplicate_id;

CREATE UNIQUE INDEX IF NOT EXISTS message_templates_waba_name_language_uq
  ON message_templates(organization_id,business_account_id,normalized_name,language)
  WHERE business_account_id IS NOT NULL
    AND normalized_name IS NOT NULL
    AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS message_templates_family_idx
  ON message_templates(organization_id,family_id,status,language)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS message_template_channels_channel_idx
  ON message_template_channels(organization_id,channel_id,template_id);

ALTER TABLE message_template_variables
  ADD COLUMN IF NOT EXISTS internal_key text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS default_value text,
  ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS missing_policy text NOT NULL DEFAULT 'block',
  ADD COLUMN IF NOT EXISTS formatter text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE message_template_variables
SET internal_key=COALESCE(internal_key,variable_name)
WHERE internal_key IS NULL;

CREATE TABLE IF NOT EXISTS message_template_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES message_templates(id) ON DELETE CASCADE,
  dependency_type text NOT NULL,
  dependency_id text NOT NULL,
  dependency_label text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,template_id,dependency_type,dependency_id)
);

CREATE INDEX IF NOT EXISTS message_template_dependencies_template_idx
  ON message_template_dependencies(organization_id,template_id,dependency_type);

CREATE TABLE IF NOT EXISTS message_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES message_templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  source text NOT NULL,
  snapshot jsonb NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  provider_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id,version)
);

CREATE TABLE IF NOT EXISTS template_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_account_id text NOT NULL,
  provider_event_key text NOT NULL,
  field text NOT NULL,
  provider_template_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'processed',
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (organization_id,provider_event_key)
);

ALTER TABLE template_sync_runs
  ADD COLUMN IF NOT EXISTS business_account_id text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS cursor text,
  ADD COLUMN IF NOT EXISTS pages_received integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_details jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS template_sync_runs_idempotency_uq
  ON template_sync_runs(organization_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS template_sync_runs_channel_started_idx
  ON template_sync_runs(organization_id,channel_id,started_at DESC);

CREATE INDEX IF NOT EXISTS template_send_events_analytics_idx
  ON template_send_events(organization_id,template_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS provider_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_account_id text,
  display_name text NOT NULL,
  encrypted_credentials text,
  credential_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  last_authenticated_at timestamptz,
  token_expires_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, provider, external_account_id)
);

CREATE INDEX IF NOT EXISTS provider_accounts_org_active_idx
  ON provider_accounts(organization_id, provider, created_at DESC)
  WHERE archived_at IS NULL;

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS provider_account_id uuid REFERENCES provider_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS platform text,
  ADD COLUMN IF NOT EXISTS external_channel_id text,
  ADD COLUMN IF NOT EXISTS internal_name text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS connection_status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS health_state text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS default_language text NOT NULL DEFAULT 'tr',
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Europe/Istanbul',
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_outbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_health_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_health_error text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

ALTER TABLE channels ALTER COLUMN phone_number DROP NOT NULL;

INSERT INTO provider_accounts (
  organization_id,
  provider,
  external_account_id,
  display_name,
  encrypted_credentials,
  status,
  created_at,
  updated_at
)
SELECT DISTINCT ON (c.organization_id, c.provider, c.business_account_id)
  c.organization_id,
  c.provider,
  c.business_account_id,
  concat('Meta WABA ', c.business_account_id),
  c.credentials_encrypted,
  CASE WHEN c.deleted_at IS NULL THEN 'active' ELSE 'archived' END,
  c.created_at,
  c.updated_at
FROM channels c
WHERE c.provider = 'meta'
  AND c.business_account_id IS NOT NULL
ORDER BY
  c.organization_id,
  c.provider,
  c.business_account_id,
  (c.credentials_encrypted IS NOT NULL) DESC,
  c.updated_at DESC
ON CONFLICT (organization_id, provider, external_account_id)
DO UPDATE SET
  encrypted_credentials = COALESCE(
    provider_accounts.encrypted_credentials,
    EXCLUDED.encrypted_credentials
  ),
  updated_at = GREATEST(provider_accounts.updated_at, EXCLUDED.updated_at);

UPDATE channels c
SET
  provider_account_id = pa.id,
  platform = COALESCE(c.platform, 'whatsapp'),
  external_channel_id = COALESCE(c.external_channel_id, c.phone_number_id, c.public_id::text),
  internal_name = COALESCE(c.internal_name, c.name),
  identity = CASE
    WHEN c.identity = '{}'::jsonb THEN jsonb_strip_nulls(jsonb_build_object(
      'type', 'phone_number',
      'value', c.phone_number,
      'phoneNumberId', c.phone_number_id,
      'businessAccountId', c.business_account_id
    ))
    ELSE c.identity
  END,
  capabilities = CASE
    WHEN c.capabilities = '[]'::jsonb THEN
      '["text","media","templates","reactions","interactive","read_receipts","delivery_receipts","webhooks","template_sync"]'::jsonb
    ELSE c.capabilities
  END,
  connection_status = CASE
    WHEN c.deleted_at IS NOT NULL THEN 'ARCHIVED'
    WHEN c.status = 'connected' THEN 'ACTIVE'
    WHEN c.status = 'disabled' THEN 'DISABLED'
    WHEN c.status = 'disconnected' THEN 'DISCONNECTED'
    ELSE 'ERROR'
  END,
  health_state = CASE
    WHEN c.health_status = 'healthy' THEN 'HEALTHY'
    WHEN c.health_status IN ('unhealthy', 'error') THEN 'UNHEALTHY'
    WHEN c.health_status IN ('degraded', 'warning') THEN 'WARNING'
    ELSE 'UNKNOWN'
  END,
  last_outbound_at = COALESCE(c.last_outbound_at, c.last_successful_message_at),
  last_health_check_at = COALESCE(c.last_health_check_at, c.health_checked_at),
  last_health_error = COALESCE(c.last_health_error, c.last_error_code),
  archived_at = COALESCE(c.archived_at, c.deleted_at)
FROM provider_accounts pa
WHERE c.provider = 'meta'
  AND pa.organization_id = c.organization_id
  AND pa.provider = c.provider
  AND pa.external_account_id = c.business_account_id;

UPDATE channels
SET
  platform = COALESCE(platform, 'whatsapp'),
  external_channel_id = COALESCE(external_channel_id, phone_number_id, public_id::text),
  internal_name = COALESCE(internal_name, name),
  connection_status = CASE
    WHEN deleted_at IS NOT NULL THEN 'ARCHIVED'
    WHEN status = 'connected' THEN 'ACTIVE'
    WHEN status = 'disabled' THEN 'DISABLED'
    WHEN status = 'disconnected' THEN 'DISCONNECTED'
    ELSE connection_status
  END,
  archived_at = COALESCE(archived_at, deleted_at)
WHERE platform IS NULL
   OR external_channel_id IS NULL
   OR internal_name IS NULL;

CREATE INDEX IF NOT EXISTS channels_provider_account_idx
  ON channels(organization_id, provider_account_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS channels_active_provider_endpoint_uq
  ON channels(organization_id, provider, external_channel_id)
  WHERE deleted_at IS NULL AND external_channel_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS channels_active_meta_phone_number_id_uq
  ON channels(organization_id, phone_number_id)
  WHERE deleted_at IS NULL
    AND provider = 'meta'
    AND phone_number_id IS NOT NULL;

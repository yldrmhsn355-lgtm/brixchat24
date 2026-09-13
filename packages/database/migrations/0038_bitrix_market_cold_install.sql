-- Prevent the same Bitrix24 portal from being auto-provisioned into more than
-- one organization when the Marketplace "cold install" flow creates a brand
-- new tenant on demand. Scoped by member_id (Bitrix's stable, domain-independent
-- portal identifier) rather than portal_url, and only against *active*
-- connections so a portal can freely reinstall after ONAPPUNINSTALL sets the
-- prior row to status='disconnected'.
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_provider_member_active_uq
  ON integration_connections(provider, member_id)
  WHERE member_id IS NOT NULL AND member_id <> '' AND status <> 'disconnected';

-- One-time tokens issued after a Bitrix24 Marketplace cold install so the
-- portal admin can claim the auto-provisioned organization/user from their
-- own browser -- Bitrix24 never sees (and doesn't need) a Brixchat24 password.
CREATE TABLE IF NOT EXISTS bitrix_setup_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bitrix_setup_tokens_org_idx ON bitrix_setup_tokens(organization_id, expires_at);

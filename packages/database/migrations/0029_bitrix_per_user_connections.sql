ALTER TABLE integration_connections
  ADD COLUMN IF NOT EXISTS auth_external_user_id text;

ALTER TABLE integration_connections
  DROP CONSTRAINT IF EXISTS integration_connections_organization_id_provider_portal_url_key;

CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_portal_auth_user_uq
  ON integration_connections(
    organization_id,
    provider,
    portal_url,
    auth_external_user_id
  )
  WHERE portal_url IS NOT NULL
    AND auth_external_user_id IS NOT NULL
    AND status <> 'disconnected';

CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_portal_oauth_pending_uq
  ON integration_connections(organization_id,provider,portal_url)
  WHERE portal_url IS NOT NULL
    AND auth_mode='oauth'
    AND status='oauth_pending';

CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_portal_non_oauth_uq
  ON integration_connections(organization_id,provider,portal_url)
  WHERE portal_url IS NOT NULL
    AND auth_mode<>'oauth'
    AND status<>'disconnected';

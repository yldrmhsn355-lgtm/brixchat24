CREATE TABLE IF NOT EXISTS whatsapp_web_sessions (
  channel_id uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'initializing'
    CHECK (status IN (
      'initializing',
      'qr_ready',
      'connecting',
      'connected',
      'reconnecting',
      'disconnected',
      'logged_out',
      'error'
    )),
  encrypted_credentials text,
  encrypted_qr text,
  qr_expires_at timestamptz,
  phone_number text,
  push_name text,
  device_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  assigned_worker_id text,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  restart_attempts integer NOT NULL DEFAULT 0,
  next_restart_at timestamptz,
  last_connected_at timestamptz,
  last_disconnected_at timestamptz,
  last_error_code text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_web_sessions_org_status_idx
  ON whatsapp_web_sessions(organization_id, status, next_restart_at);

CREATE INDEX IF NOT EXISTS wa_web_sessions_lease_idx
  ON whatsapp_web_sessions(lease_expires_at)
  WHERE assigned_worker_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_web_signal_keys (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  key_type text NOT NULL,
  key_id text NOT NULL,
  encrypted_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_web_signal_keys_pk PRIMARY KEY(channel_id, key_type, key_id)
);

CREATE INDEX IF NOT EXISTS wa_web_signal_keys_org_channel_idx
  ON whatsapp_web_signal_keys(organization_id, channel_id);

ALTER TABLE whatsapp_web_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_web_signal_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_web_sessions_tenant_isolation
  ON whatsapp_web_sessions;
CREATE POLICY whatsapp_web_sessions_tenant_isolation
  ON whatsapp_web_sessions
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );

DROP POLICY IF EXISTS whatsapp_web_signal_keys_tenant_isolation
  ON whatsapp_web_signal_keys;
CREATE POLICY whatsapp_web_signal_keys_tenant_isolation
  ON whatsapp_web_signal_keys
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );

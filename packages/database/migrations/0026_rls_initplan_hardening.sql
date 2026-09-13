DROP POLICY IF EXISTS whatsapp_web_sessions_tenant_isolation
  ON whatsapp_web_sessions;
CREATE POLICY whatsapp_web_sessions_tenant_isolation
  ON whatsapp_web_sessions
  USING (
    organization_id = NULLIF(
      (SELECT current_setting('app.organization_id', true)),
      ''
    )::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(
      (SELECT current_setting('app.organization_id', true)),
      ''
    )::uuid
  );

DROP POLICY IF EXISTS whatsapp_web_signal_keys_tenant_isolation
  ON whatsapp_web_signal_keys;
CREATE POLICY whatsapp_web_signal_keys_tenant_isolation
  ON whatsapp_web_signal_keys
  USING (
    organization_id = NULLIF(
      (SELECT current_setting('app.organization_id', true)),
      ''
    )::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(
      (SELECT current_setting('app.organization_id', true)),
      ''
    )::uuid
  );

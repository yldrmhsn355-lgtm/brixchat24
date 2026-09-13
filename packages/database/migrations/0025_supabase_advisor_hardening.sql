CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid=extension.extnamespace
    WHERE extension.extname='pg_trgm'
      AND namespace.nspname='public'
      AND extension.extrelocatable
  ) THEN
    EXECUTE 'ALTER EXTENSION pg_trgm SET SCHEMA extensions';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS user_sessions_organization_idx
  ON user_sessions(organization_id);

DROP POLICY IF EXISTS whatsapp_web_sessions_tenant_isolation
  ON whatsapp_web_sessions;
CREATE POLICY whatsapp_web_sessions_tenant_isolation
  ON whatsapp_web_sessions
  USING (
    organization_id = (
      SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS whatsapp_web_signal_keys_tenant_isolation
  ON whatsapp_web_signal_keys;
CREATE POLICY whatsapp_web_signal_keys_tenant_isolation
  ON whatsapp_web_signal_keys
  USING (
    organization_id = (
      SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
    )
  );

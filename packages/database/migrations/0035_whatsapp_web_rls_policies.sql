-- Environments that applied 0030 from master (pre-hardening) enabled RLS on
-- these tables without any policy, which is deny-all for non-owner roles.
-- Idempotent for environments whose 0030 already created the policies.
DROP POLICY IF EXISTS whatsapp_web_message_mutations_tenant_isolation
  ON whatsapp_web_message_mutations;
CREATE POLICY whatsapp_web_message_mutations_tenant_isolation
  ON whatsapp_web_message_mutations
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

DROP POLICY IF EXISTS whatsapp_web_ignored_messages_tenant_isolation
  ON whatsapp_web_ignored_messages;
CREATE POLICY whatsapp_web_ignored_messages_tenant_isolation
  ON whatsapp_web_ignored_messages
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

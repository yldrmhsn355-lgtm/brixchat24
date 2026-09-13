-- API tenant connections must use the non-owner brixchat_app_scoped role.
-- Verified control-plane operations and background workers use separate roles.
-- Cover every tenant-keyed table, including queue metadata and new AI tables.
-- A restrictive policy prevents another permissive policy from opening a row.
DO $$
DECLARE tenant_table record;
BEGIN
  FOR tenant_table IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema='public' AND c.column_name='organization_id' AND t.table_type='BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tenant_table.table_name);
    EXECUTE format(
      'CREATE POLICY api_tenant_access ON public.%I AS PERMISSIVE FOR ALL TO brixchat_app_scoped USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',
      tenant_table.table_name);
    EXECUTE format(
      'CREATE POLICY api_tenant_boundary ON public.%I AS RESTRICTIVE FOR ALL TO brixchat_app_scoped USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',
      tenant_table.table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO brixchat_app_scoped',tenant_table.table_name);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_tenant_access ON organizations AS PERMISSIVE FOR ALL TO brixchat_app_scoped
  USING (id = nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (id = nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY api_tenant_boundary ON organizations AS RESTRICTIVE FOR ALL TO brixchat_app_scoped
  USING (id = nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (id = nullif(current_setting('app.organization_id',true),'')::uuid);

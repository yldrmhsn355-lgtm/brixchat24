-- Tables whose tenancy is inherited through a parent must have the same DB
-- backstop. Global catalogs are shared read-only; authentication secrets are
-- only available through explicitly privileged authentication operations.
DO $$
DECLARE entry record; condition text;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('assignment_rule_actions','rule_id','assignment_rules'),
    ('assignment_rule_conditions','rule_id','assignment_rules'),
    ('automation_rule_actions','version_id','automation_rule_versions'),
    ('automation_rule_conditions','version_id','automation_rule_versions'),
    ('automation_rule_triggers','version_id','automation_rule_versions'),
    ('message_template_components','template_id','message_templates'),
    ('message_template_variables','template_id','message_templates')
  ) AS parents(child_table,parent_column,parent_table)
  LOOP
    condition := format('EXISTS(SELECT 1 FROM public.%I p WHERE p.id=%I.%I AND p.organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid)',entry.parent_table,entry.child_table,entry.parent_column);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',entry.child_table);
    EXECUTE format('CREATE POLICY api_tenant_access ON public.%I AS PERMISSIVE FOR ALL TO brixchat_app_scoped USING (%s) WITH CHECK (%s)',entry.child_table,condition,condition);
    EXECUTE format('CREATE POLICY api_tenant_boundary ON public.%I AS RESTRICTIVE FOR ALL TO brixchat_app_scoped USING (%s) WITH CHECK (%s)',entry.child_table,condition,condition);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_tenant_access ON users AS PERMISSIVE FOR ALL TO brixchat_app_scoped
  USING (id=nullif(current_setting('app.user_id',true),'')::uuid OR EXISTS(
    SELECT 1 FROM organization_members m WHERE m.user_id=users.id AND m.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid))
  WITH CHECK (id=nullif(current_setting('app.user_id',true),'')::uuid OR EXISTS(
    SELECT 1 FROM organization_members m WHERE m.user_id=users.id AND m.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid));
CREATE POLICY api_tenant_boundary ON users AS RESTRICTIVE FOR ALL TO brixchat_app_scoped
  USING (id=nullif(current_setting('app.user_id',true),'')::uuid OR EXISTS(
    SELECT 1 FROM organization_members m WHERE m.user_id=users.id AND m.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid))
  WITH CHECK (id=nullif(current_setting('app.user_id',true),'')::uuid OR EXISTS(
    SELECT 1 FROM organization_members m WHERE m.user_id=users.id AND m.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid));
--> statement-breakpoint
REVOKE ALL ON users FROM brixchat_app_scoped;
GRANT SELECT(id,email,full_name,first_name,last_name,avatar_url,locale,timezone,notification_preferences,email_verified_at,is_active,suspended_at,created_at,updated_at,last_login_at) ON users TO brixchat_app_scoped;
GRANT UPDATE(first_name,last_name,full_name,email,email_verified_at,avatar_url,locale,timezone,notification_preferences,is_active,suspended_at,updated_at) ON users TO brixchat_app_scoped;
REVOKE ALL ON user_credentials,email_verification_tokens,password_reset_tokens,login_attempts FROM brixchat_app_scoped;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON billing_products,billing_prices,plans,worker_instances,worker_heartbeats,operational_metrics FROM brixchat_app_scoped;

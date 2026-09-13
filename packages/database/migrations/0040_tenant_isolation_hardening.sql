-- Defense-in-depth tenant isolation: today every organization_id filter is
-- applied by hand in application code with no database-level backstop (a
-- single missed WHERE clause in a new query is a silent cross-tenant leak).
-- This migration arms Postgres RLS as that backstop on the tables holding
-- customer conversation content and AI/PII data.
--
-- RLS alone does nothing while the app connects as the table owner (owners
-- bypass RLS by default). Rather than FORCE ROW LEVEL SECURITY on the owner
-- role -- which would also restrict admin/migration tooling that legitimately
-- needs cross-tenant access -- this migration introduces a separate,
-- non-owner role for the API service. RLS applies to that role automatically
-- because it does not own the tables. The worker service (background queue
-- processing, e.g. ai_run_requests claiming) intentionally keeps using the
-- existing owner-role connection, since it has a legitimate need to see rows
-- across organizations when claiming queued work.
--
-- This migration only arms the policies; it does not change which role the
-- API service connects as. That is a separate, manual production step (new
-- role password + DATABASE_URL rotation for the API service only), documented
-- in packages/database/README-tenant-role.md, done after this migration has
-- been applied and the app-side wiring (see withTenantScope in
-- packages/database/src/tenant-scope.ts) has been verified locally.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brixchat_app_scoped') THEN
    CREATE ROLE brixchat_app_scoped LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

-- Keep the role fail-closed if it already exists from an interrupted or
-- repeated environment bootstrap. In particular, BYPASSRLS would silently
-- defeat every policy below.
ALTER ROLE brixchat_app_scoped WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO brixchat_app_scoped', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO brixchat_app_scoped;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO brixchat_app_scoped;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO brixchat_app_scoped;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brixchat_app_scoped;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO brixchat_app_scoped;

-- Password is set manually outside of version control:
--   ALTER ROLE brixchat_app_scoped WITH PASSWORD '...';
-- (never commit a real password to a migration file).

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'conversations',
    'messages',
    'contacts',
    'channels',
    'audit_logs',
    'ai_settings',
    'ai_customer_memory',
    'ai_knowledge_bases',
    'ai_knowledge_documents',
    'ai_knowledge_chunks',
    'ai_runs',
    'ai_feedback',
    'ai_training_examples',
    'file_assets',
    'file_versions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (organization_id = (SELECT NULLIF(current_setting(''app.organization_id'', true), '''')::uuid)) WITH CHECK (organization_id = (SELECT NULLIF(current_setting(''app.organization_id'', true), '''')::uuid))',
      t || '_tenant_isolation',
      t
    );
  END LOOP;
END $$;

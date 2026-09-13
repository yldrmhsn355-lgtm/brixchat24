-- Keep the application database private when it is hosted on Supabase.
-- Brixchat24 uses a direct PostgreSQL connection; its public schema is not a
-- client-facing Supabase Data API. The role checks keep this migration safe on
-- ordinary PostgreSQL installations where Supabase roles do not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    REVOKE USAGE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO service_role, authenticator;

    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
      FROM anon, authenticated;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
      FROM anon, authenticated;
    REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
      FROM anon, authenticated;

    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL PRIVILEGES ON FUNCTIONS FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regprocedure('public.normalize_conversation_label_name(text)') IS NOT NULL THEN
    ALTER FUNCTION public.normalize_conversation_label_name(text)
      SET search_path = pg_catalog;
  END IF;

  IF to_regprocedure('public.refresh_conversation_label_usage()') IS NOT NULL THEN
    ALTER FUNCTION public.refresh_conversation_label_usage()
      SET search_path = pg_catalog, public;
  END IF;
END
$$;

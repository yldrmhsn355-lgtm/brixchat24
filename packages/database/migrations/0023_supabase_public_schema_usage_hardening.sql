-- Supabase grants public-schema usage directly to its client roles on newly
-- provisioned projects. Revoking the inherited PUBLIC grant alone is not
-- sufficient, so explicitly close schema discovery for client-facing roles.
-- Brixchat24 uses direct PostgreSQL connections and does not expose its public
-- schema through the Supabase Data API.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    REVOKE USAGE ON SCHEMA public FROM anon, authenticated;
    GRANT USAGE ON SCHEMA public TO service_role, authenticator;
  END IF;
END
$$;

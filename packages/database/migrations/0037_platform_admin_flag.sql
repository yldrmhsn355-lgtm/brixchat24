-- Cross-tenant platform administration (viewing/managing every organization
-- from a web UI, not just via scripts/tenant-cli.ts) needs an authorization
-- concept that is deliberately independent of the existing per-organization
-- RBAC (role/permission), since a platform admin must not be derived from
-- being an "owner" of any particular tenant -- that would let any tenant
-- owner see every other tenant's data. This flag is granted manually,
-- directly in the database, by whoever operates the platform; there is no
-- self-service or API path to set it on your own account.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

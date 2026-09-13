-- Bitrix24 member_id identifies a portal installation, not an individual
-- OAuth user. Per-user connections inside the same organization are instead
-- protected by the portal/user unique index introduced in migration 0029.
-- Cold-install tenant deduplication is enforced transactionally by the
-- Market install route, where its organization-level scope belongs.
DROP INDEX IF EXISTS integration_connections_provider_member_active_uq;

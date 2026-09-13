-- conversations_active_identity_uq was unique across every status value, so a
-- second closed/spam/waiting conversation for the same (org, channel, contact)
-- raised 23505 and surfaced as a 500. Only active conversations need the
-- single-row guarantee; terminal statuses may accumulate history rows.
DROP INDEX IF EXISTS conversations_active_identity_uq;
CREATE UNIQUE INDEX conversations_active_identity_uq
  ON conversations(organization_id,channel_id,contact_id,status)
  WHERE status IN ('open','waiting');

-- Keep terminal-status lookups (tombstone checks, archive dedup) indexed now
-- that the unique index no longer covers them.
CREATE INDEX IF NOT EXISTS conversations_identity_status_idx
  ON conversations(organization_id,channel_id,contact_id,status)
  WHERE status NOT IN ('open','waiting');

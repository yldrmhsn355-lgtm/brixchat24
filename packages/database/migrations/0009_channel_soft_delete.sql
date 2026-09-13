ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS channels_org_active_idx
  ON channels(organization_id, created_at DESC)
  WHERE deleted_at IS NULL;

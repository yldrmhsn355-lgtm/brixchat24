ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS organization_id uuid
  REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS user_sessions_workspace_idx
  ON user_sessions(user_id, organization_id);

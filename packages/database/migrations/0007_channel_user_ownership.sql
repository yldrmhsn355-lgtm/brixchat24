CREATE TABLE IF NOT EXISTS channel_user_ownership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship_type text NOT NULL DEFAULT 'owner' CHECK (relationship_type IN ('owner','shared','manager')),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,channel_id,user_id)
);
CREATE INDEX IF NOT EXISTS channel_user_ownership_user_idx ON channel_user_ownership(organization_id,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS channel_user_ownership_primary_idx ON channel_user_ownership(channel_id) WHERE is_primary;

-- Channels created before channel_user_ownership existed must still be visible
-- in the Inbox. Assign each unowned channel to the first workspace owner.
INSERT INTO channel_user_ownership (organization_id, channel_id, user_id, relationship_type, is_primary)
SELECT c.organization_id, c.id, owner_member.user_id, 'owner', true
FROM channels c
JOIN LATERAL (
  SELECT om.user_id
  FROM organization_members om
  WHERE om.organization_id = c.organization_id
    AND om.role IN ('owner', 'admin')
  ORDER BY CASE WHEN om.role = 'owner' THEN 0 ELSE 1 END, om.created_at
  LIMIT 1
) owner_member ON true
WHERE NOT EXISTS (
  SELECT 1
  FROM channel_user_ownership existing
  WHERE existing.channel_id = c.id
);

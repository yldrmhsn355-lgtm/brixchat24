CREATE TABLE IF NOT EXISTS whatsapp_web_message_mutations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  event_provider_message_id text NOT NULL,
  target_provider_message_id text NOT NULL,
  mutation_type text NOT NULL CHECK (mutation_type IN ('edit','revoke')),
  message_type text NOT NULL,
  body text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}',
  provider_timestamp timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','ignored')),
  applied_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_web_message_mutations_event_uq
  ON whatsapp_web_message_mutations(channel_id,event_provider_message_id);

CREATE INDEX IF NOT EXISTS whatsapp_web_message_mutations_target_idx
  ON whatsapp_web_message_mutations(
    organization_id,channel_id,target_provider_message_id,status
  );

CREATE TABLE IF NOT EXISTS whatsapp_web_ignored_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  provider_message_id text NOT NULL,
  raw_type text NOT NULL,
  reason text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  provider_timestamp timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_web_ignored_messages_event_uq
  ON whatsapp_web_ignored_messages(channel_id,provider_message_id);

CREATE INDEX IF NOT EXISTS whatsapp_web_ignored_messages_type_idx
  ON whatsapp_web_ignored_messages(
    organization_id,channel_id,raw_type,provider_timestamp DESC
  );

ALTER TABLE whatsapp_web_message_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_web_ignored_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_web_message_mutations_tenant_isolation
  ON whatsapp_web_message_mutations;
CREATE POLICY whatsapp_web_message_mutations_tenant_isolation
  ON whatsapp_web_message_mutations
  USING (
    organization_id = (
      SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS whatsapp_web_ignored_messages_tenant_isolation
  ON whatsapp_web_ignored_messages;
CREATE POLICY whatsapp_web_ignored_messages_tenant_isolation
  ON whatsapp_web_ignored_messages
  USING (
    organization_id = (
      SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
    )
  );
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE whatsapp_web_message_mutations FROM anon';
    EXECUTE 'REVOKE ALL ON TABLE whatsapp_web_ignored_messages FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE whatsapp_web_message_mutations FROM authenticated';
    EXECUTE 'REVOKE ALL ON TABLE whatsapp_web_ignored_messages FROM authenticated';
  END IF;
END $$;

-- Existing unsupported Baileys transport envelopes are retained for audit, but
-- are removed from every customer-facing and workflow projection.
WITH ranked_inbound AS (
  SELECT m.id,m.conversation_id,
    row_number() OVER (
      PARTITION BY m.conversation_id
      ORDER BY COALESCE(m.provider_timestamp,m.sent_at) DESC,m.id DESC
    ) AS inbound_rank
  FROM messages m
  WHERE m.direction='inbound' AND m.type<>'reaction'
), phantom_unread AS (
  SELECT r.conversation_id,count(*)::int AS count
  FROM ranked_inbound r
  JOIN conversations c ON c.id=r.conversation_id
  JOIN messages m ON m.id=r.id
  WHERE r.inbound_rank<=c.unread_count
    AND m.type='unsupported'
    AND m.metadata->>'provider'='whatsapp_web'
  GROUP BY r.conversation_id
)
UPDATE conversations c
SET unread_count=GREATEST(0,c.unread_count-p.count),updated_at=now()
FROM phantom_unread p
WHERE c.id=p.conversation_id;

UPDATE automation_events e
SET status='ignored',processed_at=COALESCE(processed_at,now()),
  locked_at=NULL,locked_by=NULL,last_error_code='WHATSAPP_TECHNICAL_MESSAGE_SUPPRESSED'
FROM messages m
WHERE e.aggregate_type='message' AND e.aggregate_id=m.id
  AND e.status IN ('pending','retry')
  AND m.type='unsupported' AND m.metadata->>'provider'='whatsapp_web';

UPDATE bitrix_open_channel_jobs j
SET status='cancelled',completed_at=COALESCE(completed_at,now()),
  locked_at=NULL,locked_by=NULL,
  last_error='WHATSAPP_TECHNICAL_MESSAGE_SUPPRESSED',updated_at=now()
FROM messages m
WHERE j.local_message_id=m.id AND j.status IN ('pending','retry')
  AND m.type='unsupported' AND m.metadata->>'provider'='whatsapp_web';

UPDATE crm_sync_jobs j
SET status='cancelled',completed_at=COALESCE(completed_at,now()),
  locked_at=NULL,locked_by=NULL,
  last_error_code='WHATSAPP_TECHNICAL_MESSAGE_SUPPRESSED',
  last_error_message='Technical WhatsApp transport envelope',updated_at=now()
FROM messages m
WHERE j.aggregate_type='message' AND j.aggregate_id=m.id::text
  AND j.status IN ('pending','retry')
  AND m.type='unsupported' AND m.metadata->>'provider'='whatsapp_web';

UPDATE messages
SET metadata=metadata||jsonb_build_object(
      'suppressed',true,
      'suppressionReason','whatsapp_technical_or_unsupported_message',
      'suppressedAt',now()
    ),
    updated_at=now()
WHERE type='unsupported' AND metadata->>'provider'='whatsapp_web'
  AND metadata->>'suppressed' IS DISTINCT FROM 'true';

WITH affected AS (
  SELECT DISTINCT conversation_id
  FROM messages
  WHERE metadata->>'suppressed'='true'
    AND metadata->>'provider'='whatsapp_web'
)
UPDATE conversations c
SET last_message_id=(
      SELECT m.id FROM messages m
      WHERE m.conversation_id=c.id
        AND m.type<>'reaction'
        AND m.metadata->>'suppressed' IS DISTINCT FROM 'true'
      ORDER BY COALESCE(m.provider_timestamp,m.sent_at) DESC,m.id DESC
      LIMIT 1
    ),
    last_message_at=COALESCE((
      SELECT COALESCE(m.provider_timestamp,m.sent_at) FROM messages m
      WHERE m.conversation_id=c.id
        AND m.type<>'reaction'
        AND m.metadata->>'suppressed' IS DISTINCT FROM 'true'
      ORDER BY COALESCE(m.provider_timestamp,m.sent_at) DESC,m.id DESC
      LIMIT 1
    ),c.created_at),
    customer_service_window_expires_at=(
      SELECT COALESCE(m.provider_timestamp,m.sent_at)+interval '24 hours'
      FROM messages m
      WHERE m.conversation_id=c.id AND m.direction='inbound'
        AND m.type<>'reaction'
        AND m.metadata->>'suppressed' IS DISTINCT FROM 'true'
      ORDER BY COALESCE(m.provider_timestamp,m.sent_at) DESC,m.id DESC
      LIMIT 1
    ),
    updated_at=now()
WHERE c.id IN (SELECT conversation_id FROM affected);

WITH affected AS (
  SELECT DISTINCT conversation_id
  FROM messages
  WHERE metadata->>'suppressed'='true'
    AND metadata->>'provider'='whatsapp_web'
)
UPDATE conversations c
SET status='archived',closed_at=COALESCE(closed_at,now()),updated_at=now()
WHERE c.id IN (SELECT conversation_id FROM affected)
  AND c.status<>'archived'
  AND NOT EXISTS (
    SELECT 1 FROM messages m
    WHERE m.conversation_id=c.id
      AND m.type<>'reaction'
      AND m.metadata->>'suppressed' IS DISTINCT FROM 'true'
  )
  -- conversations_active_identity_uq is unique on (org,channel,contact,status),
  -- so skip identities that already own an archived row.
  AND NOT EXISTS (
    SELECT 1 FROM conversations dup
    WHERE dup.organization_id=c.organization_id
      AND dup.channel_id=c.channel_id
      AND dup.contact_id=c.contact_id
      AND dup.status='archived'
      AND dup.id<>c.id
  );

WITH affected_channels AS (
  SELECT DISTINCT channel_id
  FROM messages
  WHERE metadata->>'suppressed'='true'
    AND metadata->>'provider'='whatsapp_web'
)
UPDATE channels ch
SET last_inbound_at=(
      SELECT max(COALESCE(m.provider_timestamp,m.sent_at))
      FROM messages m WHERE m.channel_id=ch.id AND m.direction='inbound'
        AND m.metadata->>'suppressed' IS DISTINCT FROM 'true'
    ),
    last_outbound_at=(
      SELECT max(COALESCE(m.provider_timestamp,m.sent_at))
      FROM messages m WHERE m.channel_id=ch.id AND m.direction='outbound'
        AND m.metadata->>'suppressed' IS DISTINCT FROM 'true'
    ),
    updated_at=now()
WHERE ch.id IN (SELECT channel_id FROM affected_channels);

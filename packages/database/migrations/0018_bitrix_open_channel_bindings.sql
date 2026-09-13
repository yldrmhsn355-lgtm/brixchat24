CREATE TABLE IF NOT EXISTS bitrix_open_channel_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  brixchat_channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  line_id text NOT NULL,
  status text NOT NULL DEFAULT 'registered',
  settings jsonb NOT NULL DEFAULT '{}',
  last_event_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bitrix_open_channel_binding_channel_uq
    UNIQUE (organization_id, brixchat_channel_id),
  CONSTRAINT bitrix_open_channel_binding_line_uq
    UNIQUE (integration_connection_id, line_id)
);

CREATE INDEX IF NOT EXISTS bitrix_open_channel_bindings_connection_idx
  ON bitrix_open_channel_bindings(integration_connection_id, status);

INSERT INTO bitrix_open_channel_bindings(
  organization_id,
  integration_connection_id,
  brixchat_channel_id,
  connector_id,
  line_id,
  status,
  settings,
  last_event_at,
  last_success_at,
  last_error,
  created_at,
  updated_at
)
SELECT
  ic.organization_id,
  ic.id,
  (ic.settings#>>'{openChannels,brixchatChannelId}')::uuid,
  oc.connector_id,
  COALESCE(oc.line_id, ic.settings#>>'{openChannels,lineId}'),
  oc.status,
  COALESCE(ic.settings->'openChannels', '{}'::jsonb)
    - 'brixchatChannelId'
    - 'lineId',
  oc.last_event_at,
  oc.last_success_at,
  oc.last_error,
  oc.created_at,
  oc.updated_at
FROM integration_connections ic
JOIN bitrix_open_channel_connectors oc
  ON oc.integration_connection_id=ic.id
WHERE ic.settings#>>'{openChannels,brixchatChannelId}' IS NOT NULL
  AND COALESCE(oc.line_id, ic.settings#>>'{openChannels,lineId}') IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE bitrix_open_channel_jobs job
SET
  status='manual_review',
  last_error='OPEN_CHANNEL_BINDING_MISSING_PRE_MIGRATION',
  locked_at=NULL,
  locked_by=NULL,
  updated_at=now()
FROM messages message
WHERE message.id=job.local_message_id
  AND job.status IN ('pending', 'retry', 'processing')
  AND NOT EXISTS (
    SELECT 1
    FROM bitrix_open_channel_bindings binding
    WHERE binding.organization_id=job.organization_id
      AND binding.integration_connection_id=job.integration_connection_id
      AND binding.brixchat_channel_id=message.channel_id
  );

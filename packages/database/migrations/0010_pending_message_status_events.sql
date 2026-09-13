CREATE TABLE IF NOT EXISTS pending_message_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_message_id text NOT NULL,
  status message_status NOT NULL,
  provider_timestamp timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, event_key)
);

CREATE INDEX IF NOT EXISTS pending_message_status_lookup_idx
  ON pending_message_status_events(organization_id, provider_message_id, created_at);

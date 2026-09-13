-- Baileys acks inbound messages before the worker persists them, so a
-- transient ingest failure (pool exhaustion, deadlock) permanently lost the
-- customer message. Failed ingests are now parked here and replayed by the
-- runtime tick until they succeed or dead-letter.
CREATE TABLE IF NOT EXISTS whatsapp_web_inbound_retries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  provider_message_id text NOT NULL,
  message jsonb NOT NULL,
  status text NOT NULL
    CHECK (status IN ('pending','processing','completed','dead_letter'))
    DEFAULT 'pending',
  attempt_count int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 10,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  locked_at timestamptz,
  locked_by text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_web_inbound_retries_event_uq
  ON whatsapp_web_inbound_retries(channel_id,provider_message_id);

CREATE INDEX IF NOT EXISTS whatsapp_web_inbound_retries_claim_idx
  ON whatsapp_web_inbound_retries(status,next_attempt_at)
  WHERE status IN ('pending','processing');

ALTER TABLE whatsapp_web_inbound_retries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_web_inbound_retries_tenant_isolation
  ON whatsapp_web_inbound_retries;
CREATE POLICY whatsapp_web_inbound_retries_tenant_isolation
  ON whatsapp_web_inbound_retries
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

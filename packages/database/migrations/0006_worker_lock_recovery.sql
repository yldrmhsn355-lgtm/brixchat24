ALTER TABLE provider_webhook_events
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text;

CREATE INDEX IF NOT EXISTS webhook_processing_lock_idx
  ON provider_webhook_events(status, locked_at, received_at);

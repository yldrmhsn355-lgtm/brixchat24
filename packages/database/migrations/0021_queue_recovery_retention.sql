ALTER TABLE crm_webhook_events
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text;

ALTER TABLE bitrix_open_channel_events
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text;

ALTER TABLE retention_jobs
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text;

CREATE INDEX IF NOT EXISTS crm_webhook_recovery_idx
  ON crm_webhook_events(status, locked_at, received_at);

CREATE INDEX IF NOT EXISTS bitrix_open_channel_event_recovery_idx
  ON bitrix_open_channel_events(status, locked_at, received_at);

CREATE INDEX IF NOT EXISTS retention_job_recovery_idx
  ON retention_jobs(status, locked_at, created_at);

CREATE INDEX IF NOT EXISTS pending_message_status_age_idx
  ON pending_message_status_events(created_at);

CREATE INDEX IF NOT EXISTS messages_conversation_sent_idx
  ON messages(conversation_id, sent_at);

CREATE INDEX IF NOT EXISTS crm_webhook_events_organization_idx
  ON crm_webhook_events(organization_id);

CREATE INDEX IF NOT EXISTS automation_events_conversation_idx
  ON automation_events(conversation_id);

CREATE INDEX IF NOT EXISTS media_download_audit_organization_idx
  ON media_download_audit(organization_id);

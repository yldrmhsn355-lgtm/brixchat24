-- event_key values are derived from provider message ids, so two
-- organizations sharing the same WABA/number produce identical keys. A
-- globally unique index silently swallowed the second tenant's status
-- events; dedupe must be tenant-scoped like pending_message_status_events.
DROP INDEX IF EXISTS message_status_event_key_uq;
CREATE UNIQUE INDEX message_status_event_key_uq
  ON message_status_events(organization_id,event_key);

-- Status webhooks resolve messages by (organization_id, provider_message_id)
-- on every delivery/read receipt; neither existing index covers that lookup.
CREATE INDEX IF NOT EXISTS messages_org_provider_message_idx
  ON messages(organization_id,provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Lets a Bitrix24 CRM automation rule / business process ("Outgoing
-- webhook" activity) trigger an outbound WhatsApp send directly, without
-- going through Bitrix24 Open Channels. The rule is configured with a URL
-- carrying a per-connection secret (automation_webhook_token_hash, hashed
-- the same way as webhook_token_hash) and, when the payload doesn't name a
-- channel explicitly, falls back to automation_default_channel_id.

ALTER TABLE integration_connections
  ADD COLUMN IF NOT EXISTS automation_webhook_token_hash text,
  ADD COLUMN IF NOT EXISTS automation_default_channel_id uuid REFERENCES channels(id) ON DELETE SET NULL;

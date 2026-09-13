# Meta WhatsApp webhook fields v25.0

This project snapshot was checked against app `1533363735080951` in the Meta
dashboard on 2026-07-19. The dashboard exposed 33 WhatsApp Business Account
fields. The following 23 fields were `Unsubscribed`:

- `account_settings_update`
- `automatic_events`
- `business_capability_update`
- `business_status_update`
- `business_username_updates`
- `flows`
- `group_lifecycle_update`
- `group_participants_update`
- `group_settings_update`
- `group_status_update`
- `history`
- `message_echoes`
- `message_template_components_update`
- `messaging_handovers`
- `partner_solutions`
- `payment_configuration_update`
- `smb_app_state_sync`
- `smb_message_echoes`
- `standby`
- `template_category_update`
- `template_correct_category_detection`
- `tracking_events`
- `user_preferences`

## Runtime contract

- The API verifies `X-Hub-Signature-256` before accepting any field.
- Each `entry[].changes[]` item gets its own deterministic deduplication key and
  durable `provider_webhook_events` row with event type `meta.<field>`.
- Phone-scoped events with an explicit, mismatching `metadata.phone_number_id`
  remain quarantined as `unmatched_channel`.
- WABA-level events without phone metadata are accepted on the already
  channel-scoped callback URL.
- The worker keeps the existing first-class `messages` handling. Every other
  field is acknowledged durably and published as
  `whatsapp.webhook.<field>` with the channel ID, field, event key, and a bounded
  list of payload keys. Raw payloads stay in the tenant-scoped durable ledger and
  are not copied into the realtime stream.
- Safe future field names are preserved; malformed names become `unknown`.

## Validation

Run the deterministic registry and routing tests:

```bash
pnpm --filter @brixchat/integrations test
pnpm --filter @brixchat/integrations typecheck
pnpm --filter @brixchat/database typecheck
pnpm --filter @brixchat/worker typecheck
pnpm --filter @brixchat/api typecheck
```

With a local API and worker running, send a signed sample for every dashboard
`Unsubscribed` field:

```powershell
$env:SIMULATOR_CHANNEL_PUBLIC_ID='<channel-public-id>'
$env:META_WHATSAPP_APP_SECRET='<app-secret>'
pnpm webhook:simulate:fields
```

Or run the isolated PostgreSQL + API + worker acceptance test. It creates and
removes its own temporary database and leaves the normal development database
untouched:

```powershell
pnpm webhook:test:fields:e2e
```

Subscribe fields in Meta only after the deployed API/worker version containing
this contract is healthy. Subscribe in small batches and verify the corresponding
`provider_webhook_events` rows reach `processed`; do not enable product-specific
fields such as payments, groups, calling, or coexistence unless that product is
actually enabled for the WABA.

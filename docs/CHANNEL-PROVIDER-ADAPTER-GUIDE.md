# Messaging provider adapter guide

This guide defines the minimum contract for adding a messaging platform to
Brixchat24 without leaking provider-specific behavior into Inbox.

## Domain boundaries

- **Provider** authenticates and calls an external service: Meta, Telegram,
  Twilio or an email transport.
- **Platform** is the user-visible messaging type: WhatsApp, Instagram,
  Messenger, Telegram, SMS, email or web chat.
- **Provider account** owns reusable credentials and an external account
  identity. A Meta WABA is one provider account.
- **Channel** is one selectable Inbox endpoint. A WhatsApp phone number is one
  channel, even when several numbers share a WABA.
- **Integration** is a non-messaging external system. Bitrix24 remains a CRM
  integration and must not be registered in the messaging catalog.

## Availability lifecycle

Definitions live in
`packages/integrations/src/messaging/provider-catalog.ts`.

- `available`: the real adapter, credentials, webhook validation and acceptance
  suite exist; production creation may be enabled.
- `coming_soon`: shown as disabled product discovery only.
- `unavailable`: hidden or disabled due to policy/operational constraints.
- `development_only`: deterministic local/test adapter; production must reject
  it.

Changing a definition to `available` is a release decision, not a UI-only
change. `requireCreatableProviderDefinition` fails closed when the definition
is not enabled.

## Required adapter behavior

An adapter implements `MessagingProvider` from
`packages/integrations/src/messaging/types.ts`. Unsupported operations must
return a stable, non-retryable `ProviderError`; they must never simulate
success.

Before enabling a new definition:

1. Implement text sending and stable provider-message IDs.
2. Implement only the optional operations declared in `capabilities`.
3. Normalize provider errors into retryable/non-retryable `ProviderError`.
4. Apply bounded request timeouts and rate-limit-aware retries.
5. Verify webhook authenticity before durable acceptance.
6. Produce deterministic event keys for provider deduplication.
7. Normalize inbound events into the canonical conversation/message model.
8. Store provider IDs as lossless strings and timestamps in UTC.
9. Keep credentials encrypted on the provider account and redact every API/log
   surface.
10. Add real external acceptance before production enablement.

## Factory registration

`createMessagingProvider` receives both `provider` and `platform`. Never select
an adapter from a global production mode or from a frontend-supplied channel
identifier. Outbound workers derive the provider/platform from the message's
conversation channel.

To add an adapter:

1. Add a provider/platform definition with `coming_soon`.
2. Implement the adapter and unit tests under
   `packages/integrations/src/<provider>/`.
3. Add an explicit factory branch.
4. Add provider-account credential validation and rotation.
5. Add webhook intake and signature tests if webhooks are supported.
6. Add worker normalization, status and media tests.
7. Add disabled-to-enabled UI acceptance.
8. Run authenticated external acceptance and only then set `available` and
   `isEnabled: true`.

## Capability rules

UI and API actions are capability-driven:

- `templates` and `template_sync` gate WhatsApp template actions.
- `media` gates upload/send controls and media worker flows.
- `webhooks` gates callback setup and token rotation.
- `read_receipts`, `delivery_receipts`, `reactions`, `interactive` and `typing`
  must not appear when the adapter does not implement them.

Database capability overrides may remove a provider capability for a specific
channel. They may not invent an unsupported provider capability.

## Canonical Inbox routing

- A conversation has exactly one authoritative `channel_id`.
- Outbound APIs accept a conversation, not an arbitrary sending channel.
- The outbox worker loads provider, platform, endpoint and credentials from that
  channel/provider account.
- Restricted users must have channel ownership before listing, reading or
  replying.
- Realtime refresh, search, pagination and URL filters preserve the selected
  channel.

For Meta WABAs with multiple phone numbers, the callback anchor may be one
channel, but every phone-scoped change is rerouted by `phone_number_id` inside
the same tenant/provider account.

## Security checklist

- No access token, app secret, webhook token or decrypted envelope in logs,
  audit metadata, responses or realtime payloads.
- Credential writes require a configured 32-byte encryption key.
- Verify tokens are one-time values and are stored only as hashes.
- Production has no local webhook-secret fallback.
- Webhook signatures use the raw request body.
- Tenant, provider-account and channel endpoint predicates are all checked.
- Archive clears channel-local secrets; the shared provider account is cleared
  only after its final active channel is archived.
- Destructive provider calls are explicit, audited and safely retryable.

## Test matrix

- Catalog availability/capabilities and factory fail-closed behavior.
- Provider request/response, timeouts, retry taxonomy and unsupported methods.
- Credential encryption, merging, rotation, redaction and archive cleanup.
- Signature, callback verification, endpoint mismatch and duplicate events.
- Inbound canonicalization and outbound conversation-channel invariants.
- Status-before-message reconciliation and no status regression.
- Direct and restricted-role channel access.
- Responsive add/edit/disabled-provider UI.
- Migration backfill with multiple channels under one provider account.
- Real create/delete/send/delivery/inbound acceptance for the enabled provider.

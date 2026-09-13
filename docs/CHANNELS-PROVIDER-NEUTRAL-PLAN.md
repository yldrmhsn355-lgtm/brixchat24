# Channels provider-neutral architecture plan

Status: Phase 0 complete; implementation proceeds phase by phase without a
second approval checkpoint.

## Scope and invariants

- Production messaging remains Meta WhatsApp Cloud API only.
- This document records the earlier Cloud-only slice. It is superseded for the
  current channel architecture by
  [`CHANNELS-CLOUD-WEB-REDESIGN-PLAN.md`](./CHANNELS-CLOUD-WEB-REDESIGN-PLAN.md),
  which keeps Cloud API and the optional Baileys linked-device adapter as
  separate providers. `whatsapp-web.js` remains out of scope.
- Instagram, Messenger, Telegram, SMS, email and web chat are represented only
  as unavailable provider definitions until real credentials, webhooks and
  adapters exist.
- Bitrix24 remains a CRM integration. It is not a messaging provider or channel.
- Existing channel, conversation, contact, message and outbox identifiers stay
  stable. Existing credentials are never returned by an API.

## 1. Current end-to-end channel architecture

The Next.js channels screen calls the Fastify product routes. Those routes
persist a tenant-scoped `channels` row, encrypt Meta credentials, create a
per-channel webhook verify-token hash and subscribe the Meta app to the WABA.
Conversations carry a mandatory `channel_id`; messages normally copy the same
channel. Outbound requests create messages and transactional outbox jobs.
Workers claim jobs with `SKIP LOCKED`, decrypt the selected channel credentials
and call the messaging provider. Provider callbacks are durably recorded before
worker processing.

Primary files:

- `apps/web/app/app/channels/page.tsx`
- `apps/api/src/product-routes.ts`
- `apps/api/src/app.ts`
- `packages/database/src/schema.ts`
- `packages/database/src/repositories/index.ts`
- `packages/database/src/repositories/worker.ts`
- `apps/worker/src/index.ts`
- `packages/integrations/src/messaging/*`
- `packages/integrations/src/meta-whatsapp/provider.ts`

## 2. WhatsApp Cloud API connection model

A channel currently combines four concepts: Meta provider, WABA, WhatsApp phone
endpoint and Inbox-visible channel. `business_account_id`, `phone_number_id`,
phone number and encrypted credentials are stored on every channel. Creation
subscribes the application to the WABA and returns the one-time verify token.
Deletion unsubscribes the WABA, archives the row, clears secrets and rotates the
public webhook identifier.

The current duplicate predicate rejects the same `business_account_id`, which
incorrectly prevents multiple phone-number channels under one WABA. A provider
account layer and phone-number-level uniqueness are required.

## 3. Inbound webhook flow

`GET /webhooks/meta/whatsapp/:channelPublicId` verifies the hashed channel token.
`POST` resolves the public channel, verifies `x-hub-signature-256`, validates
the Meta envelope and persists a deduplicated `provider_webhook_events` row.
The worker claims the event, normalizes messages/statuses, canonicalizes the
contact and conversation by organization + channel + contact, writes messages,
reconciles early status callbacks and emits realtime events. Channel webhook
timestamps/results are updated by the durable processing path.

## 4. Outbound flow

The API first resolves the tenant conversation, enforces channel ownership for
restricted roles, creates a message and an outbox job in one transaction.
The worker resolves that message's channel and credentials, calls
`MessagingProvider`, records the provider ID and advances status. Retryable
failures use delayed retry; permanent/exhausted failures become dead-letter.
The conversation channel is authoritative, so an arbitrary outbound channel
must never be accepted from the client.

## 5. Channel and conversation relationship

`conversations.channel_id` is mandatory and participates in the active
conversation identity constraint. `messages.channel_id` is available for
provider routing and evidence. This is already the correct canonical seam for
multiple channels and must not be replaced by a provider-specific Inbox model.

## 6. Inbox channel filter

The conversation repository supports `channelId` together with search, cursor
pagination, labels, assignment, unread and status filters. The web filter state
is URL-backed, so refresh and pagination preserve the selection. Realtime
refreshes reuse the current query. The remaining requirement is to source the
channel picker from access-filtered provider-neutral channel metadata and prove
that every read/detail/send route applies the same access predicate.

## 7. Credential storage and security

Meta access tokens/app secrets are AES-256-GCM encrypted with the application
encryption key. Verify tokens are stored only as hashes and credentials are
redacted from API responses. Rotation is audited and rate-limited. The current
weakness is ownership: credentials are channel-local even when several phone
numbers share a WABA. Provider accounts will become the credential owner while a
compatibility read path preserves existing deployments during migration.

## 8. Health checks

Channel health calls the real provider profile/subscription checks and persists
health state, code and timestamp. Connection state and health state currently
use overlapping legacy strings (`connected`, `disconnected`,
`configuration_required`, `unhealthy`). New explicit connection and health
fields will separate lifecycle from operational health.

## 9. Webhook health tracking

The database records last webhook time/result and worker failures. The channel
screen exposes only the latest event. Operations need stale-webhook detection,
last error detail without secrets, and safe recheck/resubscribe actions.

## 10. Template synchronization

Manual and periodic sync use the channel's WABA/token, upsert templates by
tenant/WABA/name/language, archive missing provider templates, record sync runs,
audit outcomes and notify on failures. Template capabilities must therefore be
declared by the channel definition instead of assumed for every provider.

## 11. Provider-specific coupling blocking expansion

- `channels.provider` is limited to `meta|fake` and also acts as platform type.
- Phone number is mandatory for every channel.
- WABA, endpoint and credentials live on the same row.
- The duplicate check treats a WABA as one channel.
- UI renders WhatsApp fields and actions unconditionally.
- Provider factory selects only `meta|fake`.
- Health, templates and webhook actions are exposed by provider-name branches
  instead of capability checks.
- Contacts require a normalized phone, so future email/web identities need a
  canonical identity table before real adapters are enabled.

## 12. Frontend/backend/database gaps

The UI offers a fake provider even though it is not a production feature. The
API exposes organization-wide channel lists/details to any role with
`inbox:read`; agent/team-lead ownership is applied in conversation queries but
not consistently at the channel resource boundary. Database columns do not
express platform, provider account, endpoint, availability or capability
overrides.

## 13. Workspace and channel authorization risks

Every query is organization-scoped, which prevents cross-tenant ID access.
However restricted roles can enumerate channel metadata and call channel detail
unless list/detail routes add ownership predicates. All channel-derived
resources and sends must use one shared access rule; frontend filtering is not a
security boundary.

## 14. Data model and migration

Phase 1 adds:

- Static provider definitions and capability contracts.
- `provider_accounts` with tenant ownership, external account identity,
  encrypted credentials, lifecycle timestamps and archive semantics.
- A nullable `channels.provider_account_id`.
- Explicit `platform`, `external_channel_id`, identity, configuration,
  capability overrides, connection status, health state and operational
  timestamps.
- A backfill that groups existing Meta channels by tenant + WABA while
  preserving channel IDs and current encrypted credentials.
- Active uniqueness at provider endpoint level, not WABA level.

The legacy fields remain during the compatibility window. No destructive
column migration is required.

## 15. File plan

Create:

- `packages/integrations/src/messaging/provider-catalog.ts`
- `packages/integrations/src/messaging/provider-catalog.test.ts`
- `packages/database/migrations/0014_provider_neutral_channels.sql`
- `docs/CHANNEL-PROVIDER-ADAPTER-GUIDE.md`

Modify:

- `packages/integrations/src/index.ts`
- `packages/integrations/src/messaging/types.ts`
- `packages/integrations/src/messaging/provider-factory.ts`
- `packages/database/src/schema.ts`
- `packages/database/src/repositories/index.ts`
- `packages/database/src/repositories/worker.ts`
- `apps/api/src/product-routes.ts`
- `apps/api/src/app.ts`
- `apps/worker/src/index.ts`
- `apps/web/app/app/channels/page.tsx`
- `apps/web/app/app/inbox/workspace.tsx`
- focused API/database/web/integration tests and styling

## 16. Backward compatibility risks

- Old deployments still expect credentials on `channels`.
- Existing status strings cannot be changed atomically without updating API,
  worker and UI consumers.
- One WABA unsubscribe must not disconnect sibling phone channels.
- Provider-account backfill must be deterministic and tenant-scoped.
- Existing webhooks use `channels.public_id`; it must remain unchanged.
- Archived channels must retain historical conversation/message references.

## 17. Tests and acceptance criteria

- Migration safety and idempotent backfill.
- Provider catalog returns Meta WhatsApp as available and all future platforms
  as unavailable; unavailable definitions cannot be created.
- Multiple phone IDs under one WABA can be created; duplicate phone IDs cannot.
- Agent/team-lead channel list/detail and conversations honor ownership.
- Outbound text/template/media always resolves the conversation's channel.
- Invalid signatures, mismatched phone metadata and duplicate callbacks fail or
  deduplicate safely.
- Credential responses/logs contain no tokens or app secrets.
- Channel selection survives URL refresh, search, pagination and realtime.
- Existing Meta integration, worker, API and web tests pass; lint, typecheck,
  build, architecture checks and Graphify update pass.
- Production deployment requires backup evidence, safe migration gate and real
  Meta acceptance; unavailable providers are never reported as connected.

## 18. Phased execution

1. Provider-neutral domain and capability catalog.
2. Meta adapter and multi-phone WABA routing hardening.
3. Credential ownership, webhook validation and rotation security.
4. Provider-neutral channel management cards and state presentation.
5. Capability-driven add/edit experience.
6. Access-filtered Inbox channel selector and send invariants.
7. Health, sync and operations controls.
8. Channel RBAC/team ownership enforcement.
9. Realtime, analytics, audit and notifications.
10. Adapter developer guide and unavailable provider skeleton.
11. Full migration, regression, responsive, build and release validation.

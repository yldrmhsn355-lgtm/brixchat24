# Spec: Milestone 2 — Live Messaging Infrastructure

**Author:** Codex with user-provided requirements
**Date:** 2026-07-16
**Status:** Approved
**Reviewers:** Repository owner (approval supplied with implementation request)
**Related specs:** `docs/ARCHITECTURE.md`, Milestone 1 implementation

## Context

Milestone 1 established a working Turborepo with Next.js, Fastify, BullMQ, PostgreSQL, Redis, JWT/RBAC and a responsive inbox. The current API and frontend still read `demoConversations` and `demoMessages`, the worker only acknowledges BullMQ jobs, and the initial schema lacks the provider event ledger, status history, trace events and locking fields needed for durable delivery.

Milestone 2 replaces mock runtime data with tenant-scoped PostgreSQL repositories and completes the live message boundary. A fake provider supplies deterministic local acceptance without pretending that real Meta credentials exist. Meta integration remains selectable through dependency injection and must apply timeout, redaction, normalized errors, signed webhook verification and provider-specific mapping behind the common domain interface.

## Current Repository Analysis

1. Monorepo: `apps/web`, `apps/api`, `apps/worker`, plus auth, config, database, integrations, observability, shared, UI and validation packages.
2. Schema: users, organizations, organization_members, teams, channels, contacts, conversations, messages, outbox_jobs and audit_logs.
3. Mock sources: `packages/shared/src/index.ts`; imported directly by API routes and inbox component.
4. Auth/RBAC: Fastify JWT pre-handler uses organization and role claims; permissions are defined in `@brixchat/auth`.
5. Worker: one BullMQ `message-outbox` consumer that logs jobs without database state transitions.
6. Redis: BullMQ connects from `REDIS_URL`; no pub/sub or durable DB dispatcher exists.
7. Frontend state: local React state with no server query cache or realtime transport.
8. Optimistic send: inserts a local pending message, calls API, but does not reconcile success/failure.
9. Missing schema: channel credentials/health fields, conversation last-message pointer/window, message provider context, webhook ledger, status events, flow events and concurrency-safe outbox locking.
10. Change surface: database schema/migration/seed/repositories; API modules/routes; integration providers; worker dispatcher; web data/realtime hooks; tests; Docker; environment and README.

## Functional Requirements

- FR-1: Runtime conversation and message endpoints MUST read PostgreSQL repositories and MUST NOT import demo fixtures.
- FR-2: Every tenant repository method MUST receive `organizationId` explicitly and constrain its query by that value.
- FR-3: Conversation lists MUST support opaque cursor pagination with a default limit of 30 and maximum limit of 100.
- FR-4: Conversation lists MUST support status, assignee, channel, search and unread filters.
- FR-5: Agent conversation access MUST be limited to assigned or unassigned conversations; owner/admin access MUST cover the organization.
- FR-6: Sending a text message MUST atomically insert a pending message, an outbox job and initial message flow events.
- FR-7: Repeated `clientMessageId` within one organization MUST return the original message without creating another message or outbox job.
- FR-8: Free-text sends MUST be rejected with `WHATSAPP_TEMPLATE_REQUIRED` when the customer-service window is closed.
- FR-9: The PostgreSQL outbox MUST be the delivery source of truth and MUST use concurrency-safe claims with `FOR UPDATE SKIP LOCKED`.
- FR-10: Worker retries MUST use 5s, 30s, 2m and 10m delays, then transition to dead letter after the fifth failure.
- FR-11: Worker success MUST persist provider message ID, mark the message sent, complete the outbox job and publish a realtime event.
- FR-12: Worker permanent failure MUST mark the message failed without exposing raw provider errors to the frontend.
- FR-13: A `FakeMessagingProvider` MUST support success, temporary failure, permanent failure and configurable latency.
- FR-14: A `MetaWhatsAppCloudProvider` MUST send text through the configured Graph API version using AbortController timeout and normalized errors.
- FR-15: Channel access token and app secret MUST be stored as AES-256-GCM encrypted envelopes and MUST NOT be returned by APIs.
- FR-16: GET webhook verification MUST compare verify tokens safely and return the challenge as plain text only for subscribe mode.
- FR-17: POST webhook ingestion MUST verify `X-Hub-Signature-256` against the preserved raw body before processing events.
- FR-18: Webhook ingestion MUST derive deterministic event keys and acknowledge duplicate events without enqueueing duplicate work.
- FR-19: Incoming text/media/location/contact payloads MUST normalize into common message records while preserving provider metadata.
- FR-20: Incoming sender phones MUST be normalized to E.164 and contacts MUST be upserted by organization plus phone.
- FR-21: Incoming messages MUST upsert an active conversation, increment unread count and extend the customer-service window by 24 hours.
- FR-22: Status webhooks MUST persist idempotent status events and MUST NOT regress sent/delivered/read priority.
- FR-23: Authenticated SSE MUST emit organization-scoped conversation/message/channel events and MUST send reconnect hints.
- FR-24: The inbox MUST fetch real conversations/messages, reconcile optimistic messages and apply realtime updates without duplicate event IDs.
- FR-25: Channel list/health/test endpoints MUST hide secrets; channel tests MUST require owner/admin permissions.
- FR-26: A signed local webhook simulator MUST create Meta-compatible incoming and status payloads without real credentials.
- FR-27: Message flow events MUST record accepted, outbox, provider, webhook, status and realtime lifecycle steps with a trace ID.
- FR-28: Read endpoint MUST reset unread count and publish `conversation.read`.

## Non-Functional Requirements

- NFR-1: Webhook POST MUST complete signature validation, ledger insert and enqueue attempt before returning and MUST NOT perform provider or contact processing inline.
- NFR-2: Tenant-owned queries MUST include an organization predicate; cross-tenant integration tests MUST return no data.
- NFR-3: Tokens, secrets, credentials, authorization headers and message text MUST be redacted from structured logs.
- NFR-4: Provider HTTP calls MUST time out within 15 seconds.
- NFR-5: Outbox claims MUST prevent two workers from owning the same unexpired lock.
- NFR-6: Old outbox locks MUST become claimable after 2 minutes.
- NFR-7: SSE events MUST contain eventId, eventType, organizationId, entityType, entityId, occurredAt and payloadVersion.
- NFR-8: API validation limits MUST reject more than 100 list items and text exceeding 4096 characters.
- NFR-9: Encryption MUST use a 32-byte key, unique 12-byte IV and 16-byte authentication tag.
- NFR-10: Existing Milestone 1 endpoint paths and response envelope conventions MUST remain backward compatible.

## Acceptance Criteria

### AC-1: Database conversation list (FR-1, FR-2, FR-3, FR-4)

Given seeded conversations in PostgreSQL
When an authenticated owner requests `/api/v1/conversations`
Then the response contains database-backed contact, channel, assignee, last-message and unread data
And the response contains an opaque next cursor or null.

### AC-2: Tenant isolation (FR-2, FR-5, NFR-2)

Given conversations for tenant A and tenant B
When a tenant A token requests conversations or messages
Then no tenant B record is returned.

### AC-3: Transactional send (FR-6, FR-7)

Given an accessible conversation with an open customer-service window
When a valid text message is posted twice with one clientMessageId
Then exactly one pending message and one outbox job exist
And both API responses identify the same message.

### AC-4: Closed messaging window (FR-8)

Given a conversation whose service window expired
When an agent posts free text
Then the API returns 409 with code `WHATSAPP_TEMPLATE_REQUIRED`
And creates no message or outbox job.

### AC-5: Worker success (FR-9, FR-11, FR-13)

Given a pending outbox job and fake provider success mode
When the worker claims the job
Then the message becomes sent with one provider message ID
And the job becomes completed.

### AC-6: Worker failure policy (FR-10, FR-12, FR-13)

Given fake provider temporary or permanent failure modes
When delivery is processed
Then temporary failures schedule the specified backoff
And permanent or exhausted failures mark the message failed/dead-letter with normalized codes.

### AC-7: Webhook security (FR-16, FR-17, NFR-3)

Given a channel with encrypted webhook credentials
When verification or ingestion uses an invalid token/signature
Then the API returns 403/401 and queues no event
And no secret appears in logs or responses.

### AC-8: Idempotent incoming webhook (FR-18, FR-19, FR-20, FR-21)

Given one valid signed incoming message payload replayed twice
When webhook work is processed
Then one webhook event, contact, active conversation and provider message exist
And the conversation unread count/window are updated once.

### AC-9: Monotonic statuses (FR-22)

Given a sent outgoing message
When read arrives before delivered and both events are replayed
Then final status remains read
And duplicate status ledger records are not created.

### AC-10: Realtime isolation (FR-23, NFR-7)

Given authenticated SSE clients for two organizations
When a tenant A message event is published
Then only the tenant A stream receives the versioned event.

### AC-11: Real inbox integration (FR-24)

Given a logged-in user and running API
When inbox loads, sends a message and receives a realtime status event
Then database conversations/messages render
And the optimistic message reconciles by clientMessageId without duplication.

### AC-12: Channel health authorization (FR-25)

Given owner and agent users
When both call the channel test endpoint
Then owner receives a normalized health result
And agent receives 403.

### AC-13: Encryption round trip (FR-15, NFR-9)

Given a valid encryption key and credential payload
When encrypted then decrypted
Then the original value is recovered
And ciphertext does not contain the plaintext.

### AC-14: Simulator end-to-end (FR-26)

Given fake-provider development mode
When incoming and status simulator commands run
Then their signatures are accepted and the database/realtime state changes are observable.

### AC-15: Traceability (FR-27)

Given an outbound or inbound message flow
When lifecycle steps complete
Then message_flow_events contain the shared trace ID and named steps.

### AC-16: Read conversation (FR-28)

Given an unread accessible conversation
When `/api/v1/conversations/:id/read` is posted
Then unread count becomes zero and `conversation.read` is published.

### AC-17: Meta adapter request handling (FR-14)

Given meta provider mode with configured development test credentials and a mocked Graph endpoint
When a text send succeeds, times out or returns a provider error
Then success extracts `messages[0].id`
And failures are classified without exposing the access token or raw response body.

## Edge Cases and Error Scenarios

- EC-1: PostgreSQL unavailable → API returns generic 503/500 without connection details; durable rows remain intact.
- EC-2: Redis unavailable during webhook enqueue → stored webhook event remains pending for dispatcher recovery.
- EC-3: Meta timeout/429/5xx → normalized temporary failure and scheduled retry.
- EC-4: Meta 400/401 or unsupported type → normalized permanent failure, no retry beyond policy.
- EC-5: Concurrent duplicate clientMessageId → unique constraint plus transaction returns the existing row.
- EC-6: Concurrent duplicate provider message → channel/provider unique constraint prevents a second message.
- EC-7: Webhook without a native event ID → SHA-256 deterministic key from stable payload coordinates.
- EC-8: Malformed raw JSON with valid-looking signature → 400, no event record.
- EC-9: Out-of-order read before delivered → status remains read.
- EC-10: Stale worker lock → claimable after lock timeout; active lock is skipped.
- EC-11: SSE reconnect → client reconnects with backoff and refetches authoritative lists/messages.
- EC-12: Missing Meta credentials in meta mode → channel health unhealthy; no fake success is reported.

## API Contracts

```ts
interface Page<T> {
  data: T[];
  page: { nextCursor: string | null };
}
interface ApiError {
  error: { code: string; message: string; requestId?: string };
}
interface SendMessageRequest {
  clientMessageId: string;
  type: "text";
  text: string;
}
interface SendMessageResponse {
  data: MessageDto;
}
interface RealtimeEvent {
  eventId: string;
  eventType: string;
  organizationId: string;
  entityType: string;
  entityId: string;
  conversationId?: string;
  occurredAt: string;
  payloadVersion: 1;
  payload: Record<string, unknown>;
}
```

- `GET /api/v1/conversations?cursor&limit&status&assignee&channelId&search&unreadOnly` → 200 `Page<ConversationDto>`; 401/403/400/500 errors.
- `GET /api/v1/conversations/:id` → 200 `{data:ConversationDto}`; 401/403/404.
- `GET /api/v1/conversations/:id/messages?cursor&limit` → 200 `Page<MessageDto>`; 401/403/404.
- `POST /api/v1/conversations/:id/messages` → 202 `{data:MessageDto}`; 400/401/403/404/409.
- `POST /api/v1/conversations/:id/read` → 200 `{data:{conversationId,unreadCount:0}}`.
- `GET /api/v1/realtime?access_token=` → `text/event-stream`; 401 before stream establishment.
- `GET /api/v1/channels` and `GET /api/v1/channels/:id/health` → secret-free DTOs.
- `POST /api/v1/channels/:id/test` → owner/admin only health result.
- `GET /webhooks/meta/whatsapp/:channelPublicId` → plain challenge or 403.
- `POST /webhooks/meta/whatsapp/:channelPublicId` → 200 `{accepted,duplicates}`; 400/401/404.

## Data Models

| Entity               | Key fields and constraints                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel              | UUID PK; organization FK; unique public ID; provider/name/status/phone; encrypted credentials; verify hash; webhook/success/error timestamps; organization indexes                                          |
| Contact              | UUID PK; organization FK; display name, normalized phone, profile/language/country; unique organization+phone                                                                                               |
| Conversation         | UUID PK; organization/channel/contact FKs; assignee; status/priority; last message; unread/window; unique active organization+channel+contact identity                                                      |
| Message              | UUID PK; organization/conversation/channel/contact FKs; sender; direction/type/text/status; client/provider IDs; reply/provider time/errors/metadata; unique organization+client ID and channel+provider ID |
| ProviderWebhookEvent | UUID PK; nullable organization/channel; provider+event key unique; payload/signature/status/attempt/error/received/processed timestamps                                                                     |
| OutboxJob            | UUID PK; organization/aggregate; job/payload/status; attempts/max/next; lock owner/time; error/completed timestamps; status scheduling indexes                                                              |
| MessageStatusEvent   | UUID PK; organization/message; provider ID/status/time/payload/deterministic key; unique event key                                                                                                          |
| MessageFlowEvent     | UUID PK; organization/message; trace/event/source/payload/time; trace and message indexes                                                                                                                   |

All timestamps are timezone-aware UTC. Tenant entities are hard-deleted only through future retention workflows; runtime repositories do not expose cross-tenant records.

## Out of Scope

- OS-1: Campaigns, AI auto-replies and advanced CRM — explicitly deferred beyond Milestone 2.
- OS-2: Template creation UI — Milestone 3; Milestone 2 only returns template-required state.
- OS-3: Instagram, Telegram, Gmail and Bitrix — separate provider/connectors.
- OS-4: Billing, mobile apps and advanced analytics — unrelated to live messaging acceptance.
- OS-5: Downloading provider media into object storage — metadata persistence only in this milestone.
- OS-6: Real Meta phone acceptance without credentials/external phone — reported as manual verification, never simulated as live success.

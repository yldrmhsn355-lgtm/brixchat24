# Spec: Milestone 4 — Bitrix24 Integration and Advanced Conversation Operations

**Author:** Codex with user-provided requirements
**Date:** 2026-07-16
**Status:** Approved
**Reviewers:** Repository owner (approval supplied with implementation request)
**Related specs:** `docs/MILESTONE-3-SPEC.md`, `docs/ARCHITECTURE.md`

## Context

Milestone 3 provides production authentication, tenant-scoped channel management, templates, quick replies, notifications, and a durable WhatsApp outbox. Agents still lack CRM context and the inbox lacks the operational controls needed for ownership, collaboration, triage, and high-volume work.

Milestone 4 integrates Bitrix24 as the external CRM and source of truth. Brixchat24 MUST NOT become a parallel CRM: it stores provider connections, mappings, cached display context, idempotent events, and asynchronous synchronization state only. Wazzup's Bitrix product is a behavioral reference for keeping CRM context and handoffs close to the conversation; no proprietary implementation or visual design is copied. The WhatsApp send/receive critical path MUST remain available when Bitrix24 is slow or unavailable.

## Functional Requirements

- FR-1: The system MUST expose a provider-neutral `CrmProvider` contract and Bitrix24 plus deterministic fake implementations.
- FR-2: Owner/admin users MUST connect Bitrix24 through OAuth 2.0 or an incoming webhook URL, store credentials encrypted, test health, disable, reconnect, and disconnect a tenant-scoped connection.
- FR-3: OAuth MUST validate `state`, bind the returned portal/member identity to the initiating tenant, exchange the code server-side, and never expose refresh/access tokens to the browser or logs.
- FR-4: The Bitrix REST client MUST support webhook and OAuth authentication, bounded timeout, normalized errors, retry/backoff, pagination, and batch requests.
- FR-5: The product MUST synchronize Bitrix users and support explicit local-user mappings, with unmapped and inactive states visible.
- FR-6: Contact matching MUST normalize phone/email, search Bitrix contacts first and leads second, record confidence/source, avoid silent ambiguous matches, and permit authorized manual linking.
- FR-7: The inbox MUST display cached Bitrix contact, lead/deal, responsible user, pipeline, stage, company, and safe custom-field context without blocking conversation loading.
- FR-8: Authorized users MUST create a Bitrix contact, lead, or deal from a conversation and link the returned external entity; the system MUST NOT create local CRM equivalents.
- FR-9: Pipeline/category/stage metadata MUST be fetched from Bitrix, cached with freshness metadata, and used for deal creation and context display.
- FR-10: Outbound/inbound conversation events MUST enqueue a separate CRM timeline job; Bitrix writes MUST use timeline comments and, where configured, current todo activity APIs.
- FR-11: CRM jobs MUST be idempotent, independently retryable, observable, dead-letterable, and MUST NOT delay or fail WhatsApp delivery.
- FR-12: `POST /webhooks/bitrix24/:connectionPublicId` MUST validate the connection token, persist a deduplicated form-encoded event, return 200 quickly, and defer processing to the worker.
- FR-13: Bitrix responsible-user changes and local conversation assignments MUST synchronize bidirectionally when enabled, using origin/version markers to prevent loops.
- FR-14: Owner/admin users MUST configure field mappings, sync direction, timeline behavior, entity creation defaults, pipeline/category/stage defaults, and responsible-user rules.
- FR-15: The inbox MUST support manual assignment/unassignment, team assignment, bulk assignment, deterministic assignment rules, round-robin, capacity limits, and auditable assignment history.
- FR-16: Conversation operations MUST support open, waiting, snoozed, closed, archived, and spam states; reopen, snooze-until, priority, pin, mute, and block controls; and immutable status history.
- FR-17: Organization-scoped labels MUST support CRUD, color, attach/detach, filter, and bulk operations.
- FR-18: Internal notes MUST support create/edit/delete, mentions, replies, tenant-scoped visibility, audit history, and in-app notifications without being sent to WhatsApp.
- FR-19: Conversation list APIs and UI MUST support query, assignee/team/status/priority/label/channel/date/unread/pinned/muted/CRM-linked filters, cursor pagination, sorting, bulk actions, and personal/shared saved views.
- FR-20: Conversation export MUST be permission-gated, tenant-scoped, streamed as CSV or JSON, audited, and exclude credentials and internal secret metadata.
- FR-21: All CRM and conversation mutations MUST enforce tenant scope and RBAC with explicit permissions for integration management, CRM writes, assignment, bulk actions, notes, export, and label/view management.
- FR-22: Durable notification creation MUST publish a Redis organization event after commit; Redis failure MUST NOT roll back the domain mutation.
- FR-23: The integration UI MUST provide `/app/integrations`, `/app/integrations/bitrix24`, and connect/settings/mappings/users/sync/logs surfaces with loading, empty, error, permission, retry, and disconnected states.
- FR-24: The fake Bitrix provider MUST cover success, empty, pagination, ambiguous contact, timeout, auth failure, rate limit, permission denial, invalid payload, duplicate webhook, and temporary/permanent write failure scenarios.
- FR-25: Migration `0003_bitrix24_and_conversation_operations.sql`, seed fixtures, environment documentation, and Docker configuration MUST support deterministic local acceptance without real Bitrix credentials.
- FR-26: Existing authentication, channel, WhatsApp webhook, template, quick-reply, outbox, SSE, and tenant-isolation behavior MUST remain compatible.

## Non-Functional Requirements

- NFR-1: Bitrix credentials MUST use the existing authenticated encryption envelope; connection tokens and OAuth state MUST be hashed or constant-time compared and all secret fields MUST be log-redacted.
- NFR-2: Bitrix requests MUST time out within 12 seconds, retry retryable calls at most 5 times with capped exponential backoff and jitter, and honor provider rate-limit hints.
- NFR-3: Webhook acknowledgement SHOULD complete within 500 ms after durable persistence under normal local database conditions.
- NFR-4: Every tenant-owned query MUST constrain `organization_id`; inaccessible IDs MUST not disclose cross-tenant existence.
- NFR-5: Webhook and job idempotency MUST be enforced by database unique keys, not process memory.
- NFR-6: Conversation list first-page and cached CRM-context endpoints SHOULD complete within 500 ms at 10,000 conversations per tenant with documented indexes.
- NFR-7: CRM context cache MUST expose `fetchedAt`, `staleAt`, and last-error state and MUST render stale data explicitly.
- NFR-8: Bulk mutations MUST be bounded to 100 conversation IDs per request and execute transactionally per local domain mutation.
- NFR-9: Notes, exports, webhooks, and CRM payloads MUST be validated with bounded strict schemas; message/credential contents MUST not appear in operational logs.
- NFR-10: New interactive controls MUST be keyboard reachable, visibly focused, labeled, and meet WCAG AA contrast expectations.
- NFR-11: The worker MUST isolate WhatsApp and CRM failures so a CRM backlog cannot starve message/webhook processing.
- NFR-12: Lint, typecheck, unit/integration/E2E, build, migration/seed, and Docker health gates MUST remain green.

## Acceptance Criteria

### AC-1: Secure connection lifecycle (FR-1, FR-2, FR-3, NFR-1)

Given an owner and an agent, when each attempts OAuth or webhook connection and the owner completes a valid flow, then only the owner succeeds, state/tenant binding is verified, encrypted credentials persist, and no response or log contains a token.

### AC-2: Normalized client behavior (FR-4, FR-24, NFR-2)

Given paginated, rate-limited, timed-out, malformed, unauthorized, and successful fake responses, when the client executes a provider operation, then pagination/batch results are normalized and only retryable failures retry within the configured bound.

### AC-3: User sync and mappings (FR-5, FR-13)

Given Bitrix and local users, when sync and explicit mapping run, then tenant-scoped mappings show mapped/unmapped/inactive states and a responsible change resolves only through an active mapping.

### AC-4: Contact matching and ambiguity (FR-6)

Given exact, absent, and multiple normalized phone matches, when a conversation is matched, then exact evidence links once, no match remains unlinked, and ambiguity requires an authorized manual choice.

### AC-5: Nonblocking CRM context (FR-7, FR-9, NFR-7)

Given fresh, stale, missing, and failed Bitrix context, when a conversation opens, then chat content renders independently and the CRM panel shows the cached context, freshness, retry, or empty/error action.

### AC-6: External entity creation (FR-8, FR-14)

Given authorized defaults and a linked or unlinked conversation, when contact/lead/deal creation is requested, then Bitrix receives the mapped fields, one external link is persisted, duplicates are prevented, and no local CRM entity is created.

### AC-7: Asynchronous timeline write (FR-10, FR-11, NFR-11)

Given a WhatsApp message event while Bitrix is unavailable, when message processing completes, then WhatsApp state/realtime completes normally, a separate CRM job retries, and successful replay writes one timeline record.

### AC-8: Idempotent webhook intake (FR-12, NFR-3, NFR-5)

Given duplicate valid Bitrix form events and an invalid token, when delivered, then valid duplicates receive 200 with one persisted event and invalid requests are rejected without processing.

### AC-9: Loop-free responsible sync (FR-13)

Given bidirectional sync enabled, when either Bitrix or Brixchat24 changes the responsible user, then the mapped opposite side updates once and the echoed event is ignored by origin/version markers.

### AC-10: Assignment and capacity (FR-15)

Given eligible agents, rules, round-robin cursor, and capacity limits, when conversations arrive or bulk assignment runs, then deterministic eligible assignments persist with reason/history and over-capacity agents are skipped.

### AC-11: Conversation lifecycle (FR-16)

Given an accessible conversation, when authorized status, snooze, priority, pin, mute, block, reopen, and archive actions run, then current state and immutable operation history agree and invalid transitions fail atomically.

### AC-12: Labels and notes (FR-17, FR-18, FR-22)

Given scoped labels and users, when labels and mentioned internal notes are mutated, then only authorized tenant rows change, notes never become WhatsApp messages, and durable plus realtime notifications are produced.

### AC-13: Filters, views, and bulk operations (FR-19, NFR-8)

Given conversations with varied operational/CRM attributes, when combined filters are saved and a bounded bulk action runs, then result/count/view state is reproducible and more than 100 IDs is rejected.

### AC-14: Safe export (FR-20, FR-21)

Given an authorized filtered view and an unauthorized agent, when CSV/JSON export is requested, then only the authorized request streams tenant rows, an audit record exists, and secrets/internal credentials are absent.

### AC-15: Integration administration UI (FR-14, FR-23, NFR-10)

Given connected, disconnected, unauthorized, loading, empty, sync-running, retryable-failure, and success states, when users navigate integration routes by keyboard, then each state and permitted action is visible and direct unauthorized API calls remain blocked.

### AC-16: Fake-provider local acceptance (FR-24, FR-25)

Given no real Bitrix credentials, when migration, seed, fake sync, fake webhook, matching, entity creation, timeline, assignment, notes, filters, export, and UI scenarios run, then deterministic assertions pass without claiming real Bitrix success.

### AC-17: Regression and release gates (FR-22, FR-26, NFR-12)

Given an existing Milestone 3 database, when migration, seed, lint, typecheck, tests, E2E, build, Docker build/start, and health checks execute, then existing messaging behavior remains valid and all services are healthy.

## Edge Cases

- EC-1: OAuth callback state is expired, replayed, portal-mismatched, or tenant-mismatched; connection is rejected without token persistence.
- EC-2: Webhook URL credentials are malformed or point to an unsupported host; validation fails before storage.
- EC-3: Bitrix returns partial batch results, pagination repeats an ID, 429, timeout, HTML, malformed JSON, 401/403, or 5xx; errors normalize and deduplication/retry rules hold.
- EC-4: Phone normalization yields no usable digits or multiple contacts/leads; no automatic link is created.
- EC-5: A linked Bitrix entity is deleted or access is revoked; the link is marked unavailable and stale cache remains visibly recoverable.
- EC-6: Redis is unavailable after a durable note/assignment/status/notification mutation; API succeeds and later refetch remains authoritative.
- EC-7: Duplicate webhook delivery arrives concurrently; the unique provider event key creates one processing job.
- EC-8: A local assignment and Bitrix responsible event cross in flight; version/origin resolution prevents oscillation and preserves the newest accepted change.
- EC-9: All agents are inactive or at capacity; conversation remains unassigned with an auditable no-candidate reason.
- EC-10: Snooze time is past, invalid, or crosses DST; validation uses UTC and the worker reopens exactly once.
- EC-11: Mention targets another tenant or inactive user; note is rejected or mention omitted without data leakage.
- EC-12: Bulk input contains duplicates, inaccessible IDs, or more than 100 IDs; validation/transaction semantics prevent partial unauthorized mutation.
- EC-13: Export client disconnects; cursor/stream resources close and audit status records interruption.
- EC-14: Integration is disabled while CRM jobs are queued; jobs pause safely and do not consume attempts until re-enabled.
- EC-15: Migration is rerun or applied over M3 seed data; it is idempotent at runner level and preserves existing conversations/messages.

## API Contracts

```ts
type CrmEntityType = "contact" | "lead" | "deal" | "company";
type CrmErrorCode =
  | "AUTH"
  | "PERMISSION"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "VALIDATION"
  | "NOT_FOUND"
  | "TEMPORARY"
  | "PERMANENT";
interface CrmProvider {
  health(): Promise<CrmHealth>;
  listUsers(cursor?: string): Promise<Page<CrmUser>>;
  findEntities(input: MatchInput): Promise<CrmMatch[]>;
  getContext(link: CrmLink): Promise<CrmContext>;
  createEntity(input: CreateCrmEntity): Promise<CrmEntityRef>;
  addTimelineComment(input: TimelineInput): Promise<{ externalId: string }>;
  listPipelines(): Promise<CrmPipeline[]>;
}
interface ApiError {
  error: {
    code: string;
    message: string;
    requestId?: string;
    retryable?: boolean;
  };
}
interface ConversationOperation {
  status?: "open" | "waiting" | "snoozed" | "closed" | "archived" | "spam";
  priority?: "low" | "normal" | "high" | "urgent";
  snoozedUntil?: string | null;
  pinned?: boolean;
  muted?: boolean;
  blocked?: boolean;
}
interface BulkRequest {
  conversationIds: string[];
  action: string;
  value?: unknown;
}
```

Connection and integration endpoints:

- `GET/POST /api/v1/integrations`, `GET/PATCH/DELETE /api/v1/integrations/:id`, `POST /api/v1/integrations/:id/test`
- `POST /api/v1/integrations/bitrix24/oauth/start`, `GET /api/v1/integrations/bitrix24/oauth/callback`, `POST /api/v1/integrations/bitrix24/webhook-connect`
- `GET/PUT /api/v1/integrations/:id/settings`, `GET/PUT /api/v1/integrations/:id/field-mappings`
- `GET /api/v1/integrations/:id/users`, `POST /api/v1/integrations/:id/users/sync`, `PUT /api/v1/integrations/:id/user-mappings`
- `GET /api/v1/integrations/:id/pipelines`, `POST /api/v1/integrations/:id/pipelines/sync`, `POST /api/v1/integrations/:id/sync`, `GET /api/v1/integrations/:id/jobs`, `GET /api/v1/integrations/:id/logs`
- `POST /webhooks/bitrix24/:connectionPublicId` accepts form-encoded Bitrix events and returns `{accepted:boolean, duplicate:boolean}`.

CRM context endpoints:

- `GET /api/v1/conversations/:id/crm-context`, `POST /api/v1/conversations/:id/crm-context/refresh`
- `POST /api/v1/conversations/:id/crm-match`, `POST /api/v1/conversations/:id/crm-link`, `DELETE /api/v1/conversations/:id/crm-link`
- `POST /api/v1/conversations/:id/crm-entities` with `{type, fields, pipelineId?, stageId?}`.

Conversation operation endpoints:

- `PATCH /api/v1/conversations/:id/operations`, `POST /api/v1/conversations/:id/assign`, `DELETE /api/v1/conversations/:id/assign`
- `GET/POST/PATCH/DELETE /api/v1/labels`, `POST/DELETE /api/v1/conversations/:id/labels/:labelId`
- `GET/POST /api/v1/conversations/:id/notes`, `PATCH/DELETE /api/v1/notes/:id`, `POST /api/v1/notes/:id/replies`
- `GET/POST/PATCH/DELETE /api/v1/saved-views`, `POST /api/v1/conversations/bulk`, `POST /api/v1/conversations/export`
- `GET/POST/PATCH/DELETE /api/v1/assignment-rules`, `GET /api/v1/assignment-history`.

All protected endpoints require bearer authentication, tenant scope, strict validation, and the relevant permission. Success uses `{data}` or `{data,page}`; errors use `ApiError`.

## Data Models

| Model                                                    | Key fields and constraints                                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration_connections`                                | organization_id, provider, public_id unique, auth_mode, portal_url/member_id, encrypted_credentials, token_hash, status, health/error/sync timestamps, settings JSON |
| `crm_entity_links`                                       | organization_id, connection_id, conversation_id/contact_id, entity_type, external_id, match source/confidence, unique conversation links; one CRM entity may serve multiple channel conversations |
| `crm_user_mappings`                                      | organization_id, connection_id, local_user_id, external_user_id, active, external snapshot; unique mapping pairs                                                     |
| `crm_field_mappings`                                     | organization_id, connection_id, entity_type, local_field, external_field, direction, transforms, enabled                                                             |
| `crm_sync_jobs`                                          | organization_id, connection_id, job_type, aggregate/idempotency key, payload, status/attempt/max/next/lock/error/completed timestamps                                |
| `crm_sync_logs`                                          | organization_id, connection_id/job_id, level, operation, safe message/details, duration, created_at                                                                  |
| `crm_webhook_events`                                     | organization_id, connection_id, provider event key unique, event/auth/payload, status/attempt/error/received/processed timestamps                                    |
| `conversation_crm_context_cache`                         | organization_id, conversation_id unique, connection/link IDs, context JSON, fetched/stale/error timestamps                                                           |
| `crm_pipeline_cache`                                     | organization_id, connection_id, entity/category/pipeline/stage external IDs, names/order/semantics, fetched/stale timestamps                                         |
| `assignment_rules/conditions/actions`                    | organization_id, name, priority, active, strategy/config and ordered normalized predicates/actions                                                                   |
| `assignment_history`                                     | organization_id, conversation_id, from/to user/team, rule, reason, origin/version, actor, created_at                                                                 |
| `agent_capacity_status`                                  | organization_id/user_id unique, capacity, active count, availability, round-robin timestamp                                                                          |
| `conversation_labels` / `conversation_label_assignments` | organization scoped unique name/color; unique conversation-label pair and actor/timestamp                                                                            |
| `conversation_assignments`                               | organization_id, conversation_id, user/team, active, origin/version, assigned/unassigned actor/timestamps                                                            |
| `conversation_notes/mentions/threads`                    | organization/conversation, author, body, parent/thread IDs, edited/deleted timestamps; unique mention targets                                                        |
| `saved_views`                                            | organization_id, owner_user_id, name, visibility, filters/sort JSON, position/default timestamps                                                                     |
| `conversation_operation_history`                         | organization_id, conversation_id, operation, from/to JSON, actor/origin, created_at                                                                                  |

`conversations` gains `team_id`, `snoozed_until`, `pinned_at`, `muted_until`, `blocked_at`, `closed_at`, and `operation_version`. The status enum gains `snoozed`; existing rows and indexes are preserved.

## Out of Scope

- OS-1: An internal CRM, contact master, pipeline, deal board, sales task system, or replacement for Bitrix24.
- OS-2: Copying Wazzup source code, proprietary assets, or pixel-identical UI.
- OS-3: Automated marketing broadcasts, bot/AI responses, billing, mobile applications, and analytics dashboards.
- OS-4: Supporting CRM providers other than the provider-neutral boundary, Bitrix24, and fake provider in this milestone.
- OS-5: Claiming production Bitrix24 verification without real portal credentials and successful live requests.
- OS-6: Deleting remote Bitrix entities when a local link or connection is removed.

## Delivery and Verification

Implementation proceeds through schema/provider, API, worker/realtime, UI, and test slices. Local acceptance uses the fake provider. Final verification runs frozen install, migration, seed, lint, typecheck, unit/integration tests, Playwright E2E, build, Docker build/start, service health, and manual fake-provider API assertions. Real Bitrix24 status is reported separately as verified, failed, or not run because credentials were unavailable.

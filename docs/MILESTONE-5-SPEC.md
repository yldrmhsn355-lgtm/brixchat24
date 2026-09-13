# Milestone 5 — Media Pipeline, Search, Automation Rules, Bitrix24 Open Channels and Production Hardening

**Author:** Codex with user-provided requirements
**Date:** 2026-07-16
**Status:** Approved
**Reviewers:** Repository owner (approval conveyed by the supplied milestone brief and instruction to implement)

## Context

Brixchat24 is a Wazzup-like communication layer: it owns WhatsApp messaging, shared-inbox operations, media, assignment, notes, labels and operational automations while Bitrix24 remains the source of truth for CRM entities, pipelines, tasks and sales reporting. Milestones 1–4 provide transactional messaging, Meta/fake providers, inbox operations, realtime notifications and Bitrix24 CRM-context synchronization.

Milestone 5 closes the operational gaps required for production preparation: private media storage, indexed search and message jump, bounded event-driven automation, an Open Channels mode isolated from CRM timeline synchronization, and observable/retained/deployable runtime behavior. Unsupported WhatsApp group automation and any internal CRM remain prohibited.

## Functional Requirements

- FR-1: The system MUST expose provider capabilities and MUST set `groupConversations=false` for Meta and fake Meta-compatible providers.
- FR-2: The system MUST provide local-development and S3-compatible object-storage adapters behind `ObjectStorageProvider`; stored objects MUST be private.
- FR-3: Incoming media webhooks MUST persist a pending attachment and media job before returning, and MUST NOT download the file inside the webhook request.
- FR-4: The media worker MUST stream downloads, enforce redirect, timeout, byte-size, MIME, magic-byte, filename and executable-content policies, calculate SHA-256 and write an organization-scoped unpredictable key.
- FR-5: Attachments MUST have retry/dead-letter status and MUST emit processing/stored/failed/deleted realtime events.
- FR-6: Download and thumbnail URLs MUST be short-lived, tenant-aware, conversation-authorized and audited; infected, expired or deleted files MUST be denied.
- FR-7: The system MUST provide Noop and ClamAV malware-scanner adapters and MUST report a production warning when Noop is selected.
- FR-8: Images SHOULD receive orientation-safe WebP thumbnails when the runtime supports it; unsupported previews MUST fall back to safe metadata cards.
- FR-9: Outgoing media MUST enter private storage and the existing transactional message outbox; clients MUST NOT call Meta directly.
- FR-10: The composer MUST support image/video/audio/document selection, validation, preview, removal, progress/error states and a controlled MediaRecorder fallback.
- FR-11: PostgreSQL search MUST support tenant-scoped conversations, contacts, messages, notes, attachments and Bitrix cached context with normalized text/phone matching and safe highlight segments.
- FR-12: Search MUST support the documented filters, stable cursor pagination and an around-message endpoint returning the target plus previous/next windows.
- FR-13: Global search MUST support Ctrl/Cmd+K; conversation search MUST support Ctrl/Cmd+F; selecting a message MUST open and highlight it.
- FR-14: Saved views MUST support personal/team/organization scope and organization-scope mutation MUST require elevated permission.
- FR-15: Automation MUST use versioned draft/publish rules with Trigger → Conditions → Actions, dry-run, pause/archive/duplicate and run/step history.
- FR-16: Domain events MUST enter an automation event outbox; request handlers MUST NOT execute rules synchronously.
- FR-17: Automation MUST enforce correlation/origin deduplication, depth, action-count and organization/rule/conversation rate limits, permission snapshots and audit logs.
- FR-18: Webhook actions MUST reject private/link-local/loopback targets and non-allowlisted hosts; DNS results MUST be revalidated before delivery.
- FR-19: Automation message actions MUST use the existing transactional outbox and MUST respect the WhatsApp customer-service window/template policy.
- FR-20: Out-of-office automation MUST respect organization timezone, working hours, holidays and per-conversation repeat limits.
- FR-21: Bitrix connections MUST support `crm_context`, `open_channels` and `both` modes without merging their queues or message mappings.
- FR-22: Open Channels MUST use a connector abstraction plus deterministic fake connector supporting registration, line activation, sessions, operator messages, delivery/close, duplicates, temporary/permanent errors and rate limits.
- FR-23: Incoming WhatsApp messages in Open Channels mode MUST enqueue connector sync; Bitrix operator messages MUST create local pending messages through the existing WhatsApp outbox.
- FR-24: `both` mode MUST apply an explicit conflict policy; Open Channels message links and source markers MUST prevent duplicate timeline/chat messages and loops.
- FR-25: The Bitrix UI MUST expose an Open Channels tab with mode, connector/line state, mappings, direction toggles, last event/success/error and safe test/disable/re-register controls.
- FR-26: Health endpoints MUST expose live, ready and redacted dependency states for PostgreSQL, Redis, storage, workers, providers, connector, scanner and realtime.
- FR-27: A protected Prometheus-compatible metrics endpoint MUST expose operational counters/gauges without PII labels.
- FR-28: Trace IDs MUST propagate through webhook persistence, messages, jobs, worker logs, CRM/Open Channels and automation records; OTLP export MAY be enabled by environment.
- FR-29: Tenant retention settings and a retryable retention worker MUST support batch purge, legal hold, object deletion and audited dry-run.
- FR-30: Secret access MUST use Environment/File provider abstractions and production startup MUST reject known-default/short/missing critical secrets while warning for unsafe optional adapters.
- FR-31: Production Docker/VPS deployment, TLS/domain policy, backups, PITR, object versioning, restore verification, RPO/RTO and operational runbooks MUST be documented separately from development Compose.
- FR-32: RBAC and tenant isolation MUST be enforced server-side for all new attachments, search, automation, Open Channels, retention, metrics and health operations.
- FR-33: No internal CRM, unofficial WhatsApp Web/QR/Baileys/group integration or direct provider call from automation/Open Channels MUST be introduced.

## Non-Functional Requirements

- NFR-1: Webhook persistence SHOULD return within 500 ms excluding database outage.
- NFR-2: Search SHOULD return the first 50 results within 750 ms for the seeded acceptance dataset.
- NFR-3: Media processing MUST use bounded streaming and MUST NOT buffer files larger than the configured inspection prefix.
- NFR-4: Signed URLs MUST expire within 15 minutes by default and MUST be unguessable.
- NFR-5: Job claiming MUST use `FOR UPDATE SKIP LOCKED` and idempotency constraints.
- NFR-6: Health and metrics responses MUST contain no secrets, message bodies, phone numbers or email addresses.
- NFR-7: Automation MUST cap depth at 5 and actions at 20 by default.
- NFR-8: All new public inputs MUST be schema validated and normalized.
- NFR-9: Existing messaging/CRM tests and runtime behavior MUST remain backward compatible.
- NFR-10: UI controls MUST use semantic labels, keyboard operation and visible loading/empty/error states.
- NFR-11: Production configuration validation MUST be deterministic and testable without external credentials.
- NFR-12: No real Meta/Bitrix success may be claimed without supplied credentials and observed provider results.

## Acceptance Criteria

### AC-1: Provider capability boundary (FR-1, FR-33)

Given Meta capabilities, when read, then groups are false and unsupported group UI/actions are absent.

### AC-2: Private incoming media (FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8, NFR-3, NFR-4, NFR-5)

Given an incoming fake image, when webhook and worker complete, then a clean stored attachment and private thumbnail exist and an authorized signed URL works.

### AC-3: Media authorization (FR-6, FR-32)

Given another tenant or infected/deleted media, when requesting a URL, then access is denied and no URL is disclosed.

### AC-4: Media retry (FR-5)

Given a temporary media failure, when retries exhaust, then the job is dead-lettered with redacted error data.

### AC-5: Outgoing media (FR-9, FR-10)

Given an authorized upload, when sent, then a pending attachment/message and normal message outbox job are created.

### AC-6: Search and jump (FR-11, FR-12, FR-13, NFR-2)

Given seeded old messages, attachments, notes and Bitrix context, when searched, then tenant-only safe highlighted results are returned and message jump loads the target window.

### AC-7: Saved-view scope (FR-14, FR-32)

Given a saved view scope, when mutated, then personal/team/organization authorization is enforced.

### AC-8: Automation execution (FR-15, FR-16, FR-17)

Given a published matching rule and one event, when the worker runs, then one run and ordered steps are recorded and duplicate events create no second run.

### AC-9: Webhook SSRF safety (FR-18)

Given a webhook action targeting private or non-allowlisted infrastructure, when validated, then it is rejected before network delivery.

### AC-10: WhatsApp policy safety (FR-19, FR-20)

Given a closed service window, when automation attempts free text, then it is blocked or converted only through an approved template policy.

### AC-11: Fake Open Channels (FR-21, FR-22, FR-23, FR-24, FR-25)

Given fake Open Channels mode, when connector/line activate and a WhatsApp message arrives, then one fake session/message link is created; one operator event creates one WhatsApp outbox message.

### AC-12: Both-mode conflict (FR-24)

Given `both` mode, when the same source message is processed, then conflict policy prevents duplicate timeline/chat synchronization.

### AC-13: Redacted operations (FR-26, FR-27, FR-28)

Given a healthy development stack, when health and authorized metrics are requested, then dependencies/metrics are redacted and trace IDs remain correlated.

### AC-14: Retention (FR-29)

Given expired media without legal hold, when retention dry-run and execution occur, then eligibility is reported and object/database deletion is audited.

### AC-15: Production validation (FR-30, FR-31)

Given production mode with weak/default secrets or local/noop adapters, when validated, then fatal conditions fail and warnings are explicit; deployment/restore procedures are documented.

### AC-16: RBAC regression (FR-32, NFR-9)

Given agent and owner users, when new management endpoints are called, then RBAC is enforced and all prior tests still pass.

### AC-17: Honest acceptance (NFR-12)

Given no live credentials, when final acceptance is reported, then real Meta and Bitrix/Open Channels acceptance is marked as not run.

## Edge Cases

- EC-1: Provider media URL expires between metadata lookup and download; metadata is refreshed once.
- EC-2: MIME header and magic bytes disagree; storage is refused and the message placeholder remains.
- EC-3: Redirect targets a private address or exceeds the redirect cap; download fails safely.
- EC-4: Object write succeeds but DB completion fails; idempotent retry uses the same attachment identity without duplicate user-visible media.
- EC-5: Thumbnail/FFmpeg/ClamAV is unavailable; attachment remains downloadable only when policy permits and health reports degradation.
- EC-6: Search text contains markup or tsquery operators; response contains escaped text segments, never raw headline HTML.
- EC-7: Automation action emits another matching event; depth/correlation dedupe stops recursion.
- EC-8: Rule is edited while active; published version remains immutable until explicit publish.
- EC-9: DNS changes between validation and webhook call; resolved target is checked again.
- EC-10: Operator and timeline events share a provider ID in `both` mode; unique source mapping prevents duplication.
- EC-11: Open Channels rate-limits; job retries without creating another local message/session.
- EC-12: Legal hold overrides organization retention and records a skipped audit entry.
- EC-13: Redis is unavailable; durable records commit and realtime delivery is best effort.
- EC-14: Real provider credentials are absent; fake providers remain testable and live acceptance remains unverified.

## API Contracts

```ts
interface MessagingProviderCapabilities {
  textMessages: boolean;
  templateMessages: boolean;
  mediaMessages: boolean;
  reactions: boolean;
  locations: boolean;
  contacts: boolean;
  groupConversations: boolean;
}
interface ObjectStorageProvider {
  putObject(input: PutObjectInput): Promise<StoredObject>;
  getObject(input: GetObjectInput): Promise<ReadableStream>;
  deleteObject(input: DeleteObjectInput): Promise<void>;
  createSignedDownloadUrl(
    input: SignedDownloadInput,
  ): Promise<SignedDownloadResult>;
  healthCheck(): Promise<StorageHealth>;
}
interface MalwareScanner {
  scan(input: MalwareScanInput): Promise<MalwareScanResult>;
}
interface SearchResult {
  id: string;
  type:
    "conversation" | "message" | "contact" | "note" | "attachment" | "bitrix";
  title: string;
  preview: string;
  conversationId?: string;
  messageId?: string;
  attachmentId?: string;
  occurredAt: string;
  highlights: Array<{ text: string; match: boolean }>;
}
interface AutomationRuleInput {
  name: string;
  description?: string;
  trigger: { type: string };
  conditions: Array<{ field: string; operator: string; value: unknown }>;
  actions: Array<{ type: string; config: Record<string, unknown> }>;
  stopProcessing?: boolean;
}
interface OpenChannelsSettings {
  mode: "crm_context" | "open_channels" | "both";
  connectorId?: string;
  lineId?: string;
  incomingEnabled: boolean;
  outgoingEnabled: boolean;
  timelinePolicy: "per_message" | "session_summary" | "disabled";
}
interface ApiError {
  error: { code: string; message: string; requestId?: string };
}
// GET /api/v1/search; GET /api/v1/conversations/:id/messages/around/:messageId
// GET /api/v1/messages/:messageId/attachments; GET /api/v1/attachments/:id
// POST /api/v1/attachments/:id/download-url; POST /api/v1/attachments/:id/retry; DELETE /api/v1/attachments/:id
// POST /api/v1/media/uploads; POST /api/v1/media/uploads/:id/complete
// CRUD /api/v1/automations; POST /api/v1/automations/:id/{dry-run,publish,pause,duplicate,archive}; GET /api/v1/automations/:id/runs
// GET/PUT /api/v1/integrations/:id/open-channels; POST /api/v1/integrations/:id/open-channels/{register,activate,test-incoming,test-outgoing,disable}
// GET /health/{live,ready,dependencies}; GET /metrics; GET/PUT /api/v1/retention; POST /api/v1/retention/dry-run
```

## Data Models

| Entity                                                                              | Required identity/constraints                                 | Purpose                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| message_attachments                                                                 | UUID; org/message/channel; unique(channel, provider_media_id) | Provider and private-storage metadata/status   |
| media_processing_jobs                                                               | UUID; attachment; claim/status/attempt indexes                | Download/inspect/scan/thumbnail/retention work |
| media_download_audit                                                                | org/user/attachment/action/time                               | Signed URL and deletion audit                  |
| automation_rules/versions                                                           | org/name/version/status                                       | Draft/published rule definition                |
| automation_rule_triggers/conditions/actions                                         | rule version + ordered unique position                        | Executable rule graph                          |
| automation_events/runs/run_steps/rate_limits/webhook_deliveries                     | org/correlation/idempotency unique                            | Durable safe execution                         |
| bitrix_open_channel_connectors/sessions/message_links/operator_mappings/events/jobs | org/connection/source unique                                  | Isolated Open Channels lifecycle               |
| organization_retention_settings/retention_jobs                                      | one per org; legal hold                                       | Tenant retention and audited purge             |
| operational_metrics                                                                 | bounded metric name/labels                                    | PII-free counters/gauges                       |

## Out of Scope

- OS-1: Internal CRM, pipeline, deal board, task management or sales reporting; Bitrix24 remains authoritative.
- OS-2: WhatsApp Web, QR login, Puppeteer, Baileys, reverse-engineered group messaging or personal-account automation.
- OS-3: Visual node-canvas workflow builder; v1 uses a form-based rule builder.
- OS-4: Instagram, Telegram, Gmail, Calendar, billing, campaigns, AI replies, mobile app and mandatory Kubernetes.
- OS-5: Claiming real Meta, Bitrix24 or production acceptance without credentials and observed evidence.

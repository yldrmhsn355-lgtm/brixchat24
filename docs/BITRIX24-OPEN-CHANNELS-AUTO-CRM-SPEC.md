# Spec: Bitrix24 Open Channels and Automatic CRM Registration

**Author:** Codex with repository owner requirements  
**Date:** 2026-07-29  
**Status:** Approved  
**Reviewers:** Repository owner (implementation approval given on 2026-07-29)  
**Related specs:** `MILESTONE-4-SPEC.md`, `MILESTONE-5-SPEC.md`

## Context

BrixChat24 currently has the database tables, queues, fake connector, REST
connector skeleton, webhook receiver and management page required for a
Bitrix24 Open Channels integration. Incoming WhatsApp messages already create
canonical BrixChat contacts and conversations and enqueue Open Channels jobs.
Bitrix operator events can already enter the normal WhatsApp outbox.

The production path is not complete. The worker rejects every non-fake Open
Channels job with `OPEN_CHANNELS_CONNECTOR_NOT_CONFIGURED`; the management page
does not list or activate real Bitrix open lines; registration does not set
connector data or prove connector status; and outgoing operator delivery is not
acknowledged back to Bitrix. The production connection is currently in
`crm_context` mode with Open Channels disabled and no registered connector.

When an unknown phone number sends its first message, BrixChat creates its own
contact but does not automatically create or link a Bitrix CRM record. The
target behavior is Wazzup-like: administrators choose whether an unknown number
creates a lead or a contact plus deal, and optionally select the destination
pipeline/stage. Existing CRM records must be reused by normalized phone number.

## Functional Requirements

- FR-1: The system MUST list Bitrix open lines visible to the connected OAuth
  application using `imopenlines.config.list.get`.
- FR-2: An authorized administrator MUST be able to select one active Bitrix
  open line and one active BrixChat messaging channel for the connector.
- FR-3: The system MUST register the connector with a stable organization-safe
  identifier using `imconnector.register`.
- FR-4: Registration MUST set connector data with
  `imconnector.connector.data.set`, activate the selected line with
  `imconnector.activate`, and verify `CONFIGURED=true`, `STATUS=true`, and
  `ERROR=false` using `imconnector.status`.
- FR-5: The system MUST subscribe the shared authenticated Bitrix event handler
  to `OnImConnectorMessageAdd`, `OnImConnectorDialogStart`,
  `OnImConnectorDialogFinish`, `OnImConnectorLineDelete`, and
  `OnImConnectorStatusDelete`.
- FR-6: Incoming BrixChat messages MUST be sent to the selected Bitrix line
  through the real `BitrixRestOpenChannelsConnector`.
- FR-7: The connector message MUST include stable external user/chat/message
  identifiers, normalized E.164 phone, display name, message timestamp, text or
  supported file data, and a BrixChat source marker.
- FR-8: A successfully synchronized incoming message MUST create or update one
  Open Channels session and one message link; retries MUST NOT duplicate either.
- FR-9: A Bitrix operator message received through
  `OnImConnectorMessageAdd` MUST create one pending BrixChat outbound message
  and MUST send it through the existing provider outbox.
- FR-10: After the provider accepts the operator message, the system MUST call
  `imconnector.send.status.delivery` with the Bitrix chat/message identifiers.
- FR-11: The system MUST support the automatic CRM modes `disabled`, `lead`,
  and `contact_and_deal`.
- FR-12: Before automatic creation, the system MUST search Bitrix contacts and
  leads by normalized phone and MUST reuse one unambiguous existing record.
- FR-13: In `lead` mode, an unknown phone MUST create one Bitrix lead containing
  the display name, normalized mobile phone, and configured source. The Open
  Channels line queue MUST NOT be copied into the CRM responsible field.
- FR-14: In `contact_and_deal` mode, an unknown phone MUST create one contact
  and one linked deal in the configured pipeline/stage; the deal MUST reference
  the created contact.
- FR-15: Automatic CRM creation MUST run only for the first canonical incoming
  message of a conversation that has no active `crm_entity_links` row.
- FR-16: Automatic CRM creation and matching MUST persist the resulting
  `crm_entity_links` row before the Open Channels message is marked completed.
- FR-17: On an ambiguous phone match, the system MUST NOT create another CRM
  record and MUST expose a `manual_review` state in the Open Channels log/UI.
- FR-18: CRM creation and Open Channels delivery MUST use separate durable job
  states so a temporary failure in one dependency can be retried without
  duplicating the other.
- FR-19: Administrators MUST be able to disable/deactivate the connector without
  deleting BrixChat conversations, contacts, messages, CRM links, or historical
  Open Channels mappings.
- FR-20: The management UI MUST expose mode, selected BrixChat channel, Bitrix
  line, connector status, CRM creation policy, optional pipeline/stage,
  direction toggles, last success, last event, and redacted last error.
- FR-21: The management UI MUST require an explicit confirmation before it
  activates/deactivates a Bitrix line or enables automatic CRM creation.
- FR-22: `crm_context`, `open_channels`, and `both` modes MUST retain the
  existing timeline conflict policy and MUST prevent message loops through
  source markers and provider identities.
- FR-23: OAuth token refresh MUST continue to rotate and persist credentials for
  API and worker Open Channels calls.
- FR-24: All management endpoints MUST enforce tenant scope and the existing
  `open_channels:*` permissions.

## Non-Functional Requirements

- NFR-1: Incoming provider webhook persistence MUST NOT wait for Bitrix and
  SHOULD complete within 500 ms excluding database outage.
- NFR-2: Open Channels and automatic CRM jobs MUST use durable PostgreSQL
  queues, `FOR UPDATE SKIP LOCKED`, bounded retries, and dead-letter status.
- NFR-3: At-least-once retries MUST produce at most one BrixChat message, one
  Open Channels message link, and one CRM link per source message/conversation.
- NFR-4: Phone numbers, message bodies, OAuth tokens and application tokens
  MUST NOT appear in operational logs or error responses.
- NFR-5: Bitrix API errors exposed to users MUST be normalized and redacted;
  retryability MUST distinguish authorization, permission, validation,
  throttling, timeout, and temporary provider failures.
- NFR-6: Existing messaging, CRM context, timeline, OAuth, webhook, media and
  automation behavior MUST remain backward compatible.
- NFR-7: Open Channels controls MUST be keyboard operable and MUST expose
  loading, empty, success, warning and error states.
- NFR-8: Production acceptance MUST include one unique inbound customer message
  and one unique Bitrix operator reply; fake-only evidence is insufficient.
- NFR-9: The integration MUST support only one active worker claim per durable
  job and MUST not create a second provider socket/runtime.
- NFR-10: No production activation may be reported successful unless
  `imconnector.status` and persisted job/session/message evidence agree.

## Acceptance Criteria

### AC-1: Discover and activate a real line (FR-1, FR-2, FR-3, FR-4, FR-5, FR-20)

Given a connected Bitrix OAuth application with Open Channels scopes  
When an administrator selects an active Bitrix line and BrixChat channel and confirms activation  
Then the connector is registered, connector data is set, the selected line is activated, required events are subscribed, and connector status is configured and active.

### AC-2: Customer message reaches Bitrix (FR-6, FR-7, FR-8, NFR-2, NFR-3)

Given an active connector and a unique incoming WhatsApp text message  
When the BrixChat worker processes the durable Open Channels job  
Then exactly one Bitrix Open Channels message, one local session, and one message link exist with the same source marker.

### AC-3: Bitrix reply reaches WhatsApp (FR-9, FR-10, NFR-3)

Given an active Open Channels session  
When a Bitrix operator sends one unique reply  
Then exactly one BrixChat outbound message and one provider outbox job are created, the provider accepts the message, and Bitrix receives a delivery acknowledgement.

### AC-4: Existing CRM record is reused (FR-12, FR-15, FR-16)

Given a first incoming message whose normalized phone matches one unambiguous Bitrix contact or lead  
When automatic CRM processing runs  
Then no CRM entity is created and one `crm_entity_links` row references the existing entity.

### AC-5: Unknown number creates a lead (FR-11, FR-13, FR-15, FR-16)

Given `autoCrmMode=lead` and a first incoming message whose phone has no Bitrix match  
When automatic CRM processing completes  
Then one lead containing the normalized phone is created and linked to the BrixChat conversation.

### AC-6: Unknown number creates contact and deal (FR-11, FR-14, FR-15, FR-16)

Given `autoCrmMode=contact_and_deal`, pipeline `8`, stage `C8:NEW`, and an unknown normalized phone  
When automatic CRM processing completes  
Then one contact and one deal linked to that contact are created in the selected pipeline/stage and the conversation is linked to the contact.

### AC-6a: Channel operators do not own CRM data (FR-13, FR-14)

Given a Bitrix line whose queue contains one or more operators
When BrixChat matches or creates a CRM entity for that line
Then no `ASSIGNED_BY_ID` is derived from the line queue; responsibility changes only through an explicit CRM assignment flow.

### AC-7: Ambiguous match is safe (FR-17)

Given two Bitrix entities match the same normalized phone  
When automatic CRM processing runs  
Then no entity is created, the job enters `manual_review`, and the UI displays a redacted review warning.

### AC-8: Retry does not duplicate CRM data (FR-18, NFR-2, NFR-3)

Given Bitrix creates a CRM record but the first response is lost  
When the job retries  
Then it searches again, reuses the created record, and persists one CRM link without creating another record.

### AC-9: Disable is non-destructive (FR-19, FR-21)

Given an active connector with existing sessions and CRM links  
When an administrator confirms deactivation  
Then Bitrix reports the connector inactive, new Open Channels jobs stop, and historical BrixChat/CRM data remains unchanged.

### AC-10: Tenant and secret safety (FR-23, FR-24, NFR-4, NFR-5)

Given an unauthorized tenant user or a failing Bitrix request  
When a management endpoint is called  
Then access is denied or a normalized error is returned and no credential, token, phone or message body is disclosed.

### AC-11: Live end-to-end acceptance (NFR-8, NFR-10)

Given the production WhatsApp channel and selected Bitrix line  
When a unique external phone sends a message and a Bitrix operator replies  
Then provider, database, worker and UI evidence all show a completed bidirectional flow and the selected automatic CRM policy is observed.

### AC-12: Both-mode conflict protection (FR-22)

Given `mode=both` and an incoming message already synchronized to Open Channels  
When timeline and Open Channels workers observe the same source marker  
Then the configured `session_summary` policy creates no duplicate Bitrix message or BrixChat outbound loop.

## Edge Cases and Error Scenarios

- EC-1: No Bitrix open lines are returned -> show an empty state and instructions
  to create/configure a line in Bitrix; do not register or activate.
- EC-2: Selected line is inactive or deleted -> reject activation and refresh
  the line list.
- EC-3: OAuth token expires during activation -> refresh once, persist rotated
  tokens, and retry the original call once.
- EC-4: Bitrix returns `QUERY_LIMIT_EXCEEDED` -> retry with bounded backoff
  without creating a duplicate session/message/entity.
- EC-5: `OnImConnectorMessageAdd` contains an unknown connector or line -> store
  a redacted failed event and do not send a WhatsApp message.
- EC-6: Operator event repeats -> event and message idempotency keys suppress
  the duplicate.
- EC-7: Incoming media is not yet safely stored -> keep the Open Channels job
  pending until a signed provider-accessible file URL is available or send a
  policy-approved text fallback.
- EC-8: Phone is empty or invalid -> skip automatic CRM creation, mark
  `manual_review`, and still preserve the BrixChat conversation.
- EC-9: Contact creation succeeds and deal creation fails -> retain/reuse the
  contact and retry only deal creation.
- EC-10: Selected pipeline/stage becomes unavailable -> stop automatic deal
  creation, mark configuration stale, and require administrator reselection.
- EC-11: Connector is disabled while jobs are pending -> do not claim new jobs;
  preserve them for explicit retry after reactivation.
- EC-12: Bitrix operator reply is outside the WhatsApp service window -> apply
  the existing template policy and do not bypass provider restrictions.
- EC-13: Same customer writes through two BrixChat channels -> keep distinct
  Open Channels sessions while reusing the same unambiguous CRM entity.
- EC-14: Worker restarts after external success but before local completion ->
  recover using phone/source-marker lookup and finish idempotently.

## API Contracts

```ts
interface BitrixOpenLine {
  id: string;
  name: string;
  active: boolean;
  crmEnabled: boolean;
  crmCreate: "lead" | "deal" | "none";
  queueUserIds: string[];
}

interface OpenChannelsSettingsInput {
  mode: "crm_context" | "open_channels" | "both";
  brixchatChannelId: string;
  lineId: string;
  incomingEnabled: boolean;
  outgoingEnabled: boolean;
  deliveryStatusSync: boolean;
  sessionCloseSync: boolean;
  timelinePolicy: "per_message" | "session_summary" | "disabled";
  autoCrmMode: "disabled" | "lead" | "contact_and_deal";
  crmSourceId?: string;
  responsibleExternalUserId?: string;
  pipelineId?: string;
  stageId?: string;
}

interface OpenChannelsState {
  mode: OpenChannelsSettingsInput["mode"];
  connectorId: string | null;
  lineId: string | null;
  brixchatChannelId: string | null;
  status: "disabled" | "registered" | "active" | "warning" | "failed";
  configured: boolean;
  providerStatus: boolean;
  providerError: boolean;
  autoCrmMode: OpenChannelsSettingsInput["autoCrmMode"];
  lastEventAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
}

interface OpenChannelsActivationRequest {
  confirm: "ACTIVATE";
}

interface OpenChannelsDeactivationRequest {
  confirm: "DEACTIVATE";
}

interface ApiError {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

// GET  /api/v1/integrations/:id/open-channels
// GET  /api/v1/integrations/:id/open-channels/lines
// PUT  /api/v1/integrations/:id/open-channels
// POST /api/v1/integrations/:id/open-channels/register
// POST /api/v1/integrations/:id/open-channels/activate
// POST /api/v1/integrations/:id/open-channels/deactivate
// POST /api/v1/integrations/:id/open-channels/health
// POST /api/v1/integrations/:id/open-channels/test-incoming
// GET  /api/v1/integrations/:id/open-channels/jobs
```

All endpoints require bearer authentication, tenant scope, and the matching
`open_channels:read`, `open_channels:manage`, or `open_channels:test`
permission. Validation errors return 400; authentication 401; authorization
403; missing connection/line/channel 404; stale/conflicting configuration 409;
Bitrix throttling 429; temporary provider failure 503.

## Data Models

### Existing tables extended by behavior

| Entity                                          | Required identity/constraints                                                 | Purpose                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `integration_connections.settings.openChannels` | connection-scoped JSON; validated before write                                | Selected channel/line, directions, timeline and automatic CRM policy |
| `bitrix_open_channel_connectors`                | unique `integration_connection_id`                                            | Stable connector/line status and redacted health                     |
| `bitrix_open_channel_sessions`                  | unique `(integration_connection_id, conversation_id)`                         | BrixChat conversation to Bitrix chat/session mapping                 |
| `bitrix_open_channel_message_links`             | unique `(organization_id, source_marker)` and `(local_message_id, direction)` | Cross-system message idempotency                                     |
| `bitrix_open_channel_events`                    | unique `(integration_connection_id, provider_event_key)`                      | Durable Bitrix operator/line events                                  |
| `bitrix_open_channel_jobs`                      | unique `(integration_connection_id, idempotency_key)`                         | Durable incoming, delivery and automatic CRM work                    |
| `crm_entity_links`                              | existing connection/conversation/entity uniqueness                            | Result of CRM match or creation                                      |

No new table is required for the first implementation. New job types and
validated JSON settings MUST remain backward compatible with existing rows.
If implementation proves that contact-created/deal-pending recovery cannot be
represented safely, a separate reviewed migration MUST add explicit step state
before code proceeds.

## Out of Scope

- OS-1: Replacing Bitrix24 CRM with an internal BrixChat CRM.
- OS-2: WhatsApp group conversations; the current provider capability remains
  unsupported.
- OS-3: Voice recording inside Bitrix Open Channels; text and safely supported
  files are the first production scope.
- OS-4: Bulk campaigns, CRM Marketing and Bitrix business-process activities.
- OS-5: Automatically creating or modifying Bitrix operator queues; queue
  ownership remains in Bitrix.
- OS-6: Hard-deleting connector sessions, CRM links, contacts, leads or deals
  when the connector is disabled.
- OS-7: Bypassing Meta/WhatsApp service-window and template policies.
- OS-8: Enabling production Open Channels before unique inbound and operator
  reply acceptance evidence passes.

## Recommended Production Configuration

For the currently connected portal:

- BrixChat channel: active `WhatsApp 0894`
- Mode after acceptance: `both`
- Automatic CRM policy: `contact_and_deal`
- Pipeline: `Müşteri Adayları` (`8`)
- Initial stage: `Geliştiriliyor` (`C8:NEW`)
- Timeline policy: `per_message`

This recommendation MUST be confirmed by the repository owner before the
production activation mutation.

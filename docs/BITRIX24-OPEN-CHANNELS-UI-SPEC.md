# Spec: Bitrix24 Open Channels Management UI

**Author:** Codex with repository owner requirements
**Date:** 2026-07-29
**Status:** Approved
**Reviewers:** Repository owner (reference design and implementation request supplied on 2026-07-29)
**Related specs:** `BITRIX24-OPEN-CHANNELS-AUTO-CRM-SPEC.md`

## Context

The existing Open Channels page exposes the production configuration and
connector actions as one unstructured form. It is functional, but the visual
hierarchy does not communicate the BrixChat channel to Bitrix24 open-line
relationship, status, message direction, or CRM rule clearly. Actions and raw
select controls also wrap unpredictably at common desktop widths.

The redesign turns the existing real API data into a professional management
surface inspired by the supplied reference. Its primary list deliberately
shows only the WhatsApp channel, last verified activity, status, and management
action. All configuration and lifecycle details remain available in the
management drawer, keeping the overview concise without removing capability.

## Functional Requirements

- FR-1: The page MUST list every tenant-scoped Bitrix24 integration connection
  returned by the existing integrations API.
- FR-2: Each connection summary MUST display only its WhatsApp channel, last
  verified activity, normalized connector status, and management action using
  real API data.
- FR-3: Users MUST be able to search by connection, channel, open-line, CRM
  rule, and connector identifier.
- FR-4: Users MUST be able to filter the list by normalized connector status
  and switch between list and Kanban views.
- FR-5: Status tabs MUST display counts derived from the loaded connection
  states and MUST filter the visible results.
- FR-6: The selected view preference MUST persist in browser local storage.
- FR-7: Operational and configuration details MUST remain out of the primary
  connection summary and be available through the management drawer.
- FR-8: Users MUST be able to open an edit drawer for a connection and retain
  all existing settings: mode, channel, line, CRM rule, pipeline, stage,
  direction and synchronization toggles.
- FR-9: Existing save, register, activate, health-test, and deactivate actions
  MUST continue to call their current endpoints with the current confirmation
  requirements.
- FR-10: The add-connection action MUST route to the existing Bitrix24 connect
  flow rather than creating mock data.
- FR-11: The page MUST expose loading, empty, filtered-empty, success, warning,
  and error states.
- FR-12: On narrow screens the desktop table MUST become readable connection
  cards without horizontal page overflow.

## Non-Functional Requirements

- NFR-1: Search filtering SHOULD update within 150 ms after input settles.
- NFR-2: All buttons, tabs, filters, disclosure controls, and drawer controls
  MUST be keyboard operable and expose accessible names.
- NFR-3: Status MUST NOT be communicated by color alone; every status needs a
  visible text label.
- NFR-4: Existing API contracts, database schema, tenant scope, and RBAC MUST
  remain unchanged.
- NFR-5: The redesign MUST NOT display secrets, credentials, raw provider
  payloads, phone numbers not already supplied by the channel API, or invented
  operational metrics.

## Acceptance Criteria

### AC-1: Real connections render (FR-1, FR-2, FR-10, NFR-5)

Given the integrations API returns one or more Bitrix24 connections
When the Open Channels page finishes loading
Then one management item is rendered for each Bitrix24 connection
And every displayed relationship field comes from its loaded connection,
Open Channels state, channel list, or open-line list
And the add-connection action links to the existing Bitrix24 connect route.

### AC-2: Search and status filtering (FR-3, FR-5, NFR-1)

Given multiple loaded connection items
When the user enters a matching search term or selects a status tab
Then only items matching both the settled search term and selected status are
displayed
And the tab counts continue to represent all loaded items.

### AC-3: List and Kanban preference (FR-4, FR-6)

Given the page is loaded
When the user selects Kanban view
Then connection items render in status columns
And a page reload restores Kanban view from local storage.

### AC-4: Concise summary and managed detail (FR-7, NFR-2, NFR-5)

Given a loaded connection item
When the overview renders
Then only the WhatsApp channel, last verified activity, status and management
action are displayed in its summary
And configuration and lifecycle controls are available after activating the
accessible management action.

### AC-5: Edit preserves lifecycle actions (FR-8, FR-9)

Given a loaded Bitrix24 connection
When the user opens its edit drawer
Then all existing configuration fields and lifecycle actions are available
And each action uses the existing tenant-scoped endpoint for that connection.

### AC-6: Responsive and accessible controls (FR-12, NFR-2, NFR-3)

Given a viewport narrower than 760 pixels
When the page renders
Then each connection is presented as a labeled card without horizontal page
overflow
And status, controls, and field labels remain visible and keyboard operable.

### AC-7: Loading and failure states (FR-11)

Given one or more required API calls are pending or fail
When the page renders
Then it shows a loading state or a recoverable error with a retry action
And it does not render fabricated connection data.

## Edge Cases and Error Scenarios

- EC-1: No Bitrix24 connection exists -> show an empty state with the existing
  add-connection route.
- EC-2: A connection state request fails -> retain the connection item, mark it
  as requiring attention, and expose a redacted load error.
- EC-3: An open-line request fails -> display the saved line identifier when
  available and keep edit retryable.
- EC-4: The selected BrixChat channel is no longer active -> show it as
  unavailable and require a valid selection before activation.
- EC-5: Search/filter yields no matches -> show a filtered-empty state with a
  clear-filters action.
- EC-6: Local storage is unavailable -> default to list view without blocking
  page rendering.
- EC-7: Health, save, register, activate, or deactivate fails -> keep the drawer
  open and display the normalized API error without clearing user input.
- EC-8: The user deactivates a connector -> require the current confirmation
  and preserve historical data through the existing endpoint behavior.

## API Contracts

The redesign consumes the existing contracts without schema changes:

```ts
interface OpenChannelsConnectionSummary {
  connectionId: string;
  connectionName: string;
  portalUrl: string | null;
  state: OpenChannelsState | null;
  lines: BitrixOpenLine[];
  loadError?: string;
}

GET  /api/v1/integrations
GET  /api/v1/channels
GET  /api/v1/integrations/:id/open-channels
GET  /api/v1/integrations/:id/open-channels/lines
GET  /api/v1/integrations/:id/pipelines
PUT  /api/v1/integrations/:id/open-channels
POST /api/v1/integrations/:id/open-channels/register
POST /api/v1/integrations/:id/open-channels/activate
POST /api/v1/integrations/:id/open-channels/deactivate
POST /api/v1/integrations/:id/open-channels/health
```

All responses retain the existing `{ data, error? }` envelope. Authentication,
tenant scope, permissions, validation, conflict, throttling, and provider error
semantics remain defined by
`BITRIX24-OPEN-CHANNELS-AUTO-CRM-SPEC.md`.

## Data Models

No database migration is required. The presentation model is derived in memory
from existing tenant-scoped entities:

| Entity                                          | Identity                    | UI purpose                                    |
| ----------------------------------------------- | --------------------------- | --------------------------------------------- |
| `integration_connections`                       | connection `id`             | Bitrix24 connection/card                      |
| `bitrix_open_channel_connectors`                | `integration_connection_id` | connector status and health                   |
| `integration_connections.settings.openChannels` | connection-scoped JSON      | selected channel, line, direction, CRM policy |
| `channels`                                      | channel `id`                | active BrixChat channel name and health       |
| Bitrix open-line response                       | external line `id`          | line name and availability                    |
| `crm_pipeline_cache`                            | connection and external IDs | pipeline/stage edit options                   |

## Out of Scope

- OS-1: New activity analytics or 24-hour message counters, because the current
  API does not expose a verified aggregate for this page.
- OS-2: Drag-and-drop state mutation in Kanban; lifecycle changes require
  explicit confirmed actions.
- OS-3: Database migrations or replacement Open Channels endpoints; the
  existing connection-scoped contracts are sufficient.
- OS-4: Instagram or other future connector rows that are not returned as real
  Bitrix24/Open Channels connections.
- OS-5: Changes to provider workers, message delivery, automatic CRM matching,
  or Bitrix event processing.

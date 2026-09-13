# Spec: Automation Reliability and Truthful Studio Modernization

**Author:** Codex with repository owner requirements
**Date:** 2026-07-30
**Status:** Approved
**Reviewers:** Repository owner (phased plan approved with “başla”; professional node connections explicitly requested on 2026-07-30)
**Related specs:** `MILESTONE-5-SPEC.md`, `INBOX-CLOUD-API-AUDIT.md`

## Context

Brixchat24 already has a durable automation core: inbound messages create
`automation_events`, the worker matches published rules, and ordered actions can
add or remove a label, assign a user, or enqueue an approved WhatsApp template.
A controlled local acceptance test proved that a unique inbound message created
one completed run, added the `Takip` label, assigned the conversation, and
became visible in the Inbox.

The current Automation Studio presents capabilities that the executable model
does not honor. Canvas edges, branches, delay nodes, “ready” status, test,
analytics, and version tabs are not connected to the stored rule or worker
execution model. Existing automation routes also omit detail/update and
lifecycle operations promised by the Milestone 5 contract. A worker exception
can leave an event locked in `processing` without retry or dead-letter
resolution.

This increment makes the current linear Trigger → Conditions → Ordered Actions
engine reliable and makes the Studio truthful. Arbitrary graph branching and
delayed execution remain unavailable until a graph executor is specified and
implemented. No visual control may claim a capability that is not enforced by
the API and worker.

## Functional Requirements

- FR-1: Automation event claiming MUST recover stale `processing` locks and
  MUST increment an attempt counter for every claim.
- FR-2: A failed automation event MUST transition to `retry` with bounded
  exponential backoff or to `dead_letter` after its maximum attempts.
- FR-3: A worker exception MUST mark the active run and active step as failed
  where they exist, store a redacted error code, and release the event lock.
- FR-4: An action with missing or tenant-invalid required configuration MUST
  produce a `blocked` or `failed` step and MUST NOT be recorded as completed.
- FR-5: A rate-limited rule MUST produce an observable skipped run/step result
  instead of silently disappearing.
- FR-6: Automation user assignment MUST write operation history and publish the
  same tenant-scoped realtime conversation-assignment event used by manual
  Inbox assignment.
- FR-7: The API MUST expose a tenant-scoped automation detail containing the
  rule, requested draft/published version, trigger, conditions, and actions.
- FR-8: The API MUST update an automation by immutable identifier; changing the
  name MUST NOT create or update another rule.
- FR-9: Updating a rule MUST create a new immutable draft version while the
  published version continues to execute until explicit publish.
- FR-10: The API MUST provide pause, resume, duplicate, and archive lifecycle
  operations with existing automation RBAC and tenant isolation.
- FR-11: Publishing MUST reject an absent rule, an archived rule, unsupported
  catalog entries, and invalid action configuration.
- FR-12: Duplicate MUST create an independent draft rule and draft version with
  a unique organization-scoped name.
- FR-13: Archive MUST stop future execution without deleting rules, versions,
  runs, or step history.
- FR-14: The Studio MUST load an existing automation by its route identifier
  and MUST save changes back to that identifier.
- FR-15: The Studio palette and type selectors MUST be generated from
  `availability=available` API catalog entries; planned entries MUST NOT be
  actionable.
- FR-16: The first modern Studio increment MUST represent only one trigger,
  zero-to-twenty AND conditions, and one-to-twenty actions connected as one
  directed linear execution path.
- FR-17: Executable branch, merge, delay, SLA, analytics, and version-restore
  controls MUST be absent or explicitly labeled “planned”; they MUST NOT claim
  readiness.
- FR-18: The Studio MUST configure required fields for label actions, user
  assignment, and approved WhatsApp-template actions before save or publish.
- FR-19: Studio validation MUST use the server catalog and API validation
  response, show field-level errors, and disable publish while invalid.
- FR-20: Dry-run MUST display condition-by-condition matched results and MUST
  NOT execute actions or create outbound messages.
- FR-21: Run history MUST distinguish completed, skipped, blocked, retrying,
  failed, and dead-letter results with redacted error codes.
- FR-22: Inbox acceptance MUST prove that one signed inbound webhook creates
  one message, one automation event, at most one run per matching rule/event,
  ordered steps, and the expected visible conversation mutation.
- FR-23: All new API mutations MUST write tenant-scoped audit records without
  secrets, message bodies, phone numbers, or template variable values.
- FR-24: Existing Open Channels working-tree changes and unrelated product
  behavior MUST remain untouched.
- FR-25: Every node output port MUST expose a keyboard-operable `+` control
  that starts connection mode and MUST render a dotted preview toward the
  pointer or focused target.
- FR-26: Completing a connection MUST create one directed edge, prevent
  self-links, duplicate edges, cycles, multiple incoming edges, and multiple
  outgoing edges in linear mode.
- FR-27: A node not reachable from the trigger MUST be visibly marked as
  disconnected and MUST block save and publish.
- FR-28: Save MUST derive condition/action order from the connected path rather
  than node insertion order or canvas coordinates.

## Non-Functional Requirements

- NFR-1: Automation event claiming MUST use `FOR UPDATE SKIP LOCKED`.
- NFR-2: Default stale-lock recovery MUST occur after two minutes and MUST be
  configurable by environment.
- NFR-3: Default maximum attempts MUST be five; retry delay MUST be bounded
  between one second and five minutes.
- NFR-4: Event deduplication MUST preserve the existing unique
  organization/event/correlation/origin boundary.
- NFR-5: Worker processing MUST preserve the default maximum depth of five and
  maximum actions per run of twenty.
- NFR-6: Lifecycle and detail endpoints MUST enforce tenant isolation and
  existing `automations:*` permissions server-side.
- NFR-7: API error responses MUST use stable machine-readable codes and
  Turkish user-facing messages.
- NFR-8: Studio controls MUST be keyboard operable, visibly focused, and
  usable without drag-and-drop.
- NFR-9: The Studio MUST remain readable at 1280, 1024, 768, and 390 CSS-pixel
  viewport widths without horizontal page overflow.
- NFR-10: No schema migration may be applied to production without backup proof
  and a successful migration preflight.
- NFR-11: Unit, API integration, worker integration, web typecheck/build, and
  signed-in Inbox E2E MUST pass before deployment.
- NFR-12: Local, staging, and production source/version identity MUST be
  recorded separately; a stale local container MUST NOT be reported as current
  source acceptance.
- NFR-13: Connection preview MUST update within one animation frame during
  pointer movement and connection controls MUST have at least a 32×32 CSS-pixel
  hit target with visible keyboard focus.

## Acceptance Criteria

### AC-1: Recover and retry a failed event (FR-1, FR-2, FR-3, NFR-1, NFR-2, NFR-3)

Given an automation event whose worker action throws
When the event is processed
Then the event becomes `retry` with a future `next_attempt_at`, its lock is
cleared, and its attempt count increases
And after maximum attempts it becomes `dead_letter` with a redacted error code.

### AC-2: Recover a stale lock (FR-1, NFR-1, NFR-2)

Given an automation event stuck in `processing` beyond the configured lock age
When another worker claims work
Then that event is safely reclaimed exactly once through `SKIP LOCKED`.

### AC-3: Reject incomplete action configuration (FR-4, FR-11, FR-18)

Given an `assign_user`, label, or template action without its required
tenant-valid identifiers
When a draft is saved or published
Then the API rejects it with a stable validation code
And the worker never records the incomplete action as completed.

### AC-4: Preserve published version during edit (FR-7, FR-8, FR-9)

Given an active rule at published version 2
When an authorized owner edits it by ID
Then draft version 3 is created while version 2 remains active
And detail requests can return either the draft or published definition.

### AC-5: Lifecycle operations (FR-10, FR-12, FR-13, FR-23, NFR-6)

Given a tenant-owned automation
When an authorized owner pauses, resumes, duplicates, or archives it
Then each operation returns the correct state, writes an audit record, and
preserves historical versions/runs
And an agent or another tenant receives 403 or 404 without data disclosure.

### AC-6: Truthful Studio edit flow (FR-14, FR-15, FR-16, FR-17, FR-19, NFR-8)

Given an existing automation route
When the Studio loads
Then it renders the saved trigger, AND conditions, and ordered actions from the
detail API
And only available catalog items can be selected
And unsupported graph controls do not appear as working features.

### AC-7: Dry-run without side effects (FR-20)

Given a draft and sample event context
When the owner runs a dry-run
Then each condition shows its matched result and the overall result
And no automation run, step, message, label, assignment, or outbox job is
created.

### AC-8: Assignment is observable in Inbox (FR-6, FR-22)

Given a published matching rule with `assign_user`
When one signed inbound message is processed
Then one assignment history record and one realtime assignment event are
produced
And the Inbox displays the selected assignee without a manual page reload.

### AC-9: Idempotent inbound execution (FR-22, NFR-4, NFR-5)

Given the same signed provider event is delivered twice
When webhook and worker processing complete
Then one canonical message, one automation event per dedupe boundary, and at
most one run per rule/event exist.

### AC-10: Responsive and releasable (FR-21, FR-24, NFR-9, NFR-10, NFR-11, NFR-12)

Given the final source commit
When validation and release checks run
Then all required automated checks pass, responsive Studio states are visually
accepted, Graphify is updated, and any production migration remains blocked
until backup proof exists.

### AC-11: Connect and compile a node path (FR-16, FR-19, FR-25, FR-26, FR-27, FR-28, NFR-8, NFR-13)

Given a Studio canvas with a trigger and one disconnected action
When the owner activates the trigger output `+`, moves toward the action, and
selects the action input
Then a dotted preview is visible during connection mode and a persistent
directed edge is created
And the action is no longer marked disconnected
And save sends the graph to server validation and persists conditions/actions
in trigger-reachable path order.

## Edge Cases

- EC-1: Worker exits after claiming but before creating a run; stale-lock
  recovery retries the event.
- EC-2: Worker exits after creating a run but before completing a step;
  idempotency prevents a second run and recovery finalizes the existing run.
- EC-3: The configured user, label, channel, or template is deleted or disabled
  after publish; the step becomes blocked with a stable reason.
- EC-4: A rule is paused while an event is already processing; the claimed run
  may finish, but no later event selects the paused rule.
- EC-5: A rule is archived while a draft exists; published execution stops and
  history remains readable.
- EC-6: Duplicate names collide; the API generates a deterministic numbered
  suffix within the organization.
- EC-7: Editing changes a rule name to another rule’s name; the update is
  rejected without mutating either rule.
- EC-8: Dry-run context omits a field; operators follow the existing null/empty
  semantics and return a deterministic result.
- EC-9: Realtime publication fails after the database commit; durable
  assignment/history remain correct and Inbox polling can recover.
- EC-10: A template is no longer approved for the configured channel; publish
  or execution blocks without creating an outbound message.
- EC-11: Rate limits are reached; the decision is recorded and does not leave
  the event locked.
- EC-12: The local web container is older than the source; acceptance reports
  the mismatch and rebuilds before visual verification.
- EC-13: A connection targets its source, an existing edge, or a node that
  would create a cycle; the Studio rejects it without changing the graph.
- EC-14: Deleting a node removes its incident edges and marks any downstream
  nodes that become unreachable as disconnected.
- EC-15: Pointer connection mode is cancelled with Escape or a second click on
  the source `+`; no partial edge is persisted.

## API Contracts

```ts
type AutomationStatus = "draft" | "active" | "paused" | "archived";
type AutomationVersionSelector = "draft" | "published";

interface AutomationActionInput {
  type:
    | "add_label"
    | "remove_label"
    | "assign_user"
    | "send_whatsapp_template";
  config: Record<string, unknown>;
}

interface AutomationDefinitionInput {
  name: string;
  description?: string;
  priority: number;
  stopProcessing: boolean;
  trigger: { type: string; config: Record<string, unknown> };
  conditions: Array<{ field: string; operator: string; value: unknown }>;
  actions: AutomationActionInput[];
}

interface AutomationDetail {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  priority: number;
  stopProcessing: boolean;
  draftVersion: number;
  publishedVersion: number | null;
  selectedVersion: number;
  trigger: { type: string; config: Record<string, unknown> };
  conditions: Array<{ position: number; field: string; operator: string; value: unknown }>;
  actions: Array<{ position: number; type: string; config: Record<string, unknown> }>;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AutomationEventState {
  status: "pending" | "processing" | "retry" | "completed" | "blocked" | "dead_letter";
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastErrorCode: string | null;
}

interface AutomationGraphValidationInput {
  mode: "linear";
  nodes: Array<{
    id: string;
    type: string;
    category: "trigger" | "condition" | "action";
    position: { x: number; y: number };
    config: Record<string, unknown>;
  }>;
  edges: Array<{ id: string; source: string; target: string }>;
}

GET    /api/v1/automations
POST   /api/v1/automations
GET    /api/v1/automations/:id?version=draft|published
PUT    /api/v1/automations/:id
POST   /api/v1/automations/:id/publish
POST   /api/v1/automations/:id/pause
POST   /api/v1/automations/:id/resume
POST   /api/v1/automations/:id/duplicate
POST   /api/v1/automations/:id/archive
POST   /api/v1/automations/:id/dry-run
GET    /api/v1/automations/:id/runs
GET    /api/v1/automations/catalog
POST   /api/v1/automations/validate-graph
```

All endpoints retain the existing `{ data, error? }` response envelope.

## Data Models

| Entity                           | Required additions/constraints                                                    | Purpose                            |
| -------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------- |
| `automation_rules`               | status limited to draft/active/paused/archived; unique organization/name retained | Stable rule identity and lifecycle |
| `automation_rule_versions`       | immutable version rows                                                            | Draft/published definition history |
| `automation_rule_triggers`       | one trigger per version                                                           | Linear entry event                 |
| `automation_rule_conditions`     | unique ordered positions, maximum 20                                              | AND condition list                 |
| `automation_rule_actions`        | unique ordered positions, maximum 20                                              | Ordered executable actions         |
| `automation_events`              | `attempt_count`, `max_attempts`, `last_error_code`; retry/dead-letter states      | Recoverable durable execution      |
| `automation_runs`                | completed/skipped/blocked/failed statuses and redacted error code                 | Rule execution observability       |
| `automation_run_steps`           | completed/skipped/blocked/failed statuses                                         | Action-level observability         |
| `conversation_operation_history` | automation origin and rule/run metadata                                           | Inbox assignment trace             |
| `audit_logs`                     | lifecycle action and redacted metadata                                            | Administrative accountability      |

The new automation-event columns require an additive migration. Production
application is separately gated by verified backup evidence.

## Out of Scope

- OS-1: Arbitrary branch/merge graph execution; visual connections compile to
  one truthful linear execution path.
- OS-2: Delay/SLA scheduling nodes; these require a separately specified durable
  scheduler.
- OS-3: Webhook and Bitrix24 timeline actions; catalog entries remain planned.
- OS-4: AI-generated automation rules or natural-language rule creation.
- OS-5: Drag-and-drop as the only editing method; ordered form controls remain
  the accessible source of truth.
- OS-6: Destructive deletion of rules, versions, events, runs, or steps.
- OS-7: Production migration or deployment without backup and release-gate
  evidence.
- OS-8: Changes to the previously modified Open Channels overview.

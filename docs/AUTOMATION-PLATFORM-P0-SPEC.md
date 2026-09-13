# Spec: Automation Platform P0 Core

**Author:** Codex with repository owner requirements
**Date:** 2026-07-30
**Status:** Approved
**Reviewers:** Repository owner via the attached Automation Studio platform brief
**Supersedes:** The P0 scope exclusions in `AUTOMATION-MODERNIZATION-SPEC.md`

## Context

Brixchat24 already persists automation rules, immutable rule-version rows,
events, runs and step results. The current worker selects active rules by
workspace and event type, evaluates a linear AND condition list, executes a
small set of actions, and sends approved WhatsApp templates through the
transactional outbox. The current uncommitted reliability increment also adds
stale-lock recovery, retry/dead-letter state and a connected linear Studio
graph.

The executable model is still a positional rule engine rather than a node
runtime. Catalog entries are presentation metadata instead of versioned node
contracts, graph JSON is not compiled into an immutable runtime definition,
branch outputs are not executed, and durable wait/SLA continuation does not
exist. BullMQ is installed in the worker but is not used by the automation
runtime. Runtime behavior is implemented as a large conditional block in the
worker rather than registered handlers.

This specification establishes the P0 platform seam without replacing the
canonical message, conversation, contact, channel, outbox, Bitrix24, RBAC or
workspace-isolation systems. The initial implementation MUST preserve the
existing linear rule contract while introducing a versioned node contract,
typed registries and an immutable compiler. Branch and wait nodes MUST become
actionable only when their registered runtime handlers and persistence paths
exist.

## Functional Requirements

- FR-1: Every node MUST use a shared, versioned contract containing `id`,
  `type`, `version`, `category`, `name`, `description`, `position`, `config`,
  `inputPorts`, `outputPorts`, `retryPolicy`, `timeoutPolicy`, `errorPolicy`,
  `uiMetadata`, and `runtimeMetadata`.
- FR-2: Technical node type and user-visible label MUST be separate fields.
- FR-3: Trigger, condition and action definitions MUST be registered centrally
  by technical type and version.
- FR-4: Registry definitions MUST expose config validation, input/output ports,
  availability, runtime capability and UI metadata.
- FR-5: Duplicate registry keys MUST be rejected during process startup or
  tests.
- FR-6: Publishing MUST validate node contracts and config schemas, normalize
  the graph, identify unreachable nodes, reject missing endpoints, reject
  empty required branches and reject unsupported cycles.
- FR-7: Publishing MUST produce an immutable compiled definition containing a
  compiler version, stable checksum, entry node, normalized nodes, normalized
  edges, adjacency data and execution limits.
- FR-8: Runtime MUST execute a persisted compiled definition and MUST NOT
  interpret mutable Studio coordinates or an unvalidated graph.
- FR-9: Existing linear definitions MUST compile through a compatibility
  adapter into the same compiled-definition contract.
- FR-10: A condition node MUST expose explainable evaluation output containing
  masked input summary, operator, comparison summary, result and selected
  output port.
- FR-11: Branch nodes MUST route through named `true` and `false` output ports;
  switch nodes MUST route through explicit case ports and a default port.
- FR-12: End-success and end-failure nodes MUST terminate executions with
  deterministic completed or failed states.
- FR-13: Wait nodes MUST persist a continuation before scheduling a BullMQ
  delayed job and MUST expose success, timeout, error and cancelled outputs.
- FR-14: Waiting MUST NOT keep an HTTP request, database transaction or worker
  thread open.
- FR-15: Resume jobs MUST be idempotent by workspace, execution, step and
  continuation generation.
- FR-16: Customer-reply and agent-reply wait nodes MUST support cancellation
  keys and timer-reset policies based on canonical message events.
- FR-17: Every execution step MUST persist node ID, node type/version, input
  summary, output summary, selected port, status, attempt and redacted error.
- FR-18: Event, execution, step and side-effect idempotency keys MUST be
  independently enforced.
- FR-19: Message actions MUST use the existing transactional outbox and provider
  send pipeline; runtime handlers MUST NOT call providers directly.
- FR-20: Bitrix24 actions MUST use existing tenant-scoped Bitrix24 services and
  MUST preserve Bitrix24 as the CRM source of truth.
- FR-21: Trigger candidate selection MUST filter by workspace, trigger type,
  active status and channel scope before loading compiled definitions.
- FR-22: Channel scope MUST support selected channels, all current channels,
  and all current/future channels with exclusions.
- FR-23: Dry-run MUST use the same registry evaluators and compiler semantics as
  runtime while suppressing all database mutations, outbox writes, external
  requests and realtime side effects.
- FR-24: API permissions and workspace ownership MUST be enforced server-side
  for create, edit, publish, pause, archive, test, run viewing, run cancel,
  retry, analytics and version operations.
- FR-25: Studio node library and inspector MUST be generated from registry
  metadata and config schemas rather than duplicated hard-coded arrays.
- FR-26: Studio MUST label definitions without a production runtime handler as
  planned and MUST prevent them from being published.
- FR-27: Existing message-received, label add/remove, user assignment and
  WhatsApp-template behavior MUST remain operational during migration.
- FR-28: Existing unrelated Open Channels and Bitrix24 working-tree changes
  MUST remain untouched.
- FR-29: Runtime limits MUST be configurable through the existing config system
  for worker concurrency, maximum steps, loops, execution duration, subflow
  depth, retry limit, stale age, retention and webhook timeout.
- FR-30: Production migration or deployment MUST remain blocked until backup
  evidence and migration preflight succeed.

## Non-Functional Requirements

- NFR-1: Compiling the same semantic graph in a different node or edge array
  order MUST produce the same checksum.
- NFR-2: Registry lookup MUST be constant-time by `type@version`.
- NFR-3: Default maximum execution steps MUST be 100 and configurable between
  1 and 1000.
- NFR-4: Default maximum loop iterations MUST be 20 and configurable between 1
  and 100.
- NFR-5: Default maximum subflow depth MUST be 5 and configurable between 1 and
  20.
- NFR-6: Default retry limit MUST be 5 with bounded exponential backoff between
  one second and five minutes.
- NFR-7: A continuation MUST survive worker restart and Redis reconnect because
  PostgreSQL remains its durable source of truth.
- NFR-8: Queue names MUST be namespaced by application environment and
  workspace-neutral job data MUST NOT contain credentials or message bodies.
- NFR-9: All persisted errors and dry-run explanations MUST mask phone numbers,
  secrets, tokens and message bodies by default.
- NFR-10: Graph and registry unit tests MUST run without PostgreSQL, Redis or
  external credentials.
- NFR-11: Integration tests MUST prove tenant isolation and duplicate-event
  safety against PostgreSQL.
- NFR-12: Existing API, web and worker typecheck/lint/build suites MUST remain
  green.
- NFR-13: New schema changes MUST be additive and reversible without deleting
  rule, version, run or message history.
- NFR-14: No button or node may advertise production readiness unless its
  registry definition has `runtimeCapability="production"`.

## Acceptance Criteria

### AC-1: Versioned node contract (FR-1, FR-2, FR-4, NFR-10)

Given a node definition with all required contract fields
When it is parsed
Then a normalized immutable node contract is returned
And an unknown category, invalid port, unsupported version or invalid policy is
rejected with a stable issue code.

### AC-2: Registry safety (FR-3, FR-4, FR-5, FR-25, FR-26, NFR-2, NFR-14)

Given trigger, condition and action definitions
When registries are created
Then lookup by technical type and version is constant-time
And duplicate keys are rejected
And only definitions with a production runtime capability are publishable.

### AC-3: Immutable graph compilation (FR-6, FR-7, NFR-1, NFR-3, NFR-4, NFR-5)

Given a valid connected graph with named ports
When it is compiled
Then the result contains a compiler version, checksum, entry node, adjacency
data and execution limits
And reordering input arrays does not change the checksum
And mutating the source graph does not mutate the compiled definition.

### AC-4: Invalid graph rejection (FR-6, FR-11, NFR-10)

Given a graph with an unreachable node, missing port, empty branch, duplicate
edge, self-edge, unsupported cycle or more than one trigger
When publish validation runs
Then compilation fails with stable node/edge-scoped issue codes.

### AC-5: Linear compatibility (FR-9, FR-27)

Given an existing trigger, AND conditions and ordered actions definition
When the compatibility adapter compiles it
Then it produces one trigger-reachable compiled path in the same condition and
action order
And existing published rules remain executable without destructive migration.

### AC-6: Explainable branching (FR-10, FR-11, FR-12, FR-17)

Given a condition followed by true and false paths
When the evaluator returns true or false
Then the matching named output port is selected
And a masked explanation is persisted in the step result
And the selected end node deterministically completes or fails the run.

### AC-7: Durable wait and resume (FR-13, FR-14, FR-15, FR-17, FR-29, NFR-7, NFR-8)

Given an execution reaches a duration wait node
When the step is suspended
Then a PostgreSQL continuation is committed before one namespaced BullMQ job is
scheduled
And after worker restart the job resumes the same execution/version exactly
once through its success port.

### AC-8: Reply cancellation (FR-16, FR-18)

Given a customer-reply or agent-reply wait
When the matching canonical message event arrives
Then the active continuation is atomically cancelled or resumed exactly once
And a later timeout job produces no action.

### AC-9: Side-effect idempotency and outbox (FR-18, FR-19)

Given the same provider event or retry is processed more than once
When a message action executes
Then only one execution-side-effect key and one canonical outbox send are
created.

### AC-10: Channel-scoped candidate selection (FR-21, FR-22, NFR-11)

Given three channels and a rule scoped to one channel
When events arrive on all channels
Then only the selected channel creates a run
And all-current/future scope includes newly created channels unless excluded.

### AC-11: Side-effect-free dry-run (FR-23, NFR-9)

Given a compiled definition and sample context
When dry-run executes
Then the trigger, conditions, branches, variables, waits and planned actions
are explained
And no run, step, message, label, assignment, outbox job, Bitrix24 request or
realtime event is created.

### AC-12: Security and release gates (FR-20, FR-24, FR-25, FR-26, FR-28, FR-29, FR-30, NFR-11, NFR-12, NFR-13)

Given the completed P0 increment
When validation runs
Then RBAC and tenant-isolation tests pass, existing product suites remain green,
Graphify is updated and migration/deployment is not executed without verified
backup evidence.

## Edge Cases

- EC-1: A registry contains the same technical type and version twice; startup
  fails before serving traffic.
- EC-2: A saved graph references a removed registry version; publish is blocked
  while an already published compiled definition remains executable.
- EC-3: Studio coordinates or metadata change without semantic changes; the
  semantic checksum remains stable.
- EC-4: A condition output edge uses an unknown port; compilation fails with
  `unknown_output_port`.
- EC-5: A branch has `true` but no `false` path; compilation fails with
  `required_output_unconnected`.
- EC-6: A wait job is delivered after its continuation was cancelled; the job
  completes as a no-op and no downstream step runs.
- EC-7: Redis is unavailable after the PostgreSQL continuation commits; a
  recovery scanner schedules the missing job later.
- EC-8: Redis accepts the job but the worker crashes before acknowledgement;
  the continuation generation makes redelivery idempotent.
- EC-9: Version 2 is published while a version 1 execution is waiting; the old
  execution resumes with compiled version 1.
- EC-10: A configured channel, user, team, label or template is deleted after
  publish; the handler returns a blocked/error port without cross-tenant lookup.
- EC-11: A message action retries after an ambiguous provider response; the
  canonical outbox/idempotency record prevents a second send.
- EC-12: An automation triggers itself recursively; depth and step limits stop
  the run with a stable limit code.
- EC-13: A webhook target resolves to private, loopback, link-local or cloud
  metadata IP space; execution is blocked before the request.
- EC-14: Production backup evidence is missing; migration and deployment remain
  NO-GO even when unit tests pass.

## API Contracts

```ts
type RuntimeCapability = "production" | "dry-run-only" | "planned";
type NodeCategory =
  | "trigger" | "condition" | "time" | "messaging" | "assignment"
  | "conversation" | "crm" | "integration" | "control"
  | "ai" | "error";

interface AutomationNodeContract {
  id: string;
  type: string;
  version: number;
  category: NodeCategory;
  name: string;
  description: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  inputPorts: Array<{ id: string; kind: "control" | "data"; required: boolean }>;
  outputPorts: Array<{
    id: string;
    kind: "success" | "true" | "false" | "case" | "timeout" | "error" | "cancelled";
    required: boolean;
  }>;
  retryPolicy: { maxAttempts: number; backoffMs: number; maxBackoffMs: number };
  timeoutPolicy: { timeoutMs: number | null };
  errorPolicy: { mode: "fail" | "continue" | "route" };
  uiMetadata: { label: string; icon: string; color: string };
  runtimeMetadata: { capability: RuntimeCapability; handlerKey: string | null };
}

interface CompiledAutomationDefinition {
  compilerVersion: 1;
  checksum: string;
  entryNodeId: string;
  nodes: ReadonlyArray<AutomationNodeContract>;
  edges: ReadonlyArray<{ id: string; source: string; sourcePort: string; target: string; targetPort: string }>;
  adjacency: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<string>>>>>;
  limits: { maxSteps: number; maxLoopIterations: number; maxSubflowDepth: number };
}

interface AutomationContinuation {
  id: string;
  organizationId: string;
  runId: string;
  versionId: string;
  nodeId: string;
  generation: number;
  status: "scheduled" | "resumed" | "cancelled" | "expired" | "failed";
  resumeAt: string | null;
  cancellationKeyHash: string | null;
  queueJobId: string | null;
}

POST /api/v1/automations/validate-graph
POST /api/v1/automations/:id/publish
POST /api/v1/automations/:id/dry-run
GET  /api/v1/automations/catalog
GET  /api/v1/automations/:id/runs
POST /api/v1/automation-runs/:runId/cancel
POST /api/v1/automation-runs/:runId/retry
```

All endpoints MUST retain the existing `{ data, error? }` envelope and stable
machine-readable error codes.

## Data Models

| Entity | Required additions/constraints | Purpose |
| --- | --- | --- |
| `automation_rule_versions` | `source_graph`, `compiled_definition`, `compiler_version`, `definition_checksum`; published compiled definition immutable | Version-safe runtime |
| `automation_node_definitions` | Optional future DB override; built-in registry remains code-owned in P0 | Extension seam |
| `automation_runs` | `version_id`, `current_node_id`, execution limits snapshot | Resume exact version |
| `automation_run_steps` | `node_id`, `node_version`, `selected_port`, `attempt`, masked summaries | Explainable timeline |
| `automation_continuations` | unique run/node/generation, durable status and resume/cancel keys | Wait/SLA recovery |
| `automation_side_effects` | unique organization/run/node/idempotency key | Duplicate prevention |
| `automation_events` | existing retry/dead-letter additions retained | Durable domain events |

All schema changes MUST be additive. Existing trigger, condition and action
tables remain readable through the compatibility adapter until a later
deprecation migration.

## Out of Scope

- OS-1: Independent CRM or pipeline models inside Brixchat24; Bitrix24 remains
  the CRM source of truth.
- OS-2: A second messaging transport, duplicate provider sender or alternative
  outbox.
- OS-3: Production-ready AI nodes before deterministic P0/P1 nodes and human
  approval policies are complete.
- OS-4: Enabling catalog cards without production runtime handlers.
- OS-5: Destructive deletion of automation versions, runs, steps or messages.
- OS-6: Production migration or deployment without backup proof.
- OS-7: Rewriting unrelated Open Channels, Inbox, media or Bitrix24 behavior.
- OS-8: Completing every P1-P3 node in the same atomic release; those packages
  MUST land only after the P0 compiler, idempotency and continuation contracts
  are proven.

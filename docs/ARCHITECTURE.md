# Brixchat24 Milestone 1 Architecture

## Repository analysis

The repository contained only Git metadata before initialization. Milestone 1 therefore establishes the product's architectural boundaries instead of adapting a legacy runtime. The browser never accesses PostgreSQL directly. Every tenant-scoped command crosses the API authorization layer and every query requires an `organizationId`.

## System architecture

```mermaid
flowchart LR
  U[Agent browser] --> W[Next.js web]
  W -->|JWT + organization context| A[Fastify API]
  A --> R[(Redis / BullMQ)]
  A --> P[(PostgreSQL)]
  R --> K[Worker]
  K --> P
  K -. provider adapter .-> M[Meta Cloud API - next milestone]
  A --> O[Structured audit + request logs]
  K --> O
```

## Monorepo

```text
apps/web       Next.js dashboard and inbox
apps/api       Fastify REST API and tenant authorization
apps/worker    BullMQ worker boundary
packages/auth  JWT claims, roles, and permission policy
packages/database Drizzle schema, migration, and seed
packages/shared Domain contracts and demo fixtures
packages/validation Zod request contracts
packages/ui     Reusable UI primitives
packages/config Environment parsing
packages/integrations Provider contracts
packages/observability Structured logging contracts
```

## ER model

```mermaid
erDiagram
  USERS ||--o{ ORGANIZATION_MEMBERS : joins
  ORGANIZATIONS ||--o{ ORGANIZATION_MEMBERS : has
  ORGANIZATIONS ||--o{ TEAMS : owns
  ORGANIZATIONS ||--o{ CONTACTS : owns
  ORGANIZATIONS ||--o{ CHANNELS : owns
  ORGANIZATIONS ||--o{ CONVERSATIONS : owns
  CONTACTS ||--o{ CONVERSATIONS : starts
  CHANNELS ||--o{ CONVERSATIONS : receives
  CONVERSATIONS ||--o{ MESSAGES : contains
  USERS ||--o{ CONVERSATIONS : assigned
  ORGANIZATIONS ||--o{ AUDIT_LOGS : records
```

## Outbound message sequence

```mermaid
sequenceDiagram
  participant UI
  participant API
  participant DB
  participant Worker
  UI->>API: POST message + clientMessageId
  API->>API: authenticate, authorize, validate window
  API->>DB: transaction: pending message + outbox job
  API-->>UI: 202 pending
  Worker->>DB: claim outbox job
  Worker->>Worker: provider adapter send
  Worker->>DB: persist provider id and status
  Worker-->>UI: realtime message.status_changed
```

## Inbound webhook sequence

```mermaid
sequenceDiagram
  participant Meta
  participant API
  participant DB
  participant Queue
  participant Worker
  Meta->>API: signed webhook
  API->>API: verify signature
  API->>DB: insert provider event (unique provider event id)
  API->>Queue: enqueue normalization
  API-->>Meta: 200 quickly
  Queue->>Worker: event
  Worker->>DB: tenant contact, conversation, message upsert
  Worker-->>UI: realtime message.created
```

## Authorization matrix

| Capability          | Owner | Admin | Team lead |    Agent |    Viewer |
| ------------------- | ----: | ----: | --------: | -------: | --------: |
| View inbox          |   All |   All |      Team | Assigned | Read only |
| Send message        |   Yes |   Yes |       Yes | Assigned |        No |
| Assign conversation |   Yes |   Yes |      Team |       No |        No |
| Manage members      |   Yes |   Yes |        No |       No |        No |
| Manage channels     |   Yes |   Yes |        No |       No |        No |
| View reports        |   Yes |   Yes |      Team |      Own |        No |
| Billing             |   Yes |    No |        No |       No |        No |

Backend policy checks are authoritative; UI visibility is only a convenience.

## Development phases

1. Foundation: repository, tenant identity, RBAC, dashboard, inbox, migration and seed.
2. Messaging core: provider adapter, webhook inbox, outbox, delivery state machine and realtime.
3. CRM: contacts, custom fields, pipelines, deals and deduplication.
4. Operations: templates, automation, tasks, notifications and channel health.
5. Growth: consent-safe campaigns, analytics, integrations and billing limits.
6. Production hardening: load tests, disaster recovery, security review and deployment gates.

## Risks and controls

- Tenant data leakage: mandatory organization-scoped repository methods plus isolation tests.
- Duplicate provider events: unique idempotency constraints and raw event ledger.
- WhatsApp policy drift: provider policy module and backend-enforced messaging window.
- Secret exposure: encrypted credential envelope and redacted structured logs.
- Queue divergence: transactional outbox, exponential retry and dead-letter inspection.
- Health-data sensitivity: tenant-defined fields, access audit, retention and export/delete workflows.
- Local Docker availability: acceptance records infrastructure failures separately from application failures.

## Milestone 1 file changes

Milestone 1 creates the workspace manifests, three runnable apps, shared packages, initial SQL migration and deterministic seed, tenant-aware auth/RBAC endpoints, dashboard/inbox UI, tests, Docker Compose, environment template and operational README.

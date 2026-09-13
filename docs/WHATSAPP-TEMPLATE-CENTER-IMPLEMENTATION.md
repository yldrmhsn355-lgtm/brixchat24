# WhatsApp Template Management Center

## Phase 0 — Existing system analysis

### Current end-to-end flow

1. A workspace administrator configures a `channels` row with a provider, WABA
   (`business_account_id`), phone-number ID and encrypted credentials.
2. `POST /api/v1/channels/:id/templates/sync` creates a
   `template_sync_runs` row, decrypts the channel credentials and resolves the
   provider through the existing provider-neutral messaging factory.
3. The Meta adapter follows `paging.next` until all WABA templates are read,
   normalizes the basic header/body/footer/buttons and body parameters, then the
   API upserts by `(channel_id, name, language)`. Missing provider records are
   archived.
4. `GET /api/v1/templates` supplies the passive template table and
   `GET /api/v1/templates/:id` supplies a basic detail payload.
5. Inbox uses `GET /api/v1/channels/:id/templates`. Free text is rejected by the
   backend when `customer_service_window_expires_at` is closed. An approved,
   channel-matching template can instead be submitted to
   `POST /api/v1/conversations/:id/template-messages`.
6. Template submission validates body parameter positions in a transaction,
   creates a pending message, durable outbox job, flow events and a
   `template_send_events` row. The worker sends it through the same provider
   adapter and applies the existing retry/dead-letter policy.

### Working capabilities

- Workspace-scoped template list/detail and channel ownership checks on the
  inbox-specific template path.
- Meta pagination, deterministic fake-provider fixtures and idempotent database
  upsert.
- Approved-only template delivery through the transactional outbox.
- Backend-authoritative 24-hour customer-service-window enforcement for free
  text.
- HMAC webhook verification, durable webhook event deduplication, monotonic
  message statuses, SSE/realtime events, encrypted provider credentials and
  audit infrastructure.
- WABA and phone number identifiers are already lossless text fields.

### Gaps and risks

- The current page is a read-only search table. There is no WABA selector,
  summary, sync state, quality filter, detail drawer, wizard, draft lifecycle,
  family/language view, usage dependencies, analytics or audit history.
- Data is channel-centric. Multiple phone numbers on the same WABA duplicate a
  provider template and cannot be presented as one WABA template family.
- Template name normalization, family/fallback language, versioning,
  parameter format, component payloads, variable source/default/required/missing
  policy, folders/tags and soft deletion are missing.
- Sync deletes and recreates variable rows and does not persist components,
  cursors, idempotency keys or structured provider errors.
- Provider supports list/send only. Create and delete management calls are
  absent; editing restrictions are not surfaced.
- Sending assumes every parameter belongs to BODY and therefore cannot safely
  send media headers or button parameters.
- WABA template status/quality/category webhook fields are accepted and
  broadcast, but do not update local template records.
- Generic `inbox:read`, `channels:manage` and `message:send` permissions are too
  broad for the requested template-management separation.
- Template list/detail do not consistently apply channel ownership for
  agent/team-lead roles.
- Automation persists arbitrary action config but the worker implements only
  label and assignment actions; it does not execute a template-send action.
- There is no template-specific notification, dependency guard, periodic sync,
  test-send endpoint or cost/conversion attribution. Metrics must remain
  “unavailable” when provider/event evidence does not exist.
- The externally accessible Meta documentation returned HTTP 429 during this
  implementation session. Provider management behavior is therefore kept
  behind explicit adapter capabilities and the configured API version; live
  success is never inferred without credentials.

## File-based implementation plan

### Phase 1 — data and backend foundation

- `packages/database/migrations/0011_whatsapp_template_center.sql`: additive,
  backward-compatible columns; WABA-aware families, variable mappings,
  dependencies, versions, webhook event deduplication and sync indexes.
- `packages/database/src/schema.ts`: Drizzle parity for the migration.
- `packages/auth/src/index.ts`: explicit template view/create/submit/edit/delete,
  test-send, analytics and sync permissions.
- `packages/integrations/src/messaging/template-utils.ts`: shared name,
  component, parameter, variable and language-fallback rules.

### Phase 2 — Meta management and synchronization

- `packages/integrations/src/messaging/types.ts`: provider-neutral management
  contracts and capability flags.
- `packages/integrations/src/meta-whatsapp/provider.ts`: create/delete and
  normalized component/page behavior using the configured Graph version.
- `packages/integrations/src/fake/provider.ts`: controlled management fixture.
- `apps/api/src/product-routes.ts`: draft/create/edit/submit/delete, WABA-aware
  list/detail, dependency checks, sync diagnostics and audit. Editing is limited
  to draft/rejected lifecycle states; approved content requires a new version.
- `apps/worker/src/index.ts`: status/quality/category webhook projection and
  durable, idempotent periodic sync handling. `TEMPLATE_SYNC_INTERVAL_MS`
  defaults to 15 minutes and the worker processes one due WABA per scan.

### Phases 3–5 — management UI

- `apps/web/app/app/templates/page.tsx`: responsive center with selectors,
  filters, summary, sync result, table, detail drawer and four-step wizard.
- `apps/web/components/whatsapp-template-preview.tsx`: reusable phone preview.
- `apps/web/app/globals.css`: scoped responsive and accessibility styles only.
- Focused frontend tests cover normalization, validation, fallback and preview
  helpers without depending on live Meta credentials.

### Phase 6 — Inbox

- `apps/web/app/app/inbox/workspace.tsx`: preserve the existing user changes and
  extend the existing template picker only at non-overlapping seams.
- `apps/api/src/product-routes.ts`: resolve variable mappings/defaults and keep
  final approved/channel/window authority in the transaction.
- `apps/worker/src/index.ts`: component-aware provider payload and duplicate-safe
  outbox delivery.

### Phase 7 — automation and Bitrix24

- `apps/api/src/milestone5-routes.ts`: validate template action configuration
  and dependency records.
- `apps/worker/src/index.ts`: execute `send_whatsapp_template` with language
  policy, opt-in, cooldown and idempotency.
- Reuse `conversation_crm_context_cache`, `crm_entity_links` and Bitrix field
  mappings; no parallel CRM or pipeline is introduced.

### Phase 8 — analytics and audit

- `apps/api/src/product-routes.ts`: indexed aggregate metrics from message,
  status and template send events; explicit unavailable fields.
- Existing `audit_logs`, notifications and SSE are reused for sync, mutation and
  provider status changes.

### Phase 9 — verification and operations

- Provider/unit/API tests, migration safety, lint, typecheck, test, production
  build and Graphify update.
- Live Meta create/delete/sync/send/webhook acceptance remains a separate,
  credentialed gate and cannot be reported as passed from fake-provider tests.

## Acceptance strategy

- Unit: normalization, component combinations, provider payloads, response
  normalization, variable policies and language fallback.
- API/database: workspace and channel isolation, RBAC, idempotent sync, duplicate
  webhook, dependency-protected delete and approved-only send.
- Integration: fake create → approval fixture → sync → inbox send; closed-window
  free-text rejection; automation idempotency.
- Production: migration/index check, queue retry/DLQ, redacted structured logs,
  configured timeouts/backoff, health, Docker build and external Meta acceptance
  with real credentials.

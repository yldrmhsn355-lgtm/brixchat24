# Milestone 6 � Production Acceptance, Load Testing, Security Hardening and Commercial Release

## Title and Metadata

- **Author:** Codex with repository owner requirements
- **Date:** 2026-07-17
- **Status:** Approved � the owner explicitly requested immediate implementation
- **Reviewers:** Repository owner
- **Target release state:** Production Candidate � External Acceptance Pending

## Context

Brixchat24 has completed the first five milestones and currently provides a multi-tenant WhatsApp operations layer, private media processing, message automation, realtime delivery, and Bitrix24 CRM context/Open Channels integration. Bitrix24 remains the source of truth for CRM entities, pipeline, tasks, sales automation, and CRM reporting. Milestone 6 MUST NOT introduce an internal CRM.

The current repository has development Docker services and an image-based production Compose definition. The API already protects metrics and redacts common authorization/cookie headers; workers use bounded database connections and graceful shutdown. Production gaps include a comprehensive fail-fast validator, edge TLS configuration, environment separation, worker heartbeat, commercial entitlements, privacy operations, acceptance tooling, load/security/recovery evidence, release gates, and CI/CD.

No real Meta, Bitrix24, S3/R2, ClamAV, SMTP, DNS, TLS, backup, or deployment credentials are present. Credential-free code and fake/local acceptance MUST proceed. External checks MUST be reported as pending and MUST block a production-ready declaration.

## Functional Requirements

- FR-1: The system MUST distinguish development, staging, and production configuration and MUST keep environment resources logically separate.
- FR-2: Production startup MUST fail fast for unsafe secrets, fake/local providers, insecure URLs/cookies/CORS, missing TLS controls, unprotected metrics, or development credentials.
- FR-3: `GET /health/configuration` MUST return only check name, status, and safe description.
- FR-4: A Caddy production edge configuration MUST enforce HTTPS, HSTS, security headers, body limits, trusted proxy routing, and separate app/API/webhook hosts.
- FR-5: Meta, Bitrix24, object storage, malware, and SMTP acceptance CLIs MUST redact secrets and MUST emit machine-readable and Markdown reports.
- FR-6: External acceptance without credentials MUST return `pending_external_acceptance`, never success.
- FR-7: Authentication security tests MUST cover rate limiting, generic errors, refresh rotation/reuse, revoke, one-time reset, invitation validation, suspended users, redirects, and OAuth state tampering.
- FR-8: A backend-enforced RBAC matrix MUST be testable for owner, admin, team lead, agent, and viewer.
- FR-9: A two-organization tenant-isolation suite MUST verify protected entity classes return 403/404 without existence disclosure.
- FR-10: Security tooling MUST include dependency audit, secret scan, SBOM, license inventory, container scan workflow, and staging-only OWASP scan instructions.
- FR-11: k6 load tests MUST cover auth, inbox, message send, webhook ingestion, search, SSE, media, and automation with declared SLO thresholds.
- FR-12: Performance seed profiles and EXPLAIN tooling MUST cover critical list, pagination, search, and queue claim queries.
- FR-13: API/worker/Redis/database concurrency MUST be environment-configurable and bounded.
- FR-14: Workers MUST gracefully stop claiming work, finish bounded in-flight work, close dependencies, and expose durable heartbeats.
- FR-15: Queue stale locks MUST be reclaimable and chaos tooling MUST exercise worker, Redis, database, storage, and scanner failures without production mutation.
- FR-16: Logs MUST redact credentials, tokens, cookies, signed URLs, phone values, and CR/LF injection.
- FR-17: Error reporting MUST use an adapter with a safe local implementation and production extension point.
- FR-18: Alert rules and SLO queries MUST cover API errors, webhook failures, queue backlog, dead letters, stale workers, storage/scanner/provider failures, and backup failure.
- FR-19: Backup/restore and migration-safety scripts MUST produce evidence without performing destructive production operations by default.
- FR-20: Retention acceptance MUST cover dry-run, legal hold, idempotency, media deletion retry, and tenant policy.
- FR-21: Tenant-scoped privacy request, event, consent, and processing-log models and owner/admin APIs MUST exist.
- FR-22: Privacy deletion MUST be blocked by legal hold and every state transition MUST be audited.
- FR-23: Idempotent PII-free usage events and daily rollups MUST support current/history owner APIs.
- FR-24: Plans, organization entitlements, usage limits, trial state, grace period, and backend send enforcement MUST exist without billing.
- FR-25: Tenant provisioning CLI commands MUST create/list/enable/disable/assign-plan/report-usage with audit records and production confirmation.
- FR-26: An internal operations API/UI MUST expose safe organization, health, queue, worker, usage, trial, and provider status without message content and MUST reject customer roles.
- FR-27: Worker instance and heartbeat models MUST identify stale workers without exposing unsafe host metadata.
- FR-28: `GET /version` MUST expose semantic version, commit SHA, build time, environment, and migration version without secrets.
- FR-29: CI/CD MUST run install, lint, typecheck, tests, build, migration check, security checks, container build/scan, staging smoke, and manual production gates.
- FR-30: Rolling, versioned Docker release, smoke, rollback, release checklist, incident response, and commercial operator/agent documentation MUST be provided.
- FR-31: A deterministic release-gate command MUST emit pass/fail/blocker evidence and MUST classify missing external acceptance as a blocker.
- FR-32: Git initialization/first baseline commit MAY occur only after secret scan and all credential-free gates pass; remote push MUST NOT occur without owner request.

## Non-Functional Requirements

- NFR-1: Conversation/message APIs MUST target p95 below 500 ms; message acceptance below 350 ms; webhook below 250 ms; search below 750 ms; auth below 700 ms.
- NFR-2: Load-test error rate MUST remain below 1%, duplicate accepted messages MUST equal zero, and accepted outbox loss MUST equal zero.
- NFR-3: API availability target MUST be 99.9%, webhook acceptance 99.95%, accepted-message durability 99.999%, RPO 15 minutes, and RTO 2 hours.
- NFR-4: Security and acceptance artifacts MUST contain no complete phone, access token, refresh token, password, cookie, encryption key, signed media token, or client secret.
- NFR-5: Every new database query and API MUST scope by organization unless explicitly internal and network/role protected.
- NFR-6: Production containers SHOULD run non-root, use pinned base images, bounded resources, health checks, and read-only filesystems where compatible.
- NFR-7: Smoke tests MUST be non-destructive and MUST NOT send an external provider message unless an explicit opt-in flag is supplied.
- NFR-8: Real external acceptance MUST be reproducible but MUST NOT be claimed from fake-provider evidence.

## Acceptance Criteria

### AC-1: (FR-1, FR-2, FR-3) Given unsafe production environment values, when validation runs, then startup is rejected and the configuration endpoint exposes only safe check metadata.

### AC-2: (FR-4) Given the reference Caddy configuration, when inspected/tested, then HTTP redirects to HTTPS and required headers/routes/body limits are present.

### AC-3: (FR-5, FR-6, NFR-4) Given missing external credentials, when each acceptance CLI runs, then it emits redacted pending reports and exits non-success for acceptance.

### AC-4: (FR-7) Given authentication attack scenarios, when the security suite runs, then replay/tamper/expired/revoked attempts are denied with generic errors.

### AC-5: (FR-8, FR-9, NFR-5) Given five roles and two tenants, when protected endpoints are exercised, then the expected HTTP matrix passes with zero cross-tenant rows.

### AC-6: (FR-10) Given the repository, when security commands run, then audit/SBOM/license/secret reports exist and critical findings fail the gate.

### AC-7: (FR-11, NFR-1, NFR-2) Given the safe fake-provider environment, when smoke load tests run, then a report records measured thresholds and pass/fail status.

### AC-8: (FR-12, FR-13) Given the small performance profile, when query analysis runs, then critical query plans and configured pool/concurrency bounds are recorded.

### AC-9: (FR-14, FR-15) Given a worker restart or stale lock, when processing resumes, then the job is reclaimed once, heartbeat becomes healthy, and graceful shutdown completes within the configured timeout.

### AC-10: (FR-16, FR-17) Given sensitive and CR/LF-bearing log fields, when redaction/error capture runs, then secrets/PII are removed and structured output remains one event per line.

### AC-11: (FR-18, NFR-3) Given operational metrics, when alert/SLO rules are evaluated, then the documented thresholds cover every required failure class.

### AC-12: (FR-19) Given local/staging backup input, when restore/migration checks run, then checksummed non-destructive reports are generated; production mutation requires explicit confirmation.

### AC-13: (FR-20) Given legal hold and repeated retention jobs, when retention runs, then hold blocks deletion and repeated eligible-object deletion remains safe.

### AC-14: (FR-21, FR-22) Given a tenant owner, when privacy requests transition, then organization scope and audit history are enforced; deletion under legal hold returns conflict.

### AC-15: (FR-23) Given duplicate usage event keys, when rollup runs, then they count once and current/history endpoints contain no PII.

### AC-16: (FR-24) Given expired trial or exceeded entitlement, when an outgoing send/config creation is attempted, then backend enforcement denies it while read-only inbox remains available.

### AC-17: (FR-25) Given authorized CLI input, when tenant provisioning runs, then organization/trial/plan/owner invitation/audit records are created without printing secrets.

### AC-18: (FR-26, FR-27) Given an internal operator versus customer agent, when operations endpoints load, then only the internal role receives safe operational aggregates and stale heartbeat state.

### AC-19: (FR-28) Given build metadata, when `/version` is called, then safe version/environment/migration values are returned.

### AC-20: (FR-29, FR-30) Given PR/main/production paths, when workflows are inspected, then required validation, manual approval, smoke, rollback, and no embedded credentials are present.

### AC-21: (FR-31, NFR-8) Given all local gates pass but real integrations are untested, when release-gate runs, then result is `Production Candidate � External Acceptance Pending` with blockers.

### AC-22: (FR-32) Given no Git HEAD, when baseline preparation runs, then ignored/generated/secret files are excluded; no remote push occurs.

## Edge Cases

- EC-1: Missing or malformed production URLs, wildcard CORS, insecure cookies, fake providers, or default credentials are fatal.
- EC-2: Acceptance CLI interruption leaves a partial, explicitly failed report and never exposes credentials.
- EC-3: S3, ClamAV, SMTP, Meta, or Bitrix timeout/unavailability yields pending/failed evidence rather than success.
- EC-4: Refresh token reuse revokes the affected session family.
- EC-5: Cross-tenant random and known IDs produce equivalent safe 403/404 bodies.
- EC-6: Worker termination after provider acceptance but before DB update uses idempotency and does not duplicate delivery.
- EC-7: Redis outage degrades realtime while durable DB data remains available for refetch.
- EC-8: Database pool exhaustion returns bounded errors without unbounded connection growth.
- EC-9: Legal hold activated during a retention batch prevents subsequent deletion and records evidence.
- EC-10: Usage replay, delayed events, and concurrent rollups remain idempotent.
- EC-11: Trial expiry never deletes existing data and blocks only configured mutating operations.
- EC-12: Production tenant CLI requires typed confirmation and refuses ambiguous tenant identifiers.
- EC-13: Worker heartbeat from a replaced instance becomes stale without marking the new instance unhealthy.
- EC-14: Git secret scan failure blocks initial commit.

## API Contracts

```ts
interface SafeConfigurationCheck { check: string; status: "pass" | "warning" | "fatal"; description: string }
interface ConfigurationResponse { data: { environment: string; valid: boolean; checks: SafeConfigurationCheck[] } }
interface VersionResponse { data: { version: string; commitSha: string; buildTime: string; environment: string; migrationVersion: string } }
interface PrivacyRequestInput { subjectReference: string; type: "export" | "delete" | "restrict"; reason?: string }
interface PrivacyRequestResponse { data: { id: string; status: "requested" | "approved" | "processing" | "completed" | "rejected" | "blocked"; legalHoldConflict: boolean } }
interface UsageCurrentResponse { data: { period: string; metrics: Record<string, number>; limits: Record<string, number | null> } }
interface UsageHistoryResponse { data: Array<{ date: string; metrics: Record<string, number> }> }
interface OperationsResponse { data: { organizations: number; queueBacklog: Record<string, number>; staleWorkers: number; failedIntegrations: number } }
interface ReleaseGateReport { status: "pass" | "blocked" | "fail"; classification: string; checks: Array<{ name: string; status: string; evidence?: string }> }

GET  /health/configuration -> ConfigurationResponse
GET  /version -> VersionResponse
POST /api/v1/privacy/requests -> PrivacyRequestResponse
GET  /api/v1/privacy/requests -> { data: PrivacyRequestResponse["data"][] }
POST /api/v1/privacy/requests/:id/:transition -> PrivacyRequestResponse
GET  /api/v1/usage/current -> UsageCurrentResponse
GET  /api/v1/usage/history -> UsageHistoryResponse
GET  /api/v1/internal/operations -> OperationsResponse
```

Error responses use `{ error: { code: string; message: string } }` with 400 validation, 401 authentication, 403 authorization, 404 concealed tenant entity, 409 legal-hold/limit conflict, and 503 unsafe configuration/dependency.

## Data Models

| Entity                    | Required fields and constraints                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| privacy_requests          | id, organization_id, type, subject_reference_hash, status, requested_by, approved_by, legal_hold_conflict, timestamps; tenant index |
| privacy_request_events    | request_id, organization_id, event_type, safe metadata, actor_id, created_at; append-only                                           |
| consent_records           | organization_id, subject_reference_hash, purpose, status, source, timestamps; no raw phone                                          |
| processing_activity_logs  | organization_id, activity_type, legal_basis, safe metadata, created_at                                                              |
| usage_events              | organization_id, event_key, metric, quantity, occurred_at; unique organization/event_key                                            |
| usage_daily_rollups       | organization_id, date, metric, quantity; unique organization/date/metric                                                            |
| plans                     | code, display_name, limits json, active; unique code                                                                                |
| organization_entitlements | organization_id, plan_id, trial dates/status/grace, overrides, timestamps; one active assignment                                    |
| organization_usage_limits | organization_id, metric, hard_limit, warning_limit; unique organization/metric                                                      |
| worker_instances          | instance_id, service, version, started_at, last_heartbeat, processed_count, failed_count, status, safe metadata                     |
| worker_heartbeats         | instance_id, current_jobs, status, recorded_at; indexed by recorded_at                                                              |
| tenant_provisioning_audit | organization_id, action, actor, safe details, created_at                                                                            |

## Out of Scope

- OS-1: Internal CRM, pipeline, tasks, sales reporting, and CRM automation remain in Bitrix24.
- OS-2: Billing, Stripe, automatic payment, invoices, and customer-facing checkout are excluded.
- OS-3: WhatsApp Web, QR sessions, scraping, unofficial groups, Baileys, and personal-account automation are prohibited.
- OS-4: Instagram, Telegram, Gmail, Calendar, AI responder, marketing campaigns, native mobile, Kubernetes mandate, and multi-region active-active are excluded.
- OS-5: Real external acceptance cannot be completed without owner-supplied staging credentials and infrastructure; tooling and pending reports are in scope.
- OS-6: Remote Git push and production deployment are excluded unless separately authorized.

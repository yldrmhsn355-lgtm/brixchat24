# Spec: Milestone 3 — Channel Management, WhatsApp Templates, Quick Replies and Production Authentication

**Author:** Codex with user-provided requirements
**Date:** 2026-07-16
**Status:** Approved
**Reviewers:** Repository owner (approval supplied with implementation request)
**Related specs:** `docs/MILESTONE-2-SPEC.md`, `docs/ARCHITECTURE.md`

## Context

Milestones 1 and 2 provide a tenant-scoped shared inbox, PostgreSQL outbox, worker, signed Meta webhook ingestion, realtime SSE, RBAC, encrypted channel credentials, fake provider, and a selectable Meta adapter. Authentication is still a development-only fixed login that returns a browser-stored access token. Channel configuration is CLI-only, templates and quick replies do not exist, and organization/user/team administration has no product surface.

Milestone 3 replaces demo authentication with Argon2id credentials and rotating server-managed sessions, introduces resumable organization onboarding and invitations, exposes secure channel administration and normalized health checks, implements WhatsApp template synchronization and outbox delivery, and adds scoped quick replies. Existing tenant isolation, provider abstraction, idempotency, monotonic message status, outbox durability, and webhook security remain mandatory. Real Meta success MUST NOT be claimed unless an actual Graph request succeeds; deterministic local acceptance uses the fake provider.

## Functional Requirements

- FR-1: The API MUST register users with normalized unique email, Argon2id password credentials, verification token, and resumable onboarding state.
- FR-2: Login MUST return a short-lived signed access token and set only an opaque refresh token in an HttpOnly cookie; invalid credentials MUST use one generic response.
- FR-3: Refresh MUST rotate the token and session atomically; reuse of a replaced token MUST revoke its complete session family.
- FR-4: Logout, session revoke, revoke-others, password change, forgot/reset password, verify-email, resend-verification, and current-user endpoints MUST be implemented with one-time hashed tokens and audit events.
- FR-5: Password reset and password change MUST revoke other active sessions, and expired or consumed tokens MUST be rejected.
- FR-6: Onboarding MUST persist name, organization, industry, locale, timezone, slug, initial team, optional channel, optional quick reply, and completion state so the flow can resume.
- FR-7: Owner/admin users MUST manage organization members, roles, activation state, and teams; at least one active owner MUST always remain.
- FR-8: Invitations MUST be organization-bound, hashed, expiring, single-use, resendable, revocable, and capable of creating or attaching a verified user membership.
- FR-9: Team membership and team-lead operations MUST enforce organization scope and role permissions at the backend.
- FR-10: Owner/admin users MUST create, list, inspect, update, enable, disable, test, and rotate public/webhook identifiers for channels through API and UI.
- FR-11: Channel access tokens, app secrets, and verify tokens MUST be encrypted or hashed at rest, MUST never be returned, and blank updates MUST preserve existing secrets.
- FR-12: Channel detail MUST expose safe webhook setup information, configured flags, last webhook state, callback URL, and rotation actions without revealing verify tokens.
- FR-13: Channel health MUST normalize fake and Meta checks to healthy, warning, unhealthy, or configuration_required with safe error codes and provider profile details.
- FR-14: Meta health MUST perform real Graph authorization/profile checks when Meta mode and credentials are configured; it MUST NOT substitute fake success.
- FR-15: Template synchronization MUST authorize the channel, decrypt credentials, paginate provider results, normalize/upsert templates, archive missing templates, record a sync run, audit, and notify.
- FR-16: Template listing/detail MUST support channel, language, category, status, and search filters and MUST only expose raw provider payload to a debug-authorized role.
- FR-17: Approved channel-matching templates MUST be sendable through a transactionally created pending message, outbox job, and flow event, including outside the 24-hour free-text window.
- FR-18: Template variables MUST be validated and mapped by component position; preview and message metadata MUST preserve template ID, name, language, and variables.
- FR-19: Messaging providers MUST implement template listing and template sending; fake mode MUST support approved/pending/rejected fixtures plus success/auth-expired/permission-denied scenarios.
- FR-20: Quick replies MUST support organization, team, and personal scopes with case-insensitive scope-appropriate shortcut uniqueness and CRUD permissions.
- FR-21: Quick reply rendering MUST resolve the allowed contact, agent, organization, and conversation variables, reject unknown variables, report missing values, and record usage.
- FR-22: The conversation composer MUST open a keyboard-accessible quick-reply menu on `/`, insert rendered editable content without auto-send, and track selection.
- FR-23: The composer MUST disable free text when the service window is closed and offer an approved-template selector with search, filters, preview, variable form, validation, and send.
- FR-24: Profile settings MUST update safe user fields and require re-verification after email change; security settings MUST show/revoke sessions and security events and expose an MFA feature placeholder.
- FR-25: All named authentication, invitation, user/team, channel, template, and quick-reply mutations MUST emit safe audit records with actor, target, organization, IP, and user agent.
- FR-26: Invitation acceptance, unhealthy channels, invalid tokens, template sync results, suspended users, and session revocation MUST publish organization-scoped in-app notifications through realtime.
- FR-27: Authentication, channel-test/credential/template-sync, and invitation endpoints MUST apply endpoint-specific IP, user, and organization rate limits and return a standard 429 envelope.
- FR-28: Frontend navigation MUST show Inbox, Templates, Quick Replies, Channels, Team, and Settings according to permissions while backend authorization remains authoritative.
- FR-29: Every new page MUST provide loading, empty, API-error, permission-denied, validation, reconnecting, success, and destructive-confirmation states appropriate to its actions.
- FR-30: Migration `0002_auth_channels_templates_quick_replies.sql`, development seed, environment example, Docker health behavior, and README MUST support the complete local flow without embedding secrets.
- FR-31: Existing Milestone 1/2 endpoints, tenant boundaries, webhook verification, realtime, idempotent message flow, and outbox processing MUST remain compatible.

## Non-Functional Requirements

- NFR-1: Passwords MUST use Argon2id with explicit memory, time, and parallelism settings and MUST never be logged or stored outside a hash.
- NFR-2: Refresh, reset, verification, and invitation tokens MUST have at least 256 bits of entropy; only SHA-256 hashes MUST be persisted.
- NFR-3: Refresh cookies MUST be HttpOnly, path-scoped, configurable SameSite/Secure/domain, and compatible with localhost development.
- NFR-4: Access tokens SHOULD expire in 15 minutes by default and refresh sessions SHOULD expire in 30 days with configurable values.
- NFR-5: Session rotation/reuse detection and owner invariants MUST be transactional and concurrency-safe.
- NFR-6: All tenant-owned queries MUST constrain `organization_id`; cross-organization IDs MUST return 404 or 403 without leaking existence.
- NFR-7: Secrets, passwords, cookies, tokens, authorization headers, provider bodies, and message text MUST be redacted from logs and safe audit metadata.
- NFR-8: Meta HTTP calls MUST time out within 15 seconds and normalize 401/403/429/5xx/network failures without returning raw provider bodies.
- NFR-9: Credential encryption MUST retain AES-256-GCM with a unique 12-byte IV and authenticated envelope; key material MUST come from environment configuration.
- NFR-10: Provider sync MUST handle pagination and idempotent upserts, and repeated syncs MUST NOT duplicate templates.
- NFR-11: All request bodies and query parameters MUST use strict bounded validation with no TypeScript `any` in production code.
- NFR-12: Existing lint, typecheck, unit/integration/E2E, build, and Docker service health gates MUST remain green.
- NFR-13: Authentication errors SHOULD resist account enumeration and timing disclosure; rate-limit responses MUST include a stable code.
- NFR-14: Email delivery MUST use a provider interface with console and SMTP-compatible adapters; local console output MUST never print raw reset/invitation tokens in production mode.
- NFR-15: Destructive and credential mutation UI MUST require explicit confirmation and MUST never redisplay stored secret values.

## Acceptance Criteria

### AC-1: Registration and secure login (FR-1, FR-2, NFR-1, NFR-3)

Given a new valid email and strong password
When the user registers and then logs in
Then an Argon2id credential and secure server session exist
And the response contains an access token while the refresh token exists only in the HttpOnly cookie.

### AC-2: Generic authentication rejection (FR-2, FR-27, NFR-13)

Given either an unknown email or an incorrect password
When login is attempted repeatedly
Then every failure uses the same safe error envelope and an audit/security event is recorded
And the configured authentication limit eventually returns standardized 429.

### AC-3: Rotation and reuse response (FR-3, NFR-2, NFR-5)

Given an active refresh session
When refresh rotates once and the previous refresh token is replayed
Then the replay is rejected and every session in that token family is revoked.

### AC-4: Password and email token lifecycle (FR-4, FR-5, NFR-2)

Given verification and password-reset tokens that may be valid, expired, or consumed
When the corresponding endpoints are called
Then only a valid unused hash succeeds once and expired/consumed tokens fail generically
And password completion revokes other sessions.

### AC-5: Resumable onboarding (FR-6)

Given a newly registered user who stops after any onboarding step
When the user returns and completes the remaining organization, team, optional channel, and optional quick-reply steps
Then the saved progress resumes correctly and completion routes to the inbox.

### AC-6: Member, role, and owner invariant (FR-7, FR-9, NFR-5, NFR-6)

Given an organization with owner, admin, team-lead, agent, and viewer memberships
When authorized role/team changes and an attempt to remove the final active owner occur
Then valid changes persist with audit events and the final-owner operation is rejected atomically.

### AC-7: Invitation lifecycle (FR-8, FR-25, FR-26)

Given an organization-bound unexpired invitation
When it is accepted once and then replayed or used against another organization
Then exactly one membership is created, the replay/cross-tenant attempt fails, and audit/notification events exist.

### AC-8: Secure channel CRUD (FR-10, FR-11, FR-12, NFR-9)

Given an owner and an agent
When both attempt channel creation and the owner performs blank and nonblank credential updates
Then only the owner succeeds, secrets never appear in a response, blank values preserve ciphertext, and nonblank values rotate encrypted credentials.

### AC-9: Normalized provider health (FR-13, FR-14, FR-19, NFR-8)

Given fake health scenarios and a Meta channel with configured or missing credentials
When channel health is tested
Then fake scenarios return deterministic normalized states and Meta mode reflects the actual Graph result or configuration error without fake success or raw error bodies.

### AC-10: Webhook setup and token rotation (FR-11, FR-12, FR-25)

Given a configured channel webhook
When detail is viewed and the verify token/public ID is rotated
Then only safe configured flags/callback data are visible and the old identifier/token no longer verifies.

### AC-11: Idempotent template synchronization (FR-15, FR-16, FR-19, NFR-10)

Given fake provider templates and an existing synchronized template that later disappears
When sync runs repeatedly
Then templates are created or updated without duplicates, missing provider templates become archived, sync statistics persist, and audit/notification events are emitted.

### AC-12: Approved template delivery (FR-17, FR-18, FR-19)

Given a closed-window conversation and an approved matching-channel template
When valid variables are submitted twice with one client message ID
Then exactly one template message and outbox job are created and the worker sends the provider template outside the 24-hour window.

### AC-13: Template send rejection (FR-17, FR-18)

Given a rejected template, channel mismatch, tenant mismatch, or invalid variables
When template delivery is attempted
Then the API rejects it before message/outbox creation with a safe stable code.

### AC-14: Scoped quick replies (FR-20, FR-21, NFR-6)

Given personal, team, and organization quick replies in two tenants
When users list, mutate, render, and track them
Then only scope-permitted rows are visible/actionable, shortcut uniqueness is case-insensitive within scope, and tenant B data never reaches tenant A.

### AC-15: Composer quick-reply interaction (FR-22, FR-29)

Given an accessible conversation and scoped quick replies
When the user types `/`, filters and selects by keyboard
Then rendered text is inserted into the editable composer without sending and a usage event is persisted.

### AC-16: Composer template interaction (FR-23, FR-29)

Given a conversation whose service window is closed
When the conversation opens and a template is selected, completed, previewed, and sent
Then free text remains disabled, validation is visible, and the template transitions from pending to sent via outbox.

### AC-17: Profile and security controls (FR-4, FR-24, FR-26)

Given an authenticated user with multiple sessions
When profile email changes, password changes, and other sessions are revoked
Then email becomes unverified, other sessions close, security history updates, and no secret appears in the UI.

### AC-18: Audit, notification, and rate-limit safety (FR-25, FR-26, FR-27, NFR-7)

Given each named security or administration mutation
When it succeeds or produces a security-relevant failure
Then the required audit and realtime notification records contain safe metadata only and applicable limits use standard 429 responses.

### AC-19: Permission-aware navigation and states (FR-28, FR-29)

Given owner and agent accounts
When each navigates the application and loads new pages under normal, empty, denied, failure, and reconnecting conditions
Then visible navigation matches permissions, direct unauthorized API calls remain blocked, and each state is explicitly rendered.

### AC-20: Migration and regression gates (FR-30, FR-31, NFR-12)

Given the Milestone 2 database and a clean local environment
When migration, seed, lint, typecheck, all tests, build, Docker build, and Docker startup execute
Then existing data and M1/M2 behavior remain valid and PostgreSQL, Redis, API, worker, and web report healthy.

## Edge Cases

- EC-1: Concurrent refresh requests using one token → one rotation succeeds; reuse detection revokes the family without issuing two valid successors.
- EC-2: Password reset completes while another session refreshes → transaction order cannot preserve an unauthorized old session.
- EC-3: Duplicate normalized email or organization slug → stable conflict response without leaking credential state.
- EC-4: Invitation accepted by an existing user with different casing → normalized email comparison attaches the intended account once.
- EC-5: Final owner is suspended, deactivated, demoted, or removed → invariant rejects every path.
- EC-6: Empty credential fields on channel patch → existing encrypted values remain unchanged; explicit rotation produces new ciphertext.
- EC-7: Meta timeout, malformed JSON, 401, 403, 429, or 5xx → safe normalized health/sync result with no raw body or token.
- EC-8: Provider template pagination repeats an item → unique key and upsert prevent duplication.
- EC-9: Approved template becomes rejected between selection and send → transactional send rechecks current status and rejects it.
- EC-10: Template variable gaps, extra variables, wrong component, or unknown position → no message/outbox row is created.
- EC-11: Two scoped quick replies differ only by shortcut casing → the second insert conflicts within that scope but remains legal in a distinct scope.
- EC-12: Quick-reply variable exists but source value is null → render reports the missing value and does not silently send unresolved braces.
- EC-13: Redis is unavailable during notification publication → durable domain/audit mutation remains committed and reconnect can refetch authoritative data.
- EC-14: Cookie Secure is enabled on plain HTTP localhost → documented local configuration disables Secure without changing production defaults.
- EC-15: Migration runs on existing seeded M2 rows → legacy password data is moved/reseeded safely and no conversation/message is removed.
- EC-16: Access token expires during an API call → refresh cookie rotates and the client retries once; repeated 401 returns to login.

## API Contracts

```ts
interface ApiError {
  error: { code: string; message: string; requestId?: string };
}
interface AuthSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
  ipAddress?: string;
  userAgent?: string;
}
interface ChannelHealth {
  status: "healthy" | "warning" | "unhealthy" | "configuration_required";
  code?: string;
  checkedAt: string;
  profile?: Record<string, string | null>;
}
interface TemplateSendRequest {
  clientMessageId: string;
  templateId: string;
  language: string;
  variables: Record<string, string>;
}
interface QuickReplyRender {
  content: string;
  missingVariables: string[];
}
```

Authentication:

- `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password`, `POST /api/v1/auth/verify-email`, `POST /api/v1/auth/resend-verification`
- `GET /api/v1/auth/me`, `GET /api/v1/auth/sessions`, `DELETE /api/v1/auth/sessions/:id`, `POST /api/v1/auth/sessions/revoke-others`, `POST /api/v1/auth/change-password`

Onboarding and administration:

- `GET /api/v1/onboarding`, `PATCH /api/v1/onboarding`, `POST /api/v1/onboarding/complete`
- `GET /api/v1/users`, `GET /api/v1/users/:id`, `PATCH /api/v1/users/:id`, `POST /api/v1/users/:id/suspend`, `POST /api/v1/users/:id/activate`
- `GET /api/v1/teams`, `POST /api/v1/teams`, `GET /api/v1/teams/:id`, `PATCH /api/v1/teams/:id`, `DELETE /api/v1/teams/:id`
- `POST /api/v1/teams/:id/members`, `DELETE /api/v1/teams/:id/members/:userId`
- `GET /api/v1/invitations`, `POST /api/v1/invitations`, `POST /api/v1/invitations/:id/resend`, `DELETE /api/v1/invitations/:id`, `POST /api/v1/invitations/accept`

Channels and templates:

- `GET /api/v1/channels`, `POST /api/v1/channels`, `GET /api/v1/channels/:id`, `PATCH /api/v1/channels/:id`
- `POST /api/v1/channels/:id/enable`, `POST /api/v1/channels/:id/disable`, `POST /api/v1/channels/:id/test`
- `POST /api/v1/channels/:id/credentials`, `POST /api/v1/channels/:id/rotate-public-id`, `POST /api/v1/channels/:id/rotate-verify-token`, `GET /api/v1/channels/:id/webhook-info`
- `POST /api/v1/channels/:id/templates/sync`, `GET /api/v1/channels/:id/templates`, `GET /api/v1/templates`, `GET /api/v1/templates/:id`
- `POST /api/v1/conversations/:id/template-messages` accepts `TemplateSendRequest` and returns 202 `{data: MessageDto}`.

Quick replies, profile, and support:

- `GET /api/v1/quick-replies`, `POST /api/v1/quick-replies`, `GET /api/v1/quick-replies/:id`, `PATCH /api/v1/quick-replies/:id`, `DELETE /api/v1/quick-replies/:id`
- `POST /api/v1/quick-replies/:id/render`, `POST /api/v1/quick-replies/:id/track-usage`
- `GET /api/v1/profile`, `PATCH /api/v1/profile`, `GET /api/v1/security-events`, `GET /api/v1/notifications`, `POST /api/v1/notifications/:id/read`

Every protected endpoint requires a bearer access token. Refresh reads only its cookie. List contracts use `{data, page:{nextCursor}}` where pagination applies. Mutations return `{data}` or 204. Errors always use `ApiError`; secrets never appear.

## Data Models

Migration `0002_auth_channels_templates_quick_replies.sql` extends users/organizations/channels and creates the following tenant-aware models.

| Model                         | Key fields                                                                                                              | Constraints and purpose                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `user_credentials`            | user_id, password_hash, password_changed_at                                                                             | one active password credential per user; Argon2id only             |
| `user_sessions`               | user_id, family_id, token_hash, replaced_by_id, revoked_at, expires_at, ip, user_agent                                  | hashed rotating refresh sessions; family/reuse indexes             |
| `password_reset_tokens`       | user_id, token_hash, expires_at, consumed_at                                                                            | unique hash, single use                                            |
| `email_verification_tokens`   | user_id, token_hash, email, expires_at, consumed_at                                                                     | binds verification to normalized email                             |
| `login_attempts`              | normalized_email_hash, ip_hash, success, created_at                                                                     | enumeration-safe rate/security evidence                            |
| `user_security_events`        | user_id, organization_id, event_type, safe_metadata, ip, user_agent                                                     | user-visible security history                                      |
| `organization_invitations`    | organization_id, email, role, token_hash, expires_at, accepted_at, revoked_at, invited_by                               | unique active invite semantics                                     |
| `onboarding_progress`         | user_id, organization_id, current_step, state, completed_at                                                             | resumable server-side onboarding                                   |
| `team_members`                | organization_id, team_id, user_id                                                                                       | tenant-scoped unique membership                                    |
| `message_templates`           | organization_id, channel_id, provider_template_id, name, language, category, status, component fields, provider_payload | unique channel/name/language and provider indexes                  |
| `message_template_components` | template_id, component_type, position, payload                                                                          | normalized component ordering                                      |
| `message_template_variables`  | template_id, component, position, variable_name, example_value                                                          | unique component position                                          |
| `template_sync_runs`          | organization_id, channel_id, status, counters, last_error, timestamps                                                   | auditable synchronization history                                  |
| `template_send_events`        | organization_id, template_id, message_id, status, created_at                                                            | template usage/status evidence                                     |
| `quick_reply_folders`         | organization_id, name, scope, owner_user_id, team_id                                                                    | scoped organization folders                                        |
| `quick_replies`               | organization_id, shortcut, title, content, language, scope, owner_user_id, team_id, folder_id, usage_count              | partial unique indexes implement case-insensitive scoped shortcuts |
| `quick_reply_usage_events`    | organization_id, quick_reply_id, user_id, conversation_id, rendered_content_hash                                        | usage analytics without duplicating message text                   |
| `notifications`               | organization_id, user_id, type, title, body, metadata, read_at                                                          | durable in-app notification feed                                   |

Existing `users.password_hash` becomes transitional and is no longer an authentication source after migration. Users gain profile/verification fields; organizations gain industry/onboarding metadata; channels gain health/profile/webhook fields. All foreign keys and deletion behavior MUST preserve tenant consistency and existing M2 data.

## Out of Scope

- OS-1: Bulk campaign/broadcast orchestration.
- OS-2: AI-generated or automatic responses.
- OS-3: Instagram, Telegram, Bitrix, or other new channel providers.
- OS-4: Billing, Stripe, subscription enforcement, or metering.
- OS-5: Advanced CRM pipelines, tasks, and analytics beyond retained placeholders.
- OS-6: Native mobile applications.
- OS-7: Full MFA enrollment/challenge; only an extensible placeholder/feature flag is included.
- OS-8: Meta template creation, editing, or approval submission; synchronization and sending only.
- OS-9: Full media download/storage pipeline.

## Delivery and Verification

Implementation proceeds in bounded slices: schema/auth core; onboarding/users/teams/invitations; channels/health; templates/provider/outbox; quick replies/composer; profile/audit/notifications/rate limits; regression and documentation. Each slice adds unit and integration coverage before UI completion. Final verification runs `pnpm install`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`, `docker compose build`, and `docker compose up -d`, followed by service health and manual API assertions. Real Meta verification is explicitly reported as verified, failed, or not run due to absent credentials.

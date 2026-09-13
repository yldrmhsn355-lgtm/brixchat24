# Production feature parity audit — 2026-07-19

## Decision

Full pre-live parity is **not yet achieved**. The production release branch is
not a continuation of `origin/master`: the two histories have no merge base.
The release branch was created from the parentless snapshot `cff2224`, so a
bulk merge or route-only copy would mix incompatible auth, database, worker and
permission models.

Current tree after the first recovery slice:

| Area | Production tree | Pre-live `origin/master` |
| --- | ---: | ---: |
| Web pages | 31 | 67 |
| API route files | 7 | 33 |
| Worker TypeScript files | 5 | 32 |
| Database migrations | 11 | 54 |

These counts are an inventory signal, not a request to restore every old file.
Some old routes were placeholders or belong to deliberately paused products.

## Live baseline

Read-only checks on 2026-07-19 confirmed:

- `https://brixchat24.com/app/inbox` responds successfully.
- API readiness reports PostgreSQL, Redis, R2 and ClamAV healthy.
- The deployed web CSP permits the configured Brixchat24 API and realtime
  origins.
- Old pages such as labels, notifications, contacts, analytics, activity,
  billing, campaigns and AI agents were not present in the production web
  artifact.
- Several current APIs were deployed but had no usable UI, including labels,
  notifications, retention and usage history.

## Recovery slice 1

This slice restores user-visible regressions without a database migration:

- Valid WhatsApp reaction choices: thumbs up, heart, laugh, surprised, sad and
  prayer.
- All replacement-character corruption found in web source, including
  `Şablonlar`, `Şablon ara`, `Şablonlara dön` and `Şirket`.
- A UTF-8 editor policy and an automated source-encoding regression gate.
- A permanent `/app/labels` route and sidebar link.
- Empty, loading and API-failure states for the Inbox label section.
- Role-aware label management: owner, admin and team lead can create, edit and
  delete; agent and viewer remain read-only.
- Additive multi-label assignment using the existing POST/DELETE API instead
  of the single-label replacement endpoint.
- Correct label usage-count refresh after assignment changes.
- Railway-native commit, branch and deployment identity in `/version`.

Label deletion remains the existing permanent API operation. The UI requires
an explicit confirmation and warns that conversation assignments are removed.
A future archive/undo model requires a schema migration and production backup
proof.

## No-migration activation queue

Implement these as separate reviewed releases, in this order:

1. Global-search deep links into the selected conversation/message.
2. Notification center and working header bell.
3. Retry control for failed media processing.
4. Quick-reply edit, active state and team scope.
5. Channel enable/disable and health controls, with confirmation.
6. Conversation assignment controls.
7. Saved Inbox views.
8. Missing conversation operations: priority, snooze and block.
9. Note edit/delete, mentions and replies.
10. Team membership, invitation and user lifecycle operations.
11. Usage history and session-management actions.

## Vertical slices requiring compatibility work

These must be rebuilt against the current JWT, PostgreSQL schema, RBAC and
worker model. Do not cherry-pick the old pages alone:

- Contacts/customer directory, dashboard, analytics, activity and audit.
- Scheduled messages.
- Billing, subscriptions and tenant administration.
- Custom roles, API keys, public API, business hours, SLA and storage policy.
- Advanced automation editor and run inspection.
- Bitrix24 mappings and advanced Open Channels operations.
- Privacy and retention execution workflows.

## Deliberately deferred scope

- WhatsApp Web/home-node operations.
- AI agents, RAG and automatic replies.
- Chat widget and managed gateway.
- Instagram, Messenger and TikTok placeholder pages.

## Release gates

For every slice:

1. Run targeted tests, lint, typecheck and production builds.
2. Update Graphify and pass the source-only graph input gate.
3. Commit and push only the reviewed slice.
4. Require Railway health plus the exact `/version` commit SHA.
5. Smoke-test the changed authenticated flow.
6. Require verified production backup evidence before any migration or
   destructive data-model change.

Railway variable identity reference:
<https://docs.railway.com/variables/reference>.

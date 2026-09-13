# Tenant isolation in the API

Production uses two separate PostgreSQL connections:

- `API_DATABASE_URL`: control connection for authentication, signed callbacks and explicitly authorized platform administration.
- `API_SCOPED_DATABASE_URL`: tenant connection. Its login must inherit `brixchat_app_scoped`, must not own tenant tables, and must have neither SUPERUSER nor BYPASSRLS. Production startup requires this variable and checks the role.

Do not replace the control connection with the scoped connection or grant BYPASSRLS to the scoped role. The worker retains a separate service connection for cross-organization queues. Migration credentials remain separate from runtime credentials.

`apps/api/src/database-scope.ts` wraps tenant routes using the organization and user from a verified JWT. Public control routes are explicitly enumerated; their existing signature and authorization checks still apply. Platform routes require the platform-admin claim. Realtime callbacks explicitly re-enter tenant scope.

`packages/database/src/scoped-router.ts` provides the repository SQL proxy. Each query uses a short transaction with transaction-local `app.organization_id` and `app.user_id`. Explicit `begin` calls preserve atomic groups and nested savepoints. Queries outside a scope or consumed after its lifetime are rejected. Separate advisory-lock connections prevent storage-lock waiters from exhausting query connections.

Migrations 0045–0047 enable tenant-keyed and parent-derived RLS, limit shared identity columns, deny tenant access to credentials, and add composite foreign keys that prevent cross-organization relationships. Future tables must include their own policies, grants and tenant relationship constraints: the migration discovery logic is not rerun automatically for new tables.

## Deployment and verification

1. Back up production and test restoration to a separate database.
2. Apply migrations with the migration account.
3. Provision the scoped login without rotating existing application keys. The IIS helper `deploy/iis/prepare-live-rls.mjs` retains an existing scoped secret and writes it only to protected server configuration.
4. Build an isolated release, verify it using the scoped connection, then switch the API service to that release.
5. Verify login, refresh, tenant routes, platform permissions and realtime access. Preserve the worker's WhatsApp session when changing API releases.

Integration suites: `scoped-router.integration.test.ts`, `database-scope.integration.test.ts` and `apps/api/src/app.test.ts`. Use only an isolated test database for fixture tests. They exercise concurrent tenant reads, scope escape rejection, cross-tenant writes and foreign keys, credential restrictions, explicit rollback, advisory-lock contention and API authorization. Live smoke verification does not replace these tests.

On 10 September 2026, release `20260910-rls` was deployed for API and web with 48 migrations, 144 RLS tables and 167 validated tenant foreign keys. All 65 selected database/API integration tests passed. The worker remained on its previous release to preserve the connected WhatsApp session.

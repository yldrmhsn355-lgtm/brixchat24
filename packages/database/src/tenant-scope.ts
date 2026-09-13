import type postgres from "postgres";
import { DATABASE_ORGANIZATION } from "./scoped-router";

type DatabaseClient = ReturnType<typeof postgres>;

/**
 * Runs `fn` inside a transaction with `app.organization_id` pinned to
 * `organizationId` for that transaction's duration, so the RLS policies from
 * migration 0040 enforce tenant isolation as a database-level backstop even
 * if `fn`'s own queries omit an explicit `WHERE organization_id` filter.
 *
 * Uses `set_config(..., true)` (the `SET LOCAL` equivalent), which is scoped
 * to the current transaction and is automatically reset on commit/rollback
 * -- required because the underlying connection comes from a shared pool and
 * must never carry one request's organization_id into another's queries.
 *
 * Only takes effect once the caller connects as a non-owner role (see
 * packages/database/migrations/0040_tenant_isolation_hardening.sql); against
 * the table-owner role this still runs correctly, RLS just has no additional
 * effect since owners bypass it.
 */
export async function withTenantScope<T>(
  client: DatabaseClient,
  organizationId: string,
  fn: (tx: DatabaseClient) => Promise<T>,
): Promise<T> {
  const requestOrganization = Reflect.get(client, DATABASE_ORGANIZATION);
  if (
    typeof requestOrganization === "string" &&
    requestOrganization !== organizationId
  )
    throw new Error("TENANT_SCOPE_SWITCH_DENIED");
  return client.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    return fn(tx as unknown as DatabaseClient);
  }) as Promise<T>;
}

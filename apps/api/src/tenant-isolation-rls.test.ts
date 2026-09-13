import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Proves the database-level backstop added by migration
 * 0040_tenant_isolation_hardening.sql and 0043_subscription_billing.sql:
 * even a query with NO
 * `WHERE organization_id = ...` filter at all -- the exact shape of the bug
 * a missed filter in application code would produce -- cannot return another
 * tenant's rows once the connection uses the non-owner `brixchat_app_scoped`
 * role with `app.organization_id` set via withTenantScope.
 *
 * This is deliberately a DB-level test, not an HTTP one: it exercises the
 * safety net that exists precisely for the case where application code
 * (route or repository) forgets to scope a query, so it must not rely on
 * any application-level filtering to pass.
 */
const ownerUrl =
  process.env.DATABASE_URL ??
  "postgresql://brixchat:brixchat@localhost:5434/brixchat";
const scopedPassword =
  process.env.TENANT_ISOLATION_TEST_ROLE_PASSWORD ??
  "tenant-isolation-test-only";
const scopedUrl = ownerUrl.replace(
  /^postgresql:\/\/[^:]+:[^@]+@/,
  `postgresql://brixchat_app_scoped:${scopedPassword}@`,
);
const seededOrganizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "11111111-1111-4111-8111-111111111111";

const owner = postgres(ownerUrl);
const protectedTables = [
  "conversations",
  "messages",
  "contacts",
  "channels",
  "audit_logs",
  "ai_settings",
  "ai_customer_memory",
  "ai_knowledge_bases",
  "ai_knowledge_documents",
  "ai_knowledge_chunks",
  "ai_runs",
  "ai_feedback",
  "ai_training_examples",
  "file_assets",
  "file_versions",
  "organization_subscriptions",
  "subscription_items",
  "billing_transactions",
  "billing_webhook_events",
  "usage_period_counters",
  "credit_accounts",
  "credit_ledger_entries",
  "billing_sales_requests",
] as const;

describe("RLS tenant isolation backstop (migration 0040)", () => {
  beforeAll(async () => {
    // ALTER ROLE ... PASSWORD does not accept a bind parameter; scopedPassword
    // is a fixed test-only constant, not user input.
    await owner.unsafe(
      `ALTER ROLE brixchat_app_scoped WITH PASSWORD '${scopedPassword}'`,
    );
  });

  afterAll(async () => {
    await owner.end();
  });

  it("enables one tenant policy on every protected table", async () => {
    const rows = await owner<
      Array<{ table_name: string; rls_enabled: boolean; policy_count: number }>
    >`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rls_enabled,
             count(p.policyname)::int AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
      LEFT JOIN pg_policies p ON p.schemaname=n.nspname AND p.tablename=c.relname
      WHERE c.relname IN ${owner(protectedTables)}
      GROUP BY c.relname,c.relrowsecurity
      ORDER BY c.relname
    `;
    expect(rows).toHaveLength(protectedTables.length);
    expect(rows.every((row) => row.rls_enabled && row.policy_count === 1)).toBe(
      true,
    );
  });

  it("keeps the scoped role non-owner and unable to bypass RLS", async () => {
    const [role] = await owner<
      Array<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolinherit: boolean;
        rolbypassrls: boolean;
      }>
    >`
      SELECT rolcanlogin,rolsuper,rolinherit,rolbypassrls
      FROM pg_roles WHERE rolname='brixchat_app_scoped'
    `;
    expect(role).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolinherit: false,
      rolbypassrls: false,
    });
  });

  it.each([
    "conversations",
    "messages",
    "contacts",
    "channels",
    "ai_customer_memory",
    "ai_knowledge_bases",
    "file_assets",
    "organization_subscriptions",
    "billing_transactions",
    "credit_accounts",
  ])(
    "blocks an unfiltered query against %s for a mismatched organization_id",
    async (table) => {
      const scoped = postgres(scopedUrl, { max: 1 });
      try {
        const rows = await scoped.begin(async (tx) => {
          await tx`SELECT set_config('app.organization_id', ${otherOrganizationId}, true)`;
          return tx.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
        });
        expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
      } finally {
        await scoped.end();
      }
    },
  );

  it("still returns the tenant's own rows once app.organization_id matches", async () => {
    const scoped = postgres(scopedUrl, { max: 1 });
    try {
      const [ownerCount] = await owner<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM conversations
        WHERE organization_id=${seededOrganizationId}::uuid
      `;
      const rows = await scoped.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${seededOrganizationId}, true)`;
        return tx<
          Array<{ n: number }>
        >`SELECT count(*)::int AS n FROM conversations`;
      });
      expect(rows[0]?.n).toBe(ownerCount!.n);
      expect(rows[0]?.n).toBeGreaterThan(0);
    } finally {
      await scoped.end();
    }
  });

  it("blocks a query with app.organization_id entirely unset", async () => {
    const scoped = postgres(scopedUrl, { max: 1 });
    try {
      const rows = await scoped<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM conversations
      `;
      expect(rows[0]?.n).toBe(0);
    } finally {
      await scoped.end();
    }
  });

  it("does not leak transaction-local tenant context into the next query", async () => {
    const scoped = postgres(scopedUrl, { max: 1 });
    try {
      await scoped.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${seededOrganizationId}, true)`;
        const [visible] = await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM conversations
        `;
        expect(visible!.n).toBeGreaterThan(0);
      });
      const [afterCommit] = await scoped<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM conversations
      `;
      expect(afterCommit!.n).toBe(0);
    } finally {
      await scoped.end();
    }
  });
});

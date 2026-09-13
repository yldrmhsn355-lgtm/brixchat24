import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createScopedDatabaseRouter,
  DATABASE_ADVISORY_LOCK,
} from "./scoped-router";

const url = process.env.SCOPED_ROUTER_TEST_DATABASE_URL;
describe.skipIf(!url)("scoped database router against PostgreSQL RLS", () => {
  const admin = postgres(url!, { max: 2, onnotice: () => {} });
  const a = randomUUID(),
    b = randomUUID();
  const role = `router_test_${randomBytes(8).toString("hex")}`;
  let pool: ReturnType<typeof postgres>;
  let locks: ReturnType<typeof postgres>;
  let router: ReturnType<typeof createScopedDatabaseRouter>;
  let testDatabaseVerified = false;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!/restore|test/.test(parsed.pathname))
      throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
    testDatabaseVerified = true;
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE brixchat_app_scoped`,
    );
    parsed.username = role;
    parsed.password = password;
    pool = postgres(parsed.toString(), { max: 2 });
    locks = postgres(parsed.toString(), { max: 2 });
    router = createScopedDatabaseRouter(pool, locks);
    await admin`INSERT INTO organizations(id,name,slug) VALUES(${a},'Router A',${a}),(${b},'Router B',${b})`;
    await admin`INSERT INTO contacts(organization_id,first_name,normalized_phone) VALUES(${a},'Router','905550000011'),(${b},'Router','905550000012')`;
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (locks) await locks.end();
    if (!testDatabaseVerified) {
      await admin.end();
      return;
    }
    await admin`DELETE FROM organizations WHERE id IN (${a},${b})`;
    await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  });
  it("rejects SQL with no request context", () => {
    expect(() => router.sql`SELECT 1`).toThrow("DATABASE_SCOPE_REQUIRED");
  });
  it("isolates concurrent filterless tenant reads with a reused pool", async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.all(
        [a, b].map((id) =>
          router.tenant(id, async () => {
            await router.sql`SELECT pg_sleep(0.01)`;
            const rows = await router.sql`SELECT organization_id FROM contacts`;
            expect(rows).toHaveLength(1);
            expect(rows[0]!.organization_id).toBe(id);
          }),
        ),
      );
    }
    const context =
      await pool`SELECT current_setting('app.organization_id',true) AS tenant`;
    expect(context[0]!.tenant || null).toBeNull();
  });
  it("rejects writes to another tenant", async () => {
    await expect(
      router.tenant(a, async () => {
        await router.sql`INSERT INTO contacts(organization_id,first_name,normalized_phone) VALUES(${b},'Denied','905550000013')`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("rejects a same-tenant row referencing another tenant's hidden contact", async () => {
    const [foreignContact]=await admin`SELECT id FROM contacts WHERE organization_id=${b}`;
    const [channel]=await admin`INSERT INTO channels(organization_id,name,provider) VALUES(${a},'Scope channel','meta') RETURNING id`;
    await expect(router.tenant(a,async()=>{
      await router.sql`INSERT INTO conversations(organization_id,contact_id,channel_id) VALUES(${a},${foreignContact!.id},${channel!.id})`;
    })).rejects.toMatchObject({code:'23503'});
  });
  it("denies credential reads and platform-privilege writes to tenant connections", async () => {
    await expect(router.tenant(a,async()=>{
      await router.sql`SELECT password_hash FROM user_credentials`;
    })).rejects.toMatchObject({code:'42501'});
    await expect(router.tenant(a,async()=>{
      await router.sql`UPDATE users SET is_platform_admin=true`;
    })).rejects.toMatchObject({code:'42501'});
  });
  it("enforces RLS on every tenant-keyed table, including tables with other tenants' seed data", async () => {
    const tables = await admin<
      { table_name: string }[]
    >`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='organization_id' ORDER BY table_name`;
    expect(tables.length).toBeGreaterThan(100);
    await router.tenant(a, async () => {
      for (const table of tables) {
        const rows = await router.sql.unsafe(
          `SELECT DISTINCT organization_id FROM "${table.table_name.replaceAll('"', '""')}"`,
        );
        expect(
          rows.every((row) => row.organization_id === a),
          table.table_name,
        ).toBe(true);
      }
      expect(await router.sql`SELECT id FROM organizations`).toEqual([
        { id: a },
      ]);
    });
  });
  it("serializes storage locks without starving the query pool", async () => {
    await Promise.all(
      [0, 1].map(() =>
        router.tenant(a, async () => {
          const lock = await Reflect.get(router.sql, DATABASE_ADVISORY_LOCK)(a);
          await router.sql`SELECT pg_sleep(0.01)`;
          await lock.release();
        }),
      ),
    );
  });
  it("rolls back nested transactions and retains the outer scope", async () => {
    await router.tenant(a, async () => {
      await expect(
        router.sql.begin(async () => {
          await router.sql`UPDATE contacts SET first_name='Changed'`;
          throw new Error("ROLLBACK_TEST");
        }),
      ).rejects.toThrow("ROLLBACK_TEST");
      expect(
        (await router.sql`SELECT first_name FROM contacts`)[0]!.first_name,
      ).toBe("Router");
    });
  });
  it("supports SQL fragments and rejects a captured query after the scope closes", async () => {
    let captured: ReturnType<typeof router.sql> | undefined;
    await router.tenant(a, async () => {
      const fragment = router.sql`first_name='Router'`;
      expect(
        await router.sql`SELECT id FROM contacts WHERE ${fragment}`,
      ).toHaveLength(1);
      captured = router.sql`SELECT organization_id FROM contacts`;
    });
    await expect(Promise.resolve(captured)).rejects.toThrow(
      "DATABASE_QUERY_ESCAPED_SCOPE",
    );
  });
  it("prevents tenant switching or privilege escalation from a tenant scope", async () => {
    await router.tenant(a, async () => {
      await expect(router.tenant(b, async () => undefined)).rejects.toThrow(
        "TENANT_SCOPE_SWITCH_DENIED",
      );
      await expect(
        router.control(admin, async () => undefined),
      ).rejects.toThrow("DATABASE_PRIVILEGE_ESCALATION_DENIED");
    });
  });
  it("allows an explicit control-plane scope without changing tenant defaults", async () => {
    await router.control(admin, async () => {
      expect(
        await router.sql`SELECT id FROM organizations WHERE id IN (${a},${b})`,
      ).toHaveLength(2);
    });
    expect(() => router.sql`SELECT 1`).toThrow("DATABASE_SCOPE_REQUIRED");
  });
});

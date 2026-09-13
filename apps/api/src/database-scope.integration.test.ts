import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import postgres from "postgres";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScopedDatabaseRouter } from "@brixchat/database";
import { databaseRouteScope, registerDatabaseScopes } from "./database-scope";

describe("database scope route classification", () => {
  it("defaults unknown routes to authenticated tenant scope", () => {
    expect(databaseRouteScope("/api/v1/new-feature")).toBe("tenant");
    expect(databaseRouteScope("/webhooks/unknown")).toBe("tenant");
    expect(databaseRouteScope("/api/v1/platform-admin/organizations")).toBe(
      "platform",
    );
  });
});
const url = process.env.SCOPED_ROUTER_TEST_DATABASE_URL;
describe.skipIf(!url)("HTTP transaction boundaries with RLS", () => {
  const admin = postgres(url!, { max: 2, onnotice: () => {} });
  const a = randomUUID(),
    b = randomUUID();
  const role = `http_scope_test_${randomBytes(8).toString("hex")}`;
  let pool: ReturnType<typeof postgres>;
  let app: ReturnType<typeof Fastify>;
  let token: string;
  let verified = false;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!/restore|test/.test(parsed.pathname))
      throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
    verified = true;
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE brixchat_app_scoped`,
    );
    parsed.username = role;
    parsed.password = password;
    pool = postgres(parsed.toString(), { max: 2 });
    const router = createScopedDatabaseRouter(pool);
    await admin`INSERT INTO organizations(id,name,slug) VALUES(${a},'HTTP A',${a}),(${b},'HTTP B',${b})`;
    app = Fastify();
    app.register(jwt, { secret: "integration-secret-only-not-production" });
    registerDatabaseScopes(app, router, admin);
    app.get("/test/stream", async (_request, reply) => {
      return reply.type("text/plain").send(Readable.from(["first", "second"]));
    });
    app.get("/test/read", async () => ({
      data: await router.sql`SELECT organization_id FROM contacts`,
    }));
    app.post("/test/write", async (_request, reply) => {
      await router.sql`INSERT INTO contacts(organization_id,first_name,normalized_phone) VALUES(${a},'HTTP','905550000015')`;
      return reply.code(201).send({ created: true });
    });
    app.post("/test/rollback", async (_request, reply) => {
      await router.sql.begin(async () => {
        await router.sql`INSERT INTO contacts(organization_id,first_name,normalized_phone) VALUES(${a},'Rollback','905550000016')`;
        reply.send({ incorrectSuccess: true });
        throw new Error("TRANSACTION_FAILED");
      });
    });
    app.get("/api/v1/platform-admin/test", async () => ({
      data: await router.sql`SELECT id FROM organizations WHERE id IN (${a},${b})`,
    }));
    await app.ready();
    token = app.jwt.sign({
      sub: randomUUID(),
      organizationId: a,
      role: "owner",
    });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (verified) {
      await admin`DELETE FROM organizations WHERE id IN (${a},${b})`;
      await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
    await admin.end();
  });
  it("requires authentication before entering tenant routes", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/test/read" })).statusCode,
    ).toBe(401);
  });
  it("waits for streamed responses instead of sending an empty body", async () => {
    const response = await app.inject({ method: "GET", url: "/test/stream", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("firstsecond");
  });
  it("commits explicit reply.send before reporting successful creation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/test/write",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ created: true });
    expect(
      await admin`SELECT id FROM contacts WHERE organization_id=${a}`,
    ).toHaveLength(1);
  });
  it("does not send a buffered success if the transaction fails", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/test/rollback",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("incorrectSuccess");
    expect(
      await admin`SELECT id FROM contacts WHERE organization_id=${a} AND first_name='Rollback'`,
    ).toHaveLength(0);
  });
  it("denies platform access to a company owner", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/platform-admin/test",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(403);
    const adminToken = app.jwt.sign({
      sub: randomUUID(),
      organizationId: a,
      role: "owner",
      platformAdmin: true,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/platform-admin/test",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(2);
    expect((await app.inject({method:'HEAD',url:'/api/v1/platform-admin/test',headers:{authorization:`Bearer ${adminToken}`}})).statusCode).toBe(200);
  });
});

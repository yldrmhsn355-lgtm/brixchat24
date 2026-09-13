import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

const url = process.env.SCOPED_ROUTER_TEST_DATABASE_URL;
describe.skipIf(!url)(
  "campaign HTTP workflow with scoped database access",
  () => {
    const sql = postgres(url!, { max: 2, onnotice: () => {} });
    const org = randomUUID(),
      user = randomUUID(),
      channel = randomUUID();
    let app: ReturnType<typeof buildApp>;
    let headers: { authorization: string };
    let verified = false;
    beforeAll(async () => {
      if (!/restore|test/.test(new URL(url!).pathname))
        throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
      verified = true;
      await sql`INSERT INTO organizations(id,name,slug) VALUES(${org},'Campaign API',${org})`;
      await sql`INSERT INTO users(id,email,full_name,password_hash) VALUES(${user},${`${user}@example.invalid`},'Test','login-disabled')`;
      await sql`INSERT INTO organization_members(organization_id,user_id,role) VALUES(${org},${user},'owner')`;
      await sql`INSERT INTO channels(id,organization_id,name,provider,status) VALUES(${channel},${org},'Test line','whatsapp_web','connected')`;
      app = buildApp({
        databaseUrl: url,
        scopedDatabaseUrl: process.env.API_SCOPED_TEST_DATABASE_URL,
        jwtSecret: "campaign-integration-secret-at-least-32-characters",
        webUrl: "http://localhost:3000",
      });
      await app.ready();
      headers = {
        authorization: `Bearer ${app.jwt.sign({ sub: user, organizationId: org, role: "owner" })}`,
      };
    }, 30000);
    afterAll(async () => {
      if (app) await app.close();
      if (verified) {
        await sql`DELETE FROM campaigns WHERE organization_id=${org}`;
        await sql`DELETE FROM organizations WHERE id=${org}`;
        await sql`DELETE FROM users WHERE id=${user}`;
      }
      await sql.end();
    });
    it("requires login and rejects a non-manager even with a valid token", async () => {
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/campaigns" }))
          .statusCode,
      ).toBe(401);
      const token = app.jwt.sign({
        sub: randomUUID(),
        organizationId: org,
        role: "owner",
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/campaigns",
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(403);
    });
    it("previews CSV, creates an idempotent draft and blocks unapproved sending without messages", async () => {
      const options = await app.inject({
        method: "GET",
        url: "/api/v1/campaigns/options",
        headers,
      });
      expect(options.statusCode).toBe(200);
      expect(options.json().data.channels[0].id).toBe(channel);
      const csv = await app.inject({
        method: "POST",
        url: "/api/v1/campaigns/preview-csv",
        headers,
        payload: {
          csv: "telefon,isim\n+15551234567,Test\n0015551234567,Duplicate",
        },
      });
      expect(csv.statusCode).toBe(200);
      expect(csv.json().data.duplicates).toBe(1);
      const payload = {
        requestKey: randomUUID(),
        channelId: channel,
        name: "HTTP dry-run",
        content: { type: "text", text: "Ön izleme" },
        recipients: csv.json().data.recipients,
      };
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/campaigns",
        headers,
        payload,
      });
      expect(create.statusCode).toBe(201);
      const id = create.json().data.id;
      const retry = await app.inject({
        method: "POST",
        url: "/api/v1/campaigns",
        headers,
        payload,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().data.id).toBe(id);
      const dry = await app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${id}/dry-run`,
        headers,
      });
      expect(dry.statusCode).toBe(200);
      expect(dry.json().data.messagesQueued).toBe(0);
      expect(dry.json().data.blockedCount).toBe(1);
      const noConfirm = await app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${id}/start`,
        headers,
        payload: { token: dry.json().data.token, recipientCount: 1 },
      });
      expect(noConfirm.statusCode).toBe(400);
      const blocked = await app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${id}/start`,
        headers,
        payload: {
          confirm: true,
          token: dry.json().data.token,
          recipientCount: 1,
        },
      });
      expect(blocked.statusCode).toBe(409);
      const [count] =
        await sql`SELECT count(*)::int total FROM outbox_jobs WHERE organization_id=${org}`;
      expect(count!.total).toBe(0);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/campaigns/${id}/cancel`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
    });
  },
);

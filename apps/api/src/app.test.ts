import { createHmac } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { buildApp as createApp } from "./app";
import { recordUsage } from "./milestone6-routes";
import { META_WHATSAPP_WEBHOOK_FIELDS } from "@brixchat/integrations";
const buildApp: typeof createApp = (options) =>
  createApp({
    databaseUrl: process.env.DATABASE_URL,
    ...options,
    ...(process.env.API_SCOPED_TEST_DATABASE_URL
      ? { scopedDatabaseUrl: process.env.API_SCOPED_TEST_DATABASE_URL }
      : {}),
  });

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://brixchat:brixchat@localhost:5434/brixchat";
const jwtSecret = "test-secret-with-more-than-thirty-two-chars";
const organizationId = "00000000-0000-4000-8000-000000000001";
const seededChannelId = "00000000-0000-4000-8000-000000000021";
const conversationId = "10000000-0000-4000-8000-000000000001";

async function ownerToken(app: ReturnType<typeof buildApp>) {
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "owner@brixchat.local", password: "BrixChatDemo!2026" },
  });
  return (login.json() as { data: { accessToken: string } }).data.accessToken;
}

describe.sequential("api integration", () => {
  it("rejects foreign origins with 403 and accepts the configured origin", async () => {
    const app = buildApp({ jwtSecret, webUrl: "https://brixchat24.com" });
    try {
      for (const method of ["GET", "OPTIONS"] as const) {
        const response = await app.inject({
          method,
          url: "/health",
          headers: {
            origin: "https://untrusted.example",
            "access-control-request-method": "GET",
          },
        });
        expect(response.statusCode).toBe(403);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      }
      const allowed = await app.inject({
        method: "GET", url: "/health",
        headers: { origin: "https://brixchat24.com" },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://brixchat24.com");
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("publishes an OpenAPI contract and correlates responses by request id", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      openApiEnabled: true,
    });

    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    const contract = response.json() as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(contract.openapi).toMatch(/^3\./);
    expect(contract.info.title).toBe("Brixchat24 API");
    expect(contract.paths).toHaveProperty("/api/v1/conversations");
    expect(contract.paths).toHaveProperty("/api/v1/webhooks/meta");
    expect(contract.components.securitySchemes).toHaveProperty("bearerAuth");
    await app.close();
  });

  it("enforces the configured global request limit", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      rateLimitMax: 2,
    });

    expect(
      (await app.inject({ method: "GET", url: "/version" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/version" })).statusCode,
    ).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/version" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeTruthy();
    await app.close();
  });

  it("verifies the bootstrap Meta webhook with the configured token", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      metaVerifyToken: "staging-meta-verify-token",
      environment: "staging",
    });
    const verified = await app.inject({
      method: "GET",
      url: "/api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=staging-meta-verify-token&hub.challenge=ready",
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.body).toBe("ready");
    const rejected = await app.inject({
      method: "GET",
      url: "/api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=ready",
    });
    expect(rejected.statusCode).toBe(403);
    await app.close();
  });

  it("registers a user and completes resumable organization onboarding", async () => {
    const sendVerificationEmail = vi.fn(async () => undefined);
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
      emailProvider: {
        sendVerificationEmail,
        sendPasswordResetEmail: vi.fn(async () => undefined),
        sendOrganizationInvitation: vi.fn(async () => undefined),
      },
    });
    const email = `onboarding-${crypto.randomUUID()}@example.test`;
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email,
        password: "StrongPassword!2026",
        firstName: "Ada",
        lastName: "Lovelace",
      },
    });
    expect(register.statusCode).toBe(201);
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: email,
        verificationUrl: expect.stringContaining("/verify-email?token="),
      }),
    );
    const accessToken = (register.json() as { data: { accessToken: string } })
      .data.accessToken;
    const save = await app.inject({
      method: "PATCH",
      url: "/api/v1/onboarding",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        currentStep: 7,
        state: {
          organizationName: "Test Workspace",
          slug: `test-${crypto.randomUUID().slice(0, 8)}`,
          industry: "healthcare",
          locale: "tr",
          timezone: "Europe/Istanbul",
          teamName: "Support",
        },
      },
    });
    expect(save.statusCode).toBe(200);
    const complete = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/complete",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(complete.statusCode).toBe(200);
    expect(
      (complete.json() as { data: { completed: boolean; accessToken: string } })
        .data.completed,
    ).toBe(true);
    const sql = postgres(databaseUrl);
    await sql`DELETE FROM users WHERE email=${email}`;
    await sql.end();
    await app.close();
  });

  it("rotates refresh tokens and revokes the family after reuse", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "owner@brixchat.local",
        password: "BrixChatDemo!2026",
      },
    });
    const firstCookie = login.headers["set-cookie"]?.split(";")[0];
    expect(firstCookie).toContain("brixchat_refresh=");
    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: firstCookie! },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.headers["set-cookie"]).not.toBe(login.headers["set-cookie"]);
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: firstCookie! },
    });
    expect(replay.statusCode).toBe(401);
    await app.close();
  });

  it("switches an authorized workspace and preserves it through refresh", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const sql = postgres(databaseUrl);
    const slug = `workspace-switch-${crypto.randomUUID().slice(0, 8)}`;
    const owners = await sql<Array<{ id: string }>>`
      SELECT id FROM users WHERE email='owner@brixchat.local'`;
    const organizations = await sql<Array<{ id: string }>>`
      INSERT INTO organizations(name,slug)
      VALUES('Workspace Switch Test',${slug}) RETURNING id`;
    const targetOrganizationId = organizations[0]!.id;
    await sql`
      INSERT INTO organization_members(organization_id,user_id,role)
      VALUES(${targetOrganizationId}::uuid,${owners[0]!.id}::uuid,'viewer')`;
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          email: "owner@brixchat.local",
          password: "BrixChatDemo!2026",
        },
      });
      const cookie = login.headers["set-cookie"]?.split(";")[0];
      const originalToken = (
        login.json() as {
          data: { accessToken: string };
        }
      ).data.accessToken;
      const listed = await app.inject({
        method: "GET",
        url: "/api/v1/auth/workspaces",
        headers: { authorization: `Bearer ${originalToken}` },
      });
      expect(listed.statusCode).toBe(200);
      const listedBody = listed.json() as {
        data: Array<Record<string, unknown>>;
      };
      expect(listedBody.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: targetOrganizationId,
            name: "Workspace Switch Test",
            role: "viewer",
            active: false,
          }),
        ]),
      );

      const switched = await app.inject({
        method: "POST",
        url: "/api/v1/auth/switch-workspace",
        headers: {
          authorization: `Bearer ${originalToken}`,
          cookie: cookie!,
        },
        payload: { organizationId: targetOrganizationId },
      });
      expect(switched.statusCode).toBe(200);
      const switchedToken = (
        switched.json() as {
          data: { accessToken: string };
        }
      ).data.accessToken;
      expect(app.jwt.verify(switchedToken)).toMatchObject({
        organizationId: targetOrganizationId,
        role: "viewer",
      });

      const refreshed = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        headers: { cookie: cookie! },
      });
      expect(refreshed.statusCode).toBe(200);
      const refreshedToken = (
        refreshed.json() as {
          data: { accessToken: string };
        }
      ).data.accessToken;
      expect(app.jwt.verify(refreshedToken)).toMatchObject({
        organizationId: targetOrganizationId,
        role: "viewer",
      });
    } finally {
      await sql`DELETE FROM organizations WHERE id=${targetOrganizationId}::uuid`;
      await sql.end();
      await app.close();
    }
  });

  it("delivers a password reset link and consumes its token once", async () => {
    let resetUrl = "";
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
      emailProvider: {
        sendVerificationEmail: vi.fn(async () => undefined),
        sendOrganizationInvitation: vi.fn(async () => undefined),
        sendPasswordResetEmail: vi.fn(async (input) => {
          resetUrl = input.resetUrl;
        }),
      },
    });
    const email = `reset-${crypto.randomUUID()}@example.test`;
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email,
        password: "StrongPassword!2026",
        firstName: "Reset",
        lastName: "User",
      },
    });
    const forgot = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email },
    });
    expect(forgot.statusCode).toBe(200);
    const token = new URL(resetUrl).searchParams.get("token");
    expect(token).toBeTruthy();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token, password: "ChangedPassword!2026" },
    });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token, password: "AnotherPassword!2026" },
    });
    expect(replay.statusCode).toBe(400);
    const sql = postgres(databaseUrl);
    await sql`DELETE FROM users WHERE email=${email}`;
    await sql.end();
    await app.close();
  });

  it("accepts an organization invitation once and lets the owner change its role", async () => {
    let invitationUrl = "";
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
      emailProvider: {
        sendVerificationEmail: vi.fn(async () => undefined),
        sendPasswordResetEmail: vi.fn(async () => undefined),
        sendOrganizationInvitation: vi.fn(async (input) => {
          invitationUrl = input.invitationUrl;
        }),
      },
    });
    const token = await ownerToken(app);
    const email = `invite-${crypto.randomUUID()}@example.test`;
    const invitation = await app.inject({
      method: "POST",
      url: "/api/v1/invitations",
      headers: { authorization: `Bearer ${token}` },
      payload: { email, role: "agent" },
    });
    expect(invitation.statusCode).toBe(201);
    const invitationToken = new URL(invitationUrl).searchParams.get("token");
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: {
        token: invitationToken,
        firstName: "Invited",
        lastName: "Agent",
        password: "StrongPassword!2026",
      },
    });
    expect(accepted.statusCode).toBe(200);
    const sql = postgres(databaseUrl);
    const users = await sql<Array<{ id: string }>>`
      SELECT u.id FROM users u
      JOIN organization_members om ON om.user_id=u.id
      WHERE u.email=${email} AND om.organization_id=${organizationId}::uuid AND om.role='agent'`;
    expect(users).toHaveLength(1);
    const changed = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${users[0]!.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: "viewer" },
    });
    expect(changed.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: { token: invitationToken },
    });
    expect(replay.statusCode).toBe(400);
    await sql`DELETE FROM audit_logs WHERE actor_id=${users[0]!.id}::uuid`;
    await sql`DELETE FROM organization_invitations WHERE email=${email}`;
    await sql`DELETE FROM users WHERE id=${users[0]!.id}::uuid`;
    await sql.end();
    await app.close();
  });

  it("enforces channel RBAC, hides secrets, tests health, and syncs fake templates", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
      appEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    const token = await ownerToken(app);
    await app.ready();
    const agent = app.jwt.sign({
      sub: "00000000-0000-4000-8000-000000000012",
      organizationId,
      role: "agent",
      email: "ece@brixchat.local",
    });
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers: { authorization: `Bearer ${agent}` },
      payload: {
        name: "Denied",
        provider: "fake",
        phoneNumber: "+905551234567",
      },
    });
    expect(denied.statusCode).toBe(403);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Integration Fake",
        provider: "fake",
        phoneNumber: "+905551234567",
        accessToken: "never-return-this",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("never-return-this");
    const id = (created.json() as { data: { id: string } }).data.id;
    const health = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${id}/test`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(health.json()).toMatchObject({ data: { status: "healthy" } });
    const sync = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${id}/templates/sync`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sync.json()).toMatchObject({
      data: { status: "completed", received: 3 },
    });
    const templates = await app.inject({
      method: "GET",
      url: `/api/v1/templates?channelId=${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(
      (templates.json() as { data: Array<{ status: string }> }).data.some(
        (item) => item.status === "approved",
      ),
    ).toBe(true);
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/templates",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        channelId: id,
        name: `test_draft_${crypto.randomUUID().slice(0, 8)}`,
        language: "tr",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Merhaba {{1}}" }],
        variables: [
          {
            component: "body",
            position: 1,
            internalKey: "contact.first_name",
            required: true,
            missingPolicy: "block",
          },
        ],
      },
    });
    expect(draft.statusCode).toBe(201);
    const draftId = (draft.json() as { data: { id: string } }).data.id;
    const editedDraft = await app.inject({
      method: "PATCH",
      url: `/api/v1/templates/${draftId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        components: [{ type: "BODY", text: "Güncel merhaba {{1}}" }],
        internalLabel: "Entegrasyon testi",
      },
    });
    expect(editedDraft.statusCode).toBe(200);
    expect(editedDraft.json()).toMatchObject({
      data: { id: draftId, body_text: "Güncel merhaba {{1}}", version: 2 },
    });
    const deniedUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${id}`,
      headers: { authorization: `Bearer ${agent}` },
      payload: { name: "Agent cannot rename" },
    });
    expect(deniedUpdate.statusCode).toBe(403);
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Updated Integration Fake",
        phoneNumber: "+905559876543",
        phoneNumberId: null,
        businessAccountId: null,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      data: {
        name: "Updated Integration Fake",
        phoneNumber: "+905559876543",
      },
    });
    const deniedDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${id}`,
      headers: { authorization: `Bearer ${agent}` },
    });
    expect(deniedDelete.statusCode).toBe(403);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ data: { deleted: true } });
    const deletedDetail = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deletedDetail.statusCode).toBe(404);
    const visibleChannels = await app.inject({
      method: "GET",
      url: "/api/v1/channels",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(
      (visibleChannels.json() as { data: Array<{ id: string }> }).data.some(
        (channel) => channel.id === id,
      ),
    ).toBe(false);
    const sql = postgres(databaseUrl);
    await sql`DELETE FROM channels WHERE id=${id}::uuid`;
    await sql.end();
    await app.close();
  });

  it("subscribes a Meta channel and returns one-time webhook setup", async () => {
    const accessToken = "test-meta-access-token";
    const phoneNumber = `+1999${Date.now()}`;
    const phoneNumberId = `test-phone-${crypto.randomUUID()}`;
    const businessAccountId = `test-waba-${crypto.randomUUID()}`;
    let confirmedCallback = "";
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          confirmedCallback = (
            JSON.parse(String(init.body)) as {
              override_callback_uri: string;
            }
          ).override_callback_uri;
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            data: [{ override_callback_uri: confirmedCallback }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      apiPublicUrl: "https://api.example.test",
      databaseUrl,
      appEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      metaApiVersion: "v25.0",
    });
    let channelId: string | undefined;
    const inspectionSql = postgres(databaseUrl);
    try {
      const token = await ownerToken(app);
      await app.ready();
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/channels",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Meta Production",
          provider: "meta",
          phoneNumber,
          phoneNumberId,
          businessAccountId,
          accessToken,
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      expect(created.headers.pragma).toBe("no-cache");
      expect(created.body).not.toContain(accessToken);
      const createdData = (
        created.json() as {
          data: {
            id: string;
            publicId: string;
            webhookSetup: {
              callbackUrl: string;
              verifyToken: string;
              subscriptionConfigured: boolean;
            };
          };
        }
      ).data;
      channelId = createdData.id;
      expect(createdData.webhookSetup.callbackUrl).toBe(
        `https://api.example.test/webhooks/meta/whatsapp/${createdData.publicId}`,
      );
      expect(createdData.webhookSetup.verifyToken.length).toBeGreaterThan(40);
      expect(createdData.webhookSetup.subscriptionConfigured).toBe(true);
      const persisted = await inspectionSql<
        Array<{ verify_token_hash: string; audit_metadata: string }>
      >`
        SELECT
          c.verify_token_hash,
          COALESCE((
            SELECT metadata::text
            FROM audit_logs
            WHERE entity_id=c.id AND action='channel.created'
            ORDER BY created_at DESC
            LIMIT 1
          ), '') AS audit_metadata
        FROM channels c
        WHERE c.id=${channelId}::uuid`;
      expect(persisted[0]?.verify_token_hash).not.toBe(
        createdData.webhookSetup.verifyToken,
      );
      expect(persisted[0]?.verify_token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(persisted[0]?.audit_metadata).not.toContain(
        createdData.webhookSetup.verifyToken,
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `https://graph.facebook.com/v25.0/${businessAccountId}/subscribed_apps`,
        expect.objectContaining({
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            override_callback_uri: createdData.webhookSetup.callbackUrl,
            verify_token: createdData.webhookSetup.verifyToken,
          }),
        }),
      );

      const callbackPath = new URL(createdData.webhookSetup.callbackUrl)
        .pathname;
      const verified = await app.inject({
        method: "GET",
        url: `${callbackPath}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(createdData.webhookSetup.verifyToken)}&hub.challenge=ready`,
      });
      expect(verified.statusCode).toBe(200);
      expect(verified.body).toBe("ready");

      const webhookInfo = await app.inject({
        method: "GET",
        url: `/api/v1/channels/${channelId}/webhook-info`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(webhookInfo.statusCode).toBe(200);
      expect(webhookInfo.body).not.toContain(
        createdData.webhookSetup.verifyToken,
      );

      const rotated = await app.inject({
        method: "POST",
        url: `/api/v1/channels/${channelId}/rotate-verify-token`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.headers["cache-control"]).toBe("no-store");
      expect(rotated.headers.pragma).toBe("no-cache");
      const rotatedData = (
        rotated.json() as {
          data: {
            callbackUrl: string;
            verifyToken: string;
            subscriptionConfigured: boolean;
          };
        }
      ).data;
      expect(rotatedData.callbackUrl).toBe(
        createdData.webhookSetup.callbackUrl,
      );
      expect(rotatedData.verifyToken).not.toBe(
        createdData.webhookSetup.verifyToken,
      );
      expect(rotatedData.subscriptionConfigured).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        `https://graph.facebook.com/v25.0/${businessAccountId}/subscribed_apps`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            override_callback_uri: rotatedData.callbackUrl,
            verify_token: rotatedData.verifyToken,
          }),
        }),
      );
      const duplicateRotation = await app.inject({
        method: "POST",
        url: `/api/v1/channels/${channelId}/rotate-verify-token`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(duplicateRotation.statusCode).toBe(409);

      const oldToken = await app.inject({
        method: "GET",
        url: `${callbackPath}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(createdData.webhookSetup.verifyToken)}&hub.challenge=old`,
      });
      expect(oldToken.statusCode).toBe(403);
      const newToken = await app.inject({
        method: "GET",
        url: `${callbackPath}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(rotatedData.verifyToken)}&hub.challenge=rotated`,
      });
      expect(newToken.statusCode).toBe(200);
      expect(newToken.body).toBe("rotated");
    } finally {
      if (channelId) {
        await inspectionSql`DELETE FROM audit_logs WHERE entity_id=${channelId}::uuid`;
        await inspectionSql`DELETE FROM channels WHERE id=${channelId}::uuid`;
      }
      await inspectionSql.end();
      await app.close();
      vi.unstubAllGlobals();
    }
  });

  it("rejects incomplete Meta setup and removes a failed WABA provision", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "denied" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      apiPublicUrl: "https://api.example.test",
      databaseUrl,
      appEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      metaApiVersion: "v25.0",
    });
    const inspectionSql = postgres(databaseUrl);
    const name = `Meta Failed ${crypto.randomUUID()}`;
    try {
      const token = await ownerToken(app);
      await app.ready();
      const incomplete = await app.inject({
        method: "POST",
        url: "/api/v1/channels",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name,
          provider: "meta",
          phoneNumber: "+905307440895",
          phoneNumberId: "1113314715209403",
          businessAccountId: "1736060390879129",
        },
      });
      expect(incomplete.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();

      const failed = await app.inject({
        method: "POST",
        url: "/api/v1/channels",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name,
          provider: "meta",
          phoneNumber: "+905307440895",
          phoneNumberId: "1113314715209403",
          businessAccountId: "1736060390879129",
          accessToken: "denied-meta-access-token",
        },
      });
      expect(failed.statusCode).toBe(500);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const rows = await inspectionSql<
        Array<{
          id: string;
          credentials_encrypted: string | null;
          deleted_at: Date | null;
          health_code: string | null;
        }>
      >`
        SELECT id,credentials_encrypted,deleted_at,health_code
        FROM channels
        WHERE organization_id=${organizationId}::uuid
          AND name=${name}`;
      expect(rows[0]?.deleted_at).toBeTruthy();
      expect(rows[0]?.credentials_encrypted).toBeNull();
      expect(rows[0]?.health_code).toBe("CHANNEL_PERMISSION_DENIED");
      const failedAudit = await inspectionSql<
        Array<{ action: string; metadata: string }>
      >`
        SELECT action,metadata::text AS metadata
        FROM audit_logs
        WHERE entity_id=${rows[0]!.id}::uuid AND action='channel.create_failed'`;
      expect(failedAudit[0]?.action).toBe("channel.create_failed");
      expect(failedAudit[0]?.metadata).not.toContain(
        "denied-meta-access-token",
      );
    } finally {
      await inspectionSql`DELETE FROM audit_logs WHERE entity_id IN (SELECT id FROM channels WHERE organization_id=${organizationId}::uuid AND name=${name})`;
      await inspectionSql`DELETE FROM channels WHERE organization_id=${organizationId}::uuid AND name=${name}`;
      await inspectionSql.end();
      await app.close();
      vi.unstubAllGlobals();
    }
  });

  it("rolls back channel creation when ownership persistence fails", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const inspectionSql = postgres(databaseUrl);
    const name = `Rollback ${crypto.randomUUID()}`;
    try {
      await app.ready();
      const invalidOwner = app.jwt.sign({
        sub: "00000000-0000-4000-8000-ffffffffffff",
        organizationId,
        role: "owner",
        email: "missing-owner@example.test",
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/channels",
        headers: { authorization: `Bearer ${invalidOwner}` },
        payload: {
          name,
          provider: "fake",
          phoneNumber: "+905307449999",
        },
      });
      expect(response.statusCode).toBe(500);
      const rows = await inspectionSql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM channels
        WHERE organization_id=${organizationId}::uuid AND name=${name}`;
      expect(rows[0]?.count).toBe(0);
    } finally {
      await inspectionSql`DELETE FROM channels WHERE organization_id=${organizationId}::uuid AND name=${name}`;
      await inspectionSql.end();
      await app.close();
    }
  });

  it("blocks an agent from conversations on channels they do not own", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    await app.ready();
    const agent = app.jwt.sign({
      sub: "00000000-0000-4000-8000-000000000012",
      organizationId,
      role: "agent",
      email: "ece@brixchat.local",
    });
    const conversation = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${agent}` },
    });
    expect(conversation.statusCode).toBe(404);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/conversations?limit=50",
      headers: { authorization: `Bearer ${agent}` },
    });
    expect(list.statusCode).toBe(200);
    expect(
      (list.json() as { data: Array<{ channelId: string }> }).data.every(
        (item) => item.channelId === "00000000-0000-0000-0000-000000000000",
      ),
    ).toBe(true);
    await app.close();
  });

  it("creates scoped quick replies without cross-tenant visibility", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app);
    await app.ready();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/quick-replies",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Test reply",
        shortcut: `test_${crypto.randomUUID().slice(0, 6)}`,
        content: "Hi {{contact.first_name}}",
        scope: "organization",
        language: "en",
      },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { data: { id: string } }).data.id;
    const own = await app.inject({
      method: "GET",
      url: "/api/v1/quick-replies",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(
      (own.json() as { data: Array<{ id: string }> }).data.some(
        (item) => item.id === id,
      ),
    ).toBe(true);
    const shortcutConflict = await app.inject({
      method: "POST",
      url: "/api/v1/quick-replies",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Conflicting reply",
        shortcut: (created.json() as { data: { shortcut: string } }).data
          .shortcut,
        content: "Conflict",
        scope: "organization",
        language: "en",
      },
    });
    expect(shortcutConflict.statusCode).toBe(409);
    const variableReply = await app.inject({
      method: "POST",
      url: "/api/v1/quick-replies",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Variable policy reply",
        shortcut: `variables_${crypto.randomUUID().slice(0, 6)}`,
        content:
          "City: {{contact.city}} Date: {{appointment.date}} Time: {{appointment.time}}",
        scope: "organization",
        language: "en",
        variables: [
          {
            variableKey: "contact.city",
            label: "City",
            source: "contact",
            defaultValue: "Unknown",
            missingPolicy: "default",
          },
          {
            variableKey: "appointment.date",
            label: "Appointment date",
            source: "contact",
            missingPolicy: "manual",
          },
          {
            variableKey: "appointment.time",
            label: "Appointment time",
            source: "contact",
            required: false,
            missingPolicy: "remove",
          },
        ],
      },
    });
    expect(variableReply.statusCode).toBe(201);
    const variableReplyId = (variableReply.json() as { data: { id: string } })
      .data.id;
    const unresolvedRender = await app.inject({
      method: "POST",
      url: `/api/v1/quick-replies/${variableReplyId}/render`,
      headers: { authorization: `Bearer ${token}` },
      payload: { conversationId },
    });
    expect(unresolvedRender.statusCode).toBe(200);
    expect(unresolvedRender.json()).toMatchObject({
      data: {
        content: "City: Unknown Date: {{appointment.date}} Time: ",
        missingVariables: ["appointment.date"],
        timeZone: "Europe/Istanbul",
      },
    });
    const manuallyResolved = await app.inject({
      method: "POST",
      url: `/api/v1/quick-replies/${variableReplyId}/render`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        conversationId,
        manualValues: { "appointment.date": "2026-08-01" },
      },
    });
    expect(manuallyResolved.statusCode).toBe(200);
    expect(manuallyResolved.json()).toMatchObject({
      data: {
        content: "City: Unknown Date: 2026-08-01 Time: ",
        missingVariables: [],
      },
    });
    const analytics = await app.inject({
      method: "GET",
      url: "/api/v1/quick-replies/analytics?days=30",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json()).toMatchObject({
      data: {
        overview: {
          selected: expect.any(Number),
          sent: expect.any(Number),
        },
        days: 30,
      },
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/quick-replies/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Updated reply", version: 1 },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { data: { version: number } }).data.version).toBe(
      2,
    );
    const staleUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/quick-replies/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Stale update", version: 1 },
    });
    expect(staleUpdate.statusCode).toBe(409);
    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/quick-replies/${id}/archive`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(archived.statusCode).toBe(200);
    const activeAfterArchive = await app.inject({
      method: "GET",
      url: "/api/v1/quick-replies",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(
      (activeAfterArchive.json() as { data: Array<{ id: string }> }).data.some(
        (item) => item.id === id,
      ),
    ).toBe(false);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/quick-replies/${id}/restore`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
    const personal = await app.inject({
      method: "POST",
      url: "/api/v1/quick-replies",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Owner private reply",
        shortcut: `private_${crypto.randomUUID().slice(0, 6)}`,
        content: "Private",
        scope: "personal",
        language: "tr",
      },
    });
    expect(personal.statusCode).toBe(201);
    const personalId = (personal.json() as { data: { id: string } }).data.id;
    const agent = app.jwt.sign({
      sub: "00000000-0000-4000-8000-000000000012",
      organizationId,
      role: "agent",
      email: "ece@brixchat.local",
    });
    const privateDetail = await app.inject({
      method: "GET",
      url: `/api/v1/quick-replies/${personalId}`,
      headers: { authorization: `Bearer ${agent}` },
    });
    expect(privateDetail.statusCode).toBe(404);
    const importPreview = await app.inject({
      method: "POST",
      url: "/api/v1/quick-replies/import",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        confirm: false,
        rows: [
          {
            title: "Duplicate import",
            shortcut: (created.json() as { data: { shortcut: string } }).data
              .shortcut,
            content: "Duplicate",
            scope: "organization",
            language: "en",
          },
        ],
      },
    });
    expect(importPreview.statusCode).toBe(200);
    expect(
      (
        importPreview.json() as {
          data: { canCommit: boolean; rows: Array<{ status: string }> };
        }
      ).data,
    ).toMatchObject({
      canCommit: false,
      rows: [{ status: "conflict" }],
    });
    const other = app.jwt.sign({
      sub: "00000000-0000-4000-8000-000000000099",
      organizationId: "00000000-0000-4000-8000-000000000099",
      role: "owner",
      email: "other@example.test",
    });
    const isolated = await app.inject({
      method: "GET",
      url: "/api/v1/quick-replies",
      headers: { authorization: `Bearer ${other}` },
    });
    expect(
      (isolated.json() as { data: Array<{ id: string }> }).data.some(
        (item) => item.id === id,
      ),
    ).toBe(false);
    await app.inject({
      method: "DELETE",
      url: `/api/v1/quick-replies/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    await app.inject({
      method: "DELETE",
      url: `/api/v1/quick-replies/${personalId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    await app.inject({
      method: "DELETE",
      url: `/api/v1/quick-replies/${variableReplyId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();
  });
  it("reports health and protects conversations", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/conversations" }))
        .statusCode,
    ).toBe(401);
    await app.close();
  });

  it("loads the conversation list from PostgreSQL", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/conversations?limit=20&search=Elena",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: Array<{
        contactName: string;
        profilePictureUrl: string | null;
      }>;
    };
    expect(
      body.data.find((item) => item.contactName === "Elena Petrova"),
    ).toMatchObject({
      contactName: "Elena Petrova",
      profilePictureUrl: null,
    });
    await app.close();
  });

  it("isolates tenants and agent assignments", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    await app.ready();
    const otherTenant = app.jwt.sign({
      sub: "00000000-0000-4000-8000-000000000099",
      organizationId: "00000000-0000-4000-8000-000000000099",
      role: "owner",
      email: "other@example.test",
    });
    const unassignedAgent = app.jwt.sign({
      sub: "00000000-0000-4000-8000-000000000099",
      organizationId,
      role: "agent",
      email: "agent@example.test",
    });
    const tenantResponse = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${otherTenant}` },
    });
    const agentResponse = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${unassignedAgent}` },
    });
    expect(tenantResponse.statusCode).toBe(404);
    expect(agentResponse.statusCode).toBe(404);
    await app.close();
  });

  it("creates one pending message and one outbox job for an idempotency key", async () => {
    const windowSql = postgres(databaseUrl);
    const previousWindow = await windowSql<Array<{ expires_at: Date | null }>>`
      SELECT customer_service_window_expires_at expires_at FROM conversations WHERE id=${conversationId}::uuid
    `;
    await windowSql`UPDATE conversations SET customer_service_window_expires_at=now()+interval '24 hours' WHERE id=${conversationId}::uuid`;
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app);
    const clientMessageId = crypto.randomUUID();
    const payload = {
      clientMessageId,
      type: "text",
      text: "API transaction integration test",
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      data: { senderName: "Deniz Aksoy" },
    });
    const firstId = (first.json() as { data: { id: string } }).data.id;
    expect((second.json() as { data: { id: string } }).data.id).toBe(firstId);
    const sql = postgres(databaseUrl);
    const rows = await sql<Array<{ messages: number; jobs: number }>>`
      SELECT
        (SELECT count(*)::int FROM messages WHERE organization_id=${organizationId}::uuid AND client_message_id=${clientMessageId}::uuid) messages,
        (SELECT count(*)::int FROM outbox_jobs WHERE organization_id=${organizationId}::uuid AND aggregate_id=${firstId}::uuid) jobs
    `;
    expect(rows[0]).toEqual({ messages: 1, jobs: 1 });
    await sql.end();
    await app.close();
    await windowSql`UPDATE conversations SET customer_service_window_expires_at=${previousWindow[0]?.expires_at ?? null} WHERE id=${conversationId}::uuid`;
    await windowSql.end();
  });

  it("rejects invalid signatures and deduplicates a signed webhook", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
      metaAppSecret: "local-app-secret",
    });
    const url = "/webhooks/meta/whatsapp/00000000-0000-4000-8000-000000000022";
    const providerMessageId = `api-test-${crypto.randomUUID()}`;
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "integration",
          changes: [
            {
              field: "messages",
              value: { messages: [{ id: providerMessageId }] },
            },
          ],
        },
      ],
    });
    const invalid = await app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=invalid",
      },
      payload: raw,
    });
    expect(invalid.statusCode).toBe(401);
    const signature = `sha256=${createHmac("sha256", "local-app-secret").update(raw).digest("hex")}`;
    const headers = {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
    };
    const first = await app.inject({
      method: "POST",
      url,
      headers,
      payload: raw,
    });
    const second = await app.inject({
      method: "POST",
      url,
      headers,
      payload: raw,
    });
    expect(first.json()).toEqual({ accepted: 1, duplicates: 0 });
    expect(second.json()).toEqual({ accepted: 0, duplicates: 1 });
    await app.close();
  });

  it("accepts every WABA field without phone metadata and records channel receipt health", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
      metaAppSecret: "local-app-secret",
    });
    const marker = crypto.randomUUID();
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "integration",
          changes: META_WHATSAPP_WEBHOOK_FIELDS.map((field) => ({
            field,
            value: { marker, field },
          })),
        },
      ],
    });
    const signature = `sha256=${createHmac("sha256", "local-app-secret").update(raw).digest("hex")}`;
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/meta/whatsapp/00000000-0000-4000-8000-000000000022",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload: raw,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 33, duplicates: 0 });
    const inspectionSql = postgres(databaseUrl);
    try {
      const rows = await inspectionSql<
        Array<{ event_type: string; status: string }>
      >`SELECT event_type,status FROM provider_webhook_events WHERE payload::text LIKE ${`%${marker}%`} ORDER BY event_type`;
      expect(rows).toHaveLength(33);
      expect(rows.every((row) => row.status === "pending")).toBe(true);
      expect(rows.map((row) => row.event_type).sort()).toEqual(
        META_WHATSAPP_WEBHOOK_FIELDS.map((field) => `meta.${field}`).sort(),
      );
      const channelHealth = await inspectionSql<
        Array<{
          last_webhook_at: Date | null;
          last_webhook_result: string | null;
        }>
      >`SELECT last_webhook_at,last_webhook_result FROM channels WHERE public_id='00000000-0000-4000-8000-000000000022'::uuid`;
      expect(channelHealth[0]?.last_webhook_at).toBeInstanceOf(Date);
      expect(channelHealth[0]?.last_webhook_result).toBe("accepted");
      await inspectionSql`DELETE FROM provider_webhook_events WHERE payload::text LIKE ${`%${marker}%`}`;
      await inspectionSql`
        UPDATE channels
        SET last_webhook_at=NULL,last_webhook_result=NULL
        WHERE public_id='00000000-0000-4000-8000-000000000022'::uuid`;
    } finally {
      await inspectionSql.end();
      await app.close();
    }
  });

  it("returns channel_not_found for a malformed webhook public id", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
      metaAppSecret: "local-app-secret",
    });
    try {
      const raw = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "integration",
            changes: [{ field: "messages", value: {} }],
          },
        ],
      });
      const signature = `sha256=${createHmac("sha256", "local-app-secret").update(raw).digest("hex")}`;
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/meta/whatsapp/not-a-uuid",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signature,
        },
        payload: raw,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: "channel_not_found", message: "Channel not found" },
      });
    } finally {
      await app.close();
    }
  });

  it("rejects free-form text when the WhatsApp window is closed", async () => {
    const sql = postgres(databaseUrl);
    const previous = await sql<Array<{ expires_at: Date | null }>>`
      SELECT customer_service_window_expires_at expires_at FROM conversations
      WHERE id=${conversationId}::uuid AND organization_id=${organizationId}::uuid
    `;
    await sql`UPDATE conversations SET customer_service_window_expires_at=now()-interval '1 minute' WHERE id=${conversationId}::uuid`;
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    try {
      const token = await ownerToken(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/conversations/${conversationId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          clientMessageId: crypto.randomUUID(),
          type: "text",
          text: "closed window",
        },
      });
      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        "WHATSAPP_TEMPLATE_REQUIRED",
      );
    } finally {
      await app.close();
      await sql`UPDATE conversations SET customer_service_window_expires_at=${previous[0]?.expires_at ?? null} WHERE id=${conversationId}::uuid`;
      await sql.end();
    }
  });

  it("lists and health-checks fake Bitrix without exposing credentials", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
      appEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    const token = await ownerToken(app);
    await app.ready();
    const agent = app.jwt.sign({
      sub: "00000000-0000-4000-8000-000000000012",
      organizationId,
      role: "agent",
      email: "ece@brixchat.local",
    });
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/integrations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain("credentials_encrypted");
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/50000000-0000-4000-8000-000000000001/test",
      headers: { authorization: `Bearer ${agent}` },
    });
    expect(denied.statusCode).toBe(403);
    const health = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/50000000-0000-4000-8000-000000000001/test",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(health.json()).toMatchObject({
      data: { healthy: true, provider: "fake" },
    });
    await app.close();
  });

  it("lets a new WhatsApp channel reuse a Bitrix line archived by a deleted channel", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app);
    const sql = postgres(databaseUrl);
    const connectionId = crypto.randomUUID();
    const firstChannelId = crypto.randomUUID();
    const secondChannelId = crypto.randomUUID();
    try {
      await sql`
        INSERT INTO integration_connections(
          id,organization_id,provider,name,auth_mode,portal_url,status,settings
        )
        VALUES(
          ${connectionId}::uuid,
          ${organizationId}::uuid,
          'bitrix24',
          'Bitrix24 Line Reuse Test',
          'fake',
          ${`https://line-reuse-${connectionId}.bitrix24.local`},
          'connected',
          '{"fakeScenario":"success"}'::jsonb
        )`;
      await sql`INSERT INTO channels(id,organization_id,name,provider,phone_number,connection_status,health_state) VALUES(${firstChannelId}::uuid,${organizationId}::uuid,'Archived line owner','whatsapp_web','905000000005','ACTIVE','HEALTHY')`;
      const firstBind = await app.inject({
        method: "PUT",
        url: `/api/v1/integrations/${connectionId}/open-channels`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          mode: "open_channels",
          brixchatChannelId: firstChannelId,
          lineId: "fake-line",
          incomingEnabled: true,
          outgoingEnabled: true,
          deliveryStatusSync: true,
          sessionCloseSync: true,
          autoCrmMode: "disabled",
        },
      });
      expect(firstBind.statusCode).toBe(200);
      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/v1/channels/${firstChannelId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(deleted.statusCode).toBe(200);
      const [archived] = await sql<
        Array<{ status: string }>
      >`SELECT status FROM bitrix_open_channel_bindings WHERE organization_id=${organizationId}::uuid AND integration_connection_id=${connectionId}::uuid AND brixchat_channel_id=${firstChannelId}::uuid`;
      expect(archived?.status).toBe("archived");
      await sql`INSERT INTO channels(id,organization_id,name,provider,phone_number,connection_status,health_state) VALUES(${secondChannelId}::uuid,${organizationId}::uuid,'New owner of the line','whatsapp_web','905000000006','ACTIVE','HEALTHY')`;
      const secondBind = await app.inject({
        method: "PUT",
        url: `/api/v1/integrations/${connectionId}/open-channels`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          mode: "open_channels",
          brixchatChannelId: secondChannelId,
          lineId: "fake-line",
          incomingEnabled: true,
          outgoingEnabled: true,
          deliveryStatusSync: true,
          sessionCloseSync: true,
          autoCrmMode: "disabled",
        },
      });
      expect(secondBind.statusCode).toBe(200);
      const [active] = await sql<
        Array<{ status: string }>
      >`SELECT status FROM bitrix_open_channel_bindings WHERE organization_id=${organizationId}::uuid AND integration_connection_id=${connectionId}::uuid AND brixchat_channel_id=${secondChannelId}::uuid`;
      expect(active?.status).toBe("registered");
    } finally {
      await sql`DELETE FROM bitrix_open_channel_bindings WHERE organization_id=${organizationId}::uuid AND brixchat_channel_id IN (${firstChannelId}::uuid,${secondChannelId}::uuid)`;
      await sql`DELETE FROM channels WHERE id IN (${firstChannelId}::uuid,${secondChannelId}::uuid)`;
      await sql`DELETE FROM integration_connections WHERE id=${connectionId}::uuid`;
      await sql.end();
      await app.close();
    }
  });

  it("returns cached CRM context and refreshes it through the fake provider", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app);
    const cached = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/crm-context`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cached.json()).toMatchObject({
      data: { context: { entity: { externalId: "501" } } },
    });
    const refreshed = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/crm-context/refresh`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refreshed.json()).toMatchObject({
      data: { context: { pipeline: "Satış", stage: "Yeni" } },
    });
    await app.close();
  });

  it("returns an active CRM link when its context cache is missing", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app);
    const sql = postgres(databaseUrl);
    await sql`DELETE FROM conversation_crm_context_cache WHERE organization_id=${organizationId}::uuid AND conversation_id=${conversationId}::uuid`;
    try {
      const linked = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}/crm-context`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(linked.statusCode).toBe(200);
      expect(linked.json()).toMatchObject({
        data: {
          context: null,
          stale: true,
          link: { entityType: "contact", externalId: "501" },
        },
      });
    } finally {
      await app.inject({
        method: "POST",
        url: `/api/v1/conversations/${conversationId}/crm-context/refresh`,
        headers: { authorization: `Bearer ${token}` },
      });
      await sql.end();
      await app.close();
    }
  });

  it("applies conversation operations and internal notes without creating WhatsApp messages", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app);
    const sql = postgres(databaseUrl);
    const before = await sql<
      Array<{ count: number }>
    >`SELECT count(*)::int count FROM messages WHERE conversation_id=${conversationId}::uuid`;
    const operation = await app.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${conversationId}/operations`,
      headers: { authorization: `Bearer ${token}` },
      payload: { priority: "urgent", pinned: true },
    });
    expect(operation.statusCode).toBe(200);
    const note = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/notes`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        body: "Milestone 4 internal note",
        mentionUserIds: ["00000000-0000-4000-8000-000000000012"],
      },
    });
    expect(note.statusCode).toBe(201);
    const after = await sql<
      Array<{ count: number }>
    >`SELECT count(*)::int count FROM messages WHERE conversation_id=${conversationId}::uuid`;
    expect(after[0]!.count).toBe(before[0]!.count);
    await sql`DELETE FROM conversation_notes WHERE id=${(note.json() as { data: { id: string } }).data.id}::uuid`;
    await sql`UPDATE conversations SET priority='high',pinned_at=NULL WHERE id=${conversationId}::uuid`;
    await sql.end();
    await app.close();
  });

  it("canonicalizes a duplicate archived conversation when it is unarchived", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app);
    const sql = postgres(databaseUrl);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const phone = `905558${suffix.slice(0, 7)}`;
    let contactId = "";
    let archivedId = "";
    let activeId = "";

    try {
      const contacts = await sql<Array<{ id: string }>>`
        INSERT INTO contacts(
          organization_id,
          first_name,
          display_name,
          normalized_phone
        )
        VALUES(
          ${organizationId}::uuid,
          'Duplicate',
          'Duplicate archive',
          ${phone}
        )
        RETURNING id`;
      contactId = contacts[0]!.id;
      const archived = await sql<Array<{ id: string }>>`
        INSERT INTO conversations(
          organization_id,
          channel_id,
          contact_id,
          status
        )
        VALUES(
          ${organizationId}::uuid,
          ${seededChannelId}::uuid,
          ${contactId}::uuid,
          'archived'
        )
        RETURNING id`;
      archivedId = archived[0]!.id;
      const active = await sql<Array<{ id: string }>>`
        INSERT INTO conversations(
          organization_id,
          channel_id,
          contact_id,
          status
        )
        VALUES(
          ${organizationId}::uuid,
          ${seededChannelId}::uuid,
          ${contactId}::uuid,
          'open'
        )
        RETURNING id`;
      activeId = active[0]!.id;

      const operation = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${archivedId}/operations`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: "open" },
      });
      expect(operation.statusCode).toBe(200);
      expect(operation.json()).toMatchObject({
        data: {
          id: activeId,
          canonicalConversationId: activeId,
          status: "open",
        },
      });
      const superseded = await sql<
        Array<{ status: string; canonical_id: string }>
      >`
        SELECT
          c.status::text status,
          history.to_value->>'canonicalConversationId' canonical_id
        FROM conversations c
        JOIN conversation_operation_history history
          ON history.organization_id=c.organization_id
         AND history.conversation_id=c.id
         AND history.operation='conversation.canonicalized'
        WHERE c.id=${archivedId}::uuid`;
      expect(superseded).toMatchObject([
        { status: "spam", canonical_id: activeId },
      ]);

      const archivedList = await app.inject({
        method: "GET",
        url: `/api/v1/conversations?status=archived&search=${phone}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(archivedList.statusCode).toBe(200);
      expect(archivedList.json()).toMatchObject({ data: [] });
      const counts = await app.inject({
        method: "GET",
        url: `/api/v1/inbox/counts?search=${phone}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(counts.statusCode).toBe(200);
      expect(counts.json()).toMatchObject({ data: { archived: 0 } });
    } finally {
      const ids = [archivedId, activeId].filter(Boolean);
      if (ids.length)
        await sql`
          DELETE FROM conversations
          WHERE id IN ${sql(ids)}
            AND organization_id=${organizationId}::uuid`;
      if (contactId)
        await sql`
          DELETE FROM contacts
          WHERE id=${contactId}::uuid
            AND organization_id=${organizationId}::uuid`;
      await sql.end();
      await app.close();
    }
  });

  it("archives an active conversation when a stale archived duplicate exists", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app);
    const sql = postgres(databaseUrl);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const phone = `905559${suffix.slice(0, 7)}`;
    let contactId = "";
    let staleArchivedId = "";
    let activeId = "";

    try {
      const contacts = await sql<Array<{ id: string }>>`
        INSERT INTO contacts(
          organization_id,
          first_name,
          display_name,
          normalized_phone
        )
        VALUES(
          ${organizationId}::uuid,
          'Archive',
          'Archive collision',
          ${phone}
        )
        RETURNING id`;
      contactId = contacts[0]!.id;
      const staleArchived = await sql<Array<{ id: string }>>`
        INSERT INTO conversations(
          organization_id,
          channel_id,
          contact_id,
          status
        )
        VALUES(
          ${organizationId}::uuid,
          ${seededChannelId}::uuid,
          ${contactId}::uuid,
          'archived'
        )
        RETURNING id`;
      staleArchivedId = staleArchived[0]!.id;
      const active = await sql<Array<{ id: string }>>`
        INSERT INTO conversations(
          organization_id,
          channel_id,
          contact_id,
          status
        )
        VALUES(
          ${organizationId}::uuid,
          ${seededChannelId}::uuid,
          ${contactId}::uuid,
          'open'
        )
        RETURNING id`;
      activeId = active[0]!.id;

      const archive = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${activeId}/operations`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: "archived" },
      });
      expect(archive.statusCode).toBe(200);
      expect(archive.json()).toMatchObject({
        data: { id: activeId, status: "archived" },
      });

      const rows = await sql<
        Array<{ id: string; status: string; canonical_id: string | null }>
      >`
        SELECT
          c.id,
          c.status::text status,
          (
            SELECT history.to_value->>'canonicalConversationId'
            FROM conversation_operation_history history
            WHERE history.organization_id=c.organization_id
              AND history.conversation_id=c.id
              AND history.operation='conversation.canonicalized'
            ORDER BY history.created_at DESC
            LIMIT 1
          ) canonical_id
        FROM conversations c
        WHERE c.id IN (${staleArchivedId}::uuid,${activeId}::uuid)
        ORDER BY c.id`;
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: activeId, status: "archived", canonical_id: null },
          {
            id: staleArchivedId,
            status: "spam",
            canonical_id: activeId,
          },
        ]),
      );

      const archivedList = await app.inject({
        method: "GET",
        url: `/api/v1/conversations?status=archived&search=${phone}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(archivedList.statusCode).toBe(200);
      expect(archivedList.json()).toMatchObject({
        data: [{ id: activeId, status: "archived" }],
      });

      const unarchive = await app.inject({
        method: "PATCH",
        url: `/api/v1/conversations/${activeId}/operations`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: "open" },
      });
      expect(unarchive.statusCode).toBe(200);
      expect(unarchive.json()).toMatchObject({
        data: { id: activeId, status: "open" },
      });
    } finally {
      const ids = [staleArchivedId, activeId].filter(Boolean);
      if (ids.length)
        await sql`
          DELETE FROM conversations
          WHERE id IN ${sql(ids)}
            AND organization_id=${organizationId}::uuid`;
      if (contactId)
        await sql`
          DELETE FROM contacts
          WHERE id=${contactId}::uuid
            AND organization_id=${organizationId}::uuid`;
      await sql.end();
      await app.close();
    }
  });

  it("deduplicates Bitrix webhooks by durable event key", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const url = "/webhooks/bitrix24/50000000-0000-4000-8000-000000000002";
    const payload = {
      event: "ONCRMDEALUPDATE",
      ts: "1784246400",
      application_token: "local-bitrix-webhook-token-2026",
      data: { entityType: "deal", externalId: "900", responsibleId: "101" },
    };
    const first = await app.inject({ method: "POST", url, payload });
    const duplicate = await app.inject({ method: "POST", url, payload });
    expect(first.json()).toEqual({ accepted: true, duplicate: false });
    expect(duplicate.json()).toEqual({ accepted: true, duplicate: true });
    const sql = postgres(databaseUrl);
    await sql`DELETE FROM crm_webhook_events WHERE connection_id='50000000-0000-4000-8000-000000000001'::uuid AND event_type='ONCRMDEALUPDATE'`;
    await sql.end();
    await app.close();
  });

  it("rotates a Bitrix automation webhook token and accepts/dedupes an automation-triggered send", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      apiPublicUrl: "https://api.example.test",
      databaseUrl,
    });
    const token = await ownerToken(app);
    const connectionId = "50000000-0000-4000-8000-000000000001";
    const rotate = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/bitrix24/${connectionId}/automation-webhook/rotate`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rotate.statusCode).toBe(200);
    const { webhookUrl } = (rotate.json() as { data: { webhookUrl: string } })
      .data;
    expect(webhookUrl).toMatch(
      /^https:\/\/api\.example\.test\/webhooks\/bitrix24\/[^/]+\/automation\/[^/]+$/,
    );
    const path = new URL(webhookUrl).pathname;

    const setChannel = await app.inject({
      method: "PATCH",
      url: `/api/v1/integrations/bitrix24/${connectionId}/automation-webhook`,
      headers: { authorization: `Bearer ${token}` },
      payload: { channelId: seededChannelId },
    });
    expect(setChannel.statusCode).toBe(200);

    const payload = {
      entity_type: "lead",
      entity_id: "555",
      phone: "+905551239999",
      template_name: "does-not-exist-in-fixtures",
      idempotency_key: `automation-webhook-test-${crypto.randomUUID()}`,
    };
    const first = await app.inject({ method: "POST", url: path, payload });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: true, duplicate: false });
    const duplicate = await app.inject({ method: "POST", url: path, payload });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual({ accepted: true, duplicate: true });

    const wrongToken = await app.inject({
      method: "POST",
      url: path.replace(/automation\/[^/]+$/, "automation/wrong-secret"),
      payload,
    });
    expect(wrongToken.statusCode).toBe(401);

    const badPayload = await app.inject({
      method: "POST",
      url: path,
      payload: { entity_type: "invalid", phone: "123" },
    });
    expect(badPayload.statusCode).toBe(422);

    const sql = postgres(databaseUrl);
    await sql`DELETE FROM crm_sync_jobs WHERE connection_id=${connectionId}::uuid AND job_type='automation.send_whatsapp'`;
    await sql`UPDATE integration_connections SET automation_webhook_token_hash=NULL,automation_default_channel_id=NULL WHERE id=${connectionId}::uuid`;
    await sql.end();
    await app.close();
  });

  it("rejects an automation webhook call when no token has been provisioned yet", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/bitrix24/50000000-0000-4000-8000-000000000002/automation/anything",
      payload: {
        entity_type: "lead",
        entity_id: "1",
        phone: "+905551230000",
        template_name: "x",
      },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("installs a Bitrix local app, verifies its token, and binds CRM events", async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(input).includes("/profile.json")
              ? { result: { ID: "32", NAME: "Hasan", LAST_NAME: "Yıldırım" } }
              : { result: true },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const app = buildApp({
      jwtSecret,
      webUrl: "https://app.example.test",
      apiPublicUrl: "https://api.example.test",
      databaseUrl,
      appEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      bitrixClientId: "local.test",
      bitrixClientSecret: "local-secret-with-enough-length",
    });
    const token = await ownerToken(app);
    const portalUrl = `https://test-${crypto.randomUUID().slice(0, 8)}.bitrix24.com`;
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/bitrix24/local-app/start",
      headers: { authorization: `Bearer ${token}` },
      payload: { portalUrl, name: "Bitrix local app test" },
    });
    expect(start.statusCode).toBe(201);
    const setup = (
      start.json() as {
        data: {
          id: string;
          installationCallbackUrl: string;
          eventHandlerUrl: string;
        };
      }
    ).data;
    const callback = new URL(setup.installationCallbackUrl);
    const install = await app.inject({
      method: "POST",
      url: `${callback.pathname}${callback.search}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        "auth[access_token]": "access-token",
        "auth[refresh_token]": "refresh-token",
        "auth[application_token]": "application-token",
        "auth[domain]": new URL(portalUrl).hostname,
        "auth[member_id]": "member-id",
        "auth[client_endpoint]": `${portalUrl}/rest/`,
        "auth[server_endpoint]": "https://oauth.bitrix.info/rest/",
        "auth[expires_in]": "3600",
      }).toString(),
    });
    expect(install.statusCode).toBe(200);
    expect(install.json()).toMatchObject({
      status: "connected",
      subscribedEvents: expect.arrayContaining([
        "ONCRMCONTACTUPDATE",
        "ONCRMDEALUPDATE",
      ]),
    });
    expect(fetcher).toHaveBeenCalledTimes(8);
    const sql = postgres(databaseUrl);
    const rows = await sql<
      Array<{
        status: string;
        auth_external_user_id: string | null;
        credentials_encrypted: string | null;
        webhook_token_hash: string | null;
      }>
    >`SELECT status,auth_external_user_id,credentials_encrypted,webhook_token_hash FROM integration_connections WHERE id=${setup.id}::uuid`;
    expect(rows[0]).toMatchObject({
      status: "connected",
      auth_external_user_id: "32",
      credentials_encrypted: expect.any(String),
      webhook_token_hash: expect.any(String),
    });
    await sql`DELETE FROM integration_connections WHERE id=${setup.id}::uuid`;
    await sql.end();
    vi.unstubAllGlobals();
    await app.close();
  });

  it("does not provision a second organization for an installed Bitrix portal", async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(input).includes("/profile.json")
              ? { result: { ID: "77", NAME: "Market", LAST_NAME: "Admin" } }
              : { result: true },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const app = buildApp({
      jwtSecret,
      webUrl: "https://app.example.test",
      apiPublicUrl: "https://api.example.test",
      databaseUrl,
      appEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      bitrixClientId: "local.test",
      bitrixClientSecret: "local-secret-with-enough-length",
    });
    const sql = postgres(databaseUrl);
    const memberId = `market-member-${crypto.randomUUID()}`;
    const domain = `market-${crypto.randomUUID().slice(0, 8)}.bitrix24.com`;
    await sql`
      INSERT INTO integration_connections(
        organization_id,provider,name,auth_mode,portal_url,member_id,
        auth_external_user_id,status,settings
      ) VALUES(
        ${organizationId}::uuid,'bitrix24','Existing Market portal','oauth',
        ${`https://${domain}`},${memberId},'32','connected','{}'::jsonb
      )
    `;
    const organizationCountBefore = Number(
      (
        await sql<Array<{ count: string }>>`SELECT count(*) FROM organizations`
      )[0]!.count,
    );
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/bitrix24/market-install",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        "auth[access_token]": "market-access-token",
        "auth[refresh_token]": "market-refresh-token",
        "auth[application_token]": "market-application-token",
        "auth[domain]": domain,
        "auth[member_id]": memberId,
        "auth[expires_in]": "3600",
      }).toString(),
    });
    const organizationCountAfter = Number(
      (
        await sql<Array<{ count: string }>>`SELECT count(*) FROM organizations`
      )[0]!.count,
    );

    const unexpected = await sql<
      Array<{ organization_id: string; created_by: string | null }>
    >`
      SELECT organization_id,created_by
      FROM integration_connections
      WHERE provider='bitrix24'
        AND member_id=${memberId}
        AND organization_id<>${organizationId}::uuid
    `;
    for (const row of unexpected) {
      await sql`DELETE FROM bitrix_setup_tokens WHERE organization_id=${row.organization_id}::uuid`;
      await sql`DELETE FROM tenant_provisioning_audit WHERE organization_id=${row.organization_id}::uuid`;
      await sql`DELETE FROM integration_connections WHERE organization_id=${row.organization_id}::uuid`;
      await sql`DELETE FROM organization_members WHERE organization_id=${row.organization_id}::uuid`;
      await sql`DELETE FROM onboarding_progress WHERE organization_id=${row.organization_id}::uuid`;
      await sql`DELETE FROM organization_entitlements WHERE organization_id=${row.organization_id}::uuid`;
      if (row.created_by) {
        await sql`DELETE FROM user_credentials WHERE user_id=${row.created_by}::uuid`;
        await sql`DELETE FROM users WHERE id=${row.created_by}::uuid`;
      }
      await sql`DELETE FROM organizations WHERE id=${row.organization_id}::uuid`;
    }
    await sql`DELETE FROM integration_connections WHERE organization_id=${organizationId}::uuid AND provider='bitrix24' AND member_id=${memberId}`;
    await sql.end();
    vi.unstubAllGlobals();
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(organizationCountAfter).toBe(organizationCountBefore);
  });

  it("reuses a pending Bitrix connection for full OAuth and bootstraps the application token", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith("https://oauth.bitrix.info/oauth/token/"))
        return new Response(
          JSON.stringify({
            access_token: "oauth-access-token",
            refresh_token: "oauth-refresh-token",
            expires_in: 3600,
            member_id: "oauth-member-id",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      if (String(input).includes("/profile.json"))
        return new Response(
          JSON.stringify({
            result: { ID: "32", NAME: "Hasan", LAST_NAME: "Yıldırım" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      return new Response(JSON.stringify({ result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const app = buildApp({
      jwtSecret,
      webUrl: "https://app.example.test",
      apiPublicUrl: "https://api.example.test",
      databaseUrl,
      appEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      bitrixClientId: "local.test",
      bitrixClientSecret: "local-secret-with-enough-length",
    });
    const owner = await ownerToken(app);
    const portalUrl = `https://oauth-${crypto.randomUUID().slice(0, 8)}.bitrix24.com`;
    const pending = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/bitrix24/local-app/start",
      headers: { authorization: `Bearer ${owner}` },
      payload: { portalUrl, name: "Bitrix OAuth fallback test" },
    });
    expect(pending.statusCode).toBe(201);
    const pendingData = (
      pending.json() as {
        data: {
          id: string;
          eventHandlerUrl: string;
          installationCallbackUrl: string;
        };
      }
    ).data;
    const oauth = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/bitrix24/oauth/start",
      headers: { authorization: `Bearer ${owner}` },
      payload: { portalUrl, name: "Bitrix OAuth fallback test" },
    });
    expect(oauth.statusCode).toBe(200);
    const authorization = new URL(
      (oauth.json() as { data: { authorizationUrl: string } }).data
        .authorizationUrl,
    );
    const callback = new URL(
      "https://api.example.test/api/v1/integrations/bitrix24/oauth/callback",
    );
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set(
      "state",
      authorization.searchParams.get("state")!,
    );
    callback.searchParams.set("domain", new URL(portalUrl).hostname);
    callback.searchParams.set("member_id", "oauth-member-id");
    const installationReturn = new URL(pendingData.installationCallbackUrl);
    installationReturn.searchParams.set("code", "authorization-code");
    installationReturn.searchParams.set(
      "state",
      authorization.searchParams.get("state")!,
    );
    installationReturn.searchParams.set("domain", new URL(portalUrl).hostname);
    installationReturn.searchParams.set("member_id", "oauth-member-id");
    const bridged = await app.inject({
      method: "GET",
      url: `${installationReturn.pathname}${installationReturn.search}`,
    });
    expect(bridged.statusCode).toBe(302);
    const bridgedCallback = new URL(bridged.headers.location!);
    callback.search = bridgedCallback.search;
    const completed = await app.inject({
      method: "GET",
      url: `${callback.pathname}${callback.search}`,
    });
    expect(completed.statusCode).toBe(302);
    const installEvent = await app.inject({
      method: "POST",
      url: new URL(pendingData.eventHandlerUrl).pathname,
      payload: {
        event: "ONAPPINSTALL",
        ts: "1785280000",
        auth: {
          application_token: "oauth-application-token",
          domain: new URL(portalUrl).hostname,
          member_id: "oauth-member-id",
        },
        data: { VERSION: "1", INSTALLED: "Y" },
      },
    });
    expect(installEvent.json()).toEqual({
      accepted: true,
      duplicate: false,
    });
    const sql = postgres(databaseUrl);
    const rows = await sql<
      Array<{
        status: string;
        auth_external_user_id: string | null;
        webhook_token_hash: string | null;
        settings: { awaitingApplicationToken?: boolean };
      }>
    >`SELECT status,auth_external_user_id,webhook_token_hash,settings FROM integration_connections WHERE id=${pendingData.id}::uuid`;
    expect(rows[0]).toMatchObject({
      status: "connected",
      auth_external_user_id: "32",
      webhook_token_hash: expect.any(String),
      settings: { awaitingApplicationToken: false },
    });
    await sql`DELETE FROM integration_connections WHERE id=${pendingData.id}::uuid`;
    await sql.end();
    vi.unstubAllGlobals();
    await app.close();
  });

  it("connects a second OAuth user to the same Bitrix portal", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://oauth.bitrix.info/oauth/token/"))
        return new Response(
          JSON.stringify({
            access_token: "omer-access-token",
            refresh_token: "omer-refresh-token",
            expires_in: 3600,
            member_id: "shared-portal-member",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      if (url.includes("/profile.json"))
        return new Response(
          JSON.stringify({
            result: { ID: "28", NAME: "Ömer", LAST_NAME: "Özdeş" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      return new Response(JSON.stringify({ result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const app = buildApp({
      jwtSecret,
      webUrl: "https://app.example.test",
      apiPublicUrl: "https://api.example.test",
      databaseUrl,
      appEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      bitrixClientId: "local.test",
      bitrixClientSecret: "local-secret-with-enough-length",
    });
    const owner = await ownerToken(app);
    const portalUrl = `https://multi-${crypto.randomUUID().slice(0, 8)}.bitrix24.com`;
    const sql = postgres(databaseUrl);
    await sql`
      INSERT INTO integration_connections(
        organization_id,provider,name,auth_mode,portal_url,member_id,
        auth_external_user_id,status,settings
      ) VALUES(
        ${organizationId}::uuid,'bitrix24','Hasan connection','oauth',
        ${portalUrl},'shared-portal-member','32','connected',
        ${sql.json({ authExternalUserName: "Hasan Yıldırım" })}
      )
    `;
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/bitrix24/oauth/start",
      headers: { authorization: `Bearer ${owner}` },
      payload: { portalUrl, name: "Ömer 9145 connection" },
    });
    expect(start.statusCode).toBe(200);
    const authorization = new URL(
      (start.json() as { data: { authorizationUrl: string } }).data
        .authorizationUrl,
    );
    const callback = new URL(
      "https://api.example.test/api/v1/integrations/bitrix24/oauth/callback",
    );
    callback.searchParams.set("code", "omer-authorization-code");
    callback.searchParams.set(
      "state",
      authorization.searchParams.get("state")!,
    );
    callback.searchParams.set("domain", new URL(portalUrl).hostname);
    callback.searchParams.set("member_id", "shared-portal-member");
    const completed = await app.inject({
      method: "GET",
      url: `${callback.pathname}${callback.search}`,
    });
    expect(completed.statusCode).toBe(302);
    const rows = await sql<
      Array<{
        name: string;
        auth_external_user_id: string | null;
        status: string;
        settings: { authExternalUserName?: string };
      }>
    >`
      SELECT name,auth_external_user_id,status,settings
      FROM integration_connections
      WHERE organization_id=${organizationId}::uuid
        AND provider='bitrix24'
        AND portal_url=${portalUrl}
      ORDER BY auth_external_user_id
    `;
    expect(rows).toEqual([
      expect.objectContaining({
        auth_external_user_id: "28",
        status: "connected",
        settings: expect.objectContaining({
          authExternalUserName: "Ömer Özdeş",
        }),
      }),
      expect.objectContaining({
        auth_external_user_id: "32",
        status: "connected",
        settings: expect.objectContaining({
          authExternalUserName: "Hasan Yıldırım",
        }),
      }),
    ]);
    const duplicateStart = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/bitrix24/oauth/start",
      headers: { authorization: `Bearer ${owner}` },
      payload: { portalUrl, name: "Duplicate Ömer connection" },
    });
    expect(duplicateStart.statusCode).toBe(200);
    const duplicateAuthorization = new URL(
      (duplicateStart.json() as { data: { authorizationUrl: string } }).data
        .authorizationUrl,
    );
    const duplicateCallback = new URL(callback);
    duplicateCallback.searchParams.set("code", "duplicate-omer-code");
    duplicateCallback.searchParams.set(
      "state",
      duplicateAuthorization.searchParams.get("state")!,
    );
    const duplicateCompleted = await app.inject({
      method: "GET",
      url: `${duplicateCallback.pathname}${duplicateCallback.search}`,
    });
    expect(duplicateCompleted.statusCode).toBe(409);
    expect(duplicateCompleted.json()).toMatchObject({
      error: { code: "bitrix_oauth_user_already_connected" },
    });
    const activeRows = await sql<
      Array<{ auth_external_user_id: string | null }>
    >`
      SELECT auth_external_user_id
      FROM integration_connections
      WHERE organization_id=${organizationId}::uuid
        AND provider='bitrix24'
        AND portal_url=${portalUrl}
        AND status='connected'
      ORDER BY auth_external_user_id
    `;
    expect(activeRows).toEqual([
      { auth_external_user_id: "28" },
      { auth_external_user_id: "32" },
    ]);
    await sql`DELETE FROM integration_connections WHERE organization_id=${organizationId}::uuid AND provider='bitrix24' AND portal_url=${portalUrl}`;
    await sql.end();
    vi.unstubAllGlobals();
    await app.close();
  });

  it("searches tenant data and jumps around an old message", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app);
    const search = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=Elena",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(search.statusCode).toBe(200);
    expect(
      (search.json() as { data: Array<{ conversationId: string }> }).data.some(
        (x) => x.conversationId === conversationId,
      ),
    ).toBe(true);
    const sql = postgres(databaseUrl);
    const message = (
      await sql<
        Array<{ id: string }>
      >`SELECT id FROM messages WHERE conversation_id=${conversationId}::uuid ORDER BY sent_at LIMIT 1`
    )[0]!;
    const around = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/messages/around/${message.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(around.statusCode).toBe(200);
    expect(around.json()).toMatchObject({
      data: {
        targetMessageId: message.id,
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: message.id,
            senderName: "Elena Petrova",
            attachments: expect.any(Array),
          }),
        ]),
      },
    });
    await sql.end();
    await app.close();
  });

  it("creates and publishes an automation while agents remain read-only", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app);
    const agent = app.jwt.sign({
      sub: "00000000-0000-4000-8000-000000000012",
      organizationId,
      role: "agent",
      email: "ece@brixchat.local",
    });
    const name = `Rule ${crypto.randomUUID()}`;
    const catalog = await app.inject({
      method: "GET",
      url: "/api/v1/automations/catalog",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({
      data: {
        nodes: expect.arrayContaining([
          expect.objectContaining({
            type: "message.received",
            version: 1,
            runtimeCapability: "production",
          }),
          expect.objectContaining({
            type: "wait.duration",
            runtimeCapability: "planned",
          }),
        ]),
      },
    });
    const graphValidation = await app.inject({
      method: "POST",
      url: "/api/v1/automations/validate-graph",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        mode: "linear",
        nodes: [
          {
            id: "trigger",
            type: "message.received",
            category: "trigger",
            position: { x: 0, y: 0 },
            config: {},
          },
          {
            id: "action",
            type: "add_label",
            category: "action",
            position: { x: 0, y: 140 },
            config: {},
          },
        ],
        edges: [{ id: "edge", source: "trigger", target: "action" }],
      },
    });
    expect(graphValidation.statusCode).toBe(200);
    expect(graphValidation.json()).toMatchObject({
      data: {
        valid: true,
        compiled: { orderedNodeIds: ["trigger", "action"] },
      },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/automations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name,
        trigger: { type: "message.received" },
        conditions: [],
        actions: [
          {
            type: "add_label",
            config: { labelId: "52000000-0000-4000-8000-000000000002" },
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { data: { id: string } }).data.id;
    const duplicateName = await app.inject({
      method: "POST",
      url: "/api/v1/automations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name,
        trigger: { type: "message.received" },
        conditions: [],
        actions: [
          {
            type: "add_label",
            config: { labelId: "52000000-0000-4000-8000-000000000002" },
          },
        ],
      },
    });
    expect(duplicateName.statusCode).toBe(409);
    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/automations/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name,
        trigger: {
          type: "message.received",
          config: { channelId: seededChannelId },
        },
        conditions: [{ field: "text", operator: "contains", value: "lead" }],
        actions: [
          {
            type: "assign_user",
            config: { userId: "00000000-0000-4000-8000-000000000012" },
          },
        ],
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ data: { draft_version: 2 } });
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/automations/${id}?version=draft`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      data: {
        id,
        draftVersion: 2,
        trigger: { type: "message.received" },
        conditions: [{ field: "text", operator: "contains", value: "lead" }],
        actions: [
          {
            type: "assign_user",
            config: { userId: "00000000-0000-4000-8000-000000000012" },
          },
        ],
      },
    });
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/publish`,
      headers: { authorization: `Bearer ${agent}` },
    });
    expect(denied.statusCode).toBe(403);
    const published = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/publish`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(published.json()).toMatchObject({ data: { status: "active" } });
    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/pause`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(paused.json()).toMatchObject({ data: { status: "paused" } });
    const resumed = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/resume`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resumed.json()).toMatchObject({ data: { status: "active" } });
    const duplicated = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/duplicate`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(duplicated.statusCode).toBe(201);
    const duplicateId = (duplicated.json() as { data: { id: string } }).data.id;
    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/automations/${id}/archive`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(archived.json()).toMatchObject({ data: { status: "archived" } });
    const sql = postgres(databaseUrl);
    await sql`DELETE FROM automation_rules WHERE id IN (${id}::uuid,${duplicateId}::uuid)`;
    await sql.end();
    await app.close();
  });

  it("registers fake Open Channels and deduplicates operator events", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app),
      id = "50000000-0000-4000-8000-000000000001";
    const settings = await app.inject({
      method: "PUT",
      url: `/api/v1/integrations/${id}/open-channels`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        mode: "both",
        brixchatChannelId: "00000000-0000-4000-8000-000000000021",
        lineId: "fake-line",
        incomingEnabled: true,
        outgoingEnabled: true,
        deliveryStatusSync: true,
        sessionCloseSync: true,
        autoCrmMode: "disabled",
        responsibleExternalUserId: "32",
      },
    });
    expect(settings.json()).toMatchObject({
      data: {
        mode: "both",
        timelinePolicy: "per_message",
        binding: {
          settings: { timelinePolicy: "per_message" },
        },
      },
    });
    expect(settings.json()).not.toHaveProperty(
      "data.responsibleExternalUserId",
    );
    expect(settings.json()).not.toHaveProperty(
      "data.binding.settings.responsibleExternalUserId",
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/integrations/${id}/open-channels/register`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
    const lines = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/${id}/open-channels/lines`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(lines.json()).toMatchObject({
      data: [
        {
          id: "fake-line",
          active: true,
          crmEnabled: true,
        },
      ],
    });
    const activated = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/${id}/open-channels/activate`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {
        confirm: "ACTIVATE",
        channelId: "00000000-0000-4000-8000-000000000021",
      },
    });
    expect(activated.json()).toMatchObject({
      data: { configured: true, active: true, error: false },
    });
    const health = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/${id}/open-channels/health`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        channelId: "00000000-0000-4000-8000-000000000021",
      },
    });
    expect(health.json()).toMatchObject({
      data: { configured: true, active: true, error: false },
    });
    const channelBindings = await app.inject({
      method: "GET",
      url: "/api/v1/channels/bitrix24-bindings",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(channelBindings.statusCode).toBe(200);
    const channelBindingPayload = channelBindings.json() as {
      data: {
        connections: Array<{ id: string; status: string }>;
        bindings: Array<{
          channelId: string;
          binding: {
            integrationConnectionId: string;
            lineId: string;
            status: string;
          } | null;
        }>;
      };
    };
    expect(channelBindingPayload).toMatchObject({
      data: {
        connections: [
          {
            id,
            status: "connected",
          },
        ],
      },
    });
    expect(channelBindingPayload.data.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: "00000000-0000-4000-8000-000000000021",
          binding: expect.objectContaining({
            integrationConnectionId: id,
            lineId: "fake-line",
            status: "active",
          }),
        }),
      ]),
    );
    const creationChoiceChannelId = crypto.randomUUID();
    const creationChoiceSql = postgres(databaseUrl);
    await creationChoiceSql`DELETE FROM bitrix_open_channel_bindings WHERE organization_id=${organizationId}::uuid AND brixchat_channel_id IN (SELECT id FROM channels WHERE organization_id=${organizationId}::uuid AND name='Explicit Bitrix choice')`;
    await creationChoiceSql`DELETE FROM channels WHERE organization_id=${organizationId}::uuid AND name='Explicit Bitrix choice'`;
    await creationChoiceSql`INSERT INTO channels(id,organization_id,name,provider,phone_number,connection_status,health_state) VALUES(${creationChoiceChannelId}::uuid,${organizationId}::uuid,'Explicit Bitrix choice','whatsapp_web','905000000003','ACTIVE','HEALTHY')`;
    const unconfirmedCreation = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/${id}/open-channels/ensure`,
      headers: { authorization: `Bearer ${token}` },
      payload: { channelId: creationChoiceChannelId },
    });
    expect(unconfirmedCreation.statusCode).toBe(400);
    const confirmedCreation = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/${id}/open-channels/ensure`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        channelId: creationChoiceChannelId,
        confirm: "CREATE_NEW",
      },
    });
    expect(confirmedCreation.statusCode).toBe(200);
    expect(confirmedCreation.json()).toMatchObject({
      data: {
        createdLine: true,
        binding: {
          integration_connection_id: id,
          brixchat_channel_id: creationChoiceChannelId,
          status: "active",
        },
      },
    });
    const disabledCreationChoice = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${creationChoiceChannelId}/disable`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(disabledCreationChoice.statusCode).toBe(200);
    const [disabledBinding] = await creationChoiceSql<
      Array<{ status: string }>
    >`SELECT status FROM bitrix_open_channel_bindings WHERE organization_id=${organizationId}::uuid AND brixchat_channel_id=${creationChoiceChannelId}::uuid`;
    expect(disabledBinding?.status).toBe("disabled");
    const archivedCreationChoice = await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${creationChoiceChannelId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(archivedCreationChoice.statusCode).toBe(200);
    const [archivedBinding] = await creationChoiceSql<
      Array<{ status: string; line_id: string }>
    >`SELECT status,line_id FROM bitrix_open_channel_bindings WHERE organization_id=${organizationId}::uuid AND brixchat_channel_id=${creationChoiceChannelId}::uuid`;
    expect(archivedBinding?.status).toBe("archived");
    await creationChoiceSql`DELETE FROM bitrix_open_channel_bindings WHERE organization_id=${organizationId}::uuid AND brixchat_channel_id=${creationChoiceChannelId}::uuid`;
    await creationChoiceSql`DELETE FROM channels WHERE id=${creationChoiceChannelId}::uuid`;
    await creationChoiceSql.end();
    const conflictingChannelId = crypto.randomUUID();
    const conflictSql = postgres(databaseUrl);
    await conflictSql`INSERT INTO channels(id,organization_id,name,provider,phone_number,connection_status,health_state) VALUES(${conflictingChannelId}::uuid,${organizationId}::uuid,'Second WhatsApp line','whatsapp_web','905000000002','ACTIVE','HEALTHY')`;
    const conflict = await app.inject({
      method: "PUT",
      url: `/api/v1/integrations/${id}/open-channels`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        mode: "both",
        brixchatChannelId: conflictingChannelId,
        lineId: "fake-line",
        incomingEnabled: true,
        outgoingEnabled: true,
        deliveryStatusSync: true,
        sessionCloseSync: true,
        autoCrmMode: "disabled",
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "open_channel_binding_conflict" },
    });
    await conflictSql`DELETE FROM channels WHERE id=${conflictingChannelId}::uuid`;
    const remapConnectionId = crypto.randomUUID();
    await conflictSql`
      INSERT INTO integration_connections(
        id,organization_id,provider,name,auth_mode,portal_url,status,settings
      )
      VALUES(
        ${remapConnectionId}::uuid,
        ${organizationId}::uuid,
        'bitrix24',
        'Bitrix24 Remap Target',
        'fake',
        ${`https://remap-${remapConnectionId}.bitrix24.local`},
        'connected',
        '{"fakeScenario":"success"}'::jsonb
      )`;
    await conflictSql`
      INSERT INTO bitrix_open_channel_connectors(
        organization_id,integration_connection_id,connector_id,line_id,status
      )
      VALUES(
        ${organizationId}::uuid,
        ${remapConnectionId}::uuid,
        'fake-remap-connector',
        'fake-line',
        'registered'
      )`;
    await conflictSql`
      UPDATE bitrix_open_channel_sessions
      SET status='open',closed_at=NULL
      WHERE organization_id=${organizationId}::uuid
        AND integration_connection_id=${id}::uuid
        AND conversation_id=${conversationId}::uuid`;
    const unconfirmedRemap = await app.inject({
      method: "PUT",
      url: `/api/v1/integrations/${remapConnectionId}/open-channels`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        mode: "both",
        brixchatChannelId: "00000000-0000-4000-8000-000000000021",
        lineId: "fake-line",
        incomingEnabled: true,
        outgoingEnabled: true,
        deliveryStatusSync: true,
        sessionCloseSync: true,
        autoCrmMode: "disabled",
      },
    });
    expect(unconfirmedRemap.statusCode).toBe(409);
    expect(unconfirmedRemap.json()).toMatchObject({
      error: { code: "open_channel_remap_confirmation_required" },
    });
    const remapped = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/${remapConnectionId}/open-channels/remap`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        confirm: "REMAP",
        mode: "both",
        brixchatChannelId: "00000000-0000-4000-8000-000000000021",
        lineId: "fake-line",
        incomingEnabled: true,
        outgoingEnabled: true,
        deliveryStatusSync: true,
        sessionCloseSync: true,
        autoCrmMode: "disabled",
      },
    });
    expect(remapped.statusCode).toBe(200);
    expect(remapped.json()).toMatchObject({
      data: {
        remapped: true,
        closedSessionCount: 1,
        previous: {
          integrationConnectionId: id,
          lineId: "fake-line",
        },
        binding: {
          integration_connection_id: remapConnectionId,
          line_id: "fake-line",
          status: "active",
        },
      },
    });
    const [remappedBinding] = await conflictSql<
      Array<{
        integration_connection_id: string;
        session_status: string;
        audit_count: number;
      }>
    >`
      SELECT
        binding.integration_connection_id,
        session.status AS session_status,
        (
          SELECT count(*)::int
          FROM audit_logs audit
          WHERE audit.organization_id=binding.organization_id
            AND audit.entity_id=binding.brixchat_channel_id
            AND audit.action='bitrix_open_channel.remapped'
        ) AS audit_count
      FROM bitrix_open_channel_bindings binding
      JOIN bitrix_open_channel_sessions session
        ON session.organization_id=binding.organization_id
       AND session.conversation_id=${conversationId}::uuid
       AND session.integration_connection_id=${id}::uuid
      WHERE binding.organization_id=${organizationId}::uuid
        AND binding.brixchat_channel_id='00000000-0000-4000-8000-000000000021'::uuid`;
    expect(remappedBinding).toMatchObject({
      integration_connection_id: remapConnectionId,
      session_status: "closed",
      audit_count: 1,
    });
    await conflictSql`
      UPDATE bitrix_open_channel_bindings
      SET integration_connection_id=${id}::uuid,
          connector_id='fake-connector',
          line_id='fake-line',
          status='active',
          updated_at=now()
      WHERE organization_id=${organizationId}::uuid
        AND brixchat_channel_id='00000000-0000-4000-8000-000000000021'::uuid`;
    await conflictSql`
      UPDATE bitrix_open_channel_sessions
      SET status='open',closed_at=NULL,updated_at=now()
      WHERE organization_id=${organizationId}::uuid
        AND integration_connection_id=${id}::uuid
        AND conversation_id=${conversationId}::uuid`;
    await conflictSql`
      DELETE FROM audit_logs
      WHERE organization_id=${organizationId}::uuid
        AND entity_id='00000000-0000-4000-8000-000000000021'::uuid
        AND action='bitrix_open_channel.remapped'`;
    await conflictSql`
      DELETE FROM integration_connections
      WHERE id=${remapConnectionId}::uuid`;
    await conflictSql.end();
    const payload = {
      conversationId,
      text: "Operator reply",
      eventKey: `event-${crypto.randomUUID()}`,
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/${id}/open-channels/test-outgoing`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/${id}/open-channels/test-outgoing`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(first.json()).toMatchObject({
      data: { accepted: true, duplicate: false },
    });
    expect(duplicate.json()).toMatchObject({
      data: { accepted: false, duplicate: true },
    });
    const sql = postgres(databaseUrl);
    await sql`DELETE FROM bitrix_open_channel_events WHERE provider_event_key=${payload.eventKey}`;
    const reviewJobId = crypto.randomUUID();
    const blockedReviewJobId = crypto.randomUUID();
    await sql`INSERT INTO bitrix_open_channel_jobs(id,organization_id,integration_connection_id,conversation_id,job_type,idempotency_key,status,last_error) VALUES(${reviewJobId}::uuid,${organizationId}::uuid,${id}::uuid,${conversationId}::uuid,'open_channels.crm',${`review-${reviewJobId}`},'dead_letter','Bitrix rejected the request')`;
    await sql`INSERT INTO bitrix_open_channel_jobs(id,organization_id,integration_connection_id,conversation_id,job_type,idempotency_key,status,last_error) VALUES(${blockedReviewJobId}::uuid,${organizationId}::uuid,${id}::uuid,${conversationId}::uuid,'open_channels.crm',${`review-${blockedReviewJobId}`},'blocked','CRM_REVIEW_PENDING')`;
    const reviewJobs = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/${id}/open-channels/jobs`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reviewJobs.statusCode).toBe(200);
    expect(reviewJobs.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          id: reviewJobId,
          status: "dead_letter",
          related_job_count: 2,
        }),
      ]),
      meta: expect.objectContaining({ totalCases: 1, totalJobs: 2 }),
    });
    const archivedReview = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/${id}/open-channels/jobs/${reviewJobId}/archive`,
      headers: { authorization: `Bearer ${token}` },
      payload: { confirm: "ARCHIVE" },
    });
    expect(archivedReview.json()).toMatchObject({
      data: {
        id: reviewJobId,
        status: "archived",
        archivedJobCount: 2,
      },
    });
    const archivedRows = await sql<Array<{ status: string }>>`
      SELECT status FROM bitrix_open_channel_jobs
      WHERE id IN(${reviewJobId}::uuid,${blockedReviewJobId}::uuid)`;
    expect(archivedRows).toHaveLength(2);
    expect(archivedRows.every((row) => row.status === "archived")).toBe(true);
    const retryJobId = crypto.randomUUID();
    await sql`INSERT INTO bitrix_open_channel_jobs(id,organization_id,integration_connection_id,conversation_id,job_type,idempotency_key,status,last_error) VALUES(${retryJobId}::uuid,${organizationId}::uuid,${id}::uuid,${conversationId}::uuid,'open_channels.crm',${`review-${retryJobId}`},'dead_letter','Bitrix rejected the request')`;
    const retriedJob = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/${id}/open-channels/jobs/${retryJobId}/retry`,
      headers: { authorization: `Bearer ${token}` },
      payload: { confirm: "RETRY" },
    });
    expect(retriedJob.json()).toMatchObject({
      data: { id: retryJobId, status: "pending" },
    });
    const [reviewContact] = await sql<Array<{ normalized_phone: string }>>`
      SELECT contact.normalized_phone
      FROM conversations conversation
      JOIN contacts contact ON contact.id=conversation.contact_id
      WHERE conversation.id=${conversationId}::uuid`;
    const exclusion = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/${id}/open-channels/crm-exclusions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        phone: reviewContact!.normalized_phone,
        displayName: "Internal test user",
        reason: "Automated test",
        archivePendingJobs: true,
      },
    });
    expect(exclusion.statusCode).toBe(200);
    expect(exclusion.json()).toMatchObject({
      data: { archivedJobCount: 1 },
    });
    const exclusionId = String(exclusion.json().data.exclusion.id);
    const listedExclusions = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/${id}/open-channels/crm-exclusions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listedExclusions.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ id: exclusionId }),
      ]),
    });
    const removedExclusion = await app.inject({
      method: "DELETE",
      url: `/api/v1/integrations/${id}/open-channels/crm-exclusions/${exclusionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(removedExclusion.statusCode).toBe(200);
    await sql`DELETE FROM bitrix_open_channel_jobs WHERE id IN(${reviewJobId}::uuid,${blockedReviewJobId}::uuid,${retryJobId}::uuid)`;
    await sql.end();
    await app.close();
  });

  it("protects metrics and reports dependency health without secrets", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
      metricsApiKey: "metrics-test",
      objectStorageLocalPath: ".data/test-media",
      redisPing: async () => "PONG",
    });
    const token = await ownerToken(app);
    expect(
      (await app.inject({ method: "GET", url: "/metrics" })).statusCode,
    ).toBe(403);
    const metrics = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { "x-metrics-api-key": "metrics-test" },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("brixchat_info 1");
    expect(metrics.body).toContain("brixchat_http_requests_total");
    expect(metrics.body).toContain('route="/metrics"');
    expect(metrics.body).not.toContain(token);
    const health = await app.inject({
      method: "GET",
      url: "/health/dependencies",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(health.statusCode).toBe(200);
    expect(health.body).not.toContain(jwtSecret);
    await app.close();
  });

  it("reports version and unsafe configuration without exposing secret values", async () => {
    const unsafeSecret = "do-not-expose-this-secret";
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
      environment: "production",
      configEnv: {
        JWT_ACCESS_SECRET: unsafeSecret,
        JWT_REFRESH_SECRET: unsafeSecret,
        OBJECT_STORAGE_PROVIDER: "local",
        MESSAGING_PROVIDER_MODE: "fake",
      },
    });
    const configuration = await app.inject({
      method: "GET",
      url: "/health/configuration",
    });
    expect(configuration.statusCode).toBe(200);
    expect(configuration.json()).toMatchObject({
      data: { environment: "production", valid: false },
    });
    expect(configuration.body).not.toContain(unsafeSecret);
    const version = await app.inject({ method: "GET", url: "/version" });
    expect(version.statusCode).toBe(200);
    expect(version.json()).toMatchObject({
      data: {
        version: expect.any(String),
        migrationVersion: expect.stringMatching(/^\d+$/),
      },
    });
    await app.close();
  });

  it("meters usage idempotently and exposes it only to an authorized owner", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app),
      sql = postgres(databaseUrl),
      metric = `test_metric_${crypto.randomUUID().replaceAll("-", "")}`,
      eventKey = `test:${crypto.randomUUID()}`;
    expect(
      await recordUsage(sql, { organizationId, eventKey, metric, quantity: 3 }),
    ).toBe(true);
    expect(
      await recordUsage(sql, { organizationId, eventKey, metric, quantity: 3 }),
    ).toBe(false);
    const current = await app.inject({
      method: "GET",
      url: "/api/v1/usage/current",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      data: { metrics: { [metric]: 3 } },
    });
    await sql`DELETE FROM usage_events WHERE organization_id=${organizationId}::uuid AND event_key=${eventKey}`;
    await sql`DELETE FROM usage_daily_rollups WHERE organization_id=${organizationId}::uuid AND metric=${metric}`;
    await sql.end();
    await app.close();
  });

  it("starts an outbound conversation atomically and reuses its active identity", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app),
      sql = postgres(databaseUrl),
      phone = `+90555${String(Date.now()).slice(-8)}`;
    let createdConversationId: string | null = null;
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          channelId: seededChannelId,
          phone: phone.replace("+90", "+90 "),
          displayName: "Yeni Hasta",
        },
      });
      expect(created.statusCode).toBe(201);
      const createdBody = created.json() as {
        data: {
          created: boolean;
          conversation: {
            id: string;
            phone: string;
            contactName: string;
            customerServiceWindowExpiresAt: string | null;
          };
        };
      };
      createdConversationId = createdBody.data.conversation.id;
      expect(createdBody.data).toMatchObject({
        created: true,
        conversation: {
          phone,
          contactName: "Yeni Hasta",
          customerServiceWindowExpiresAt: null,
        },
      });

      const reused = await app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          channelId: seededChannelId,
          phone,
          displayName: "Güncel Hasta",
        },
      });
      expect(reused.statusCode).toBe(200);
      expect(reused.json()).toMatchObject({
        data: {
          created: false,
          conversation: {
            id: createdConversationId,
            contactName: "Güncel Hasta",
          },
        },
      });

      const agentLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "ece@brixchat.local", password: "BrixChatDemo!2026" },
      });
      const agentToken = (
        agentLogin.json() as {
          data: { accessToken: string };
        }
      ).data.accessToken;
      const forbidden = await app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: { authorization: `Bearer ${agentToken}` },
        payload: {
          channelId: seededChannelId,
          phone: "+905551234500",
        },
      });
      expect(forbidden.statusCode).toBe(404);
      expect(forbidden.json()).toMatchObject({
        error: { code: "channel_unavailable" },
      });
    } finally {
      if (createdConversationId)
        await sql`DELETE FROM audit_logs WHERE organization_id=${organizationId}::uuid AND entity_id=${createdConversationId}::uuid AND action='conversation.started'`;
      await sql`DELETE FROM conversations WHERE organization_id=${organizationId}::uuid AND contact_id IN (SELECT id FROM contacts WHERE organization_id=${organizationId}::uuid AND normalized_phone=${phone})`;
      await sql`DELETE FROM contacts WHERE organization_id=${organizationId}::uuid AND normalized_phone=${phone}`;
      await sql.end();
      await app.close();
    }
  });

  it("blocks privacy deletion under legal hold and audits the request", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app),
      sql = postgres(databaseUrl);
    await sql`UPDATE organization_retention_settings SET legal_hold=true WHERE organization_id=${organizationId}::uuid`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/privacy/requests",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        subjectReference: `privacy-${crypto.randomUUID()}@example.test`,
        type: "delete",
      },
    });
    expect(response.statusCode).toBe(409);
    const id = (response.json() as { data: { id: string } }).data.id;
    const events =
      await sql`SELECT event_type FROM privacy_request_events WHERE request_id=${id}::uuid`;
    expect(events).toEqual([
      expect.objectContaining({ event_type: "blocked.legal_hold" }),
    ]);
    await sql`DELETE FROM privacy_requests WHERE id=${id}::uuid`;
    await sql`UPDATE organization_retention_settings SET legal_hold=false WHERE organization_id=${organizationId}::uuid`;
    await sql.end();
    await app.close();
  });

  it("enforces expired trial mutations while preserving read-only inbox access", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const token = await ownerToken(app),
      sql = postgres(databaseUrl);
    try {
      await sql`UPDATE organization_entitlements SET trial_status='expired',trial_ends_at=now()-interval '1 day' WHERE organization_id=${organizationId}::uuid`;
      const denied = await app.inject({
        method: "POST",
        url: `/api/v1/conversations/${conversationId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          clientMessageId: crypto.randomUUID(),
          type: "text",
          text: "blocked",
        },
      });
      expect(denied.statusCode).toBe(409);
      expect(denied.json()).toMatchObject({ error: { code: "trial_expired" } });
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/conversations?limit=5",
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      // Runs even if an assertion above throws — otherwise the demo org is
      // left permanently trial-expired in this shared dev database, and
      // every later test run against it starts pre-corrupted.
      await sql`UPDATE organization_entitlements SET trial_status='inactive',trial_ends_at=NULL WHERE organization_id=${organizationId}::uuid`;
      await sql.end();
      await app.close();
    }
  });

  it("blocks a regular org owner from the platform-admin panel but allows a platform admin", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const sql = postgres(databaseUrl);
    const ownerRow = await sql<
      Array<{ id: string }>
    >`SELECT id FROM users WHERE email='owner@brixchat.local'`;
    const ownerId = ownerRow[0]!.id;

    const regularToken = await ownerToken(app);
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/platform-admin/organizations",
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(denied.statusCode).toBe(403);

    await sql`UPDATE users SET is_platform_admin=true WHERE id=${ownerId}::uuid`;
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "owner@brixchat.local",
        password: "BrixChatDemo!2026",
      },
    });
    const adminToken = (adminLogin.json() as { data: { accessToken: string } })
      .data.accessToken;

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/platform-admin/organizations?search=brix-dental",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    const orgs = (list.json() as { data: Array<{ id: string; slug: string }> })
      .data;
    expect(orgs.some((org) => org.id === organizationId)).toBe(true);

    const disable = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform-admin/organizations/${organizationId}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { disabled: true },
    });
    expect(disable.statusCode).toBe(200);
    const disabledRow = await sql<
      Array<{ operational_status: string }>
    >`SELECT operational_status FROM organizations WHERE id=${organizationId}::uuid`;
    expect(disabledRow[0]!.operational_status).toBe("disabled");

    const reenable = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform-admin/organizations/${organizationId}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { disabled: false },
    });
    expect(reenable.statusCode).toBe(200);

    const auditRows = await sql<Array<{ action: string }>>`
      SELECT action FROM tenant_provisioning_audit
      WHERE organization_id=${organizationId}::uuid AND actor=${ownerId}
      ORDER BY created_at DESC LIMIT 2`;
    expect(auditRows.map((row) => row.action).sort()).toEqual([
      "disable",
      "enable",
    ]);

    await sql`DELETE FROM tenant_provisioning_audit WHERE organization_id=${organizationId}::uuid AND actor=${ownerId}`;
    await sql`UPDATE organizations SET operational_status='active',disabled_at=NULL WHERE id=${organizationId}::uuid`;
    await sql`UPDATE users SET is_platform_admin=false WHERE id=${ownerId}::uuid`;
    await sql.end();
    await app.close();
  });

  it("supports org search/detail/edit and platform-admin role management", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const sql = postgres(databaseUrl);
    const ownerRow = await sql<
      Array<{ id: string }>
    >`SELECT id FROM users WHERE email='owner@brixchat.local'`;
    const ownerId = ownerRow[0]!.id;
    const secondEmail = `platform-admin-target-${crypto.randomUUID()}@example.test`;
    const secondUser = await sql<
      Array<{ id: string }>
    >`INSERT INTO users(email,password_hash,full_name) VALUES(${secondEmail},'x','Second Admin') RETURNING id`;
    const secondUserId = secondUser[0]!.id;

    await sql`UPDATE users SET is_platform_admin=true WHERE id=${ownerId}::uuid`;
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "owner@brixchat.local",
        password: "BrixChatDemo!2026",
      },
    });
    const adminToken = (adminLogin.json() as { data: { accessToken: string } })
      .data.accessToken;
    const auth = { authorization: `Bearer ${adminToken}` };

    const search = await app.inject({
      method: "GET",
      url: "/api/v1/platform-admin/organizations?search=Brix+Dental",
      headers: auth,
    });
    expect(search.statusCode).toBe(200);
    const searchResults = (
      search.json() as { data: Array<{ id: string; name: string }> }
    ).data;
    expect(searchResults.some((org) => org.id === organizationId)).toBe(true);
    const noMatch = await app.inject({
      method: "GET",
      url: "/api/v1/platform-admin/organizations?search=zzz-no-such-org-zzz",
      headers: auth,
    });
    expect(
      (noMatch.json() as { data: unknown[] }).data.some(
        (org) => (org as { id: string }).id === organizationId,
      ),
    ).toBe(false);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/platform-admin/organizations/${organizationId}`,
      headers: auth,
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as {
      data: { organization: { id: string; name: string } };
    };
    expect(detailBody.data.organization.id).toBe(organizationId);

    const edit = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform-admin/organizations/${organizationId}`,
      headers: auth,
      payload: { industry: "dentistry-updated" },
    });
    expect(edit.statusCode).toBe(200);
    const editedRow = await sql<
      Array<{ industry: string }>
    >`SELECT industry FROM organizations WHERE id=${organizationId}::uuid`;
    expect(editedRow[0]!.industry).toBe("dentistry-updated");

    const grantMissing = await app.inject({
      method: "POST",
      url: "/api/v1/platform-admin/admins",
      headers: auth,
      payload: { email: "no-such-user-at-all@example.test" },
    });
    expect(grantMissing.statusCode).toBe(404);

    const grant = await app.inject({
      method: "POST",
      url: "/api/v1/platform-admin/admins",
      headers: auth,
      payload: { email: secondEmail },
    });
    expect(grant.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/platform-admin/admins",
      headers: auth,
    });
    const admins = (list.json() as { data: Array<{ id: string }> }).data;
    expect(admins.some((admin) => admin.id === secondUserId)).toBe(true);

    const selfRevoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/platform-admin/admins/${ownerId}`,
      headers: auth,
    });
    expect(selfRevoke.statusCode).toBe(400);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/platform-admin/admins/${secondUserId}`,
      headers: auth,
    });
    expect(revoke.statusCode).toBe(200);
    const revokedRow = await sql<
      Array<{ is_platform_admin: boolean }>
    >`SELECT is_platform_admin FROM users WHERE id=${secondUserId}::uuid`;
    expect(revokedRow[0]!.is_platform_admin).toBe(false);

    const securityEvents = await sql<
      Array<{ event_type: string }>
    >`SELECT event_type FROM user_security_events WHERE user_id=${secondUserId}::uuid ORDER BY created_at`;
    expect(securityEvents.map((row) => row.event_type)).toEqual([
      "platform_admin_granted",
      "platform_admin_revoked",
    ]);

    await sql`UPDATE organizations SET industry=NULL WHERE id=${organizationId}::uuid`;
    await sql`DELETE FROM user_security_events WHERE user_id=${secondUserId}::uuid`;
    await sql`DELETE FROM users WHERE id=${secondUserId}::uuid`;
    await sql`UPDATE users SET is_platform_admin=false WHERE id=${ownerId}::uuid`;
    await sql.end();
    await app.close();
  });

  it("creates organizations with a new or existing owner, and resets a user's password", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const sql = postgres(databaseUrl);
    const ownerRow = await sql<
      Array<{ id: string }>
    >`SELECT id FROM users WHERE email='owner@brixchat.local'`;
    const ownerId = ownerRow[0]!.id;
    await sql`UPDATE users SET is_platform_admin=true WHERE id=${ownerId}::uuid`;
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "owner@brixchat.local",
        password: "BrixChatDemo!2026",
      },
    });
    const adminToken = (adminLogin.json() as { data: { accessToken: string } })
      .data.accessToken;
    const auth = { authorization: `Bearer ${adminToken}` };

    const invalidPlan = await app.inject({
      method: "POST",
      url: "/api/v1/platform-admin/organizations",
      headers: auth,
      payload: {
        name: "X",
        slug: `x-${crypto.randomUUID().slice(0, 8)}`,
        planCode: "no-such-plan",
      },
    });
    expect(invalidPlan.statusCode).toBe(400);

    const newOwnerEmail = `new-owner-${crypto.randomUUID()}@example.test`;
    const slug = `pa-created-${crypto.randomUUID().slice(0, 8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/platform-admin/organizations",
      headers: auth,
      payload: {
        name: "PA Created Org",
        slug,
        planCode: "trial",
        trialDays: 14,
        ownerEmail: newOwnerEmail,
        ownerFullName: "New Owner",
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as {
      data: {
        organizationId: string;
        ownerCreated: boolean;
        ownerPassword: string;
      };
    };
    expect(createdBody.data.ownerCreated).toBe(true);
    expect(createdBody.data.ownerPassword).toHaveLength(20);
    const newOrgId = createdBody.data.organizationId;

    const dupSlug = await app.inject({
      method: "POST",
      url: "/api/v1/platform-admin/organizations",
      headers: auth,
      payload: { name: "Dup", slug, planCode: "trial" },
    });
    expect(dupSlug.statusCode).toBe(409);

    const newOwnerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: newOwnerEmail,
        password: createdBody.data.ownerPassword,
      },
    });
    expect(newOwnerLogin.statusCode).toBe(200);
    expect(
      (newOwnerLogin.json() as { data: { organization: { id: string } } }).data
        .organization.id,
    ).toBe(newOrgId);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/platform-admin/organizations/${newOrgId}`,
      headers: auth,
    });
    expect(
      (detail.json() as { data: { owner: { email: string } | null } }).data
        .owner?.email,
    ).toBe(newOwnerEmail);

    // Second org reusing the same (now-existing) owner email should link
    // the existing user rather than creating a duplicate account.
    const secondSlug = `pa-created-${crypto.randomUUID().slice(0, 8)}`;
    const secondOrg = await app.inject({
      method: "POST",
      url: "/api/v1/platform-admin/organizations",
      headers: auth,
      payload: {
        name: "PA Created Org 2",
        slug: secondSlug,
        planCode: "trial",
        ownerEmail: newOwnerEmail,
      },
    });
    expect(secondOrg.statusCode).toBe(201);
    expect(
      (secondOrg.json() as { data: { ownerCreated: boolean } }).data
        .ownerCreated,
    ).toBe(false);

    const newOwnerId = (
      await sql<
        Array<{ id: string }>
      >`SELECT id FROM users WHERE lower(email)=${newOwnerEmail}`
    )[0]!.id;
    const memberships = await sql<
      Array<{ organization_id: string }>
    >`SELECT organization_id FROM organization_members WHERE user_id=${newOwnerId}::uuid`;
    expect(memberships).toHaveLength(2);

    // Reset the created owner's password and confirm the old one stops
    // working while a fresh login is required (sessions revoked).
    const resetResponse = await app.inject({
      method: "POST",
      url: `/api/v1/platform-admin/users/${newOwnerId}/reset-password`,
      headers: auth,
    });
    expect(resetResponse.statusCode).toBe(200);
    const resetBody = resetResponse.json() as {
      data: { password: string; email: string };
    };
    expect(resetBody.data.email).toBe(newOwnerEmail);

    const staleLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: newOwnerEmail,
        password: createdBody.data.ownerPassword,
      },
    });
    expect(staleLogin.statusCode).toBe(401);

    const freshLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: newOwnerEmail, password: resetBody.data.password },
    });
    expect(freshLogin.statusCode).toBe(200);

    const securityEvents = await sql<
      Array<{ event_type: string }>
    >`SELECT event_type FROM user_security_events WHERE user_id=${newOwnerId}::uuid AND event_type='admin_password_reset'`;
    expect(securityEvents).toHaveLength(1);

    await sql`DELETE FROM tenant_provisioning_audit WHERE organization_id IN(${newOrgId}::uuid,${(secondOrg.json() as { data: { organizationId: string } }).data.organizationId}::uuid)`;
    await sql`DELETE FROM organization_members WHERE user_id=${newOwnerId}::uuid`;
    await sql`DELETE FROM onboarding_progress WHERE user_id=${newOwnerId}::uuid`;
    await sql`DELETE FROM user_security_events WHERE user_id=${newOwnerId}::uuid`;
    await sql`DELETE FROM user_sessions WHERE user_id=${newOwnerId}::uuid`;
    await sql`DELETE FROM user_credentials WHERE user_id=${newOwnerId}::uuid`;
    await sql`DELETE FROM users WHERE id=${newOwnerId}::uuid`;
    await sql`DELETE FROM organization_entitlements WHERE organization_id IN(${newOrgId}::uuid,${(secondOrg.json() as { data: { organizationId: string } }).data.organizationId}::uuid)`;
    await sql`DELETE FROM organizations WHERE id IN(${newOrgId}::uuid,${(secondOrg.json() as { data: { organizationId: string } }).data.organizationId}::uuid)`;
    await sql`UPDATE users SET is_platform_admin=false WHERE id=${ownerId}::uuid`;
    await sql.end();
    await app.close();
  });

  it("paginates/sorts organizations, manages members, and lists a global audit log", async () => {
    const app = buildApp({
      jwtSecret,
      webUrl: "http://localhost:3000",
      databaseUrl,
    });
    const sql = postgres(databaseUrl);
    const ownerRow = await sql<
      Array<{ id: string }>
    >`SELECT id FROM users WHERE email='owner@brixchat.local'`;
    const platformAdminId = ownerRow[0]!.id;
    await sql`UPDATE users SET is_platform_admin=true WHERE id=${platformAdminId}::uuid`;
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "owner@brixchat.local",
        password: "BrixChatDemo!2026",
      },
    });
    const auth = {
      authorization: `Bearer ${(adminLogin.json() as { data: { accessToken: string } }).data.accessToken}`,
    };

    // Create the third organization before exercising pagination so the
    // result genuinely has another page beyond the two returned records.
    // The same throwaway org is then used for member-management guards.
    const firstOwnerEmail = `first-owner-${crypto.randomUUID()}@example.test`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/platform-admin/organizations",
      headers: auth,
      payload: {
        name: "Member Mgmt Org",
        slug: `member-mgmt-${crypto.randomUUID().slice(0, 8)}`,
        planCode: "trial",
        ownerEmail: firstOwnerEmail,
      },
    });
    const orgId = (created.json() as { data: { organizationId: string } }).data
      .organizationId;
    const firstOwnerId = (
      await sql<
        Array<{ id: string }>
      >`SELECT id FROM users WHERE lower(email)=${firstOwnerEmail}`
    )[0]!.id;
    const secondMemberEmail = `second-member-${crypto.randomUUID()}@example.test`;
    const secondMember = (
      await sql<Array<{ id: string }>>`
        INSERT INTO users(email,password_hash,full_name) VALUES(${secondMemberEmail},'x','Second Member') RETURNING id`
    )[0]!;
    await sql`INSERT INTO organization_members(organization_id,user_id,role) VALUES(${orgId}::uuid,${secondMember.id}::uuid,'owner')`;

    const paged = await app.inject({
      method: "GET",
      url: "/api/v1/platform-admin/organizations?limit=2&offset=0&sort=name&order=asc",
      headers: auth,
    });
    expect(paged.statusCode).toBe(200);
    const pagedBody = paged.json() as {
      data: unknown[];
      page: { limit: number; offset: number; total: number };
    };
    expect(pagedBody.data).toHaveLength(2);
    expect(pagedBody.page.total).toBeGreaterThan(2);

    const membersList = await app.inject({
      method: "GET",
      url: `/api/v1/platform-admin/organizations/${orgId}/members`,
      headers: auth,
    });
    expect(
      (membersList.json() as { data: Array<{ email: string }> }).data,
    ).toHaveLength(2);

    // Two owners: demoting one succeeds (the other remains).
    const demote = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform-admin/organizations/${orgId}/members/${secondMember.id}`,
      headers: auth,
      payload: { role: "admin" },
    });
    expect(demote.statusCode).toBe(200);
    const roleRow = await sql<
      Array<{ role: string }>
    >`SELECT role FROM organization_members WHERE organization_id=${orgId}::uuid AND user_id=${secondMember.id}::uuid`;
    expect(roleRow[0]!.role).toBe("admin");

    // Now firstOwnerId is the only owner -- demoting/removing them must be
    // blocked.
    const blockedDemote = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform-admin/organizations/${orgId}/members/${firstOwnerId}`,
      headers: auth,
      payload: { role: "admin" },
    });
    expect(blockedDemote.statusCode).toBe(409);
    const blockedRemove = await app.inject({
      method: "DELETE",
      url: `/api/v1/platform-admin/organizations/${orgId}/members/${firstOwnerId}`,
      headers: auth,
    });
    expect(blockedRemove.statusCode).toBe(409);

    // The demoted admin, on the other hand, can be freely removed.
    const removeAdmin = await app.inject({
      method: "DELETE",
      url: `/api/v1/platform-admin/organizations/${orgId}/members/${secondMember.id}`,
      headers: auth,
    });
    expect(removeAdmin.statusCode).toBe(200);

    const auditLog = await app.inject({
      method: "GET",
      url: "/api/v1/platform-admin/audit-log?limit=5",
      headers: auth,
    });
    expect(auditLog.statusCode).toBe(200);
    const auditBody = auditLog.json() as {
      data: Array<{ organization_name: string | null }>;
      page: { total: number };
    };
    expect(auditBody.data.length).toBeGreaterThan(0);
    expect(auditBody.page.total).toBeGreaterThan(0);

    await sql`DELETE FROM tenant_provisioning_audit WHERE organization_id=${orgId}::uuid`;
    await sql`DELETE FROM organization_members WHERE organization_id=${orgId}::uuid`;
    await sql`DELETE FROM onboarding_progress WHERE user_id=${firstOwnerId}::uuid`;
    await sql`DELETE FROM user_credentials WHERE user_id=${firstOwnerId}::uuid`;
    await sql`DELETE FROM organization_entitlements WHERE organization_id=${orgId}::uuid`;
    await sql`DELETE FROM organizations WHERE id=${orgId}::uuid`;
    await sql`DELETE FROM users WHERE id IN(${firstOwnerId}::uuid,${secondMember.id}::uuid)`;
    await sql`UPDATE users SET is_platform_admin=false WHERE id=${platformAdminId}::uuid`;
    await sql.end();
    await app.close();
  });
});

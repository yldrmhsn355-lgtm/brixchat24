import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://brixchat:brixchat@localhost:5434/brixchat";
const organizationId = "00000000-0000-4000-8000-000000000001";
const conversationId = "10000000-0000-4000-8000-000000000001";
const sql = postgres(databaseUrl);
const app = buildApp({
  jwtSecret: "label-integration-secret-with-more-than-thirty-two-chars",
  databaseUrl,
  webUrl: "http://localhost:3000",
});
let token = "";
const createdLabelIds: string[] = [];
const createdCategoryIds: string[] = [];

async function request(
  method: string,
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

beforeAll(async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      email: "owner@brixchat.local",
      password: "BrixChatDemo!2026",
    },
  });
  token = (login.json() as { data: { accessToken: string } }).data.accessToken;
});

afterAll(async () => {
  if (createdLabelIds.length) {
    await sql`DELETE FROM label_usage_events
      WHERE organization_id=${organizationId}::uuid
        AND label_id IN ${sql(createdLabelIds)} `;
    await sql`DELETE FROM conversation_label_assignments
      WHERE organization_id=${organizationId}::uuid
        AND label_id IN ${sql(createdLabelIds)} `;
    await sql`DELETE FROM conversation_labels
      WHERE organization_id=${organizationId}::uuid
        AND id IN ${sql(createdLabelIds)} `;
  }
  if (createdCategoryIds.length)
    await sql`DELETE FROM label_categories
      WHERE organization_id=${organizationId}::uuid
        AND id IN ${sql(createdCategoryIds)} `;
  await app.close();
  await sql.end();
});

describe.sequential("label operations center integration", () => {
  it("runs category, CRUD, conflict, assignment, filter and lifecycle acceptance", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const categoryResponse = await request("POST", "/api/v1/label-categories", {
      name: `Öncelik ${suffix}`,
      description: "Tek seçim entegrasyon kategorisi",
      color: "#dc2626",
      selectionMode: "single",
      sortOrder: 0,
      isRequiredGroup: false,
    });
    expect(categoryResponse.statusCode).toBe(201);
    const category = categoryResponse.json() as { data: { id: string } };
    createdCategoryIds.push(category.data.id);

    const create = await request("POST", "/api/v1/labels", {
      name: `  Kritik   Müşteri ${suffix} `,
      description: "Kabul testi etiketi",
      color: "#dc2626",
      icon: "🔥",
      categoryId: category.data.id,
      scope: "workspace",
      teamId: null,
      channelId: null,
      sortOrder: 10,
      isProtected: false,
    });
    expect(create.statusCode).toBe(201);
    const label = create.json() as {
      data: { id: string; version: number; normalized_name: string };
    };
    createdLabelIds.push(label.data.id);
    expect(label.data.normalized_name).toContain("kritik müşteri");

    const list = await request(
      "GET",
      `/api/v1/labels?search=${encodeURIComponent(suffix)}&status=active`,
    );
    expect(list.statusCode).toBe(200);
    expect(
      (list.json() as { data: Array<{ id: string }> }).data.some(
        (item) => item.id === label.data.id,
      ),
    ).toBe(true);

    const conflict = await request("POST", "/api/v1/labels", {
      name: `kritik müşteri ${suffix}`,
      description: null,
      color: "#dc2626",
      icon: null,
      categoryId: null,
      scope: "workspace",
      teamId: null,
      channelId: null,
      sortOrder: 0,
      isProtected: false,
    });
    expect(conflict.statusCode).toBe(409);

    const update = await request("PATCH", `/api/v1/labels/${label.data.id}`, {
      description: "Güncellenmiş açıklama",
      color: "#7c3aed",
      version: label.data.version,
    });
    expect(update.statusCode).toBe(200);
    const updated = update.json() as { data: { version: number } };

    const staleUpdate = await request(
      "PATCH",
      `/api/v1/labels/${label.data.id}`,
      { description: "Eski sürüm", version: label.data.version },
    );
    expect(staleUpdate.statusCode).toBe(409);

    const assign = await request(
      "POST",
      `/api/v1/conversations/${conversationId}/labels/${label.data.id}`,
    );
    expect([200, 201]).toContain(assign.statusCode);

    const filtered = await request(
      "GET",
      `/api/v1/conversations?labelIdsAll=${label.data.id}&limit=10`,
    );
    expect(filtered.statusCode).toBe(200);
    expect(
      (filtered.json() as { data: Array<{ id: string }> }).data.some(
        (item) => item.id === conversationId,
      ),
    ).toBe(true);

    const dependencies = await request(
      "GET",
      `/api/v1/labels/${label.data.id}/dependencies`,
    );
    expect(dependencies.statusCode).toBe(200);
    expect(
      (dependencies.json() as { data: { conversations: number } }).data
        .conversations,
    ).toBeGreaterThan(0);

    const archive = await request(
      "POST",
      `/api/v1/labels/${label.data.id}/archive`,
    );
    expect(archive.statusCode).toBe(200);
    const restore = await request(
      "POST",
      `/api/v1/labels/${label.data.id}/restore`,
    );
    expect(restore.statusCode).toBe(200);

    const remove = await request(
      "DELETE",
      `/api/v1/conversations/${conversationId}/labels/${label.data.id}`,
    );
    expect(remove.statusCode).toBe(204);

    const deleted = await request("DELETE", `/api/v1/labels/${label.data.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(updated.data.version).toBeGreaterThan(label.data.version);
  });
});

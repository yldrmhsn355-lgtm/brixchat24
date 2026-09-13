import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { BillingRepository } from "@brixchat/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://brixchat:brixchat@localhost:5434/brixchat";
const actorId = "00000000-0000-4000-8000-000000000011";

describe("line-based billing activation integration", () => {
  it("turns an approved request into family-scoped channel capacity", async () => {
    const sql = postgres(databaseUrl);
    const organizationId = crypto.randomUUID();
    const repository = new BillingRepository(sql);

    try {
      await sql`
        INSERT INTO organizations(id,name,slug)
        VALUES(${organizationId}::uuid,'Line billing integration',${`line-${organizationId}`})`;
      await sql`
        INSERT INTO organization_entitlements(organization_id,plan_id,trial_status)
        SELECT ${organizationId}::uuid,id,'inactive' FROM plans WHERE code='starter'`;

      expect(
        await repository.setManualSubscription({
          organizationId,
          planCode: "starter",
          status: "manual",
          lineItems: [{ productCode: "whatsapp_line", quantity: 2 }],
          actorId,
        }),
      ).toBe(true);

      const request = await repository.createLineSalesRequest({
        organizationId,
        productCode: "whatsapp_line",
        quantity: 2,
        customerNote: "İki yeni satış hattı",
        requestedBy: actorId,
      });
      expect(request).toMatchObject({ status: "pending", quantity: 2 });

      const approved = await repository.reviewLineSalesRequest({
        organizationId,
        requestId: String(request!.id),
        decision: "approved",
        actorId,
      });
      expect(approved).toMatchObject({ status: "approved", quantity: 2 });
      await expect(
        repository.reviewLineSalesRequest({
          organizationId,
          requestId: String(request!.id),
          decision: "approved",
          actorId,
        }),
      ).resolves.toBeNull();

      const capacity = await repository.lineCapacity(organizationId);
      expect(capacity.find((item) => item.family === "whatsapp")).toMatchObject(
        {
          included: 3,
          addon: 4,
          manual_addon: 4,
          used: 0,
        },
      );
      expect(capacity.find((item) => item.family === "telegram")).toMatchObject(
        {
          included: 3,
          addon: 0,
          used: 0,
        },
      );

      for (let index = 0; index < 4; index += 1)
        await sql`
          INSERT INTO channels(organization_id,name,provider,platform)
          VALUES(${organizationId}::uuid,${`WhatsApp ${index}`},'meta','whatsapp')`;
      for (let index = 0; index < 3; index += 1)
        await sql`
          INSERT INTO channels(organization_id,name,provider,platform)
          VALUES(${organizationId}::uuid,${`Telegram ${index}`},'telegram','telegram')`;

      await expect(
        repository.policyForChannel(organizationId, "whatsapp"),
      ).resolves.toMatchObject({ allowed: false, code: "line_limit_exceeded" });
      await expect(
        repository.policyForChannel(organizationId, "telegram"),
      ).resolves.toMatchObject({ allowed: false, code: "line_limit_exceeded" });
    } finally {
      await sql`DELETE FROM organizations WHERE id=${organizationId}::uuid`;
      await sql.end();
    }
  });
});

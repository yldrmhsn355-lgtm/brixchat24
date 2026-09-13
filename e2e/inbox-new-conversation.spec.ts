import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { localComposeEnvironment } from "./local-environment";
import { demoUsers, InboxPage } from "./pages/inbox-page";

const organizationId = "00000000-0000-4000-8000-000000000001";
const marker = "E2E Yeni Konuşma";

test("owner prepares a new customer conversation and reaches the approved template flow", async ({
  page,
}) => {
  const sql = postgres(
    `postgresql://brixchat:brixchat@127.0.0.1:${localComposeEnvironment.POSTGRES_PORT}/brixchat`,
    { max: 1 },
  );
  const phone = `+90554${String(Date.now()).slice(-8)}`;
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`
        DELETE FROM audit_logs
        WHERE organization_id=${organizationId}::uuid
          AND action='conversation.started'
          AND entity_id IN (
            SELECT conversation.id
            FROM conversations conversation
            JOIN contacts contact ON contact.id=conversation.contact_id
            WHERE conversation.organization_id=${organizationId}::uuid
              AND contact.normalized_phone=${phone}
          )`;
      await tx`
        DELETE FROM conversations
        WHERE organization_id=${organizationId}::uuid
          AND contact_id IN (
            SELECT id FROM contacts
            WHERE organization_id=${organizationId}::uuid
              AND normalized_phone=${phone}
          )`;
      await tx`
        DELETE FROM contacts
        WHERE organization_id=${organizationId}::uuid
          AND normalized_phone=${phone}`;
    });
  };

  try {
    await cleanup();
    await new InboxPage(page).login(demoUsers.owner);
    await page
      .getByRole("button", { name: "Yeni konuşma", exact: true })
      .click();

    const dialog = page.getByRole("dialog", { name: "Yeni konuşma" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Telefon numarası").fill(phone);
    await dialog.getByLabel("Müşteri adı (isteğe bağlı)").fill(marker);
    await expect(dialog.getByLabel("WhatsApp hesabı")).toHaveValue(
      "00000000-0000-4000-8000-000000000021",
    );
    await dialog.getByRole("button", { name: "Konuşmayı hazırla" }).click();

    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: `${marker} kişi` }),
    ).toBeVisible();
    await expect(
      page.getByPlaceholder("24 saatlik pencere kapalı — şablon seçin"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Mesaj araçlarını aç" }).click();
    await page.getByRole("menuitem", { name: "Şablon mesaj" }).click();
    await expect(
      page.getByRole("heading", { name: "WhatsApp Şablonu seç" }),
    ).toBeVisible();
  } finally {
    await cleanup();
    await sql.end();
  }
});

import { expect, test } from "@playwright/test";
import { demoUsers, InboxPage } from "./pages/inbox-page";

test("Bitrix24 fake integration and cached CRM context remain inside the inbox", async ({
  page,
}) => {
  await new InboxPage(page).login(demoUsers.owner);
  await page.goto("/app/integrations/bitrix24");
  await expect(
    page.getByRole("heading", { name: "Bitrix24" }).first(),
  ).toBeVisible();
  await expect(page.getByText("Bitrix24 Demo")).toBeVisible();
  await page.getByRole("button", { name: "Health" }).click();
  await expect(page.getByText("Bitrix24 health testi başarılı.")).toBeVisible();
  await page.goto("/app/inbox");
  await page.getByText("Elena Petrova").first().click();
  await page
    .getByRole("button", { name: "Kişi bilgileri", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Bitrix24 CRM" }),
  ).toBeVisible();
  await expect(page.getByText("contact #501")).toBeVisible();
  await page.getByLabel("İç not").fill(`E2E internal note ${Date.now()}`);
  await page.getByRole("button", { name: "İç not ekle" }).click();
  await expect(page.locator(".note-list article").last()).toBeVisible();
});

test("linked Bitrix24 context loads automatically when the cache is missing", async ({
  page,
}) => {
  await page.route("**/api/v1/conversations/*/crm-context", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          context: null,
          fetchedAt: null,
          staleAt: null,
          stale: true,
          lastErrorCode: null,
          link: { entityType: "contact", externalId: "501" },
        },
      }),
    });
  });
  await page.route(
    "**/api/v1/conversations/*/crm-context/refresh",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            context: {
              entity: {
                entityType: "contact",
                externalId: "501",
                displayName: "Otomatik Bitrix Kaydı",
              },
              responsible: { name: "Hasan Yıldırım" },
              company: "Brix Dental",
              pipeline: "Satış",
              stage: "Yeni",
              fields: {},
            },
            fetchedAt: new Date().toISOString(),
          },
        }),
      });
    },
  );

  await new InboxPage(page).login(demoUsers.owner);
  await page.goto("/app/inbox");
  await page.getByText("Elena Petrova").first().click();
  await page
    .getByRole("button", { name: "Kişi bilgileri", exact: true })
    .click();

  await expect(page.getByText("Otomatik Bitrix Kaydı")).toBeVisible();
  await expect(page.getByText("Hasan Yıldırım")).toBeVisible();
});

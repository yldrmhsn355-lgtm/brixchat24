import { expect, test } from "@playwright/test";
import { demoUsers, InboxPage } from "./pages/inbox-page";

test.beforeEach(async ({ page }) => {
  await new InboxPage(page).login(demoUsers.owner);
  await page.goto("/app/automations");
  await expect(
    page.getByRole("heading", { name: "Otomasyonlar", exact: true }),
  ).toBeVisible();
});

test("new automation canvas returns to the automation list", async ({
  page,
}) => {
  await page
    .getByRole("link", { name: "Otomasyon ekle", exact: true })
    .first()
    .click();

  await expect(page).toHaveURL(/\/app\/automations\/new$/);
  await expect(
    page.getByRole("heading", { name: "Otomasyon Stüdyosu", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("link", { name: "Otomasyon listesine dön", exact: true })
    .click();

  await expect(page).toHaveURL(/\/app\/automations$/);
  await expect(
    page.getByRole("heading", { name: "Otomasyonlar", exact: true }),
  ).toBeVisible();
});

test("existing automation canvas returns to the automation list", async ({
  page,
}) => {
  const editLink = page
    .getByRole("link", { name: "Düzenle", exact: true })
    .first();
  await expect(editLink).toBeVisible();
  await editLink.click();

  await expect(page).toHaveURL(/\/app\/automations\/[^/]+$/);
  await expect(
    page.getByRole("heading", { name: "Otomasyon Stüdyosu", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("link", { name: "Otomasyon listesine dön", exact: true })
    .click();

  await expect(page).toHaveURL(/\/app\/automations$/);
  await expect(
    page.getByRole("heading", { name: "Otomasyonlar", exact: true }),
  ).toBeVisible();
});

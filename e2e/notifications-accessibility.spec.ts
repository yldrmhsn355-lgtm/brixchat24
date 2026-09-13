import { expect, test } from "@playwright/test";
import { demoUsers, InboxPage } from "./pages/inbox-page";

test.beforeEach(async ({ page }) => {
  await new InboxPage(page).login(demoUsers.owner);
});

test("notification center connects the application shell to the notification API", async ({
  page,
}) => {
  const notificationResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/notifications") &&
      response.request().method() === "GET",
  );

  await page.reload();
  expect((await notificationResponse).ok()).toBeTruthy();

  await page.getByRole("button", { name: /^Bildirimler/ }).click();
  const panel = page.getByRole("dialog", { name: "Bildirimler" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(
    /Henüz bildiriminiz yok|okunmamış|Tümü okundu/,
  );

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("filters and data tables expose stable accessible names", async ({
  page,
}) => {
  await page.goto("/app/templates");
  for (const name of [
    "Dil filtresi",
    "Kategori filtresi",
    "Şablon durumu filtresi",
    "Kalite filtresi",
    "Kullanım filtresi",
  ]) {
    await expect(page.getByRole("combobox", { name })).toBeVisible();
  }

  await page.goto("/app/labels");
  for (const name of [
    "Kategori filtresi",
    "Kapsam filtresi",
    "Durum filtresi",
    "Kullanım filtresi",
    "Etiket sıralaması",
  ]) {
    await expect(page.getByRole("combobox", { name })).toBeVisible();
  }

  await page.goto("/app/team");
  await expect(
    page.getByRole("table", { name: "Ekip kullanıcıları" }),
  ).toBeVisible();

  await page.goto("/app/settings/security");
  await expect(
    page.getByRole("table", { name: "Son güvenlik olayları" }),
  ).toBeVisible();
});

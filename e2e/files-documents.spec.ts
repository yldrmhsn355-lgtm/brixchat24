import { expect, test } from "@playwright/test";
import { demoUsers, InboxPage } from "./pages/inbox-page";

test("uploads, searches and favorites a tenant-scoped document", async ({
  page,
}) => {
  await new InboxPage(page).login(demoUsers.owner);
  await page.goto("/app/files");

  await expect(
    page.getByRole("heading", { name: "Dosyalar ve Belgeler" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Son kullanılanlar" }),
  ).toBeVisible();

  const filename = `e2e-dental-plan-${Date.now()}.txt`;
  const uploadResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/files/uploads"),
  );
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Dosya yükle" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from("BrixChat files module E2E"),
  });
  expect((await uploadResponse).status()).toBe(201);

  await expect(page.getByText(filename, { exact: true })).toBeVisible();
  await page.getByPlaceholder("Dosya ara").fill(filename.slice(0, 18));
  await expect(page.getByText(filename, { exact: true })).toBeVisible();

  await page
    .getByRole("row", { name: new RegExp(filename) })
    .getByLabel("Dosya işlemleri")
    .click();
  await page.getByRole("button", { name: "Favorilere ekle" }).click();
  await page.getByRole("button", { name: "Favoriler", exact: true }).click();
  await expect(page.getByText(filename, { exact: true })).toBeVisible();
});

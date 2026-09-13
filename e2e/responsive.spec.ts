import { expect, test, type Page } from "@playwright/test";
import { demoUsers, InboxPage } from "./pages/inbox-page";

const targetViewports = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 820, height: 1180 },
  { width: 1024, height: 768 },
  { width: 1024, height: 1366 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const;

async function expectNoPageOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(
    metrics.bodyClientWidth + 1,
  );
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(
    metrics.documentClientWidth + 1,
  );
}

test.beforeEach(async ({ page }) => {
  await new InboxPage(page).login(demoUsers.owner);
});

test("application shell stays inside every supported viewport", async ({
  page,
}) => {
  await page.goto("/app/files");
  for (const viewport of targetViewports) {
    await page.setViewportSize(viewport);
    await expect(page.locator(".app-shell")).toBeVisible();
    await expectNoPageOverflow(page);

    if (viewport.width <= 680) {
      const trigger = page.locator(".mobile-nav-trigger");
      await expect(trigger).toBeVisible();
      await trigger.click();
      await expect(page.locator(".mobile-nav-drawer")).toBeVisible();
      await expect(page.locator(".mobile-nav-drawer")).toHaveCSS(
        "transform",
        "none",
      );
      const box = await page.locator(".mobile-nav-drawer").boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        viewport.width,
      );
      await page.keyboard.press("Escape");
      await expect(page.locator(".mobile-nav-drawer")).toBeHidden();
    }
  }
});

test("route changes reset the application content scroll position", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.goto("/app/templates");

  await page.locator(".management-page").evaluate((element) => {
    element.style.minHeight = "1200px";
  });
  const mainArea = page.locator(".main-area");
  await mainArea.evaluate((element) => {
    element.style.height = "300px";
    element.style.overflow = "auto";
    element.scrollTop = element.scrollHeight;
  });
  expect(await mainArea.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );

  await page.locator('.sidebar a[href="/app/team"]').click();
  await expect(page).toHaveURL(/\/app\/team$/);
  await expect
    .poll(() => mainArea.evaluate((element) => element.scrollTop))
    .toBe(0);
});

test("all primary modules avoid page overflow at 320 pixels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const route of [
    "/app/files",
    "/app/channels",
    "/app/templates",
    "/app/quick-replies",
    "/app/labels",
    "/app/automations",
    "/app/team",
    "/app/integrations",
    "/app/settings/profile",
    "/app/settings/security",
    "/app/settings/production",
  ]) {
    await page.goto(route);
    await expect(page.locator(".app-shell")).toBeVisible();
    await expectNoPageOverflow(page);
  }
});

test("mobile inbox uses list, conversation and contact stack", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/app/inbox");
  const conversation = page.locator(".conversation-row").first();
  await expect(conversation).toBeVisible();
  await conversation.click();

  const chat = page.locator(".chat-column");
  await expect(chat).toBeVisible();
  await expect(page.locator(".back-button")).toBeVisible();
  const chatBox = await chat.boundingBox();
  expect(chatBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  await expect(page.locator(".composer-row")).toBeVisible();

  await page.locator(".chat-person-button").click();
  const contact = page.locator(".contact-panel.open");
  await expect(contact).toBeVisible();
  await expect(contact).toHaveAttribute("role", "dialog");
  const contactBox = await contact.boundingBox();
  expect(contactBox?.width ?? 0).toBeLessThanOrEqual(320.01);
  await page.locator(".contact-drawer-close").click();

  await page.setViewportSize({ width: 1600, height: 900 });
  await page.locator(".chat-person-button").click();
  await expect(page.locator(".contact-panel.open")).not.toHaveAttribute(
    "role",
    "dialog",
  );
  await expect(page.locator(".contact-drawer-backdrop")).toBeHidden();

  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator(".contact-drawer-close").click();
  await page.locator(".back-button").click();
  await expect(conversation).toBeVisible();
  await expectNoPageOverflow(page);
});

test("mobile navigation, filters, composer tools and long messages remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/files");
  await page.getByRole("button", { name: "Ana menüyü aç" }).click();
  await page
    .getByRole("navigation", { name: "Mobil ana menü" })
    .getByRole("link", { name: "Otomasyonlar" })
    .click();
  await expect(page).toHaveURL(/\/app\/automations$/);
  await expect(page.locator(".mobile-nav-drawer")).toBeHidden();

  await page.goto("/app/inbox");
  await page.getByRole("button", { name: "Konuşmaları filtrele" }).click();
  const filters = page.getByRole("dialog", { name: "Konuşma filtreleri" });
  await filters.getByRole("checkbox", { name: /Okunmamış/ }).check();
  await filters.getByRole("button", { name: "Uygula" }).click();
  await expect(
    page.getByRole("button", { name: /Konuşma filtreleri, 1 etkin/ }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: /Konuşma filtreleri, 1 etkin/ })
    .click();
  await filters.getByRole("checkbox", { name: /Okunmamış/ }).uncheck();
  await filters.getByRole("button", { name: "Uygula" }).click();
  await expect(
    page.getByRole("button", { name: "Konuşmaları filtrele" }),
  ).toBeVisible();

  const elena = page.locator(".conversation-row").filter({
    hasText: "Elena Petrova",
  });
  await expect(elena).toBeVisible();
  await elena.click();
  const composer = page.getByRole("textbox", { name: "Mesaj" });
  await expect(composer).toBeVisible();
  await page.getByRole("button", { name: "Mesaj araçlarını aç" }).click();
  await page.getByRole("menuitem", { name: "Emoji ekle" }).click();
  await page.getByRole("menuitem", { name: "😀 emojisini ekle" }).click();
  await expect(composer).toHaveValue("😀");

  await page.getByRole("button", { name: "Mesaj araçlarını aç" }).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Bilgisayardan yükle" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: `mobile-attachment-${Date.now()}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from("mobile attachment acceptance"),
  });
  await expect(
    page.getByRole("dialog", { name: "Dosya işlemini seç" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dosya işlemini kapat" }).click();

  const longMessage = `😀 Mobil uzun mesaj ${Date.now()} ${"test ".repeat(240)}`;
  await composer.fill(longMessage);
  const composerBox = await composer.boundingBox();
  expect(composerBox?.height ?? 0).toBeLessThanOrEqual(180);
  const outgoing = page
    .locator("article.message.outgoing")
    .filter({ hasText: longMessage.slice(0, 60) });
  const previousCount = await outgoing.count();
  await page.getByRole("button", { name: "Mesajı gönder" }).click();
  await expect(outgoing).toHaveCount(previousCount + 1);
  await expectNoPageOverflow(page);
});

test("mobile file preview fits the viewport and restores focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/files");
  const filename = `mobile-preview-${Date.now()}.png`;
  const uploadResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/files/uploads"),
  );
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Dosya yükle" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: filename,
    mimeType: "image/png",
    buffer: Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
      0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84,
      120, 218, 99, 252, 255, 31, 0, 2, 235, 1, 245, 105, 118, 157, 116, 0, 0,
      0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]),
  });
  expect((await uploadResponse).status()).toBe(201);

  const row = page.getByRole("row", { name: new RegExp(filename) });
  await expect(row).toBeVisible();
  await row.getByLabel("Dosya işlemleri").click();
  const previewButton = page.getByRole("button", { name: "Önizle" });
  await previewButton.click();
  const dialog = page.getByRole("dialog", { name: filename });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img", { name: filename })).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox?.width ?? 0).toBeLessThanOrEqual(390.01);
  expect(dialogBox?.height ?? 0).toBeLessThanOrEqual(844.01);
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("hidden");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(previewButton).toBeFocused();
  await expectNoPageOverflow(page);
});

test("tablet inbox survives portrait and landscape orientation changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/app/inbox");
  await expect(page.locator(".conversation-column")).toBeVisible();
  await expect(page.locator(".chat-column")).toBeVisible();
  await expect(page.locator(".contact-panel")).toBeHidden();
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator(".conversation-column")).toBeVisible();
  await expect(page.locator(".chat-column")).toBeVisible();
  await expectNoPageOverflow(page);
});

test("automation editor switches between mobile steps and desktop canvas", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/automations/new");
  await expect(page.locator(".studio-mobile-flow")).toBeVisible();
  await expect(page.locator(".studio-canvas")).toBeHidden();
  await page.locator(".studio-mobile-step-copy").first().click();
  await expect(page.locator(".inspector-panel.mobile-open")).toBeVisible();
  await page.locator(".studio-mobile-close").click();

  const stepCount = await page.locator(".studio-mobile-flow article").count();
  await page.getByRole("button", { name: "Adım ekle" }).click();
  const palette = page.locator(".palette-panel.mobile-open");
  await expect(palette).toBeVisible();
  await palette.locator(".palette-item:not([disabled])").last().click();
  await expect(page.locator(".studio-mobile-flow article")).toHaveCount(
    stepCount + 1,
  );
  await expect(page.locator(".inspector-panel.mobile-open")).toBeVisible();
  await page.locator(".studio-mobile-close").click();

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator(".studio-canvas")).toBeVisible();
  await expect(page.locator(".studio-mobile-flow")).toBeHidden();
  await expectNoPageOverflow(page);
});

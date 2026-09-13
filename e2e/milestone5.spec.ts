import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { localApiUrl } from "./local-environment";
import { demoUsers, InboxPage } from "./pages/inbox-page";

async function login(page: import("@playwright/test").Page) {
  await new InboxPage(page).login(demoUsers.owner);
}

test("global search opens the matching conversation", async ({ page }) => {
  await login(page);
  await page.goto("/app/automations");
  await page.getByRole("button", { name: /Global arama/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "Brixchat24 içinde ara",
  });
  await dialog.getByRole("textbox", { name: "Arama metni" }).fill("Elena");
  await expect(dialog.getByText("Elena Petrova").first()).toBeVisible();
  await dialog.getByText("Elena Petrova").first().click();
  await expect(page).toHaveURL(/\/app\/inbox\?conversationId=/);
});

test("automation draft can be created and published", async ({ page }) => {
  await login(page);
  await page.goto("/app/automations/new");
  const name = `E2E automation ${Date.now()}`;
  await page
    .getByRole("textbox", { name: "Otomasyon adı", exact: true })
    .fill(name);
  await page
    .locator(".flow-node")
    .filter({ hasText: "Mesaj içeriğini analiz et" })
    .click();
  await page.getByLabel("Değer").fill("implant");
  await page
    .locator(".flow-node")
    .filter({ hasText: "Temsilciye ata" })
    .click();
  await page
    .getByLabel("Atanacak temsilci")
    .selectOption({ label: "Ece Kaya" });
  await page.getByRole("button", { name: "Taslağı kaydet" }).click();
  await expect(page.locator(".save-state")).toContainText("Taslak kaydedildi");
  await page.getByRole("button", { name: "Yayınla" }).click();
  await expect(page.getByText("Akış yayınlandı.")).toBeVisible();
  await expect(page.locator(".studio-status")).toHaveText("Aktif");
});

test("fake Open Channels registers with both-mode conflict policy", async ({
  page,
}) => {
  await login(page);
  await page.goto("/app/integrations/bitrix24/open-channels");
  await expect(
    page.getByRole("heading", { name: "Bitrix24 Open Channels" }),
  ).toBeVisible();
  const exclusions = page.getByRole("region", {
    name: "CRM dışında tutulan numaralar",
  });
  await expect(exclusions).toBeVisible();
  await expect(
    exclusions.getByRole("textbox", { name: "Çalışan telefon numarası" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    exclusions.getByRole("button", { name: "Numara ekle" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Yönet" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Bitrix24 Demo" });
  await drawer.getByLabel("Çalışma modu").selectOption("both");
  await drawer.getByRole("button", { name: "Ayarları kaydet" }).click();
  await expect(
    drawer.getByRole("status").filter({
      hasText: "Open Channels ve otomatik CRM ayarları kaydedildi.",
    }),
  ).toBeVisible();
  await drawer.getByRole("button", { name: "Connector kaydet" }).click();
  await expect(
    drawer
      .getByRole("status")
      .filter({ hasText: "Bitrix24 connector kaydedildi." }),
  ).toBeVisible();
});

test("premium Inbox filters remain dark and readable", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("brixchat_app_theme", "dark");
  });
  await login(page);
  await page.getByRole("button", { name: /Konuşmaları filtrele/ }).click();
  const filterDialog = page.getByRole("dialog", {
    name: "Konuşma filtreleri",
  });
  await expect(filterDialog).toBeVisible();
  const surface = await filterDialog.evaluate((element) => {
    const style = getComputedStyle(element);
    const heading = element.querySelector("strong");
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      color: style.color,
      headingColor: heading ? getComputedStyle(heading).color : "",
    };
  });
  expect(surface.backgroundColor).not.toBe("rgb(255, 255, 255)");
  expect(surface.backgroundImage).toContain("gradient");
  expect(surface.color).toBe("rgb(234, 241, 251)");
  expect(surface.headingColor).toBe("rgb(247, 249, 253)");
});

test("authenticated theme follows the system and persists the user choice", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);

  await expect(page.locator("html")).toHaveAttribute("data-app-theme", "dark");
  const lightThemeButton = page.getByRole("button", {
    name: "Gündüz temasına geç",
  });
  await expect(lightThemeButton).toBeVisible();
  await lightThemeButton.click();

  await expect(page.locator("html")).toHaveAttribute("data-app-theme", "light");
  await expect(
    page.getByRole("button", { name: "Gece temasına geç" }),
  ).toBeVisible();

  const lightSurfaces = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell-premium");
    const sidebar = document.querySelector(".premium-sidebar");
    const topbar = document.querySelector(".premium-topbar");
    return {
      shellScheme: shell ? getComputedStyle(shell).colorScheme : "",
      sidebarBackground: sidebar
        ? getComputedStyle(sidebar).backgroundImage
        : "",
      topbarBackground: topbar ? getComputedStyle(topbar).backgroundColor : "",
    };
  });
  expect(lightSurfaces.shellScheme).toBe("light");
  expect(lightSurfaces.sidebarBackground).toContain("gradient");
  expect(lightSurfaces.topbarBackground).not.toBe("rgba(8, 13, 25, 0.8)");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-app-theme", "light");
  await expect(
    page.getByRole("button", { name: "Gece temasına geç" }),
  ).toBeVisible();
});

test("incoming and outgoing media use private attachment pipeline", async ({
  page,
  request,
}) => {
  await login(page);
  await page.getByText("Elena Petrova").first().click();
  const timestamp = Math.floor(Date.now() / 1000).toString(),
    filename = `e2e-${Date.now()}.png`;
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "e2e",
        changes: [
          {
            field: "messages",
            value: {
              contacts: [
                { wa_id: "447700900123", profile: { name: "Elena Petrova" } },
              ],
              messages: [
                {
                  from: "447700900123",
                  id: `media-${Date.now()}`,
                  timestamp,
                  type: "image",
                  image: {
                    id: `fake-image-${Date.now()}`,
                    mime_type: "image/png",
                    filename,
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload),
    signature = `sha256=${createHmac("sha256", "local-app-secret").update(raw).digest("hex")}`;
  const webhook = await request.post(
    `${localApiUrl}/webhooks/meta/whatsapp/00000000-0000-4000-8000-000000000022`,
    {
      data: raw,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
    },
  );
  expect(webhook.ok()).toBeTruthy();
  await expect(async () => {
    await page.reload();
    await page.getByText("Elena Petrova").first().click();
    await expect(
      page.getByRole("button", {
        name: `${filename} dosyasını indir`,
        exact: true,
      }),
    ).toBeEnabled();
  }).toPass({ timeout: 15000 });
  const uploadName = `outgoing-${Date.now()}.png`;
  await page.locator('input[type="file"]').setInputFiles({
    name: uploadName,
    mimeType: "image/png",
    buffer: Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
    ]),
  });
  await page
    .getByRole("button", { name: /Yalnızca WhatsApp ile gönder/ })
    .click();
  await expect(
    page.getByRole("button", {
      name: `${uploadName} dosyasını indir`,
      exact: true,
    }),
  ).toBeEnabled({ timeout: 10000 });
});

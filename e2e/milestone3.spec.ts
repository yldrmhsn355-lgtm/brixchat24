import { expect, test } from "@playwright/test";
import { demoUsers, InboxPage } from "./pages/inbox-page";

test("authentication onboarding and fake channel setup", async ({ page }) => {
  const id = Date.now();
  const email = `e2e-${id}@example.test`;
  await page.goto("/register");
  await page.getByLabel("Ad", { exact: true }).fill("E2E");
  await page.getByLabel("Soyad", { exact: true }).fill("Owner");
  await page.getByLabel("E-posta").fill(email);
  await page.getByLabel("Parola").fill("StrongPassword!2026");
  await page.getByRole("button", { name: "Hesap oluştur" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel("Organizasyon adı").fill(`E2E Workspace ${id}`);
  await page.getByLabel("Workspace adresi").fill(`e2e-${id}`);
  await page.getByRole("button", { name: "Inbox’a geç" }).click();
  await expect(page).toHaveURL(/\/app\/inbox/);
  await page.goto("/app/channels");
  await page.getByRole("button", { name: "Kanal ekle" }).click();
  await page.getByLabel("Kanal adı").fill("E2E Fake Channel");
  await page.getByLabel("İç isim").fill(`e2e_fake_${id}`);
  await page.getByLabel("Kanal türü").selectOption("fake_test");
  await page.getByLabel("Telefon", { exact: true }).fill("+905551234567");
  await page.getByRole("button", { name: "Oluştur" }).click();
  const card = page
    .locator("article.channel-card")
    .filter({ hasText: "E2E Fake Channel" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Kanalı düzenle" }).click();
  await page.getByLabel("Kanal adı").fill("E2E Updated Channel");
  await page.getByRole("button", { name: "Kaydet" }).click();
  const updatedCard = page
    .locator("article.channel-card")
    .filter({ hasText: "E2E Updated Channel" });
  await expect(updatedCard).toBeVisible();
  await updatedCard.getByRole("button", { name: "Health testi" }).click();
  await expect(page.getByText("Health sonucu: healthy")).toBeVisible();
  await updatedCard
    .getByRole("button", { name: "E2E Updated Channel kanalını sil" })
    .click();
  await page.getByRole("button", { name: "Kanalı sil" }).click();
  await expect(updatedCard).not.toBeVisible();
  await page.getByRole("button", { name: "Çıkış yap" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("E-posta").fill(email);
  await page.getByLabel("Parola", { exact: true }).fill("StrongPassword!2026");
  await page.getByRole("button", { name: /Giriş yap/ }).click();
  await expect(page).toHaveURL(/\/app\/inbox/);
});

test("template delivery outside the window and composer quick reply", async ({
  page,
}) => {
  const id = Date.now();
  const shortcut = `e2e_${id}`;
  await new InboxPage(page).login(demoUsers.owner);
  await page.goto("/app/templates");
  await page
    .getByLabel("WABA / kanal")
    .selectOption("00000000-0000-4000-8000-000000000021");
  await page.getByRole("button", { name: "Meta'dan senkronize et" }).click();
  await expect(page.getByText(/Senkronizasyon tamamlandı:/)).toBeVisible();
  await expect(page.getByText("welcome_patient")).toBeVisible();
  await page.goto("/app/inbox");
  await page.getByText("Mert Yılmaz").first().click();
  await expect(
    page.getByPlaceholder("24 saatlik pencere kapalı — şablon seçin"),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Mesaj araçlarını aç" }).click();
  await page.getByRole("menuitem", { name: "Şablon mesaj" }).click();
  await page.getByRole("button", { name: /welcome_patient/ }).click();
  await page.getByLabel("body.1").fill("Mert");
  await page.getByLabel("body.2").fill("July 24");
  const templateMessages = page
    .locator("article.message.outgoing")
    .filter({ hasText: "Hello Mert" });
  const previousTemplateCount = await templateMessages.count();
  await page.getByRole("button", { name: "Template gönder" }).click();
  await expect(templateMessages).toHaveCount(previousTemplateCount + 1, {
    timeout: 15_000,
  });
  await page.goto("/app/quick-replies");
  await page.getByRole("button", { name: "Hazır cevap" }).click();
  await page.getByLabel("Başlık").fill(`E2E greeting ${id}`);
  await page.getByLabel("Kısayol").fill(shortcut);
  await page.getByLabel("İçerik").fill("Merhaba {{contact.first_name}}");
  await page.getByRole("button", { name: "Oluştur" }).click();
  await page.goto("/app/inbox");
  await page.getByText("Elena Petrova").first().click();
  const composer = page.getByPlaceholder("Bir mesaj yazın…");
  await composer.fill(`/${shortcut}`);
  await page
    .locator(".quick-menu button")
    .filter({ hasText: `/${shortcut}` })
    .click();
  await expect(composer).toHaveValue("Merhaba Elena");
});

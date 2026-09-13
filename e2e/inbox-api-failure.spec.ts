import { expect, test } from "@playwright/test";
import { demoUsers, InboxPage } from "./pages/inbox-page";

test("an API failure keeps the outbound message visible and retryable", async ({
  page,
}) => {
  const inbox = new InboxPage(page);
  await inbox.login(demoUsers.owner);
  await page.route(/\/api\/v1\/conversations\/[^/]+\/messages$/, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "Provider unavailable",
        },
      }),
    }),
  );

  await inbox.conversation("Elena Petrova").click();
  const text = `E2E failed outbound ${Date.now()}`;
  await page.getByPlaceholder("Bir mesaj yazın…").fill(text);
  await page.getByRole("button", { name: "Gönder" }).click();

  const failed = page
    .locator("article.message.outgoing.failed")
    .filter({ hasText: text });
  await expect(failed).toBeVisible();
  await expect(
    failed.getByRole("button", { name: "Tekrar dene" }),
  ).toBeEnabled();
  await expect(page.getByPlaceholder("Bir mesaj yazın…")).toHaveValue("");
});

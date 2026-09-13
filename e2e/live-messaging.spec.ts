import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { localApiUrl } from "./local-environment";
import { demoUsers, InboxPage } from "./pages/inbox-page";

test("login, send, provider status and signed incoming webhook update the inbox", async ({
  page,
  request,
}) => {
  await new InboxPage(page).login(demoUsers.owner);
  await expect(page.getByText("Elena Petrova").first()).toBeVisible();
  await page.getByText("Elena Petrova").first().click();

  const outgoingText = `E2E outgoing ${Date.now()}`;
  const composer = page.getByPlaceholder("Bir mesaj yazın…");
  await composer.fill(outgoingText);
  await page.getByRole("button", { name: "Gönder" }).click();
  const outgoing = page
    .locator("article.message.outgoing")
    .filter({ hasText: outgoingText });
  await expect(outgoing).toBeVisible();
  await expect(outgoing).toHaveClass(/sent/, { timeout: 10_000 });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const incomingText = `E2E incoming ${Date.now()}`;
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "e2e-business",
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
                  id: `e2e-in-${Date.now()}`,
                  timestamp,
                  type: "text",
                  text: { body: incomingText },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", "local-app-secret").update(raw).digest("hex")}`;
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
  await expect(
    page.locator("article.message.incoming").filter({ hasText: incomingText }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Connected")).toBeVisible();
});

import { expect, test } from "@playwright/test";
import { demoUsers, InboxPage } from "./pages/inbox-page";

const channelId = "00000000-0000-4000-8000-000000000021";

test("switching the WhatsApp channel keeps the current conversation mounted until the matching list arrives", async ({
  page,
}) => {
  const inbox = new InboxPage(page);
  await inbox.login(demoUsers.owner);
  await inbox.conversation("Elena Petrova").click();
  await expect(inbox.selectedContact("Elena Petrova")).toBeVisible();

  let releaseChannelRequest: (() => void) | undefined;
  const channelRequestGate = new Promise<void>((resolve) => {
    releaseChannelRequest = resolve;
  });
  await page.route("**/api/v1/conversations?*", async (route) => {
    const requestChannelId = new URL(route.request().url()).searchParams.get(
      "channelId",
    );
    if (requestChannelId === channelId) await channelRequestGate;
    await route.continue();
  });

  await page.getByLabel("WhatsApp hesabı").selectOption({ value: channelId });

  await expect(page.locator(".channel-switch-overlay")).toBeVisible();
  await expect(inbox.selectedContact("Elena Petrova")).toBeVisible();
  await expect(page.getByText("Bir konuşma seçin.")).toBeHidden();

  releaseChannelRequest?.();

  await expect(page.locator(".channel-switch-overlay")).toBeHidden();
  await expect(inbox.selectedContact("Elena Petrova")).toBeVisible();
});

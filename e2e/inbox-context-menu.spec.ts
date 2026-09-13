import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { demoUsers, InboxPage } from "./pages/inbox-page";
import { localDatabaseUrl } from "./local-environment";

const conversationName = "Elena Petrova";
const elenaConversationId = "10000000-0000-4000-8000-000000000001";

async function openConversationMenu(page: Page) {
  const row = page
    .locator("button.conversation-row")
    .filter({ hasText: conversationName })
    .first();
  await expect(row).toBeVisible();
  await row.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function clickOperation(
  page: Page,
  name: RegExp,
  endpoint: RegExp,
  method: "PATCH" | "POST",
) {
  const menu = await openConversationMenu(page);
  const responsePromise = page.waitForResponse(
    (response) =>
      endpoint.test(response.url()) && response.request().method() === method,
  );
  await menu.getByRole("menuitem", { name }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  await expect(menu).toBeHidden();
}

test("conversation context menu actions reach their API endpoints", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("E-posta").fill("owner@brixchat.local");
  await page.getByLabel("Parola", { exact: true }).fill("BrixChatDemo!2026");
  await page.getByRole("button", { name: /Giri/ }).click({ noWaitAfter: true });
  await expect(page).toHaveURL(/\/app\/inbox/);

  await clickOperation(
    page,
    /sabitle/i,
    /\/api\/v1\/conversations\/[^/]+\/operations$/,
    "PATCH",
  );
  await clickOperation(
    page,
    /sabitle/i,
    /\/api\/v1\/conversations\/[^/]+\/operations$/,
    "PATCH",
  );

  await clickOperation(
    page,
    /Okundu olarak|Okunmad.* olarak/,
    /\/api\/v1\/conversations\/[^/]+\/(?:read|unread)$/,
    "POST",
  );
  await clickOperation(
    page,
    /Okundu olarak|Okunmad.* olarak/,
    /\/api\/v1\/conversations\/[^/]+\/(?:read|unread)$/,
    "POST",
  );

  await clickOperation(
    page,
    /sessiz/i,
    /\/api\/v1\/conversations\/[^/]+\/operations$/,
    "PATCH",
  );
  await clickOperation(
    page,
    /sessiz/i,
    /\/api\/v1\/conversations\/[^/]+\/operations$/,
    "PATCH",
  );

  await clickOperation(
    page,
    /Ar.ivle$/,
    /\/api\/v1\/conversations\/[^/]+\/operations$/,
    "PATCH",
  );

  await page
    .locator(".filter-column")
    .getByRole("button", { name: /Arşiv/ })
    .click();
  await clickOperation(
    page,
    /Ar.ivden ..kar$/,
    /\/api\/v1\/conversations\/[^/]+\/operations$/,
    "PATCH",
  );
});

test("keyboard users can skip navigation and operate the conversation menu", async ({
  page,
}) => {
  await new InboxPage(page).login(demoUsers.owner);

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Ana içeriğe geç" });
  await expect(skipLink).toBeFocused();
  await skipLink.press("Enter");
  await expect(page.locator("#inbox-main")).toBeFocused();

  const row = page
    .locator("button.conversation-row")
    .filter({ hasText: conversationName })
    .first();
  await row.focus();
  await row.press("Shift+F10");

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(row).toBeFocused();
});

test("context menu resolves stale archived duplicates without blanking the inbox", async ({
  page,
}) => {
  const inbox = new InboxPage(page);
  await inbox.login(demoUsers.owner);
  const sql = postgres(localDatabaseUrl);
  let staleArchivedId = "";

  try {
    const staleArchived = await sql<Array<{ id: string }>>`
      INSERT INTO conversations(
        organization_id,
        channel_id,
        contact_id,
        status
      )
      SELECT
        organization_id,
        channel_id,
        contact_id,
        'archived'::conversation_status
      FROM conversations
      WHERE id=${elenaConversationId}::uuid
      RETURNING id`;
    staleArchivedId = staleArchived[0]!.id;

    await clickOperation(
      page,
      /Ar.ivle$/,
      /\/api\/v1\/conversations\/[^/]+\/operations$/,
      "PATCH",
    );
    await expect(page.locator(".inbox-state.error")).toHaveCount(0);
    await expect(page.locator(".conversation-operation-error")).toHaveCount(0);
    await expect(inbox.conversation(conversationName)).toBeHidden();

    await page
      .locator(".filter-column")
      .getByRole("button", { name: /^Ar/i })
      .click();
    await expect(inbox.conversation(conversationName)).toBeVisible();
    await clickOperation(
      page,
      /Ar.ivden ..kar$/,
      /\/api\/v1\/conversations\/[^/]+\/operations$/,
      "PATCH",
    );
    await expect(page.locator(".inbox-state.error")).toHaveCount(0);
    await expect(page.locator(".conversation-operation-error")).toHaveCount(0);
    await expect(inbox.conversation(conversationName)).toBeHidden();
  } finally {
    if (staleArchivedId)
      await sql`
        DELETE FROM conversations
        WHERE id=${staleArchivedId}::uuid`;
    await sql`
      UPDATE conversations
      SET status='open',updated_at=now()
      WHERE id=${elenaConversationId}::uuid`;
    await sql.end();
  }
});

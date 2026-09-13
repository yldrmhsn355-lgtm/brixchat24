import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import { localApiUrl } from "./local-environment";
import { demoUsers, InboxPage } from "./pages/inbox-page";

const apiBaseUrl = localApiUrl;
const ownerId = "00000000-0000-4000-8000-000000000011";
const channelId = "00000000-0000-4000-8000-000000000021";
const elenaConversationId = "10000000-0000-4000-8000-000000000001";
const mertConversationId = "10000000-0000-4000-8000-000000000002";

async function expectOk(response: APIResponse) {
  expect(
    response.ok(),
    `${response.url()} returned ${response.status()}`,
  ).toBeTruthy();
}

async function ownerToken(request: APIRequestContext) {
  const response = await request.post(`${apiBaseUrl}/api/v1/auth/login`, {
    data: demoUsers.owner,
  });
  await expectOk(response);
  const body = (await response.json()) as {
    data: { accessToken: string };
  };
  return body.data.accessToken;
}

async function resetInbox(request: APIRequestContext) {
  const token = await ownerToken(request);
  const headers = { authorization: `Bearer ${token}` };
  await expectOk(
    await request.post(
      `${apiBaseUrl}/api/v1/conversations/${elenaConversationId}/assign`,
      {
        headers,
        data: { userId: ownerId, reason: "e2e reset", origin: "manual" },
      },
    ),
  );
  await expectOk(
    await request.delete(
      `${apiBaseUrl}/api/v1/conversations/${mertConversationId}/assign`,
      { headers },
    ),
  );
  for (const conversationId of [elenaConversationId, mertConversationId]) {
    await expectOk(
      await request.patch(
        `${apiBaseUrl}/api/v1/conversations/${conversationId}/operations`,
        { headers, data: { status: "open" } },
      ),
    );
  }
  return headers;
}

test.describe("Inbox assignment workflow", () => {
  test("owner filters, reassigns and archives without a stale chat selection", async ({
    page,
    request,
  }) => {
    const headers = await resetInbox(request);
    const countsResponse = await request.get(
      `${apiBaseUrl}/api/v1/inbox/counts?channelId=${channelId}`,
      { headers },
    );
    await expectOk(countsResponse);
    const initialCounts = (await countsResponse.json()) as {
      data: {
        all: number;
        assignedToMe: number;
        unassigned: number;
        archived: number;
      };
    };
    expect(initialCounts.data).toMatchObject({
      assignedToMe: 1,
      archived: 0,
    });
    expect(initialCounts.data.all).toBeGreaterThanOrEqual(2);
    expect(initialCounts.data.unassigned).toBeGreaterThanOrEqual(1);

    const inbox = new InboxPage(page);
    await inbox.login(demoUsers.owner);
    await inbox.expectFilterCount("Tüm konuşmalar", initialCounts.data.all);
    await inbox.expectFilterCount("Bana atanmış", 1);
    await inbox.expectFilterCount("Atanmamış", initialCounts.data.unassigned);

    await inbox.selectFilter("Bana atanmış");
    await expect(inbox.conversation("Elena Petrova")).toBeVisible();
    await expect(inbox.selectedContact("Elena Petrova")).toBeVisible();

    await inbox.selectFilter("Atanmamış");
    await expect(inbox.conversation("Mert Yılmaz")).toBeVisible();
    await inbox.conversation("Mert Yılmaz").click();
    await expect(inbox.selectedContact("Mert Yılmaz")).toBeVisible();

    await inbox.assignTo({ label: "Deniz Aksoy" });
    await expect(inbox.conversation("Mert Yılmaz")).toBeHidden();
    await inbox.expectFilterCount(
      "Atanmamış",
      initialCounts.data.unassigned - 1,
    );
    await inbox.expectFilterCount("Bana atanmış", 2);

    await inbox.selectFilter("Bana atanmış");
    await inbox.conversation("Mert Yılmaz").click();
    await inbox.assignTo({ value: "" });
    await expect(inbox.conversation("Mert Yılmaz")).toBeHidden();
    await expect(inbox.selectedContact("Elena Petrova")).toBeVisible();

    await inbox.archiveSelected();
    await expect(inbox.conversation("Elena Petrova")).toBeHidden();
    await inbox.expectFilterCount("Arşiv", 1);
    await inbox.selectFilter("Arşiv");
    await expect(inbox.selectedContact("Elena Petrova")).toBeVisible();
    await inbox.unarchiveSelected();
    await expect(inbox.conversation("Elena Petrova")).toBeHidden();
    await inbox.expectFilterCount("Arşiv", 0);
    await inbox.expectFilterCount("Tüm konuşmalar", initialCounts.data.all);
  });

  test("agent without channel ownership sees an actionable access warning", async ({
    page,
  }) => {
    const inbox = new InboxPage(page);
    await inbox.login(demoUsers.agent);
    await expect(
      page.getByRole("status").filter({
        hasText: "WhatsApp kanal yetkisi gerekli",
      }),
    ).toContainText("Yöneticinizden kanal erişimi istemelisiniz.");
    await expect(page.getByLabel("Sohbet sorumlusu")).toHaveCount(0);
  });

  test("mobile inbox moves between the conversation list and chat without overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const inbox = new InboxPage(page);
    await inbox.login(demoUsers.owner);

    const conversationColumn = page.locator(".conversation-column");
    const chatColumn = page.locator(".chat-column");
    await expect(conversationColumn).toBeInViewport();
    await expect(chatColumn).not.toBeInViewport();

    await inbox.conversation("Elena Petrova").click();
    await expect(chatColumn).toBeInViewport();
    await expect(conversationColumn).not.toBeInViewport();
    await expect(
      page.getByRole("button", { name: "Konuşma listesine dön" }),
    ).toBeVisible();

    const hasHorizontalOverflow = await page
      .locator("html")
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(hasHorizontalOverflow).toBe(false);

    await page.getByRole("button", { name: "Konuşma listesine dön" }).click();
    await expect(conversationColumn).toBeInViewport();
    await expect(chatColumn).not.toBeInViewport();
  });
});

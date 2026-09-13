import { expect, type Page } from "@playwright/test";

export const demoUsers = {
  owner: {
    email: "owner@brixchat.local",
    password: "BrixChatDemo!2026",
  },
  agent: {
    email: "ece@brixchat.local",
    password: "BrixChatDemo!2026",
  },
} as const;

export class InboxPage {
  constructor(private readonly page: Page) {}

  async login(user: (typeof demoUsers)[keyof typeof demoUsers]) {
    await expect(async () => {
      await this.page.goto("/login", { waitUntil: "load" });
    }).toPass({ timeout: 15_000, intervals: [250, 500, 1_000] });
    await this.page.getByLabel("E-posta").fill(user.email);
    await this.page.getByLabel("Parola", { exact: true }).fill(user.password);
    await this.page.getByRole("button", { name: /Giriş yap/ }).click();
    await expect(this.page).toHaveURL(/\/app\/inbox/);
  }

  filter(name: string) {
    return this.page
      .locator(".filter-column")
      .getByRole("button", { name: new RegExp(name, "i") });
  }

  conversation(name: string) {
    return this.page
      .locator(".conversation-column")
      .getByRole("button", { name: new RegExp(name, "i") });
  }

  selectedContact(name: string) {
    return this.page.getByRole("button", {
      name: new RegExp(`${name} kişi bilgilerini aç`, "i"),
    });
  }

  async selectFilter(name: string) {
    await this.filter(name).click();
  }

  async expectFilterCount(name: string, count: number) {
    await expect(this.filter(name)).toContainText(String(count));
  }

  async assignTo(option: { label?: string; value?: string }) {
    await this.page.getByLabel("Sohbet sorumlusu").selectOption(option);
  }

  async archiveSelected() {
    const operation = this.waitForConversationOperation();
    await this.page.locator(".chat-more-actions > summary").click();
    await this.page.getByRole("menuitem", { name: "Arşivle" }).click();
    await this.expectOperationSucceeded(operation);
  }

  async unarchiveSelected() {
    const operation = this.waitForConversationOperation();
    await this.page.locator(".chat-more-actions > summary").click();
    await this.page.getByRole("menuitem", { name: "Arşivden çıkar" }).click();
    await this.expectOperationSucceeded(operation);
  }

  private waitForConversationOperation() {
    return this.page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "PATCH" &&
        /\/api\/v1\/conversations\/[^/]+\/operations$/.test(url.pathname)
      );
    });
  }

  private async expectOperationSucceeded(
    operation: ReturnType<Page["waitForResponse"]>,
  ) {
    const response = await operation;
    expect(
      response.ok(),
      `${response.request().method()} ${response.url()} returned ${response.status()}`,
    ).toBeTruthy();
  }
}

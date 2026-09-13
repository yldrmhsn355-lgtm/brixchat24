import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { localComposeEnvironment } from "./local-environment";
import { demoUsers, InboxPage } from "./pages/inbox-page";

test("help navigation works and workspace switching isolates inbox state", async ({
  page,
}) => {
  const sql = postgres(
    `postgresql://brixchat:brixchat@127.0.0.1:${localComposeEnvironment.POSTGRES_PORT}/brixchat`,
    { max: 1 },
  );
  const workspaceName = `E2E Workspace ${Date.now()}`;
  const slug = `e2e-workspace-${crypto.randomUUID().slice(0, 8)}`;
  let targetOrganizationId: string | undefined;

  try {
    // A force-stopped test process cannot run its finally block. Remove only
    // test-owned workspace fixtures so this acceptance starts deterministically.
    await sql`
      DELETE FROM organizations
      WHERE slug LIKE 'e2e-workspace-%'
         OR slug LIKE 'workspace-switch-%'`;

    await new InboxPage(page).login(demoUsers.owner);

    await expect(page.locator(".workspace-switch-static")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Workspace değiştir, mevcut:/ }),
    ).toHaveCount(0);

    await page.locator('a[href="/app/help"]').first().click();
    await expect(page).toHaveURL(/\/app\/help$/);
    await expect(page.locator(".help-grid")).toBeVisible();
    await expect(page.locator('a[href="/app/inbox"]').first()).toBeVisible();

    const users = await sql<Array<{ id: string }>>`
      SELECT id FROM users WHERE email=${demoUsers.owner.email}`;
    const organizations = await sql<Array<{ id: string }>>`
      INSERT INTO organizations(name,slug)
      VALUES(${workspaceName},${slug}) RETURNING id`;
    targetOrganizationId = organizations[0]!.id;
    await sql`
      INSERT INTO organization_members(organization_id,user_id,role)
      VALUES(${targetOrganizationId}::uuid,${users[0]!.id}::uuid,'viewer')`;

    await page.goto("/app/inbox");
    const workspaceTrigger = page.getByRole("button", {
      name: /Workspace değiştir, mevcut:/,
    });
    await expect(workspaceTrigger).toBeVisible();

    await page.evaluate(() => {
      localStorage.setItem(
        "selected_whatsapp_channel_id",
        "old-workspace-channel",
      );
      localStorage.setItem(
        "brixchat_inbox_drafts_v1",
        JSON.stringify({ "old-workspace-conversation": "private draft" }),
      );
    });

    await workspaceTrigger.click();
    await page
      .getByRole("menuitemradio", { name: new RegExp(workspaceName) })
      .click();

    await expect(page).toHaveURL(/\/app\/inbox\??$/);
    await expect(
      page.getByRole("button", {
        name: new RegExp(`Workspace değiştir, mevcut: ${workspaceName}`),
      }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          channel: localStorage.getItem("selected_whatsapp_channel_id"),
          drafts: localStorage.getItem("brixchat_inbox_drafts_v1"),
        })),
      )
      .toEqual({ channel: "all", drafts: "{}" });
  } finally {
    if (targetOrganizationId) {
      await sql`DELETE FROM organizations WHERE id=${targetOrganizationId}::uuid`;
    }
    await sql.end();
  }
});

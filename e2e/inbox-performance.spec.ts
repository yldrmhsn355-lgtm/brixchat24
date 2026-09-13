import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { localComposeEnvironment } from "./local-environment";
import { demoUsers, InboxPage } from "./pages/inbox-page";

const organizationId = "00000000-0000-4000-8000-000000000001";
const channelId = "00000000-0000-4000-8000-000000000021";
const marker = "E2E Perf";

test("300 additional conversations remain paginated and searchable", async ({
  page,
}) => {
  const sql = postgres(
    `postgresql://brixchat:brixchat@127.0.0.1:${localComposeEnvironment.POSTGRES_PORT}/brixchat`,
    { max: 1 },
  );
  const cleanup = () => sql.begin(async (tx) => {
    await tx`
      DELETE FROM conversations
      WHERE organization_id=${organizationId}::uuid
        AND contact_id IN (
          SELECT id FROM contacts
          WHERE organization_id=${organizationId}::uuid
            AND display_name LIKE ${`${marker} %`}
        )`;
    await tx`
      DELETE FROM contacts
      WHERE organization_id=${organizationId}::uuid
        AND display_name LIKE ${`${marker} %`}`;
  });

  try {
    await cleanup();
    await sql`
      WITH inserted_contacts AS (
        INSERT INTO contacts(
          organization_id,
          first_name,
          display_name,
          normalized_phone,
          language,
          country
        )
        SELECT
          ${organizationId}::uuid,
          ${marker},
          ${marker} || ' ' || series::text,
          '+999' || lpad(series::text, 9, '0'),
          'tr',
          'TR'
        FROM generate_series(1,300) series
        RETURNING id,display_name
      )
      INSERT INTO conversations(
        organization_id,
        contact_id,
        channel_id,
        status,
        priority,
        stage,
        unread_count,
        last_message_at,
        customer_service_window_expires_at
      )
      SELECT
        ${organizationId}::uuid,
        id,
        ${channelId}::uuid,
        'open',
        'normal',
        'Yeni Lead',
        0,
        now() - (substring(display_name from '[0-9]+$')::int * interval '1 second'),
        now() + interval '20 hours'
      FROM inserted_contacts`;

    const startedAt = Date.now();
    await new InboxPage(page).login(demoUsers.owner);
    const rows = page.locator("button.conversation-row");
    await expect(rows).toHaveCount(50);
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    const searchStartedAt = Date.now();
    await page.getByPlaceholder("Konuşmalarda ara").fill(`${marker} 300`);
    await expect(
      page.locator("button.conversation-row").filter({
        hasText: `${marker} 300`,
      }),
    ).toHaveCount(1);
    expect(Date.now() - searchStartedAt).toBeLessThan(3_000);
  } finally {
    await cleanup();
    await sql.end();
  }
});

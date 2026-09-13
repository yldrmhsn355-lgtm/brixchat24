import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { WorkerRepository } from "@brixchat/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://brixchat:brixchat@localhost:5434/brixchat";
const organizationId = "00000000-0000-4000-8000-000000000001";
const conversationId = "10000000-0000-4000-8000-000000000001";
const channelId = "00000000-0000-4000-8000-000000000021";
const contactId = "00000000-0000-4000-8000-000000000031";
const senderId = "00000000-0000-4000-8000-000000000011";

describe("worker status reconciliation integration", () => {
  it("replays a status callback received before the provider id is persisted", async () => {
    const sql = postgres(databaseUrl);
    const providerMessageId = `wamid.${crypto.randomUUID()}`;
    const clientMessageId = crypto.randomUUID();
    const traceId = crypto.randomUUID();
    let messageId: string | null = null;
    let jobId: string | null = null;

    try {
      const messageRows = await sql<Array<{ id: string }>>`
        INSERT INTO messages(
          organization_id,
          conversation_id,
          channel_id,
          contact_id,
          client_message_id,
          direction,
          type,
          status,
          body,
          sender_id
        ) VALUES(
          ${organizationId}::uuid,
          ${conversationId}::uuid,
          ${channelId}::uuid,
          ${contactId}::uuid,
          ${clientMessageId}::uuid,
          'outbound',
          'text',
          'pending',
          'status-before-provider-id integration test',
          ${senderId}::uuid
        )
        RETURNING id`;
      messageId = messageRows[0]!.id;
      const jobRows = await sql<Array<{ id: string }>>`
        INSERT INTO outbox_jobs(
          organization_id,
          aggregate_type,
          aggregate_id,
          job_type,
          payload,
          status,
          locked_at,
          locked_by
        ) VALUES(
          ${organizationId}::uuid,
          'message',
          ${messageId}::uuid,
          'message.send',
          ${sql.json({ messageId, traceId })},
          'processing',
          now(),
          'integration-test'
        )
        RETURNING id`;
      jobId = jobRows[0]!.id;

      const repository = new WorkerRepository(sql);
      const buffered = await repository.status({
        organizationId,
        providerMessageId,
        status: "read",
        providerTimestamp: new Date(),
        eventKey: `status:${providerMessageId}:read`,
        payload: { id: providerMessageId, status: "read" },
      });
      expect(buffered).toMatchObject({ pending: true, messageId: null });

      const finalStatus = await repository.complete(
        {
          id: jobId,
          organizationId,
          messageId,
          attemptCount: 1,
          maxAttempts: 5,
          traceId,
          jobType: "message.send",
        },
        providerMessageId,
      );
      expect(finalStatus).toBe("read");

      const state = await sql<
        Array<{ status: string; pending_count: number; event_count: number }>
      >`
        SELECT
          m.status::text status,
          (
            SELECT count(*)::int
            FROM pending_message_status_events p
            WHERE p.organization_id=m.organization_id
              AND p.provider_message_id=${providerMessageId}
          ) pending_count,
          (
            SELECT count(*)::int
            FROM message_status_events e
            WHERE e.message_id=m.id
              AND e.status='read'
          ) event_count
        FROM messages m
        WHERE m.id=${messageId}::uuid`;
      expect(state[0]).toEqual({
        status: "read",
        pending_count: 0,
        event_count: 1,
      });
    } finally {
      if (jobId)
        await sql`DELETE FROM outbox_jobs WHERE id=${jobId}::uuid`;
      if (messageId)
        await sql`DELETE FROM messages WHERE id=${messageId}::uuid`;
      await sql`DELETE FROM pending_message_status_events WHERE organization_id=${organizationId}::uuid AND provider_message_id=${providerMessageId}`;
      await sql.end();
    }
  });
});

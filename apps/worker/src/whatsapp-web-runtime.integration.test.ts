import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { WorkerRepository } from "@brixchat/database";
import { WhatsAppWebRuntime } from "./whatsapp-web-runtime";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://brixchat:brixchat@localhost:5434/brixchat";
const organizationId = "00000000-0000-4000-8000-000000000001";
const channelId = "00000000-0000-4000-8000-000000000021";

describe("WhatsApp Web message mutations integration", () => {
  it("applies edits and out-of-order revokes without creating chat messages", async () => {
    const sql = postgres(databaseUrl);
    const repository = new WorkerRepository(sql);
    const publish = vi.fn(async () => 1);
    const runtime = new WhatsAppWebRuntime({
      sql,
      repository,
      encryptionKey: "integration-test-key",
      workerId: "mutation-test",
      publish,
      onInboundStored: vi.fn(),
    });
    const run = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const phone = `905557${run.slice(0, 6)}`;
    const editTarget = `wamid.edit-target.${run}`;
    const revokeTarget = `wamid.revoke-target.${run}`;
    const conversationIds: string[] = [];

    try {
      await runtime.recordIgnoredMessage(organizationId, channelId, {
        providerMessageId: `wamid.ignored.${run}`,
        rawType: "albumMessage",
        reason: "whatsapp_transport_message",
        fromMe: false,
        timestamp: new Date(),
      });
      await runtime.recordIgnoredMessage(organizationId, channelId, {
        providerMessageId: `wamid.ignored.${run}`,
        rawType: "albumMessage",
        reason: "whatsapp_transport_message",
        fromMe: false,
        timestamp: new Date(),
      });
      const ignored = await sql<Array<{ count: number }>>`
        SELECT count(*)::int count FROM whatsapp_web_ignored_messages
        WHERE channel_id=${channelId}::uuid
          AND provider_message_id=${`wamid.ignored.${run}`}`;
      expect(ignored[0]?.count).toBe(1);

      const original = await repository.incoming({
        organizationId,
        channelId,
        phone,
        name: "Mutation test",
        text: "Eski metin",
        type: "text",
        providerMessageId: editTarget,
        providerTimestamp: new Date(),
        metadata: { provider: "whatsapp_web" },
        provider: "whatsapp_web",
        traceId: crypto.randomUUID(),
      });
      conversationIds.push(original.conversationId);

      await runtime.applyMessageMutation(organizationId, channelId, {
        providerMessageId: `wamid.edit-event.${run}`,
        targetProviderMessageId: editTarget,
        action: "edit",
        type: "text",
        text: "Yeni metin",
        metadata: { protocolType: 14 },
        timestamp: new Date(),
      });

      await runtime.applyMessageMutation(organizationId, channelId, {
        providerMessageId: `wamid.revoke-event.${run}`,
        targetProviderMessageId: revokeTarget,
        action: "revoke",
        type: "unsupported",
        text: "",
        metadata: { protocolType: 0 },
        timestamp: new Date(),
      });
      const pending = await sql<Array<{ status: string }>>`
        SELECT status FROM whatsapp_web_message_mutations
        WHERE channel_id=${channelId}::uuid
          AND target_provider_message_id=${revokeTarget}`;
      expect(pending[0]?.status).toBe("pending");

      const laterOriginal = await repository.incoming({
        organizationId,
        channelId,
        phone,
        name: "Mutation test",
        text: "Silinecek metin",
        type: "text",
        providerMessageId: revokeTarget,
        providerTimestamp: new Date(),
        metadata: { provider: "whatsapp_web" },
        provider: "whatsapp_web",
        traceId: crypto.randomUUID(),
      });
      if (!conversationIds.includes(laterOriginal.conversationId))
        conversationIds.push(laterOriginal.conversationId);
      await runtime.reconcileMessageMutations(
        organizationId,
        channelId,
        revokeTarget,
      );
      await runtime.applyMessageMutation(organizationId, channelId, {
        providerMessageId: `wamid.stale-edit-event.${run}`,
        targetProviderMessageId: revokeTarget,
        action: "edit",
        type: "text",
        text: "Eski ve gecikmiş düzenleme",
        metadata: { protocolType: 14 },
        timestamp: new Date("2100-01-01T00:00:00.000Z"),
      });

      const rows = await sql<
        Array<{
          provider_message_id: string;
          body: string;
          type: string;
          metadata: Record<string, unknown>;
        }>
      >`
        SELECT provider_message_id,body,type,metadata FROM messages
        WHERE channel_id=${channelId}::uuid
          AND provider_message_id IN (${editTarget},${revokeTarget})
        ORDER BY provider_message_id`;
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider_message_id: editTarget,
            body: "Yeni metin",
            metadata: expect.objectContaining({ edited: true }),
          }),
          expect.objectContaining({
            provider_message_id: revokeTarget,
            body: "Bu mesaj silindi",
            type: "text",
            metadata: expect.objectContaining({ revoked: true }),
          }),
        ]),
      );
      const mutationCount = await sql<Array<{ count: number }>>`
        SELECT count(*)::int count FROM whatsapp_web_message_mutations
        WHERE channel_id=${channelId}::uuid
          AND event_provider_message_id IN (
            ${`wamid.edit-event.${run}`},${`wamid.revoke-event.${run}`}
          ) AND status='applied'`;
      expect(mutationCount[0]?.count).toBe(2);
      expect(publish).toHaveBeenCalledTimes(2);
      const stale = await sql<Array<{ status: string }>>`
        SELECT status FROM whatsapp_web_message_mutations
        WHERE channel_id=${channelId}::uuid
          AND event_provider_message_id=${`wamid.stale-edit-event.${run}`}`;
      expect(stale[0]?.status).toBe("ignored");
    } finally {
      await sql`DELETE FROM whatsapp_web_ignored_messages
        WHERE channel_id=${channelId}::uuid
          AND provider_message_id=${`wamid.ignored.${run}`}`;
      await sql`
        DELETE FROM whatsapp_web_message_mutations
        WHERE channel_id=${channelId}::uuid
          AND event_provider_message_id LIKE ${`%.${run}`}`;
      if (conversationIds.length)
        await sql`DELETE FROM conversations
          WHERE organization_id=${organizationId}::uuid
            AND id IN ${sql(conversationIds)}`;
      await sql`DELETE FROM contacts
        WHERE organization_id=${organizationId}::uuid
          AND normalized_phone=${phone}`;
      await sql.end();
    }
  });
});

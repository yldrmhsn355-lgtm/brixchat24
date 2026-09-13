import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { MessageRepository, WorkerRepository } from "@brixchat/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://brixchat:brixchat@localhost:5434/brixchat";
const organizationId = "00000000-0000-4000-8000-000000000001";
const channelId = "00000000-0000-4000-8000-000000000021";

describe("worker inbound WhatsApp message types integration", () => {
  it("reopens archived threads and preserves already split history", async () => {
    const sql = postgres(databaseUrl);
    const worker = new WorkerRepository(sql);
    const messages = new MessageRepository(sql);
    const run = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const phone = `905559${run.slice(0, 7)}`;
    let archivedConversationId = "";
    let activeConversationId = "";

    try {
      const contact = await sql<Array<{ id: string }>>`
        INSERT INTO contacts(
          organization_id,
          first_name,
          display_name,
          normalized_phone
        )
        VALUES(
          ${organizationId}::uuid,
          'History',
          'History continuity',
          ${phone}
        )
        RETURNING id`;
      const contactId = contact[0]!.id;
      const archived = await sql<Array<{ id: string }>>`
        INSERT INTO conversations(
          organization_id,
          channel_id,
          contact_id,
          status
        )
        VALUES(
          ${organizationId}::uuid,
          ${channelId}::uuid,
          ${contactId}::uuid,
          'archived'
        )
        RETURNING id`;
      archivedConversationId = archived[0]!.id;
      await sql`
        INSERT INTO messages(
          organization_id,
          conversation_id,
          channel_id,
          contact_id,
          direction,
          type,
          status,
          body,
          provider_message_id,
          provider_timestamp
        )
        VALUES(
          ${organizationId}::uuid,
          ${archivedConversationId}::uuid,
          ${channelId}::uuid,
          ${contactId}::uuid,
          'inbound',
          'text',
          'delivered',
          'Arşivdeki eski mesaj',
          ${`wamid.archived.${run}`},
          now()-interval '1 day'
        )`;

      const reopened = await worker.incoming({
        organizationId,
        channelId,
        phone,
        name: "History continuity",
        text: "Yeni gelen mesaj",
        type: "text",
        providerMessageId: `wamid.reopen.${run}`,
        providerTimestamp: new Date(),
        metadata: {},
        traceId: crypto.randomUUID(),
      });
      expect(reopened.conversationId).toBe(archivedConversationId);
      expect(reopened.conversationCreated).toBe(false);
      const reopenedState = await sql<
        Array<{ status: string; message_count: number }>
      >`
        SELECT c.status,count(m.id)::int message_count
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id=c.id
        WHERE c.id=${archivedConversationId}::uuid
        GROUP BY c.id`;
      expect(reopenedState[0]).toEqual({
        status: "open",
        message_count: 2,
      });

      await sql`
        UPDATE conversations
        SET status='archived'
        WHERE id=${archivedConversationId}::uuid`;
      const active = await sql<Array<{ id: string }>>`
        INSERT INTO conversations(
          organization_id,
          channel_id,
          contact_id,
          status
        )
        VALUES(
          ${organizationId}::uuid,
          ${channelId}::uuid,
          ${contactId}::uuid,
          'open'
        )
        RETURNING id`;
      activeConversationId = active[0]!.id;
      await sql`
        INSERT INTO messages(
          organization_id,
          conversation_id,
          channel_id,
          contact_id,
          direction,
          type,
          status,
          body,
          provider_message_id,
          provider_timestamp
        )
        VALUES(
          ${organizationId}::uuid,
          ${activeConversationId}::uuid,
          ${channelId}::uuid,
          ${contactId}::uuid,
          'inbound',
          'text',
          'delivered',
          'Bölünmüş yeni mesaj',
          ${`wamid.split.${run}`},
          now()+interval '1 second'
        )`;

      const continuous = await messages.list(
        organizationId,
        activeConversationId,
        undefined,
        100,
      );
      expect(continuous.data.map((message) => message.body)).toEqual([
        "Arşivdeki eski mesaj",
        "Yeni gelen mesaj",
        "Bölünmüş yeni mesaj",
      ]);
    } finally {
      const conversationIds = [
        archivedConversationId,
        activeConversationId,
      ].filter(Boolean);
      if (conversationIds.length)
        await sql`
          DELETE FROM conversations
          WHERE id IN ${sql(conversationIds)}
            AND organization_id=${organizationId}::uuid`;
      await sql`
        DELETE FROM contacts
        WHERE organization_id=${organizationId}::uuid
          AND normalized_phone=${phone}`;
      await sql.end();
    }
  });

  it("persists every supported Inbox message shape and only queues real media", async () => {
    const sql = postgres(databaseUrl);
    const repository = new WorkerRepository(sql);
    const run = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const createdConversationIds: string[] = [];
    const cases = [
      { type: "text", text: "Merhaba", metadata: {}, attachment: false },
      {
        type: "image",
        text: "FotoÄŸraf",
        metadata: { id: `image-${run}`, mime_type: "image/jpeg" },
        attachment: true,
      },
      {
        type: "video",
        text: "Video",
        metadata: { id: `video-${run}`, mime_type: "video/mp4" },
        attachment: true,
      },
      {
        type: "audio",
        text: "[audio]",
        metadata: {
          id: `audio-${run}`,
          mime_type: "audio/ogg",
          voice: true,
        },
        attachment: true,
        attachmentType: "voice",
      },
      {
        type: "document",
        text: "plan.pdf",
        metadata: {
          id: `document-${run}`,
          mime_type: "application/pdf",
          filename: "plan.pdf",
        },
        attachment: true,
      },
      {
        type: "sticker",
        text: "[sticker]",
        metadata: { id: `sticker-${run}`, mime_type: "image/webp" },
        attachment: true,
      },
      {
        type: "image",
        text: "Baileys fotoğrafı",
        metadata: {
          provider: "whatsapp_web",
          senderName: "Ayşe",
          rawType: "imageMessage",
        },
        attachmentMetadata: {
          id: `web-image-${run}`,
          mime_type: "image/jpeg",
          filename: "web-image.jpg",
          encryptedMediaDescriptor: "encrypted-descriptor",
        },
        provider: "whatsapp_web",
        attachment: true,
      },
      {
        type: "interactive",
        text: "Randevu al",
        metadata: { button_reply: { id: "book", title: "Randevu al" } },
        attachment: false,
      },
      {
        type: "location",
        text: "Brix Dental",
        metadata: {
          latitude: 41.0082,
          longitude: 28.9784,
          name: "Brix Dental",
        },
        attachment: false,
      },
      {
        type: "contacts",
        text: "AyÅŸe YÄ±lmaz",
        metadata: {
          contacts: [{ name: { formatted_name: "AyÅŸe YÄ±lmaz" } }],
          replyToMessageId: "wamid.quoted",
        },
        attachment: false,
      },
      {
        type: "reaction",
        text: "ðŸ‘",
        metadata: {
          emoji: "ðŸ‘",
          reactionTargetMessageId: "wamid.target",
        },
        attachment: false,
      },
    ] as const;

    try {
      for (const [index, fixture] of cases.entries()) {
        const providerMessageId = `wamid.${fixture.type}.${index}.${run}`;
        const result = await repository.incoming({
          organizationId,
          channelId,
          phone: `905550${run.slice(0, 4)}${String(index).padStart(3, "0")}`,
          name: `Meta ${fixture.type}`,
          text: fixture.text,
          type: fixture.type,
          providerMessageId,
          providerTimestamp: new Date(Date.now() + index),
          metadata: fixture.metadata,
          ...("attachmentMetadata" in fixture
            ? { attachmentMetadata: fixture.attachmentMetadata }
            : {}),
          ...("provider" in fixture ? { provider: fixture.provider } : {}),
          traceId: crypto.randomUUID(),
        });
        expect(result.created).toBe(true);
        createdConversationIds.push(result.conversationId);

        const rows = await sql<
          Array<{
            type: string;
            body: string;
            metadata: Record<string, unknown>;
            attachment_count: number;
            attachment_type: string | null;
            attachment_provider: string | null;
            attachment_metadata: Record<string, unknown> | null;
            job_count: number;
            unread_count: number;
            last_message_id: string | null;
          }>
        >`
          SELECT
            m.type,
            m.body,
            m.metadata,
            count(DISTINCT a.id)::int attachment_count,
            max(a.attachment_type::text) attachment_type,
            max(a.provider) attachment_provider,
            (array_agg(a.metadata) FILTER (WHERE a.id IS NOT NULL))[1]
              attachment_metadata,
            count(DISTINCT j.id)::int job_count,
            c.unread_count,
            c.last_message_id
          FROM messages m
          JOIN conversations c ON c.id=m.conversation_id
          LEFT JOIN message_attachments a ON a.message_id=m.id
          LEFT JOIN media_processing_jobs j ON j.attachment_id=a.id
          WHERE m.channel_id=${channelId}::uuid
            AND m.provider_message_id=${providerMessageId}
          GROUP BY m.id,c.id`;
        expect(rows[0]).toMatchObject({
          type: fixture.type,
          body: fixture.text,
          attachment_count: fixture.attachment ? 1 : 0,
          job_count: fixture.attachment ? 1 : 0,
          unread_count: fixture.type === "reaction" ? 0 : 1,
          last_message_id:
            fixture.type === "reaction" ? null : expect.any(String),
        });
        if ("attachmentType" in fixture)
          expect(rows[0]?.attachment_type).toBe(fixture.attachmentType);
        if ("attachmentMetadata" in fixture) {
          expect(rows[0]?.metadata).not.toHaveProperty(
            "encryptedMediaDescriptor",
          );
          expect(rows[0]?.attachment_provider).toBe("whatsapp_web");
          expect(rows[0]?.attachment_metadata).toMatchObject(
            fixture.attachmentMetadata,
          );
        }
        if (fixture.type === "contacts")
          expect(rows[0]?.metadata).toMatchObject({
            contacts: [{ name: { formatted_name: "AyÅŸe YÄ±lmaz" } }],
            replyToMessageId: "wamid.quoted",
          });
      }
    } finally {
      if (createdConversationIds.length)
        await sql`DELETE FROM conversations WHERE id IN ${sql(createdConversationIds)} AND organization_id=${organizationId}::uuid`;
      await sql`
        DELETE FROM conversations
        WHERE organization_id=${organizationId}::uuid
          AND contact_id IN (
            SELECT id FROM contacts
            WHERE organization_id=${organizationId}::uuid
              AND normalized_phone LIKE ${`905550${run.slice(0, 4)}%`}
          )`;
      await sql`DELETE FROM contacts WHERE organization_id=${organizationId}::uuid AND normalized_phone LIKE ${`905550${run.slice(0, 4)}%`}`;
      await sql.end();
    }
  });

  it("keeps a known Baileys push name when a later message has only the phone fallback", async () => {
    const sql = postgres(databaseUrl);
    const repository = new WorkerRepository(sql);
    const run = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const phone = `905558${run.slice(0, 7)}`;
    const conversationIds: string[] = [];
    try {
      const named = await repository.incoming({
        organizationId,
        channelId,
        phone,
        name: "Ayşe Yılmaz",
        text: "İlk mesaj",
        type: "text",
        providerMessageId: `web.identity.named.${run}`,
        providerTimestamp: new Date(),
        metadata: { provider: "whatsapp_web", senderName: "Ayşe Yılmaz" },
        provider: "whatsapp_web",
        traceId: crypto.randomUUID(),
      });
      conversationIds.push(named.conversationId);
      const fallback = await repository.incoming({
        organizationId,
        channelId,
        phone,
        name: phone,
        text: "İkinci mesaj",
        type: "text",
        providerMessageId: `web.identity.fallback.${run}`,
        providerTimestamp: new Date(Date.now() + 1),
        metadata: { provider: "whatsapp_web" },
        provider: "whatsapp_web",
        traceId: crypto.randomUUID(),
      });
      conversationIds.push(fallback.conversationId);

      const contacts = await sql<Array<{ display_name: string }>>`
        SELECT display_name
        FROM contacts
        WHERE organization_id=${organizationId}::uuid
          AND normalized_phone=${phone}`;
      expect(contacts[0]?.display_name).toBe("Ayşe Yılmaz");
    } finally {
      if (conversationIds.length)
        await sql`
          DELETE FROM conversations
          WHERE organization_id=${organizationId}::uuid
            AND id IN ${sql([...new Set(conversationIds)])}`;
      await sql`
        DELETE FROM contacts
        WHERE organization_id=${organizationId}::uuid
          AND normalized_phone=${phone}`;
      await sql.end();
    }
  });
});

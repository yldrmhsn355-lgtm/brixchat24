import { describe, expect, it } from "vitest";
import {
  ChannelRepository,
  ConversationLabelRepository,
  ConversationRepository,
  MediaAuditRepository,
  MessageRepository,
  WebhookEventRepository,
  type DatabaseClient,
} from "./index";

interface QueryCall {
  text: string;
  values: unknown[];
}

type StubSql = ((first: unknown, ...values: unknown[]) => unknown) & {
  begin: (
    callback: (transaction: DatabaseClient) => Promise<unknown>,
  ) => Promise<unknown>;
  json: (value: unknown) => unknown;
};

function createSqlStub(responses: unknown[][]) {
  const calls: QueryCall[] = [];
  const stub = ((first: unknown, ...values: unknown[]) => {
    if (
      Array.isArray(first) &&
      Object.prototype.hasOwnProperty.call(first, "raw")
    ) {
      calls.push({
        text: (first as string[]).join("?"),
        values,
      });
      return Promise.resolve(responses.shift() ?? []);
    }
    return { values: first };
  }) as StubSql;
  stub.begin = async (callback) => callback(stub as unknown as DatabaseClient);
  stub.json = (value) => value;
  return { sql: stub as unknown as DatabaseClient, calls };
}

describe("ChannelRepository provider endpoint routing", () => {
  it("resolves a Meta phone only inside the tenant and provider account", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const providerAccountId = "00000000-0000-4000-8000-000000000101";
    const { sql, calls } = createSqlStub([
      [
        {
          id: "00000000-0000-4000-8000-000000000022",
          phone_number_id: "123456789",
        },
      ],
    ]);

    const channel = await new ChannelRepository(sql).byMetaPhoneNumberId({
      organizationId,
      providerAccountId,
      businessAccountId: "waba-1",
      phoneNumberId: "123456789",
    });

    expect(channel?.phone_number_id).toBe("123456789");
    expect(calls[0]?.text).toContain("c.organization_id=");
    expect(calls[0]?.text).toContain("c.provider_account_id=");
    expect(calls[0]?.text).toContain("c.phone_number_id=");
    expect(calls[0]?.values).toContain(organizationId);
    expect(calls[0]?.values).toContain(providerAccountId);
  });
});

describe("ChannelRepository channel access", () => {
  it("filters restricted roles through channel ownership", async () => {
    const { sql, calls } = createSqlStub([[]]);
    await new ChannelRepository(sql).listAccessible({
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000012",
      role: "agent",
    });
    expect(calls[0]?.text).toContain("channel_user_ownership");
    expect(calls[0]?.values).toContain(true);
  });

  it("applies the same ownership predicate to channel detail", async () => {
    const { sql, calls } = createSqlStub([[]]);
    const channel = await new ChannelRepository(sql).byIdAccessible({
      organizationId: "00000000-0000-4000-8000-000000000001",
      channelId: "00000000-0000-4000-8000-000000000022",
      userId: "00000000-0000-4000-8000-000000000012",
      role: "team_lead",
    });
    expect(channel).toBeNull();
    expect(calls[0]?.text).toContain("channel_user_ownership");
    expect(calls[0]?.values).toContain(true);
  });
});

describe("MessageRepository outbound safeguards", () => {
  it("rejects unresolved quick-reply placeholders before opening a transaction", async () => {
    let began = false;
    const stub = createSqlStub([]);
    stub.sql.begin = async () => {
      began = true;
      throw new Error("transaction_should_not_start");
    };
    await expect(
      new MessageRepository(stub.sql).createOutbound({
        organizationId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        senderId: crypto.randomUUID(),
        role: "agent",
        clientMessageId: crypto.randomUUID(),
        text: "Merhaba {{contact.first_name}}",
        traceId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({
      message: "QUICK_REPLY_VARIABLES_UNRESOLVED",
      statusCode: 409,
    });
    expect(began).toBe(false);
  });

  it("derives the outbound channel from the conversation without applying WhatsApp windows to other platforms", async () => {
    const messageId = "20000000-0000-4000-8000-000000000001";
    const channelId = "30000000-0000-4000-8000-000000000001";
    const contactId = "40000000-0000-4000-8000-000000000001";
    const { sql, calls } = createSqlStub([
      [],
      [
        {
          channel_id: channelId,
          contact_id: contactId,
          customer_service_window_expires_at: null,
          status: "connected",
          connection_status: "ACTIVE",
          provider: "web",
          platform: "web_chat",
          capabilities: ["text"],
        },
      ],
      [
        {
          id: messageId,
          conversation_id: "10000000-0000-4000-8000-000000000001",
          client_message_id: "70000000-0000-4000-8000-000000000001",
          body: "Merhaba",
          type: "text",
          direction: "outbound",
          status: "pending",
          created_at: new Date(),
          metadata: {},
        },
      ],
      [{ full_name: "Agent" }],
      [],
      [],
      [],
    ]);

    const result = await new MessageRepository(sql).createOutbound({
      organizationId: "00000000-0000-4000-8000-000000000001",
      conversationId: "10000000-0000-4000-8000-000000000001",
      senderId: "00000000-0000-4000-8000-000000000012",
      role: "owner",
      clientMessageId: "70000000-0000-4000-8000-000000000001",
      expectedChannelId: channelId,
      text: "Merhaba",
      traceId: "80000000-0000-4000-8000-000000000001",
    });

    expect(result.created).toBe(true);
    const insert = calls.find((call) =>
      call.text.includes("INSERT INTO messages"),
    );
    expect(insert?.values).toContain(channelId);
  });

  it("rejects an outbound message when the selected channel differs from the conversation channel", async () => {
    const { sql } = createSqlStub([
      [],
      [
        {
          channel_id: "30000000-0000-4000-8000-000000000001",
          contact_id: "40000000-0000-4000-8000-000000000001",
          customer_service_window_expires_at: new Date(Date.now() + 60_000),
          status: "connected",
          connection_status: "ACTIVE",
          provider: "meta",
          platform: "whatsapp",
          capabilities: ["text"],
        },
      ],
    ]);

    await expect(
      new MessageRepository(sql).createOutbound({
        organizationId: "00000000-0000-4000-8000-000000000001",
        conversationId: "10000000-0000-4000-8000-000000000001",
        senderId: "00000000-0000-4000-8000-000000000012",
        role: "owner",
        clientMessageId: "70000000-0000-4000-8000-000000000001",
        expectedChannelId: "30000000-0000-4000-8000-000000000002",
        text: "Merhaba",
        traceId: "80000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toMatchObject({
      message: "SELECTED_CHANNEL_MISMATCH",
      statusCode: 409,
    });
  });
});

describe("ConversationRepository ownership access", () => {
  it("requires every requested conversation to use a channel owned by the user", async () => {
    const conversationIds = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
    ];
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const userId = "00000000-0000-4000-8000-000000000012";
    const { sql, calls } = createSqlStub([
      conversationIds.map((id) => ({ id })),
    ]);

    const allowed = await new ConversationRepository(sql).hasOwnedChannelAccess(
      { organizationId, userId, conversationIds },
    );

    expect(allowed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("channel_user_ownership");
    expect(calls[0]?.text).toContain("cuo.organization_id=c.organization_id");
    expect(calls[0]?.text).toContain("cuo.channel_id=c.channel_id");
    expect(calls[0]?.values).toContain(organizationId);
    expect(calls[0]?.values).toContain(userId);
  });

  it("denies access when any requested conversation is outside owned channels", async () => {
    const { sql } = createSqlStub([
      [{ id: "10000000-0000-4000-8000-000000000001" }],
    ]);

    const allowed = await new ConversationRepository(sql).hasOwnedChannelAccess(
      {
        organizationId: "00000000-0000-4000-8000-000000000001",
        userId: "00000000-0000-4000-8000-000000000012",
        conversationIds: [
          "10000000-0000-4000-8000-000000000001",
          "10000000-0000-4000-8000-000000000002",
        ],
      },
    );

    expect(allowed).toBe(false);
  });
});

describe("ConversationRepository inbox ordering", () => {
  it("lists only active organization assignees through the repository boundary", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const { sql, calls } = createSqlStub([
      [
        {
          id: "00000000-0000-4000-8000-000000000012",
          full_name: "Agent One",
          email: "agent@example.com",
          role: "agent",
        },
      ],
    ]);

    const assignees = await new ConversationRepository(sql).listAssignees(
      organizationId,
    );

    expect(assignees).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000012",
        fullName: "Agent One",
        email: "agent@example.com",
        role: "agent",
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("om.organization_id=");
    expect(calls[0]?.text).toContain("u.is_active=true");
    expect(calls[0]?.text).toContain("u.suspended_at IS NULL");
    expect(calls[0]?.text).toContain(
      "om.role IN ('owner','admin','team_lead','agent')",
    );
    expect(calls[0]?.text).toContain("ORDER BY u.full_name,u.id");
    expect(calls[0]?.values).toContain(organizationId);
  });

  it("can exclude archived conversations from active inbox filters", async () => {
    const { sql, calls } = createSqlStub([[]]);

    await new ConversationRepository(sql).list({
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000012",
      role: "owner",
      limit: 25,
      excludeArchived: true,
    });

    expect(calls[0]?.text).toContain("c.status<>'archived'");
    expect(calls[0]?.values).toContain(true);
  });

  it("returns exact sidebar counts from one scoped aggregate", async () => {
    const { sql, calls } = createSqlStub([
      [
        {
          all_count: 12,
          assigned_to_me_count: 4,
          unassigned_count: 5,
          unread_count: 3,
          archived_count: 2,
        },
      ],
    ]);

    const counts = await new ConversationRepository(sql).counts({
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000012",
      role: "owner",
    });

    expect(counts).toEqual({
      all: 12,
      assignedToMe: 4,
      unassigned: 5,
      unread: 3,
      archived: 2,
    });
    expect(calls[0]?.text).toContain("assigned_to_me_count");
    expect(calls[0]?.text).toContain("channel_user_ownership");
  });

  it("uses the authoritative last message pointer for the inbox preview", async () => {
    const { sql, calls } = createSqlStub([[]]);

    await new ConversationRepository(sql).list({
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000012",
      role: "owner",
      limit: 25,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain(
      "LEFT JOIN messages m ON m.id=c.last_message_id",
    );
    expect(calls[0]?.text).not.toContain("LEFT JOIN LATERAL");
  });

  it("returns assigned conversation labels for inbox cards", async () => {
    const { sql, calls } = createSqlStub([
      [
        {
          id: "10000000-0000-4000-8000-000000000001",
          organization_id: "00000000-0000-4000-8000-000000000001",
          contact_id: "20000000-0000-4000-8000-000000000001",
          contact_name: "Hasan",
          phone: "+905000000000",
          channel_name: "WhatsApp 0894",
          channel_id: "30000000-0000-4000-8000-000000000001",
          stage: "Yeni Lead",
          priority: "normal",
          status: "open",
          unread_count: 0,
          last_message_at: "2026-07-25T08:00:00.000Z",
          tags: ["Hot"],
        },
      ],
    ]);

    const result = await new ConversationRepository(sql).list({
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000012",
      role: "owner",
      limit: 25,
    });

    expect(result.data[0]?.tags).toEqual(["Hot"]);
    expect(calls[0]?.text).toContain("conversation_label_assignments");
    expect(calls[0]?.text).toContain("array_agg(l.name ORDER BY l.name)");
  });

  it("exposes safe WhatsApp group participant phone details", async () => {
    const { sql } = createSqlStub([
      [
        {
          id: "10000000-0000-4000-8000-000000000001",
          organization_id: "00000000-0000-4000-8000-000000000001",
          contact_id: "20000000-0000-4000-8000-000000000001",
          contact_name: "Brix Dental",
          phone: "+120363000000",
          custom_fields: {
            whatsappWebConversationType: "group",
            whatsappWebParticipants: [
              {
                jid: "20981166936168@lid",
                lid: "20981166936168@lid",
                phoneNumber: "+905559998877",
                name: "AyÅŸe YÄ±lmaz",
                isAdmin: true,
              },
            ],
          },
          channel_name: "Banko",
          channel_id: "30000000-0000-4000-8000-000000000001",
          stage: "Yeni Lead",
          priority: "normal",
          status: "open",
          unread_count: 0,
          last_message_at: "2026-07-31T18:00:00.000Z",
          tags: [],
        },
      ],
    ]);

    const result = await new ConversationRepository(sql).list({
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000012",
      role: "owner",
      limit: 25,
    });

    expect(result.data[0]).toMatchObject({
      isGroup: true,
      groupParticipants: [
        {
          jid: "20981166936168@lid",
          phoneNumber: "+905559998877",
          name: "AyÅŸe YÄ±lmaz",
          isAdmin: true,
        },
      ],
    });
  });

  it("finds the latest inbound provider message by Meta timestamp", async () => {
    const { sql, calls } = createSqlStub([[]]);

    await new ConversationRepository(sql).latestInboundProviderMessage(
      "00000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000001",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain(
      "ORDER BY COALESCE(m.provider_timestamp,m.sent_at) DESC",
    );
    expect(calls[0]?.text).toContain(
      "m.metadata->>'suppressed' IS DISTINCT FROM 'true'",
    );
  });
});

describe("MessageRepository Meta timestamps", () => {
  it("normalizes a single API message into the inbox DTO contract", async () => {
    const { sql, calls } = createSqlStub([
      [
        {
          id: "20000000-0000-4000-8000-000000000010",
          conversation_id: "10000000-0000-4000-8000-000000000001",
          client_message_id: "20000000-0000-4000-8000-000000000011",
          body: "Hello Mert",
          type: "template",
          direction: "outbound",
          status: "pending",
          sent_at: "2026-07-25T12:00:00.000Z",
          sender_name: "Deniz Aksoy",
          metadata: { templateName: "welcome_patient" },
          attachments: [],
        },
      ],
    ]);

    const message = await new MessageRepository(sql).getById(
      "00000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000010",
    );

    expect(message).toMatchObject({
      conversationId: "10000000-0000-4000-8000-000000000001",
      clientMessageId: "20000000-0000-4000-8000-000000000011",
      senderName: "Deniz Aksoy",
      metadata: { templateName: "welcome_patient" },
      attachments: [],
      errorCode: null,
      errorMessage: null,
    });
    expect(calls[0]?.text).toContain("m.organization_id=");
    expect(calls[0]?.text).toContain("jsonb_agg");
    expect(calls[0]?.text).toContain(
      "m.metadata->>'suppressed' IS DISTINCT FROM 'true'",
    );
    expect(calls[0]?.text).toContain("a.deleted_at IS NULL");
  });

  it("orders and renders inbound messages by the provider timestamp", async () => {
    const providerTimestamp = "2026-07-20T20:29:34.000Z";
    const { sql, calls } = createSqlStub([
      [
        {
          id: "20000000-0000-4000-8000-000000000001",
          conversation_id: "10000000-0000-4000-8000-000000000001",
          body: "Meta message",
          type: "text",
          direction: "inbound",
          status: "delivered",
          provider_timestamp: providerTimestamp,
          sent_at: "2026-07-20T20:31:00.000Z",
          sender_name: "Ayşe Yılmaz",
          metadata: {},
          attachments: [],
        },
      ],
    ]);

    const result = await new MessageRepository(sql).list(
      "00000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000001",
      undefined,
      50,
    );

    expect(result.data[0]?.sentAt).toBe(providerTimestamp);
    expect(calls[0]?.text).toContain(
      "COALESCE(m.provider_timestamp,m.sent_at) display_at",
    );
    expect(calls[0]?.text).toContain(
      "ORDER BY COALESCE(m.provider_timestamp,m.sent_at) DESC",
    );
    expect(calls[0]?.text).toContain(
      "LEFT JOIN contacts ct ON ct.id=m.contact_id AND ct.organization_id=m.organization_id",
    );
    expect(calls[0]?.text).toContain("m.conversation_id IN");
    expect(calls[0]?.text).toContain("sibling.channel_id=requested.channel_id");
    expect(calls[0]?.text).toContain("sibling.contact_id=requested.contact_id");
    expect(calls[0]?.text).toContain("NULLIF(BTRIM(ct.display_name),'')");
    expect(calls[0]?.text).toContain("ct.normalized_phone");
    expect(calls[0]?.text).toContain(
      "m.metadata->>'suppressed' IS DISTINCT FROM 'true'",
    );
    expect(calls[0]?.text).toContain("a.deleted_at IS NULL");
    expect(result.data[0]?.senderName).toBe("Ayşe Yılmaz");
  });
});

describe("ConversationLabelRepository", () => {
  it("scopes conversation label reads to both organization and conversation", async () => {
    const row = {
      id: "70000000-0000-4000-8000-000000000001",
      name: "Priority",
      color: "#ff0000",
    };
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const conversationId = "10000000-0000-4000-8000-000000000001";
    const { sql, calls } = createSqlStub([[row]]);

    const result = await new ConversationLabelRepository(
      sql,
    ).listForConversation(organizationId, conversationId);

    expect(result).toEqual([row]);
    expect(calls[0]?.text).toContain("a.organization_id=");
    expect(calls[0]?.text).toContain("a.conversation_id=");
    expect(calls[0]?.values).toEqual([organizationId, conversationId]);
  });

  it("replaces labels atomically with tenant-scoped existence checks", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const conversationId = "10000000-0000-4000-8000-000000000001";
    const labelId = "70000000-0000-4000-8000-000000000001";
    const actorId = "00000000-0000-4000-8000-000000000012";
    const { sql, calls } = createSqlStub([
      [{ id: conversationId }],
      [{ id: labelId }],
      [],
      [],
    ]);

    const result = await new ConversationLabelRepository(
      sql,
    ).replaceForConversation({
      organizationId,
      conversationId,
      labelId,
      actorId,
    });

    expect(result).toBe(labelId);
    expect(calls).toHaveLength(4);
    expect(calls[0]?.text).toContain("FOR UPDATE");
    expect(calls[0]?.values).toEqual([conversationId, organizationId]);
    expect(calls[1]?.values).toEqual([labelId, organizationId]);
    expect(calls[2]?.text).toContain(
      "DELETE FROM conversation_label_assignments",
    );
    expect(calls[3]?.text).toContain(
      "INSERT INTO conversation_label_assignments",
    );
    expect(calls[3]?.values).toEqual([
      organizationId,
      conversationId,
      labelId,
      actorId,
    ]);
  });
});

describe("MediaAuditRepository", () => {
  it("records cleanup work with tenant, actor, and object provenance", async () => {
    const { sql, calls } = createSqlStub([[]]);

    await new MediaAuditRepository(sql).recordCleanupRequired({
      organizationId: "00000000-0000-4000-8000-000000000001",
      actorId: "00000000-0000-4000-8000-000000000002",
      storageKey: "tenant/day/object.pdf",
      storageProvider: "r2",
      storageBucket: "private-media",
      reason: "MEDIA_SCAN_CLEANUP_FAILED",
      scanStatus: "infected",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("INSERT INTO audit_logs");
    expect(calls[0]?.values).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      {
        storageKey: "tenant/day/object.pdf",
        storageProvider: "r2",
        storageBucket: "private-media",
        reason: "MEDIA_SCAN_CLEANUP_FAILED",
        cleanupStatus: "pending",
        scanStatus: "infected",
      },
    ]);
  });
});

describe("ChannelRepository webhook lookup", () => {
  it("returns null without querying PostgreSQL for a malformed public id", async () => {
    const { sql, calls } = createSqlStub([]);

    const result = await new ChannelRepository(sql).byPublicId("not-a-uuid");

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("updates channel health within the organization boundary", async () => {
    const { sql, calls } = createSqlStub([[]]);
    const checkedAt = new Date("2026-07-24T16:00:00.000Z");

    await new ChannelRepository(sql).updateHealth({
      organizationId: "00000000-0000-4000-8000-000000000001",
      channelId: "00000000-0000-4000-8000-000000000022",
      status: "healthy",
      code: null,
      checkedAt,
      profile: { displayPhoneNumber: "+905551112233" },
      healthy: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("UPDATE channels");
    expect(calls[0]?.text).toContain("organization_id=");
    expect(calls[0]?.values).toContain("00000000-0000-4000-8000-000000000001");
    expect(calls[0]?.values).toContain("00000000-0000-4000-8000-000000000022");
    expect(calls[0]?.values).toContain(checkedAt);
  });
});

describe("WebhookEventRepository", () => {
  it("records the channel receipt timestamp when a verified webhook is accepted", async () => {
    const receivedAt = new Date("2026-07-24T14:00:00.000Z");
    const { sql, calls } = createSqlStub([
      [{ id: "90000000-0000-4000-8000-000000000001", received_at: receivedAt }],
      [],
    ]);

    const inserted = await new WebhookEventRepository(sql).insert({
      organizationId: "00000000-0000-4000-8000-000000000001",
      channelId: "00000000-0000-4000-8000-000000000022",
      eventKey: "meta-event-1",
      eventType: "meta.message_echoes",
      payload: { field: "message_echoes" },
    });

    expect(inserted).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.text).toContain("last_webhook_at=");
    expect(calls[1]?.values).toContain(receivedAt);
    expect(calls[1]?.values).toContain("accepted");
  });

  it("still records duplicate deliveries as the latest verified webhook", async () => {
    const { sql, calls } = createSqlStub([[], []]);

    const inserted = await new WebhookEventRepository(sql).insert({
      organizationId: "00000000-0000-4000-8000-000000000001",
      channelId: "00000000-0000-4000-8000-000000000022",
      eventKey: "meta-event-duplicate",
      eventType: "meta.messages",
      payload: { field: "messages" },
    });

    expect(inserted).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.values).toContain("duplicate");
  });
});

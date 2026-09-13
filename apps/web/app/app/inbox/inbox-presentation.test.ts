import { describe, expect, it } from "vitest";
import {
  conversationCardLabels,
  formatConversationTime,
  formatGroupParticipantPhone,
  formatMessageDay,
  groupParticipantCards,
  messageGroupPosition,
  messageDisplayBody,
  parseWhatsAppText,
  reconcileLoadedMessages,
  readStoredDrafts,
  shouldRenderMessageBody,
  unreadBoundaryMessageId,
  visibleTimelineMessages,
} from "./inbox-presentation";

const now = new Date("2026-07-25T12:00:00+03:00");

describe("inbox presentation", () => {
  it("shows assigned conversation labels before the fallback stage", () => {
    expect(conversationCardLabels(["Hot"], "Yeni Lead")).toEqual(["Hot"]);
    expect(
      conversationCardLabels([" Hot ", "Priority", "Hot"], "Yeni Lead"),
    ).toEqual(["Hot", "Priority"]);
    expect(conversationCardLabels([], "Yeni Lead")).toEqual(["Yeni Lead"]);
  });

  it("uses WhatsApp-like relative date labels", () => {
    expect(formatMessageDay("2026-07-25T08:00:00+03:00", now)).toBe("Bugün");
    expect(formatMessageDay("2026-07-24T08:00:00+03:00", now)).toBe("Dün");
    expect(formatConversationTime("2026-07-24T08:00:00+03:00", now)).toBe(
      "Dün",
    );
  });

  it("removes reaction-only rows and attachment placeholders", () => {
    const messages = [
      {
        id: "reaction",
        body: "👍",
        type: "reaction",
        direction: "inbound",
        status: "received",
        sentAt: now.toISOString(),
        attachments: [],
      },
      {
        id: "image",
        body: "[image]",
        type: "image",
        direction: "inbound",
        status: "received",
        sentAt: now.toISOString(),
        attachments: [{}],
      },
    ];
    expect(
      visibleTimelineMessages(messages).map((message) => message.id),
    ).toEqual(["image"]);
    expect(shouldRenderMessageBody("[image]", "image", 1)).toBe(false);
  });

  it("shows the resolved WhatsApp mention while preserving the stored body", () => {
    expect(
      messageDisplayBody("Merhaba @20981166936168", {
        displayText: "Merhaba @Ayşe Yılmaz",
      }),
    ).toBe("Merhaba @Ayşe Yılmaz");
  });

  it("parses WhatsApp text styles without exposing their markers", () => {
    expect(
      parseWhatsAppText(
        "*Hasta Adı:* Emir Şah\n_Randevu revize_ · ~iptal~\n```15.00```",
      ),
    ).toEqual([
      { style: "bold", text: "Hasta Adı:" },
      { style: "text", text: " Emir Şah\n" },
      { style: "italic", text: "Randevu revize" },
      { style: "text", text: " · " },
      { style: "strike", text: "iptal" },
      { style: "text", text: "\n" },
      { style: "code", text: "15.00" },
    ]);
  });

  it("keeps unmatched and in-word markers as plain text", () => {
    expect(parseWhatsAppText("Eksik *işaret ve dosya_adi")).toEqual([
      { style: "text", text: "Eksik *işaret ve dosya_adi" },
    ]);
  });

  it("resolves an existing raw mention from another group message", () => {
    expect(
      messageDisplayBody(
        "@20981166936168 nasılsın?",
        { mentionedJids: ["20981166936168@lid"] },
        [
          {
            senderName: "Berivan Kılıç",
            metadata: { senderJid: "20981166936168@lid" },
          },
        ],
      ),
    ).toBe("@Berivan Kılıç nasılsın?");
  });

  it("shows group participant names with their real phone numbers", () => {
    expect(
      groupParticipantCards(
        [
          {
            jid: "20981166936168@lid",
            lid: "20981166936168@lid",
            phoneNumber: "+905559998877",
            name: null,
            isAdmin: true,
          },
        ],
        [
          {
            direction: "inbound",
            senderName: "Ayşe Yılmaz",
            metadata: { senderJid: "905559998877@s.whatsapp.net" },
          },
        ],
      ),
    ).toEqual([
      expect.objectContaining({
        displayName: "Ayşe Yılmaz",
        phoneNumber: "+905559998877",
        isAdmin: true,
      }),
    ]);
    expect(formatGroupParticipantPhone("+905559998877")).toBe(
      "+90 555 999 88 77",
    );
  });

  it("finds the first unread inbound message", () => {
    const messages = ["a", "b", "c"].map((id, index) => ({
      id,
      body: id,
      type: "text",
      direction: index === 1 ? "outbound" : "inbound",
      status: "received",
      sentAt: new Date(now.getTime() + index).toISOString(),
      attachments: [],
    }));
    expect(unreadBoundaryMessageId(messages, 1)).toBe("c");
    expect(unreadBoundaryMessageId(messages, 2)).toBe("a");
  });

  it("recovers only valid stored draft strings", () => {
    expect(readStoredDrafts('{"one":"hello","two":2}')).toEqual({
      one: "hello",
    });
    expect(readStoredDrafts("broken")).toEqual({});
  });

  it("groups consecutive messages from the same sender within five minutes", () => {
    const messages = [
      { id: "a", senderName: "Hasan", offset: 0 },
      { id: "b", senderName: "Hasan", offset: 60_000 },
      { id: "c", senderName: "Hasan", offset: 120_000 },
      { id: "d", senderName: "Customer", offset: 180_000 },
    ].map(({ id, senderName, offset }) => ({
      id,
      senderName,
      body: id,
      type: "text",
      direction: senderName === "Hasan" ? "outbound" : "inbound",
      status: "read",
      sentAt: new Date(now.getTime() + offset).toISOString(),
      attachments: [],
    }));

    expect(
      messages.map((_, index) => messageGroupPosition(messages, index)),
    ).toEqual(["first", "middle", "last", "single"]);
  });

  it("keeps unsynced pending and failed messages during realtime refresh", () => {
    const message = (
      id: string,
      conversationId: string,
      status: string,
      clientMessageId: string | null = id,
    ) => ({ id, conversationId, status, clientMessageId });
    const server = [
      message("stored", "conversation-a", "sent", "stored-client"),
    ];
    const current = [
      message("pending", "conversation-a", "pending"),
      message("failed", "conversation-a", "failed"),
      message("other", "conversation-b", "failed"),
    ];

    expect(
      reconcileLoadedMessages(server, current, "conversation-a").map(
        (item) => item.id,
      ),
    ).toEqual(["stored", "pending", "failed"]);
  });

  it("does not duplicate an optimistic message already returned by the server", () => {
    const server = [
      {
        id: "database-id",
        conversationId: "conversation-a",
        status: "sent",
        clientMessageId: "client-id",
      },
    ];
    const current = [
      {
        id: "client-id",
        conversationId: "conversation-a",
        status: "pending",
        clientMessageId: "client-id",
      },
    ];

    expect(reconcileLoadedMessages(server, current, "conversation-a")).toEqual(
      server,
    );
  });
});

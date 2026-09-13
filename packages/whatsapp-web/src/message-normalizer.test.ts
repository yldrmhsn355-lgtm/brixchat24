import { describe, expect, it } from "vitest";
import { proto, type WAMessage } from "@whiskeysockets/baileys";
import {
  normalizeWhatsAppWebMessage,
  resolveWhatsAppWebLidSender,
  resolveWhatsAppWebSender,
} from "./message-normalizer";

function waMessage(message: NonNullable<WAMessage["message"]>): WAMessage {
  return {
    key: {
      id: "wamid-1",
      remoteJid: "905551112233@s.whatsapp.net",
      fromMe: false,
    },
    message,
    messageTimestamp: 1_700_000_000,
  };
}

describe("normalizeWhatsAppWebMessage", () => {
  it("preserves text, reply and mention context", () => {
    const result = normalizeWhatsAppWebMessage(
      waMessage({
        extendedTextMessage: {
          text: "Merhaba",
          contextInfo: {
            stanzaId: "quoted-1",
            participant: "905559998877@s.whatsapp.net",
            mentionedJid: ["905550001111@s.whatsapp.net"],
          },
        },
      }),
      "wamid-1",
    );

    expect(result).toMatchObject({
      type: "text",
      rawType: "extendedTextMessage",
      text: "Merhaba",
      metadata: {
        replyToMessageId: "quoted-1",
        quotedParticipant: "905559998877@s.whatsapp.net",
        mentionedJids: ["905550001111@s.whatsapp.net"],
      },
    });
  });

  it("unwraps view-once media and creates a durable encrypted-download source", () => {
    const result = normalizeWhatsAppWebMessage(
      waMessage({
        viewOnceMessageV2: {
          message: {
            imageMessage: {
              caption: "Teklif görseli",
              mimetype: "image/jpeg",
              mediaKey: Uint8Array.from([1, 2, 3]),
              directPath: "/v/t62/example",
              fileLength: 1234,
              width: 640,
              height: 480,
            },
          },
        },
      }),
      "wamid-media",
    );

    expect(result).toMatchObject({
      type: "image",
      rawType: "imageMessage",
      text: "Teklif görseli",
      attachmentMetadata: {
        id: "wamid-media",
        mime_type: "image/jpeg",
        providerFileSize: 1234,
        width: 640,
        height: 480,
      },
    });
    expect(result.serializedMediaMessage).toBeTruthy();
    expect(
      proto.WebMessageInfo.decode(
        Buffer.from(result.serializedMediaMessage!, "base64"),
      ).message?.viewOnceMessageV2?.message?.imageMessage?.caption,
    ).toBe("Teklif görseli");
  });

  it("marks voice messages and keeps their duration", () => {
    const result = normalizeWhatsAppWebMessage(
      waMessage({
        audioMessage: {
          mimetype: "audio/ogg; codecs=opus",
          ptt: true,
          seconds: 8,
          mediaKey: Uint8Array.from([4, 5, 6]),
          directPath: "/v/t62/audio",
        },
      }),
      "wamid-audio",
    );

    expect(result).toMatchObject({
      type: "audio",
      text: "[audio]",
      attachmentMetadata: {
        voice: true,
        durationSeconds: 8,
      },
    });
  });

  it("normalizes reactions, locations and shared contacts", () => {
    expect(
      normalizeWhatsAppWebMessage(
        waMessage({
          reactionMessage: {
            text: "👍",
            key: { id: "target-1" },
          },
        }),
        "reaction-1",
      ),
    ).toMatchObject({
      type: "reaction",
      text: "👍",
      metadata: { reactionTargetMessageId: "target-1" },
    });

    expect(
      normalizeWhatsAppWebMessage(
        waMessage({
          locationMessage: {
            name: "Brixchat Ofis",
            address: "İstanbul",
            degreesLatitude: 41.01,
            degreesLongitude: 28.97,
          },
        }),
        "location-1",
      ),
    ).toMatchObject({
      type: "location",
      text: "Brixchat Ofis",
      metadata: { latitude: 41.01, longitude: 28.97 },
    });

    expect(
      normalizeWhatsAppWebMessage(
        waMessage({
          contactsArrayMessage: {
            displayName: "Satış Ekibi",
            contacts: [
              { displayName: "Ayşe", vcard: "BEGIN:VCARD\nFN:Ayşe\nEND:VCARD" },
              {
                displayName: "Mehmet",
                vcard: "BEGIN:VCARD\nFN:Mehmet\nEND:VCARD",
              },
            ],
          },
        }),
        "contacts-1",
      ),
    ).toMatchObject({
      type: "contacts",
      text: "Satış Ekibi",
      metadata: {
        contacts: [{ displayName: "Ayşe" }, { displayName: "Mehmet" }],
      },
    });
  });

  it("uses the selected value for interactive replies", () => {
    expect(
      normalizeWhatsAppWebMessage(
        waMessage({
          listResponseMessage: {
            title: "Teknik Destek",
            singleSelectReply: { selectedRowId: "support" },
          },
        }),
        "interactive-1",
      ),
    ).toMatchObject({
      type: "interactive",
      text: "Teknik Destek",
      metadata: { interactive: true, selectedId: "support" },
    });
  });

  it("suppresses transport-only envelopes instead of creating fake messages", () => {
    for (const message of [
      { albumMessage: { expectedImageCount: 2 } },
      { secretEncryptedMessage: {} },
      { placeholderMessage: { type: 0 } },
      {},
    ])
      expect(
        normalizeWhatsAppWebMessage(waMessage(message), "transport-1"),
      ).toMatchObject({
        action: "ignore",
        type: "unsupported",
        text: "",
      });
  });

  it("keeps user-authored polls visible instead of ignoring them", () => {
    expect(
      normalizeWhatsAppWebMessage(
        waMessage({
          pollCreationMessageV3: {
            name: "Toplantı saati?",
            options: [{ optionName: "10:00" }, { optionName: "14:00" }],
          },
        }),
        "poll-1",
      ),
    ).toMatchObject({
      type: "unsupported",
      text: "📊 Anket: Toplantı saati?",
      metadata: { userContent: true },
    });
  });

  it("keeps event and order messages visible as placeholders", () => {
    expect(
      normalizeWhatsAppWebMessage(
        waMessage({ eventMessage: { name: "Demo görüşmesi" } }),
        "event-1",
      ),
    ).toMatchObject({
      type: "unsupported",
      text: "📅 Etkinlik: Demo görüşmesi",
      metadata: { userContent: true },
    });
    expect(
      normalizeWhatsAppWebMessage(
        waMessage({ orderMessage: { orderId: "1" } }),
        "order-1",
      ),
    ).toMatchObject({
      type: "unsupported",
      text: "🛒 Sipariş mesajı",
      metadata: { userContent: true },
    });
  });

  it("turns protocol edit and revoke envelopes into target mutations", () => {
    expect(
      normalizeWhatsAppWebMessage(
        waMessage({
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
            key: { id: "target-edit" },
            editedMessage: { conversation: "Düzeltilmiş metin" },
          },
        }),
        "edit-event",
      ),
    ).toMatchObject({
      action: "edit",
      targetProviderMessageId: "target-edit",
      type: "text",
      text: "Düzeltilmiş metin",
    });

    expect(
      normalizeWhatsAppWebMessage(
        waMessage({
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.REVOKE,
            key: { id: "target-revoke" },
          },
        }),
        "revoke-event",
      ),
    ).toMatchObject({
      action: "revoke",
      targetProviderMessageId: "target-revoke",
      text: "",
    });
  });

  it("keeps real video-note and template content out of unsupported fallback", () => {
    expect(
      normalizeWhatsAppWebMessage(
        waMessage({
          ptvMessage: {
            mimetype: "video/mp4",
            seconds: 4,
            mediaKey: Uint8Array.from([7, 8, 9]),
            directPath: "/v/t62/ptv",
          },
        }),
        "ptv-1",
      ),
    ).toMatchObject({
      type: "video",
      rawType: "ptvMessage",
      attachmentMetadata: { durationSeconds: 4 },
    });

    expect(
      normalizeWhatsAppWebMessage(
        waMessage({
          templateMessage: {
            templateId: "appointment-reminder",
            hydratedTemplate: {
              hydratedContentText: "Randevunuzu hatırlatırız",
            },
          },
        }),
        "template-1",
      ),
    ).toMatchObject({
      type: "interactive",
      text: "Randevunuzu hatırlatırız",
      metadata: { templateId: "appointment-reminder" },
    });
  });
});

describe("resolveWhatsAppWebSender", () => {
  it("uses pushName and resolves a LID participant to the phone JID", () => {
    const message = waMessage({ conversation: "Selam" });
    message.pushName = "Ayşe Yılmaz";
    message.key.remoteJid = "120363000000@g.us";
    message.key.participant = "123456789@lid";
    (
      message.key as typeof message.key & { participantAlt?: string }
    ).participantAlt = "905551112233@s.whatsapp.net";

    expect(resolveWhatsAppWebSender(message, "120363000000@g.us")).toEqual({
      sender: "905551112233",
      senderJid: "905551112233@s.whatsapp.net",
      senderName: "Ayşe Yılmaz",
      isGroup: true,
    });
  });

  it("falls back from a one-to-one LID to remoteJidAlt", () => {
    const message = waMessage({ conversation: "Selam" });
    message.key.remoteJid = "123456789@lid";
    (
      message.key as typeof message.key & { remoteJidAlt?: string }
    ).remoteJidAlt = "905554445566@s.whatsapp.net";

    expect(resolveWhatsAppWebSender(message, "123456789@lid")).toMatchObject({
      sender: "905554445566",
      senderJid: "905554445566@s.whatsapp.net",
    });
  });

  it("resolves a direct LID from the durable reverse mapping", async () => {
    const unresolved = {
      sender: "213756361621645",
      senderJid: "213756361621645@lid",
      senderName: "Ayşe Yılmaz",
      isGroup: false,
    };

    await expect(
      resolveWhatsAppWebLidSender(unresolved, async (lidJid) => {
        expect(lidJid).toBe("213756361621645@lid");
        return "905551112233@s.whatsapp.net";
      }),
    ).resolves.toEqual({
      sender: "905551112233",
      senderJid: "905551112233@s.whatsapp.net",
      senderName: "Ayşe Yılmaz",
      isGroup: false,
    });
  });

  it("keeps the LID identity when no reverse mapping exists", async () => {
    const unresolved = {
      sender: "213756361621645",
      senderJid: "213756361621645@lid",
      senderName: "Ayşe Yılmaz",
      isGroup: false,
    };

    await expect(
      resolveWhatsAppWebLidSender(unresolved, async () => null),
    ).resolves.toEqual(unresolved);
  });
});

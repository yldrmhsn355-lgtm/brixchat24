import { describe, expect, it } from "vitest";
import {
  formatWhatsAppWebMentions,
  whatsappWebInboundContactCustomFields,
  whatsappWebContactNamePolicy,
  whatsappWebConversationIdentity,
  whatsappWebDeliveryError,
  whatsappWebMessageDirection,
} from "./whatsapp-web-runtime";

describe("whatsappWebMessageDirection", () => {
  it("keeps linked-device messages from this account as outbound", () => {
    expect(whatsappWebMessageDirection({ fromMe: true })).toBe("outbound");
    expect(whatsappWebMessageDirection({ fromMe: false })).toBe("inbound");
  });
});

describe("whatsappWebContactNamePolicy", () => {
  it("does not replace a direct contact name with the account owner's push name", () => {
    expect(
      whatsappWebContactNamePolicy(
        { fromMe: true, isGroup: false },
        { phone: "+14163015592", name: "hasan" },
      ),
    ).toEqual({ name: "+14163015592", preserveExisting: true });
  });

  it("keeps inbound and group names eligible for normal updates", () => {
    expect(
      whatsappWebContactNamePolicy(
        { fromMe: false, isGroup: false },
        { phone: "+14163015592", name: "Platinum Black Car" },
      ),
    ).toEqual({ name: "Platinum Black Car", preserveExisting: false });
    expect(
      whatsappWebContactNamePolicy(
        { fromMe: true, isGroup: true },
        { phone: "+120363000000", name: "Dental Team" },
      ),
    ).toEqual({ name: "Dental Team", preserveExisting: false });
  });
});

describe("formatWhatsAppWebMentions", () => {
  it("renders a group mention like WhatsApp without changing unmatched ids", () => {
    expect(
      formatWhatsAppWebMentions("Merhaba @20981166936168 ve @111", [
        { jid: "20981166936168@lid", displayName: "AyÅŸe YÄ±lmaz" },
      ]),
    ).toBe("Merhaba @AyÅŸe YÄ±lmaz ve @111");
  });
});

describe("whatsappWebInboundContactCustomFields", () => {
  it("persists the full participant list on the first inbound group message", () => {
    const participants = [
      {
        jid: "20981166936168@lid",
        phoneNumber: "+905559998877",
      },
    ];
    expect(
      whatsappWebInboundContactCustomFields(
        {
          whatsappWebChatId: "120363000000@g.us",
          whatsappWebConversationType: "group",
        },
        true,
        { groupParticipants: participants },
      ),
    ).toEqual({
      whatsappWebChatId: "120363000000@g.us",
      whatsappWebConversationType: "group",
      whatsappWebParticipants: participants,
      whatsappWebParticipantCount: 1,
    });
  });
});

describe("whatsappWebConversationIdentity", () => {
  it("uses one stable group identity instead of the participant phone", () => {
    expect(
      whatsappWebConversationIdentity({
        chatId: "120363000000@g.us",
        chatName: "Banka Ekibi",
        isGroup: true,
        sender: "905551112233",
        senderJid: "905551112233@s.whatsapp.net",
        senderName: "Ayşe",
      }),
    ).toEqual({
      phone: "+120363000000",
      name: "Banka Ekibi",
      contactCustomFields: {
        whatsappWebChatId: "120363000000@g.us",
        whatsappWebConversationType: "group",
      },
    });
  });

  it("does not expose a numeric technical fallback while the subject loads", () => {
    expect(
      whatsappWebConversationIdentity({
        chatId: "120363000110514@g.us",
        isGroup: true,
        sender: "905551112233",
        senderJid: "905551112233@s.whatsapp.net",
        senderName: "Ayşe",
      }).name,
    ).toBe("Grup adı alınıyor…");
  });

  it("accepts modern long group JIDs without treating them as phone numbers", () => {
    expect(
      whatsappWebConversationIdentity({
        chatId: "120363419580324594@g.us",
        chatName: "Uzun Kimlikli Grup",
        isGroup: true,
        sender: "905551112233",
        senderJid: "905551112233@s.whatsapp.net",
        senderName: "Ayse",
      }),
    ).toEqual({
      phone: "+120363419580324594",
      name: "Uzun Kimlikli Grup",
      contactCustomFields: {
        whatsappWebChatId: "120363419580324594@g.us",
        whatsappWebConversationType: "group",
      },
    });
  });

  it("keeps direct chats keyed by the sender phone", () => {
    expect(
      whatsappWebConversationIdentity({
        chatId: "905551112233@s.whatsapp.net",
        isGroup: false,
        sender: "905551112233",
        senderJid: "905551112233@s.whatsapp.net",
        senderName: "Ayşe",
      }),
    ).toEqual({
      phone: "+905551112233",
      name: "Ayşe",
    });
  });

  it("keeps an unmapped direct LID as a stable replyable identity", () => {
    expect(
      whatsappWebConversationIdentity({
        chatId: "213756361621645123@lid",
        isGroup: false,
        sender: "213756361621645123",
        senderJid: "213756361621645123@lid",
        senderName: "Ayşe",
      }),
    ).toEqual({
      phone: "+213756361621645123",
      name: "Ayşe",
      contactCustomFields: {
        whatsappWebChatId: "213756361621645123@lid",
        whatsappWebConversationType: "direct_lid",
        whatsappWebPhoneResolved: false,
      },
    });
  });

  it("does not accept a malformed non-LID identity", () => {
    expect(() =>
      whatsappWebConversationIdentity({
        chatId: "newsletter@broadcast",
        isGroup: false,
        sender: "newsletter",
        senderJid: "newsletter@broadcast",
        senderName: "Newsletter",
      }),
    ).toThrow("INVALID_PHONE");
  });
});

describe("whatsappWebDeliveryError", () => {
  it("preserves a disconnected session as an actionable retryable error", () => {
    const error = whatsappWebDeliveryError(
      new Error("WHATSAPP_WEB_SESSION_NOT_CONNECTED"),
    );

    expect(error).toMatchObject({
      code: "WHATSAPP_WEB_SESSION_NOT_CONNECTED",
      retryable: true,
      message: "WhatsApp Web session is not connected",
    });
  });

  it("maps unexpected socket failures without using PROVIDER_UNKNOWN", () => {
    const error = whatsappWebDeliveryError(new Error("socket closed"));

    expect(error).toMatchObject({
      code: "WHATSAPP_WEB_SEND_FAILED",
      retryable: true,
    });
  });
});

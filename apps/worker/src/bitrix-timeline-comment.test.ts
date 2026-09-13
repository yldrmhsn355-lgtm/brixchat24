import { describe, expect, it } from "vitest";
import { bitrixTimelineComment } from "./bitrix-timeline-comment";

const channel = {
  channel_id: "channel-a",
  channel_name: "Satış Hattı",
  channel_phone: "+908501112233",
  phone_number_id: "meta-phone-a",
  business_account_id: "waba-a",
  conversation_id: "conversation-a",
  message_type: "text",
  status: "delivered",
  sent_at: "2026-08-05T10:00:00.000Z",
  provider_message_id: "wamid.123",
};

describe("bitrixTimelineComment", () => {
  it("renders only channel, customer number, and message for inbound", () => {
    const result = bitrixTimelineComment({
      ...channel,
      body: "Merhaba",
      direction: "inbound",
      contact_name: "Hasan",
      normalized_phone: "+905076210286",
    });
    expect(result).toBe(
      "📱 WhatsApp — Gelen mesaj\nKanal: Satış Hattı (+908501112233)\nMüşteri numarası: +905076210286\n\nMerhaba",
    );
  });

  it("keeps outgoing messages equally minimal and normalizes the channel number", () => {
    const result = bitrixTimelineComment({
      ...channel,
      body: "Size nasıl yardımcı olabilirim?",
      direction: "outbound",
      normalized_phone: "+917346233517",
      sender_name: "Hasan Yıldırım",
      channel_phone: "905551112233",
    });
    expect(result).toBe(
      "📱 WhatsApp — Giden mesaj\nKanal: Satış Hattı (+905551112233)\nMüşteri numarası: +917346233517\n\nSize nasıl yardımcı olabilirim?",
    );
  });

  it("never leaks technical identifiers into the timeline", () => {
    const result = bitrixTimelineComment({
      ...channel,
      body: "Merhaba",
      direction: "outbound",
      normalized_phone: "+905076210286",
    });
    for (const forbidden of [
      "Kanal ID",
      "phone_number_id",
      "WABA",
      "Gönderen",
      "Mesaj türü",
      "Durum:",
      "Mesaj zamanı",
      "message ID",
      "Konuşma ID",
      "wamid.123",
      "conversation-a",
      "channel-a",
    ])
      expect(result).not.toContain(forbidden);
  });

  it("falls back gracefully when channel metadata is unavailable", () => {
    const result = bitrixTimelineComment({
      body: "Merhaba",
      direction: "outbound",
      normalized_phone: "+905076210286",
    });
    expect(result).toContain("Kanal: Bilinmeyen kanal (Bilinmiyor)");
    expect(result).toContain("Müşteri numarası: +905076210286");
  });

  it("limits the message body to the Bitrix timeline budget", () => {
    const result = bitrixTimelineComment({
      ...channel,
      body: "x".repeat(1100),
      direction: "inbound",
      normalized_phone: "+905000000000",
    });
    expect(result.endsWith("x".repeat(1000))).toBe(true);
    expect(result).not.toContain("x".repeat(1001));
  });
});

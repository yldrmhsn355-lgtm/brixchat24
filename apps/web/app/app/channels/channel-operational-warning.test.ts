import { describe, expect, it } from "vitest";
import { channelOperationalWarning } from "./channel-operational-warning";

describe("channelOperationalWarning", () => {
  it("does not treat an idle but healthy Meta webhook as broken", () => {
    expect(
      channelOperationalWarning({
        provider: "meta",
        webhookHealth: "HEALTHY",
        session: null,
      }),
    ).toBeNull();
  });

  it("shows actual Meta webhook processing failures", () => {
    expect(
      channelOperationalWarning({
        provider: "meta",
        webhookHealth: "UNHEALTHY",
        session: null,
      }),
    ).toContain("işlenemedi");
  });

  it("keeps WhatsApp Web session errors visible", () => {
    expect(
      channelOperationalWarning({
        provider: "whatsapp_web",
        webhookHealth: "UNKNOWN",
        session: { lastErrorCode: "CONNECTION_CLOSED" },
      }),
    ).toBe("Oturum hatası: CONNECTION_CLOSED");
  });
});

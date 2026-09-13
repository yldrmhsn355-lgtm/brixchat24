import { describe, expect, it } from "vitest";
import {
  countChannelsByPlatform,
  filterChannelsByPlatform,
  readChannelPlatformFilter,
  shouldPollWhatsAppWebSession,
  writeChannelPlatformFilter,
} from "./channel-platform-filter";

describe("channel platform filter", () => {
  const channels = [
    { id: "wa-1", platform: "whatsapp", provider: "meta" },
    { id: "wa-2", platform: "whatsapp", provider: "whatsapp_web" },
    { id: "mail-1", platform: "email" },
  ];

  it("reads only known platform values", () => {
    expect(readChannelPlatformFilter("?platform=whatsapp")).toBe("whatsapp");
    expect(readChannelPlatformFilter("?platform=unknown")).toBe("all");
    expect(readChannelPlatformFilter("")).toBe("all");
  });

  it("writes the platform without dropping other URL state", () => {
    expect(writeChannelPlatformFilter("?view=cards", "telegram")).toBe(
      "?view=cards&platform=telegram",
    );
    expect(
      writeChannelPlatformFilter("?view=cards&platform=telegram", "all"),
    ).toBe("?view=cards");
  });

  it("filters channels while preserving the all view", () => {
    expect(filterChannelsByPlatform(channels, "all")).toHaveLength(3);
    expect(filterChannelsByPlatform(channels, "whatsapp")).toEqual([
      channels[0],
    ]);
    expect(filterChannelsByPlatform(channels, "whatsapp_web")).toEqual([
      channels[1],
    ]);
    expect(filterChannelsByPlatform(channels, "telegram")).toEqual([]);
  });

  it("builds accessible channel counts for every platform", () => {
    expect(countChannelsByPlatform(channels)).toMatchObject({
      whatsapp: 1,
      whatsapp_web: 1,
      email: 1,
      telegram: 0,
      web_chat: 0,
    });
  });

  it("polls transitional WhatsApp Web sessions until they terminate", () => {
    expect(shouldPollWhatsAppWebSession(null)).toBe(true);
    expect(shouldPollWhatsAppWebSession("initializing")).toBe(true);
    expect(shouldPollWhatsAppWebSession("qr_ready")).toBe(true);
    expect(shouldPollWhatsAppWebSession("connected")).toBe(false);
    expect(shouldPollWhatsAppWebSession("logged_out")).toBe(false);
  });
});

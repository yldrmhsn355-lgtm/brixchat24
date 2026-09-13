import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import {
  BaileysWhatsAppWebEngine,
  deliverWhatsAppWebInboundMessage,
  normalizeWhatsAppWebGroupMetadata,
  resolveWhatsAppWebMentionAliases,
  SILENT_BAILEYS_LOGGER,
  type WhatsAppWebInboundMessage,
  whatsappWebContactDisplayName,
  whatsappWebRecipientJid,
} from "./engine";

describe("whatsappWebContactDisplayName", () => {
  it("prefers the saved WhatsApp contact name over profile fallbacks", () => {
    expect(
      whatsappWebContactDisplayName({
        id: "905551112233@s.whatsapp.net",
        name: "Dental Patient",
        verifiedName: "Verified Clinic",
        notify: "Profile Name",
      }),
    ).toBe("Dental Patient");
  });

  it("uses profile metadata but rejects phone-number pseudo names", () => {
    expect(
      whatsappWebContactDisplayName({
        id: "905551112233@s.whatsapp.net",
        name: "+90 555 111 22 33",
        notify: "Profile Name",
      }),
    ).toBe("Profile Name");
    expect(
      whatsappWebContactDisplayName({
        id: "905551112233@s.whatsapp.net",
        notify: "+90 555 111 22 33",
      }),
    ).toBeNull();
  });
});

describe("BaileysWhatsAppWebEngine contact resync", () => {
  it("resets only the contact app-state version before requesting a snapshot", async () => {
    const applyKeyBatch = vi.fn().mockResolvedValue(undefined);
    const resyncAppState = vi.fn().mockResolvedValue(undefined);
    const engine = new BaileysWhatsAppWebEngine(
      "channel-1",
      {
        readCredentials: vi.fn().mockResolvedValue(null),
        writeCredentials: vi.fn().mockResolvedValue(undefined),
        readKey: vi.fn().mockResolvedValue(null),
        applyKeyBatch,
        deleteAll: vi.fn().mockResolvedValue(undefined),
      },
      {
        onStatus: vi.fn(),
        onQr: vi.fn(),
        onConnected: vi.fn(),
        onMessage: vi.fn(),
      },
    );
    Object.assign(
      engine as unknown as {
        socket: { resyncAppState: typeof resyncAppState };
        status: string;
      },
      { socket: { resyncAppState }, status: "connected" },
    );

    await engine.resyncContacts();

    expect(applyKeyBatch).toHaveBeenCalledWith("channel-1", [
      {
        type: "app-state-sync-version",
        id: "critical_unblock_low",
        serialized: null,
      },
    ]);
    expect(resyncAppState).toHaveBeenCalledWith(
      ["critical_unblock_low"],
      true,
    );
  });
});

describe("Baileys logger", () => {
  it("is silent for the socket and all child loggers", () => {
    expect(SILENT_BAILEYS_LOGGER.level).toBe("silent");
    expect(SILENT_BAILEYS_LOGGER.child({ class: "baileys" })).toBe(
      SILENT_BAILEYS_LOGGER,
    );
    expect(() => {
      SILENT_BAILEYS_LOGGER.trace({ secret: "redacted" });
      SILENT_BAILEYS_LOGGER.debug({ secret: "redacted" });
      SILENT_BAILEYS_LOGGER.info({ secret: "redacted" });
      SILENT_BAILEYS_LOGGER.warn({ secret: "redacted" });
      SILENT_BAILEYS_LOGGER.error({ secret: "redacted" });
    }).not.toThrow();
  });

  it("redacts Signal session objects emitted by the transitive runtime", () => {
    const packageRequire = createRequire(import.meta.url);
    const baileysRequire = createRequire(
      packageRequire.resolve("@whiskeysockets/baileys"),
    );
    const SessionRecord = baileysRequire(
      "libsignal/src/session_record",
    ) as new () => {
      sessions: Record<string, { indexInfo: { closed: number } }>;
      closeSession(session: { indexInfo: { closed: number } }): void;
      removeOldSessions(): void;
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const record = new SessionRecord();

    record.closeSession({ indexInfo: { closed: -1 } });
    record.closeSession({ indexInfo: { closed: Date.now() } });
    record.sessions = Object.fromEntries(
      Array.from({ length: 41 }, (_, index) => [
        String(index),
        { indexInfo: { closed: index + 1 } },
      ]),
    );
    record.removeOldSessions();

    expect(info.mock.calls).toContainEqual(["Closing session"]);
    expect(info.mock.calls).toContainEqual(["Removing old closed session"]);
    expect(warn.mock.calls).toContainEqual(["Session already closed"]);
    expect([...info.mock.calls, ...warn.mock.calls].flat()).not.toContainEqual(
      expect.any(Object),
    );
    info.mockRestore();
    warn.mockRestore();
  });
});

describe("whatsappWebRecipientJid", () => {
  it("keeps a group JID intact for group replies", () => {
    expect(whatsappWebRecipientJid("120363000000@g.us")).toBe(
      "120363000000@g.us",
    );
  });

  it("normalizes a direct phone recipient", () => {
    expect(whatsappWebRecipientJid("+90 555 111 22 33")).toBe(
      "905551112233@s.whatsapp.net",
    );
  });
});

describe("normalizeWhatsAppWebGroupMetadata", () => {
  it("keeps participant names, real phone numbers, LIDs and admin state", () => {
    expect(
      normalizeWhatsAppWebGroupMetadata({
        id: "120363000000@g.us",
        subject: "Brix Dental",
        owner: undefined,
        participants: [
          {
            id: "20981166936168@lid",
            lid: "20981166936168@lid",
            phoneNumber: "905559998877@s.whatsapp.net",
            notify: "AyÅŸe YÄ±lmaz",
            admin: "admin",
          },
          { id: "905551112233@s.whatsapp.net" },
        ],
      }),
    ).toEqual({
      chatId: "120363000000@g.us",
      name: "Brix Dental",
      participants: [
        {
          jid: "20981166936168@lid",
          lid: "20981166936168@lid",
          phoneNumber: "+905559998877",
          name: "AyÅŸe YÄ±lmaz",
          isAdmin: true,
        },
        {
          jid: "905551112233@s.whatsapp.net",
          lid: null,
          phoneNumber: "+905551112233",
          name: null,
          isAdmin: false,
        },
      ],
    });
  });
});

describe("deliverWhatsAppWebInboundMessage", () => {
  const message: WhatsAppWebInboundMessage = {
    providerMessageId: "wamid.inbound-1",
    sender: "123",
    senderJid: "123@lid",
    senderName: "Unknown",
    chatId: "123@lid",
    isGroup: false,
    fromMe: false,
    type: "text",
    rawType: "conversation",
    text: "hello",
    metadata: {},
    timestamp: new Date("2026-07-31T00:00:00.000Z"),
  };

  it("isolates one inbound callback failure from the socket lifecycle", async () => {
    const onMessageError = vi.fn();

    await expect(
      deliverWhatsAppWebInboundMessage(
        {
          onMessage: async () => {
            throw new Error("INVALID_PHONE");
          },
          onMessageError,
        },
        message,
      ),
    ).resolves.toBeUndefined();

    expect(onMessageError).toHaveBeenCalledWith({
      providerMessageId: "wamid.inbound-1",
      error: expect.objectContaining({ message: "INVALID_PHONE" }),
    });
  });

  it("also isolates failures in the diagnostic callback", async () => {
    await expect(
      deliverWhatsAppWebInboundMessage(
        {
          onMessage: async () => {
            throw new Error("INVALID_PHONE");
          },
          onMessageError: async () => {
            throw new Error("LOGGING_FAILED");
          },
        },
        message,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("resolveWhatsAppWebMentionAliases", () => {
  it("keeps the raw mention and adds its durable phone JID alias", async () => {
    await expect(
      resolveWhatsAppWebMentionAliases(
        {
          mentionedJids: ["20981166936168@lid", "905551112233@s.whatsapp.net"],
        },
        async (jid) =>
          jid === "20981166936168@lid" ? "905559998877@s.whatsapp.net" : null,
      ),
    ).resolves.toEqual({
      "20981166936168@lid": "905559998877@s.whatsapp.net",
      "905551112233@s.whatsapp.net": "905551112233@s.whatsapp.net",
    });
  });
});

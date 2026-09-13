import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "@brixchat/integrations";
import { downloadInboundMedia } from "./inbound-media-source";

describe("downloadInboundMedia", () => {
  it("decrypts a WhatsApp Web descriptor and bypasses the Meta downloader", async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    const downloadMeta = vi.fn();
    const downloadWhatsAppWeb = vi
      .fn()
      .mockResolvedValue(Uint8Array.from([1, 2, 3]));

    await expect(
      downloadInboundMedia({
        provider: "whatsapp_web",
        mediaId: "web-media-1",
        providerMimeType: "image/jpeg",
        metadata: {
          encryptedMediaDescriptor: encryptSecret(
            "serialized-baileys-message",
            encryptionKey,
          ),
        },
        encryptionKey,
        downloadMeta,
        downloadWhatsAppWeb,
      }),
    ).resolves.toEqual({
      mediaId: "web-media-1",
      contentType: "image/jpeg",
      bytes: Uint8Array.from([1, 2, 3]),
    });
    expect(downloadMeta).not.toHaveBeenCalled();
    expect(downloadWhatsAppWeb).toHaveBeenCalledWith(
      "serialized-baileys-message",
    );
  });

  it("uses the configured provider downloader for Cloud API media", async () => {
    const cloudResult = {
      mediaId: "meta-media-1",
      contentType: "application/pdf",
      bytes: Uint8Array.from([4, 5]),
    };
    const downloadMeta = vi.fn().mockResolvedValue(cloudResult);
    const downloadWhatsAppWeb = vi.fn();

    await expect(
      downloadInboundMedia({
        provider: "meta",
        mediaId: "meta-media-1",
        providerMimeType: "application/pdf",
        metadata: {},
        downloadMeta,
        downloadWhatsAppWeb,
      }),
    ).resolves.toEqual(cloudResult);
    expect(downloadWhatsAppWeb).not.toHaveBeenCalled();
  });

  it("rejects an unencrypted or missing WhatsApp Web descriptor", async () => {
    await expect(
      downloadInboundMedia({
        provider: "whatsapp_web",
        mediaId: "web-media-1",
        providerMimeType: "image/jpeg",
        metadata: {},
        encryptionKey: "test-encryption-key",
        downloadMeta: vi.fn(),
        downloadWhatsAppWeb: vi.fn(),
      }),
    ).rejects.toThrow("WHATSAPP_WEB_MEDIA_DESCRIPTOR_MISSING");
  });
});

import { decryptSecret } from "@brixchat/integrations";

type MediaResult = {
  mediaId: string;
  contentType: string;
  bytes?: Uint8Array;
};

export async function downloadInboundMedia(input: {
  provider: string;
  mediaId: string;
  providerMimeType: string;
  metadata: Record<string, unknown>;
  encryptionKey?: string;
  downloadMeta: () => Promise<MediaResult>;
  downloadWhatsAppWeb: (serializedMessage: string) => Promise<Uint8Array>;
}): Promise<MediaResult> {
  if (input.provider !== "whatsapp_web") return input.downloadMeta();
  const encryptedDescriptor = input.metadata.encryptedMediaDescriptor;
  if (
    typeof encryptedDescriptor !== "string" ||
    !encryptedDescriptor ||
    !input.encryptionKey
  )
    throw new Error("WHATSAPP_WEB_MEDIA_DESCRIPTOR_MISSING");
  const bytes = await input.downloadWhatsAppWeb(
    decryptSecret(encryptedDescriptor, input.encryptionKey),
  );
  return {
    mediaId: input.mediaId,
    contentType: input.providerMimeType,
    bytes,
  };
}

import type { ConversationMessageDto } from "./types";

/**
 * Vision support: loads scanned-safe customer image attachments from object
 * storage and inlines them as base64 data URLs on the trigger messages, so a
 * vision-capable model can see what the customer sent. Bounded hard: at most
 * MAX_VISION_IMAGES per run and MAX_VISION_IMAGE_BYTES per image — a failed
 * or oversized image silently degrades to the text-only "[customer sent an
 * image]" placeholder, never a run failure.
 */

export const MAX_VISION_IMAGES = 2;
export const MAX_VISION_IMAGE_BYTES = 4_000_000;

export interface VisionObjectStorage {
  getObject(input: { key: string }): Promise<ReadableStream<Uint8Array>>;
}

export interface VisionAttachmentLookup {
  imageAttachmentsForMessages(
    organizationId: string,
    messageIds: string[],
  ): Promise<
    Array<{ messageId: string; storageKey: string; mimeType: string; size: number }>
  >;
}

async function streamToBase64(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Buffer.from(merged).toString("base64");
}

export async function attachImagesToTriggers(input: {
  lookup: VisionAttachmentLookup;
  storage: VisionObjectStorage;
  organizationId: string;
  triggers: ConversationMessageDto[];
}): Promise<number> {
  const imageMessages = input.triggers.filter(
    (message) => message.type === "image",
  );
  if (imageMessages.length === 0) return 0;
  const attachments = await input.lookup.imageAttachmentsForMessages(
    input.organizationId,
    imageMessages.map((message) => message.id),
  );
  let attached = 0;
  for (const trigger of imageMessages) {
    if (attached >= MAX_VISION_IMAGES) break;
    const attachment = attachments.find(
      (candidate) => candidate.messageId === trigger.id,
    );
    if (
      !attachment ||
      !attachment.mimeType.startsWith("image/") ||
      (attachment.size > 0 && attachment.size > MAX_VISION_IMAGE_BYTES)
    ) {
      continue;
    }
    try {
      const stream = await input.storage.getObject({
        key: attachment.storageKey,
      });
      const base64 = await streamToBase64(stream, MAX_VISION_IMAGE_BYTES);
      if (!base64) continue;
      trigger.imageDataUrl = `data:${attachment.mimeType};base64,${base64}`;
      attached += 1;
    } catch {
      // Storage failure: fall back to the text placeholder for this image.
    }
  }
  return attached;
}

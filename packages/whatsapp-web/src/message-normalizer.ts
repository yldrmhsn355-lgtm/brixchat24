import {
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
  proto,
  type WAMessage,
} from "@whiskeysockets/baileys";

export type WhatsAppWebMessageType =
  | "text"
  | "image"
  | "document"
  | "audio"
  | "video"
  | "sticker"
  | "location"
  | "contacts"
  | "interactive"
  | "reaction"
  | "unsupported";

export type NormalizedWhatsAppWebContent = {
  action?: "ignore" | "edit" | "revoke";
  type: WhatsAppWebMessageType;
  rawType: string;
  text: string;
  metadata: Record<string, unknown>;
  targetProviderMessageId?: string;
  attachmentMetadata?: Record<string, unknown>;
  serializedMediaMessage?: string;
};

export type WhatsAppWebSenderIdentity = {
  sender: string;
  senderJid: string;
  senderName: string;
  isGroup: boolean;
};

export async function resolveWhatsAppWebLidSender(
  identity: WhatsAppWebSenderIdentity,
  phoneForLid: (lidJid: string) => Promise<string | null>,
): Promise<WhatsAppWebSenderIdentity> {
  if (!identity.senderJid.endsWith("@lid")) return identity;
  const phoneJid = await phoneForLid(identity.senderJid).catch(() => null);
  const phone = phoneFromJid(phoneJid);
  if (!phone) return identity;
  return {
    ...identity,
    sender: phone,
    senderJid: phoneJid!,
    senderName:
      identity.senderName === phoneFromJid(identity.senderJid)
        ? phone
        : identity.senderName,
  };
}

type MessageContent = NonNullable<WAMessage["message"]>;
type ContentItem = Record<string, unknown>;

function item(value: unknown): ContentItem {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ContentItem)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    value &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof value.toNumber === "function"
  )
    return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function phoneFromJid(jid?: string | null): string | null {
  if (!jid) return null;
  return jid.split("@")[0]?.split(":")[0] ?? null;
}

export function resolveWhatsAppWebSender(
  message: WAMessage,
  chatId: string,
): WhatsAppWebSenderIdentity {
  const key = message.key as typeof message.key & {
    participantAlt?: string | null;
    remoteJidAlt?: string | null;
  };
  const primary = key.participant ?? chatId;
  const senderJid = primary.endsWith("@lid")
    ? (key.participantAlt ?? key.remoteJidAlt ?? primary)
    : primary;
  const sender =
    phoneFromJid(senderJid) ?? phoneFromJid(key.remoteJidAlt) ?? chatId;
  return {
    sender,
    senderJid,
    senderName: message.pushName?.trim() || sender,
    isGroup: chatId.endsWith("@g.us"),
  };
}

function messageContext(content: MessageContent, rawType: string): ContentItem {
  const selected = item(content[rawType as keyof MessageContent]);
  return item(selected.contextInfo);
}

function replyMetadata(context: ContentItem): Record<string, unknown> {
  const replyToMessageId = text(context.stanzaId);
  const quotedParticipant = text(context.participant);
  const mentionedJids = Array.isArray(context.mentionedJid)
    ? context.mentionedJid.filter(
        (jid): jid is string => typeof jid === "string" && jid.length > 0,
      )
    : [];
  return {
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(quotedParticipant ? { quotedParticipant } : {}),
    ...(mentionedJids.length ? { mentionedJids } : {}),
    ...(context.isForwarded === true ? { forwarded: true } : {}),
  };
}

function mediaFilename(
  mediaType: "image" | "video" | "audio" | "document" | "sticker",
  media: ContentItem,
  providerMessageId: string,
): string {
  const explicit = text(media.fileName) ?? text(media.title);
  if (explicit) return explicit;
  const mime = text(media.mimetype)?.split(";", 1)[0]?.toLowerCase();
  const extension =
    mime === "image/jpeg"
      ? "jpg"
      : mime === "image/png"
        ? "png"
        : mime === "image/webp"
          ? "webp"
          : mime === "video/mp4"
            ? "mp4"
            : mime === "audio/ogg"
              ? "ogg"
              : mime === "audio/mpeg"
                ? "mp3"
                : mime === "application/pdf"
                  ? "pdf"
                  : "bin";
  return `${mediaType}-${providerMessageId}.${extension}`;
}

function mediaContent(
  message: WAMessage,
  content: MessageContent,
  rawType: string,
  providerMessageId: string,
): NormalizedWhatsAppWebContent | null {
  const mapping = {
    imageMessage: "image",
    videoMessage: "video",
    audioMessage: "audio",
    documentMessage: "document",
    documentWithCaptionMessage: "document",
    stickerMessage: "sticker",
    ptvMessage: "video",
  } as const;
  const type = mapping[rawType as keyof typeof mapping];
  if (!type) return null;
  const media =
    rawType === "documentWithCaptionMessage"
      ? item(item(content.documentWithCaptionMessage).message).documentMessage
      : content[rawType as keyof MessageContent];
  const metadata = item(media);
  const caption =
    text(metadata.caption) ??
    (type === "document" ? text(metadata.fileName) : null) ??
    `[${type}]`;
  const mimeType =
    text(metadata.mimetype) ??
    (type === "sticker" ? "image/webp" : "application/octet-stream");
  return {
    type,
    rawType,
    text: caption,
    metadata: {
      ...replyMetadata(messageContext(content, rawType)),
      mediaType: type,
    },
    attachmentMetadata: {
      id: providerMessageId,
      mime_type: mimeType,
      filename: mediaFilename(type, metadata, providerMessageId),
      ...(type === "audio" ? { voice: metadata.ptt === true } : {}),
      ...(number(metadata.fileLength) !== null
        ? { providerFileSize: number(metadata.fileLength) }
        : {}),
      ...(number(metadata.width) !== null
        ? { width: number(metadata.width) }
        : {}),
      ...(number(metadata.height) !== null
        ? { height: number(metadata.height) }
        : {}),
      ...(number(metadata.seconds) !== null
        ? { durationSeconds: number(metadata.seconds) }
        : {}),
    },
    serializedMediaMessage: Buffer.from(
      proto.WebMessageInfo.encode(message).finish(),
    ).toString("base64"),
  };
}

export function normalizeWhatsAppWebMessage(
  message: WAMessage,
  providerMessageId: string,
): NormalizedWhatsAppWebContent {
  const content = normalizeMessageContent(message.message) ?? {};
  const rawType = getContentType(content) ?? "unknown";

  if (rawType === "protocolMessage") {
    const protocol = content.protocolMessage;
    const protocolType = number(protocol?.type);
    const targetProviderMessageId = text(protocol?.key?.id);
    const metadata = {
      protocolType,
      ...(targetProviderMessageId ? { targetProviderMessageId } : {}),
    };
    if (
      protocolType === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT &&
      targetProviderMessageId &&
      protocol?.editedMessage
    ) {
      const edited = normalizeWhatsAppWebMessage(
        { ...message, message: protocol.editedMessage },
        providerMessageId,
      );
      if (!edited.action)
        return {
          ...edited,
          action: "edit",
          rawType,
          targetProviderMessageId,
          metadata: { ...edited.metadata, ...metadata },
        };
    }
    if (
      protocolType === proto.Message.ProtocolMessage.Type.REVOKE &&
      targetProviderMessageId
    )
      return {
        action: "revoke",
        type: "unsupported",
        rawType,
        text: "",
        targetProviderMessageId,
        metadata,
      };
    return {
      action: "ignore",
      type: "unsupported",
      rawType,
      text: "",
      metadata: { ...metadata, ignoreReason: "whatsapp_control_message" },
    };
  }

  if (
    [
      "albumMessage",
      "secretEncryptedMessage",
      "senderKeyDistributionMessage",
      "placeholderMessage",
      "unknown",
    ].includes(rawType)
  )
    return {
      action: "ignore",
      type: "unsupported",
      rawType,
      text: "",
      metadata: { ignoreReason: "whatsapp_transport_message" },
    };

  const media = mediaContent(message, content, rawType, providerMessageId);
  if (media) return media;

  const context = replyMetadata(messageContext(content, rawType));
  if (rawType === "conversation")
    return {
      type: "text",
      rawType,
      text: text(content.conversation) ?? "",
      metadata: context,
    };
  if (rawType === "extendedTextMessage")
    return {
      type: "text",
      rawType,
      text: text(content.extendedTextMessage?.text) ?? "",
      metadata: context,
    };
  if (rawType === "reactionMessage") {
    const reaction = content.reactionMessage;
    return {
      type: "reaction",
      rawType,
      text: text(reaction?.text) ?? "[reaction]",
      metadata: {
        ...context,
        ...(text(reaction?.key?.id)
          ? { reactionTargetMessageId: reaction!.key!.id }
          : {}),
      },
    };
  }
  if (rawType === "locationMessage" || rawType === "liveLocationMessage") {
    const location = item(
      rawType === "locationMessage"
        ? content.locationMessage
        : content.liveLocationMessage,
    );
    return {
      type: "location",
      rawType,
      text:
        text(location?.name) ??
        text(location?.address) ??
        text(location?.comment) ??
        "Paylaşılan konum",
      metadata: {
        ...context,
        latitude: location.degreesLatitude ?? null,
        longitude: location.degreesLongitude ?? null,
        ...(text(location?.name) ? { name: location!.name } : {}),
        ...(text(location?.address) ? { address: location!.address } : {}),
        ...(rawType === "liveLocationMessage" ? { live: true } : {}),
      },
    };
  }
  if (rawType === "contactMessage") {
    const contact = content.contactMessage;
    return {
      type: "contacts",
      rawType,
      text: text(contact?.displayName) ?? "Paylaşılan kişi",
      metadata: {
        ...context,
        contacts: [
          {
            displayName: contact?.displayName ?? null,
            vcard: contact?.vcard ?? null,
          },
        ],
      },
    };
  }
  if (rawType === "contactsArrayMessage") {
    const contacts = content.contactsArrayMessage;
    return {
      type: "contacts",
      rawType,
      text:
        text(contacts?.displayName) ??
        text(contacts?.contacts?.[0]?.displayName) ??
        "Paylaşılan kişiler",
      metadata: {
        ...context,
        contacts: (contacts?.contacts ?? []).map((contact) => ({
          displayName: contact.displayName ?? null,
          vcard: contact.vcard ?? null,
        })),
      },
    };
  }
  if (rawType === "buttonsResponseMessage") {
    const response = content.buttonsResponseMessage;
    return {
      type: "interactive",
      rawType,
      text:
        text(response?.selectedDisplayText) ??
        text(response?.selectedButtonId) ??
        "[interactive]",
      metadata: {
        ...context,
        interactive: true,
        selectedId: response?.selectedButtonId ?? null,
      },
    };
  }
  if (rawType === "listResponseMessage") {
    const response = content.listResponseMessage;
    return {
      type: "interactive",
      rawType,
      text:
        text(response?.title) ??
        text(response?.description) ??
        text(response?.singleSelectReply?.selectedRowId) ??
        "[interactive]",
      metadata: {
        ...context,
        interactive: true,
        selectedId: response?.singleSelectReply?.selectedRowId ?? null,
      },
    };
  }
  if (rawType === "templateButtonReplyMessage") {
    const response = content.templateButtonReplyMessage;
    return {
      type: "interactive",
      rawType,
      text:
        text(response?.selectedDisplayText) ??
        text(response?.selectedId) ??
        "[interactive]",
      metadata: {
        ...context,
        interactive: true,
        selectedId: response?.selectedId ?? null,
      },
    };
  }
  if (rawType === "interactiveResponseMessage") {
    const response = content.interactiveResponseMessage;
    const params = text(response?.nativeFlowResponseMessage?.paramsJson);
    return {
      type: "interactive",
      rawType,
      text: text(response?.body?.text) ?? "[interactive]",
      metadata: {
        ...context,
        interactive: true,
        ...(params ? { response: params } : {}),
      },
    };
  }

  if (rawType === "templateMessage") {
    const template = item(content.templateMessage);
    const hydrated = item(
      template.hydratedTemplate ?? template.hydratedFourRowTemplate,
    );
    const interactive = item(template.interactiveMessageTemplate);
    const body = item(interactive.body);
    return {
      type: "interactive",
      rawType,
      text:
        text(hydrated.hydratedContentText) ??
        text(body.text) ??
        text(template.templateId) ??
        "WhatsApp şablon mesajı",
      metadata: {
        ...context,
        interactive: true,
        ...(text(template.templateId)
          ? { templateId: template.templateId }
          : {}),
      },
    };
  }

  // User-authored content types without a dedicated mapping must stay
  // visible in the inbox as placeholders; only technical transport
  // envelopes may be dropped into the ignored-message audit trail.
  const poll = item(
    content.pollCreationMessage ??
      content.pollCreationMessageV2 ??
      content.pollCreationMessageV3,
  );
  if (Object.keys(poll).length || rawType.startsWith("pollCreationMessage"))
    return {
      type: "unsupported",
      rawType,
      text: text(poll.name)
        ? `📊 Anket: ${text(poll.name)}`
        : "📊 Anket mesajı",
      metadata: { ...context, userContent: true },
    };
  if (rawType === "eventMessage") {
    const eventItem = item(content.eventMessage);
    return {
      type: "unsupported",
      rawType,
      text: text(eventItem.name)
        ? `📅 Etkinlik: ${text(eventItem.name)}`
        : "📅 Etkinlik daveti",
      metadata: { ...context, userContent: true },
    };
  }
  if (rawType === "orderMessage")
    return {
      type: "unsupported",
      rawType,
      text: "🛒 Sipariş mesajı",
      metadata: { ...context, userContent: true },
    };
  if (rawType === "productMessage") {
    const product = item(item(content.productMessage).product);
    return {
      type: "unsupported",
      rawType,
      text: text(product.title)
        ? `🛍️ Ürün: ${text(product.title)}`
        : "🛍️ Ürün mesajı",
      metadata: { ...context, userContent: true },
    };
  }

  return {
    action: "ignore",
    type: "unsupported",
    rawType,
    text: "",
    metadata: { ...context, ignoreReason: "unsupported_whatsapp_message" },
  };
}

export async function downloadWhatsAppWebMedia(
  serializedMessage: string,
): Promise<Uint8Array> {
  const message = proto.WebMessageInfo.decode(
    Buffer.from(serializedMessage, "base64"),
  ) as WAMessage;
  const bytes = await downloadMediaMessage(message, "buffer", {});
  return new Uint8Array(bytes);
}

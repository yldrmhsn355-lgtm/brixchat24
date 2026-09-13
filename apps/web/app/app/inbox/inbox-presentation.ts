export type TimelineMessage = {
  id: string;
  body: string;
  type: string;
  direction: string;
  status: string;
  sentAt: string;
  senderName?: string;
  attachments: unknown[];
};

type ReconciledMessage = {
  id: string;
  conversationId: string;
  clientMessageId: string | null;
  status: string;
};

export function reconcileLoadedMessages<T extends ReconciledMessage>(
  serverMessages: T[],
  currentMessages: T[],
  conversationId: string,
) {
  const serverIds = new Set(serverMessages.map((message) => message.id));
  const serverClientIds = new Set(
    serverMessages
      .map((message) => message.clientMessageId)
      .filter((id): id is string => Boolean(id)),
  );
  const localOnly = currentMessages.filter(
    (message) =>
      message.conversationId === conversationId &&
      (message.status === "pending" || message.status === "failed") &&
      !serverIds.has(message.id) &&
      (!message.clientMessageId ||
        !serverClientIds.has(message.clientMessageId)),
  );
  return [...serverMessages, ...localOnly];
}

export type GroupParticipant = {
  jid: string;
  lid: string | null;
  phoneNumber: string | null;
  name: string | null;
  isAdmin: boolean;
};

export type GroupParticipantCard = GroupParticipant & {
  displayName: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

export type MessageGroupPosition = "single" | "first" | "middle" | "last";

export type WhatsAppTextSegment = {
  style: "text" | "bold" | "italic" | "strike" | "code";
  text: string;
};

const WHATSAPP_MARKERS = {
  "*": "bold",
  _: "italic",
  "~": "strike",
} as const;

function isFormatBoundary(value: string | undefined) {
  return !value || /[\s([\]{}.,!?;:'"\-]/u.test(value);
}

/**
 * Converts WhatsApp's lightweight formatting markers into safe presentation
 * segments. The returned values are still plain text and are rendered by
 * React, so message content can never inject HTML.
 */
export function parseWhatsAppText(value: string): WhatsAppTextSegment[] {
  const segments: WhatsAppTextSegment[] = [];
  let plain = "";
  let index = 0;

  const flushPlain = () => {
    if (!plain) return;
    segments.push({ style: "text", text: plain });
    plain = "";
  };

  while (index < value.length) {
    if (value.startsWith("```", index)) {
      const closing = value.indexOf("```", index + 3);
      if (closing > index + 3) {
        flushPlain();
        segments.push({
          style: "code",
          text: value.slice(index + 3, closing),
        });
        index = closing + 3;
        continue;
      }
    }

    const marker = value[index] as keyof typeof WHATSAPP_MARKERS;
    const style = WHATSAPP_MARKERS[marker];
    if (style && isFormatBoundary(value[index - 1])) {
      const closing = value.indexOf(marker, index + 1);
      const content = closing > index ? value.slice(index + 1, closing) : "";
      if (
        content.trim() &&
        !content.includes("\n") &&
        isFormatBoundary(value[closing + 1])
      ) {
        flushPlain();
        segments.push({ style, text: content });
        index = closing + 1;
        continue;
      }
    }

    plain += value[index];
    index += 1;
  }

  flushPlain();
  return segments;
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function messageDayKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatMessageDay(value: string, now = new Date()) {
  const date = new Date(value);
  const difference = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / DAY_MS,
  );
  if (difference === 0) return "Bugün";
  if (difference === 1) return "Dün";
  if (difference > 1 && difference < 7)
    return new Intl.DateTimeFormat("tr-TR", { weekday: "long" }).format(date);
  return new Intl.DateTimeFormat("tr-TR", {
    day: "numeric",
    month: "long",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
}

export function formatConversationTime(value: string, now = new Date()) {
  const date = new Date(value);
  const difference = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / DAY_MS,
  );
  if (difference === 0)
    return new Intl.DateTimeFormat("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  if (difference === 1) return "Dün";
  if (difference > 1 && difference < 7)
    return new Intl.DateTimeFormat("tr-TR", { weekday: "short" }).format(date);
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: date.getFullYear() === now.getFullYear() ? undefined : "2-digit",
  }).format(date);
}

export function conversationCardLabels(
  tags: string[],
  stage: string,
  limit = 2,
) {
  const assignedLabels = [...new Set(tags.map((tag) => tag.trim()))].filter(
    Boolean,
  );
  if (assignedLabels.length > 0) return assignedLabels.slice(0, limit);
  const fallbackStage = stage.trim();
  return fallbackStage ? [fallbackStage] : [];
}

export function shouldRenderMessageBody(
  body: string,
  type: string,
  attachmentCount: number,
) {
  if (!body) return false;
  if (!attachmentCount) return type !== "reaction";
  const normalized = body.trim().toLocaleLowerCase();
  return normalized !== `[${type.toLocaleLowerCase()}]`;
}

export function messageDisplayBody(
  body: string,
  metadata: Record<string, unknown>,
  timeline: Array<{
    senderName: string;
    metadata: Record<string, unknown>;
  }> = [],
): string {
  if (typeof metadata.displayText === "string" && metadata.displayText.trim())
    return metadata.displayText;
  const mentionedJids = Array.isArray(metadata.mentionedJids)
    ? metadata.mentionedJids.filter(
        (jid): jid is string => typeof jid === "string" && jid.length > 0,
      )
    : [];
  if (!mentionedJids.length) return body;
  const aliases =
    metadata.mentionedJidAliases &&
    typeof metadata.mentionedJidAliases === "object" &&
    !Array.isArray(metadata.mentionedJidAliases)
      ? (metadata.mentionedJidAliases as Record<string, unknown>)
      : {};
  const names = new Map<string, string>();
  for (const message of timeline) {
    const jid = message.metadata.senderJid;
    const name = message.senderName.trim();
    if (typeof jid === "string" && name && !/^\+?\d+$/.test(name))
      names.set(jid, name);
  }
  return mentionedJids.reduce((text, jid) => {
    const alias = typeof aliases[jid] === "string" ? aliases[jid] : jid;
    const name = names.get(jid) ?? names.get(alias);
    const user = jid.split("@", 1)[0]?.split(":", 1)[0];
    if (!name || !user) return text;
    const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(
      new RegExp(`@${escaped}(?=$|[\\s.,!?;:)\\]}>])`, "g"),
      `@${name}`,
    );
  }, body);
}

function phoneJid(phoneNumber: string | null): string | null {
  const digits = phoneNumber?.replace(/\D/g, "") ?? "";
  return digits ? `${digits}@s.whatsapp.net` : null;
}

export function groupParticipantCards(
  stored: GroupParticipant[],
  timeline: Array<{
    direction: string;
    senderName: string;
    metadata: Record<string, unknown>;
  }>,
): GroupParticipantCard[] {
  const names = new Map<string, string>();
  const participants = new Map<string, GroupParticipant>();
  for (const message of timeline) {
    const jid = message.metadata.senderJid;
    const name = message.senderName.trim();
    if (
      message.direction === "inbound" &&
      typeof jid === "string" &&
      name &&
      name !== "Customer" &&
      !/^\+?\d+$/.test(name)
    )
      names.set(jid, name);
  }
  for (const participant of stored) {
    const key = participant.phoneNumber ?? participant.lid ?? participant.jid;
    participants.set(key, participant);
  }
  for (const message of timeline) {
    const jid = message.metadata.senderJid;
    if (message.direction !== "inbound" || typeof jid !== "string") continue;
    const phone = jid.endsWith("@s.whatsapp.net")
      ? `+${jid.split("@", 1)[0]?.split(":", 1)[0] ?? ""}`
      : null;
    const key = phone ?? jid;
    if (!participants.has(key))
      participants.set(key, {
        jid,
        lid: jid.endsWith("@lid") ? jid : null,
        phoneNumber: phone,
        name: names.get(jid) ?? null,
        isAdmin: false,
      });
  }
  return [...participants.values()]
    .map((participant) => {
      const displayName =
        participant.name ??
        names.get(participant.jid) ??
        (participant.lid ? names.get(participant.lid) : undefined) ??
        (phoneJid(participant.phoneNumber)
          ? names.get(phoneJid(participant.phoneNumber)!)
          : undefined) ??
        participant.phoneNumber ??
        "WhatsApp kullan\u0131c\u0131s\u0131";
      return { ...participant, displayName };
    })
    .sort(
      (left, right) =>
        Number(right.isAdmin) - Number(left.isAdmin) ||
        left.displayName.localeCompare(right.displayName, "tr"),
    );
}

export function formatGroupParticipantPhone(value: string | null): string {
  if (!value) return "Telefon numaras\u0131 al\u0131namad\u0131";
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("90") && digits.length === 12)
    return `+90 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 10)} ${digits.slice(10)}`;
  return value;
}

export function visibleTimelineMessages<T extends TimelineMessage>(
  messages: T[],
) {
  return messages.filter((message) => message.type !== "reaction");
}

export function unreadBoundaryMessageId<T extends TimelineMessage>(
  messages: T[],
  unreadCount: number,
) {
  if (unreadCount <= 0) return null;
  const inbound = messages.filter((message) => message.direction === "inbound");
  return inbound[Math.max(0, inbound.length - unreadCount)]?.id ?? null;
}

function messagesBelongToSameGroup(
  current: TimelineMessage,
  candidate: TimelineMessage | undefined,
) {
  if (!candidate) return false;
  return (
    current.direction === candidate.direction &&
    current.senderName === candidate.senderName &&
    messageDayKey(current.sentAt) === messageDayKey(candidate.sentAt) &&
    Math.abs(
      new Date(current.sentAt).getTime() - new Date(candidate.sentAt).getTime(),
    ) <= MESSAGE_GROUP_WINDOW_MS
  );
}

export function messageGroupPosition<T extends TimelineMessage>(
  messages: T[],
  index: number,
): MessageGroupPosition {
  const current = messages[index];
  if (!current) return "single";
  const joinsPrevious = messagesBelongToSameGroup(current, messages[index - 1]);
  const joinsNext = messagesBelongToSameGroup(current, messages[index + 1]);
  if (!joinsPrevious && !joinsNext) return "single";
  if (!joinsPrevious) return "first";
  if (!joinsNext) return "last";
  return "middle";
}

export function readStoredDrafts(value: string | null) {
  if (!value) return {} as Record<string, string>;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

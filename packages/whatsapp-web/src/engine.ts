import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type AnyMessageContent,
  type Contact,
  type GroupMetadata,
  type WASocket,
} from "@whiskeysockets/baileys";
import { toDataURL } from "qrcode";
import {
  buildWhatsAppWebAuthState,
  type WhatsAppWebAuthStorage,
} from "./auth-state";
import {
  normalizeWhatsAppWebMessage,
  resolveWhatsAppWebLidSender,
  resolveWhatsAppWebSender,
  type WhatsAppWebMessageType,
} from "./message-normalizer";

type BaileysLogger = {
  level: string;
  child(obj: Record<string, unknown>): BaileysLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
};

export const SILENT_BAILEYS_LOGGER: BaileysLogger = {
  level: "silent",
  child: () => SILENT_BAILEYS_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export type WhatsAppWebStatus =
  | "initializing"
  | "qr_ready"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "logged_out"
  | "error";

export type WhatsAppWebInboundMessage = {
  providerMessageId: string;
  sender: string;
  senderJid: string;
  senderName: string;
  chatId: string;
  chatName?: string;
  isGroup: boolean;
  fromMe: boolean;
  type: WhatsAppWebMessageType;
  rawType: string;
  text: string;
  metadata: Record<string, unknown>;
  attachmentMetadata?: Record<string, unknown>;
  serializedMediaMessage?: string;
  timestamp: Date;
};

export type WhatsAppWebMessageMutation = {
  providerMessageId: string;
  targetProviderMessageId: string;
  action: "edit" | "revoke";
  type: WhatsAppWebMessageType;
  text: string;
  metadata: Record<string, unknown>;
  timestamp: Date;
};

export type WhatsAppWebGroupMetadata = {
  chatId: string;
  name: string;
  participants: WhatsAppWebGroupParticipant[];
};

export type WhatsAppWebGroupParticipant = {
  jid: string;
  lid: string | null;
  phoneNumber: string | null;
  name: string | null;
  isAdmin: boolean;
};

export type WhatsAppWebContact = {
  id: string;
  lid: string | null;
  phoneNumber: string | null;
  displayName: string;
};

export function whatsappWebContactDisplayName(
  contact: Partial<Contact>,
): string | null {
  for (const value of [
    contact.name,
    contact.verifiedName,
    contact.notify,
    contact.username,
  ]) {
    const name = value?.trim();
    if (name && !/^\+?[\d\s()\-]+$/.test(name)) return name;
  }
  return null;
}

export type WhatsAppWebCallbacks = {
  onStatus(status: WhatsAppWebStatus): Promise<void> | void;
  onQr(qrDataUrl: string, expiresAt: Date): Promise<void> | void;
  onConnected(identity: {
    phoneNumber: string | null;
    pushName: string | null;
  }): Promise<void> | void;
  onMessage(message: WhatsAppWebInboundMessage): Promise<void> | void;
  onMessageError?(input: {
    providerMessageId: string;
    error: Error;
  }): Promise<void> | void;
  onMessageIgnored?(input: {
    providerMessageId: string;
    rawType: string;
    reason: string;
    fromMe: boolean;
    timestamp: Date;
  }): Promise<void> | void;
  onMessageMutation?(
    mutation: WhatsAppWebMessageMutation,
  ): Promise<void> | void;
  onGroupMetadata?(groups: WhatsAppWebGroupMetadata[]): Promise<void> | void;
  onContacts?(contacts: WhatsAppWebContact[]): Promise<void> | void;
  onGroupParticipantEvent?(input: {
    group: WhatsAppWebGroupMetadata;
    action: "add" | "remove" | "promote" | "demote" | "modify";
    participantJids: string[];
  }): Promise<void> | void;
  listKnownGroupIds?(): Promise<string[]> | string[];
  onMessageStatus?(input: {
    providerMessageId: string;
    status: number;
  }): Promise<void> | void;
  onError?(error: Error): Promise<void> | void;
};

export async function deliverWhatsAppWebInboundMessage(
  callbacks: Pick<WhatsAppWebCallbacks, "onMessage" | "onMessageError">,
  message: WhatsAppWebInboundMessage,
): Promise<void> {
  try {
    await callbacks.onMessage(message);
  } catch (error) {
    await Promise.resolve(
      callbacks.onMessageError?.({
        providerMessageId: message.providerMessageId,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    ).catch(() => undefined);
  }
}

export async function resolveWhatsAppWebMentionAliases(
  metadata: Record<string, unknown>,
  phoneForLid: (lidJid: string) => Promise<string | null>,
): Promise<Record<string, string>> {
  const mentionedJids = Array.isArray(metadata.mentionedJids)
    ? metadata.mentionedJids.filter(
        (jid): jid is string => typeof jid === "string" && jid.length > 0,
      )
    : [];
  const aliases = await Promise.all(
    mentionedJids.map(async (jid) => {
      if (!jid.endsWith("@lid")) return [jid, jid] as const;
      const resolved = await phoneForLid(jid).catch(() => null);
      return [jid, resolved || jid] as const;
    }),
  );
  return Object.fromEntries(aliases);
}

function phoneFromJid(jid?: string | null): string | null {
  if (!jid) return null;
  return jid.split("@")[0]?.split(":")[0] ?? null;
}

function participantPhoneNumber(
  participant: GroupMetadata["participants"][number],
): string | null {
  const jid = participant.phoneNumber?.endsWith("@s.whatsapp.net")
    ? participant.phoneNumber
    : participant.id.endsWith("@s.whatsapp.net")
      ? participant.id
      : null;
  const phone = phoneFromJid(jid);
  return phone && /^\d{8,15}$/.test(phone) ? `+${phone}` : null;
}

export function normalizeWhatsAppWebGroupMetadata(
  metadata: GroupMetadata,
): WhatsAppWebGroupMetadata {
  return {
    chatId: metadata.id,
    name: metadata.subject.trim(),
    participants: metadata.participants.map((participant) => ({
      jid: participant.id,
      lid:
        participant.lid ??
        (participant.id.endsWith("@lid") ? participant.id : null),
      phoneNumber: participantPhoneNumber(participant),
      name:
        participant.name?.trim() ||
        participant.notify?.trim() ||
        participant.verifiedName?.trim() ||
        null,
      isAdmin: Boolean(
        participant.isAdmin ||
        participant.isSuperAdmin ||
        participant.admin === "admin" ||
        participant.admin === "superadmin",
      ),
    })),
  };
}

export function whatsappWebRecipientJid(recipient: string): string {
  const value = recipient.trim();
  if (/^[0-9]+(?::[0-9]+)?@(s\.whatsapp\.net|g\.us|lid)$/.test(value))
    return value;
  const digits = value.replace(/\D/g, "");
  if (!digits) throw new Error("WHATSAPP_WEB_RECIPIENT_INVALID");
  return `${digits}@s.whatsapp.net`;
}

function statusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const output = (error as { output?: { statusCode?: unknown } }).output;
  return typeof output?.statusCode === "number" ? output.statusCode : null;
}

export class BaileysWhatsAppWebEngine {
  readonly provider = "whatsapp_web_baileys";
  private socket: WASocket | null = null;
  private readonly groupDetails = new Map<
    string,
    { value: WhatsAppWebGroupMetadata; expiresAt: number }
  >();
  private readonly contactNames = new Map<string, string>();
  private status: WhatsAppWebStatus = "disconnected";
  private intentionalClose = false;

  constructor(
    private readonly channelId: string,
    private readonly storage: WhatsAppWebAuthStorage,
    private readonly callbacks: WhatsAppWebCallbacks,
  ) {}

  getStatus(): WhatsAppWebStatus {
    return this.status;
  }

  async resyncContacts(): Promise<void> {
    const socket = this.socket;
    if (!socket || this.status !== "connected")
      throw new Error("WHATSAPP_WEB_SESSION_NOT_CONNECTED");
    await this.storage.applyKeyBatch(this.channelId, [
      {
        type: "app-state-sync-version",
        id: "critical_unblock_low",
        serialized: null,
      },
    ]);
    await socket.resyncAppState(["critical_unblock_low"], true);
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    this.intentionalClose = false;
    await this.setStatus("initializing");
    const { state, saveCredentials } = await buildWhatsAppWebAuthState(
      this.channelId,
      this.storage,
    );
    // Persist the initial noise/identity key material before the first QR is
    // exposed. A process restart during pairing must not rotate this identity.
    await saveCredentials();
    const version = await fetchLatestBaileysVersion()
      .then((result) => result.version)
      .catch(() => undefined);
    this.socket = makeWASocket({
      auth: state,
      logger: SILENT_BAILEYS_LOGGER,
      ...(version ? { version } : {}),
      browser: Browsers.windows("Chrome"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    const socket = this.socket;
    const rememberContacts = (contacts: Array<Partial<Contact>>) => {
      const normalized = contacts.flatMap((contact): WhatsAppWebContact[] => {
        const id = contact.id?.trim();
        const displayName = whatsappWebContactDisplayName(contact);
        if (!id || !displayName) return [];
        const item = {
          id,
          lid: contact.lid?.trim() || null,
          phoneNumber: contact.phoneNumber?.trim() || null,
          displayName,
        };
        for (const key of [item.id, item.lid, item.phoneNumber])
          if (key) this.contactNames.set(key, displayName);
        return [item];
      });
      if (normalized.length)
        void Promise.resolve(this.callbacks.onContacts?.(normalized)).catch(
          (error) => void this.report(error),
        );
    };
    socket.ev.on("creds.update", () =>
      void saveCredentials().catch((error) => void this.report(error)),
    );
    socket.ev.on("contacts.upsert", rememberContacts);
    socket.ev.on("contacts.update", rememberContacts);
    socket.ev.on("messaging-history.set", ({ contacts }) =>
      rememberContacts(contacts),
    );
    socket.ev.on("connection.update", (update) => {
      void (async () => {
        if (socket !== this.socket) return;
        if (update.qr) {
          const dataUrl = await toDataURL(update.qr, {
            errorCorrectionLevel: "M",
            margin: 2,
            width: 320,
          });
          await this.setStatus("qr_ready");
          await this.callbacks.onQr(dataUrl, new Date(Date.now() + 55_000));
        }
        if (update.connection === "connecting")
          await this.setStatus("connecting");
        if (update.connection === "open") {
          await this.setStatus("connected");
          await this.callbacks.onConnected({
            phoneNumber: phoneFromJid(socket.user?.id),
            pushName: socket.user?.name ?? null,
          });
          const knownGroupIds = await Promise.resolve(
            this.callbacks.listKnownGroupIds?.() ?? [],
          ).catch(() => []);
          await this.syncGroupNames(socket, knownGroupIds).catch(
            () => undefined,
          );
        }
        if (update.connection === "close") {
          const code = statusCode(update.lastDisconnect?.error);
          const loggedOut = code === DisconnectReason.loggedOut;
          this.socket = null;
          await this.setStatus(
            this.intentionalClose
              ? "disconnected"
              : loggedOut
                ? "logged_out"
                : "reconnecting",
          );
        }
      })().catch((error) => void this.report(error));
    });
    socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      void Promise.all(
        messages.map(async (message) => {
          const providerMessageId = message.key.id;
          const chatId = message.key.remoteJid;
          if (!providerMessageId || !chatId || chatId === "status@broadcast")
            return;
          const normalized = normalizeWhatsAppWebMessage(
            message,
            providerMessageId,
          );
          const rawTimestamp = Number(message.messageTimestamp ?? 0);
          const timestamp = new Date(
            rawTimestamp > 0 ? rawTimestamp * 1000 : Date.now(),
          );
          if (normalized.action === "ignore") {
            await this.callbacks.onMessageIgnored?.({
              providerMessageId,
              rawType: normalized.rawType,
              reason:
                typeof normalized.metadata.ignoreReason === "string"
                  ? normalized.metadata.ignoreReason
                  : "unsupported_whatsapp_message",
              fromMe: message.key.fromMe === true,
              timestamp,
            });
            return;
          }
          if (
            (normalized.action === "edit" || normalized.action === "revoke") &&
            normalized.targetProviderMessageId
          ) {
            await this.callbacks.onMessageMutation?.({
              providerMessageId,
              targetProviderMessageId: normalized.targetProviderMessageId,
              action: normalized.action,
              type: normalized.type,
              text: normalized.text,
              metadata: normalized.metadata,
              timestamp,
            });
            return;
          }
          const phoneForLid = async (lidJid: string) => {
            const lidUser = phoneFromJid(lidJid);
            if (!lidUser) return null;
            const reverseKey = `${lidUser}_reverse`;
            const mapping = await state.keys.get("lid-mapping", [reverseKey]);
            const phone = mapping[reverseKey];
            return typeof phone === "string" ? `${phone}@s.whatsapp.net` : null;
          };
          const identity = await resolveWhatsAppWebLidSender(
            resolveWhatsAppWebSender(message, chatId),
            phoneForLid,
          );
          const mentionedJidAliases = await resolveWhatsAppWebMentionAliases(
            normalized.metadata,
            phoneForLid,
          );
          const group = identity.isGroup
            ? await this.resolveGroupMetadata(socket, chatId)
            : undefined;
          const contactName = [
            chatId,
            identity.senderJid,
            `${identity.sender}@s.whatsapp.net`,
          ].reduce<string | null>(
            (name, key) => name ?? this.contactNames.get(key) ?? null,
            null,
          );
          await deliverWhatsAppWebInboundMessage(this.callbacks, {
            providerMessageId,
            sender: identity.sender,
            senderJid: identity.senderJid,
            senderName: contactName ?? identity.senderName,
            chatId,
            ...(group?.name ? { chatName: group.name } : {}),
            isGroup: identity.isGroup,
            fromMe: message.key.fromMe === true,
            type: normalized.type,
            rawType: normalized.rawType,
            text: normalized.text,
            metadata: {
              ...normalized.metadata,
              ...(Object.keys(mentionedJidAliases).length
                ? { mentionedJidAliases }
                : {}),
              ...(group?.participants.length
                ? { groupParticipants: group.participants }
                : {}),
            },
            ...(normalized.attachmentMetadata
              ? { attachmentMetadata: normalized.attachmentMetadata }
              : {}),
            ...(normalized.serializedMediaMessage
              ? {
                  serializedMediaMessage: normalized.serializedMediaMessage,
                }
              : {}),
            timestamp,
          });
        }),
      ).catch((error) => void this.report(error));
    });
    socket.ev.on("messages.update", (updates) => {
      void Promise.all(
        updates.map(async (update) => {
          if (!update.key.id || update.update.status === undefined) return;
          await this.callbacks.onMessageStatus?.({
            providerMessageId: update.key.id,
            status: Number(update.update.status),
          });
        }),
      ).catch((error) => void this.report(error));
    });
    socket.ev.on("groups.update", (updates) => {
      void Promise.all(
        updates.map(async (update) => {
          if (!update.id) return;
          const metadata = await socket
            .groupMetadata(update.id)
            .catch(() => null);
          if (!metadata?.subject?.trim()) return;
          const group = normalizeWhatsAppWebGroupMetadata(metadata);
          this.cacheGroupMetadata(group);
          await this.callbacks.onGroupMetadata?.([group]);
        }),
      ).catch(() => undefined);
    });
    socket.ev.on(
      "group-participants.update",
      ({ id, participants, action }) => {
        void socket
          .groupMetadata(id)
          .then(async (metadata) => {
            if (!metadata.subject?.trim()) return;
            const group = normalizeWhatsAppWebGroupMetadata(metadata);
            this.cacheGroupMetadata(group);
            await this.callbacks.onGroupMetadata?.([group]);
            await this.callbacks.onGroupParticipantEvent?.({
              group,
              action,
              participantJids: participants
                .map((participant) => participant.id)
                .filter(Boolean)
                .sort(),
            });
          })
          .catch(() => undefined);
      },
    );
  }

  async sendText(
    recipient: string,
    text: string,
    mentionedJids: string[] = [],
  ): Promise<{ providerMessageId: string }> {
    const socket = this.requireConnected();
    const result = await socket.sendMessage(
      whatsappWebRecipientJid(recipient),
      {
        text,
        ...(mentionedJids.length ? { mentions: mentionedJids } : {}),
      },
    );
    if (!result?.key.id) throw new Error("WHATSAPP_WEB_SEND_NOT_ACCEPTED");
    return { providerMessageId: result.key.id };
  }

  async sendMedia(input: {
    recipient: string;
    bytes: Uint8Array;
    mimeType: string;
    filename: string;
    caption?: string;
  }): Promise<{ providerMessageId: string }> {
    const socket = this.requireConnected();
    const caption = input.caption ? { caption: input.caption } : {};
    const payload: AnyMessageContent = input.mimeType.startsWith("image/")
      ? { image: Buffer.from(input.bytes), ...caption }
      : input.mimeType.startsWith("video/")
        ? { video: Buffer.from(input.bytes), ...caption }
        : input.mimeType.startsWith("audio/")
          ? {
              audio: Buffer.from(input.bytes),
              mimetype: input.mimeType,
              ptt: false,
            }
          : {
              document: Buffer.from(input.bytes),
              mimetype: input.mimeType,
              fileName: input.filename,
              ...caption,
            };
    const result = await socket.sendMessage(
      whatsappWebRecipientJid(input.recipient),
      payload,
    );
    if (!result?.key.id) throw new Error("WHATSAPP_WEB_SEND_NOT_ACCEPTED");
    return { providerMessageId: result.key.id };
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.socket?.end(undefined);
    this.socket = null;
    this.groupDetails.clear();
    await this.setStatus("disconnected");
  }

  async logout(): Promise<void> {
    this.intentionalClose = true;
    await this.socket?.logout().catch(() => undefined);
    this.socket = null;
    this.groupDetails.clear();
    await this.storage.deleteAll(this.channelId);
    await this.setStatus("logged_out");
  }

  private requireConnected(): WASocket {
    if (!this.socket || this.status !== "connected")
      throw new Error("WHATSAPP_WEB_SESSION_NOT_CONNECTED");
    return this.socket;
  }

  private async resolveGroupMetadata(
    socket: WASocket,
    chatId: string,
  ): Promise<WhatsAppWebGroupMetadata | undefined> {
    const cached = this.groupDetails.get(chatId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const metadata = await socket.groupMetadata(chatId).catch(() => null);
    const name = metadata?.subject?.trim() || undefined;
    if (!metadata || !name) return undefined;
    const group = normalizeWhatsAppWebGroupMetadata(metadata);
    this.cacheGroupMetadata(group);
    await this.callbacks.onGroupMetadata?.([group]);
    return group;
  }

  private cacheGroupMetadata(group: WhatsAppWebGroupMetadata): void {
    this.groupDetails.set(group.chatId, {
      value: group,
      expiresAt: Date.now() + 5 * 60_000,
    });
  }

  private async syncGroupNames(
    socket: WASocket,
    knownGroupIds: string[],
  ): Promise<void> {
    const fetched = await socket
      .groupFetchAllParticipating()
      .then((groups) => Object.values(groups))
      .catch(() => []);
    const metadataById = new Map(
      fetched
        .map((metadata) => [metadata.id, metadata] as const)
        .filter(
          ([chatId, metadata]) =>
            chatId.endsWith("@g.us") && metadata.subject?.trim(),
        ),
    );
    for (const chatId of knownGroupIds) {
      if (!chatId.endsWith("@g.us") || metadataById.has(chatId)) continue;
      const metadata = await this.fetchGroupMetadataWithRetry(socket, chatId);
      if (metadata?.subject?.trim()) metadataById.set(chatId, metadata);
    }
    const groups = [...metadataById.values()].map(
      normalizeWhatsAppWebGroupMetadata,
    );
    for (const group of groups) this.cacheGroupMetadata(group);
    if (groups.length) await this.callbacks.onGroupMetadata?.(groups);
  }

  private async fetchGroupMetadataWithRetry(socket: WASocket, chatId: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const metadata = await socket.groupMetadata(chatId).catch(() => null);
      if (metadata?.subject?.trim()) return metadata;
      if (attempt < 2)
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return null;
  }

  private async setStatus(status: WhatsAppWebStatus): Promise<void> {
    this.status = status;
    await this.callbacks.onStatus(status);
  }

  private async report(error: unknown): Promise<void> {
    // Must never reject: callers fire-and-forget this from event handlers,
    // and an unhandled rejection here would take down the whole process.
    try {
      await this.callbacks.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    } catch (reportError) {
      console.error("whatsapp-web onError callback failed", reportError);
    }
  }
}

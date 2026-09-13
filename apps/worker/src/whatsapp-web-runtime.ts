import crypto from "node:crypto";
import type postgres from "postgres";
import {
  BaileysWhatsAppWebEngine,
  type WhatsAppWebAuthStorage,
  type WhatsAppWebContact,
  type WhatsAppWebInboundMessage,
  type WhatsAppWebMessageMutation,
} from "@brixchat/whatsapp-web";
import {
  decryptSecret,
  encryptSecret,
  normalizePhone,
  ProviderError,
} from "@brixchat/integrations";
import type { WorkerRepository } from "@brixchat/database";

type Sql = ReturnType<typeof postgres>;

type SessionCandidate = {
  channel_id: string;
  organization_id: string;
};

type StoredInboundMessage = {
  created: boolean;
  messageId: string | null;
  conversationId: string;
  conversationCreated: boolean;
};

type RuntimeOptions = {
  sql: Sql;
  repository: WorkerRepository;
  encryptionKey: string;
  workerId: string;
  publish: (
    organizationId: string,
    eventType: string,
    entityId: string,
    conversationId: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  onInboundStored: (
    organizationId: string,
    result: StoredInboundMessage,
  ) => Promise<void>;
};

function normalizeWhatsAppWebJidIdentity(
  jid: string,
  expectedDomain: "lid" | "g.us",
): string {
  const [rawUser, domain] = jid.split("@", 2);
  const user = rawUser?.split(":", 1)[0] ?? "";
  if (domain !== expectedDomain || !/^\d{8,24}$/.test(user))
    throw new Error("INVALID_PHONE");
  return `+${user}`;
}

export function whatsappWebDeliveryError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const code = error instanceof Error ? error.message : "";
  if (code === "WHATSAPP_WEB_RECIPIENT_INVALID")
    return new ProviderError(code, false, "WhatsApp Web recipient is invalid");
  if (
    code === "WHATSAPP_WEB_SESSION_NOT_CONNECTED" ||
    code === "WHATSAPP_WEB_SEND_NOT_ACCEPTED"
  )
    return new ProviderError(
      code,
      true,
      code === "WHATSAPP_WEB_SESSION_NOT_CONNECTED"
        ? "WhatsApp Web session is not connected"
        : "WhatsApp Web did not accept the message",
    );
  return new ProviderError(
    "WHATSAPP_WEB_SEND_FAILED",
    true,
    "WhatsApp Web could not send the message",
  );
}

export function whatsappWebConversationIdentity(
  message: Pick<
    WhatsAppWebInboundMessage,
    "chatId" | "chatName" | "isGroup" | "sender" | "senderJid" | "senderName"
  >,
): {
  phone: string;
  name: string;
  contactCustomFields?: Record<string, unknown>;
} {
  if (!message.isGroup) {
    try {
      const phone = normalizePhone(message.sender);
      return { phone, name: message.senderName || phone };
    } catch (error) {
      const lidJid = [message.chatId, message.senderJid].find((jid) =>
        jid.endsWith("@lid"),
      );
      if (!lidJid) throw error;
      const phone = normalizeWhatsAppWebJidIdentity(lidJid, "lid");
      return {
        phone,
        name: message.senderName || "WhatsApp kullanıcısı",
        contactCustomFields: {
          whatsappWebChatId: message.chatId,
          whatsappWebConversationType: "direct_lid",
          whatsappWebPhoneResolved: false,
        },
      };
    }
  }
  const phone = normalizeWhatsAppWebJidIdentity(message.chatId, "g.us");
  return {
    phone,
    name: message.chatName?.trim() || "Grup adı alınıyor…",
    contactCustomFields: {
      whatsappWebChatId: message.chatId,
      whatsappWebConversationType: "group",
    },
  };
}

function jidUser(jid: string): string {
  return jid.split("@", 1)[0]?.split(":", 1)[0] ?? jid;
}

function phoneFromWhatsAppJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  try {
    return normalizePhone(jidUser(jid));
  } catch {
    return null;
  }
}

export function formatWhatsAppWebMentions(
  body: string,
  mentions: Array<{ jid: string; displayName: string }>,
): string {
  return mentions.reduce((text, mention) => {
    const user = jidUser(mention.jid);
    if (!user || !mention.displayName.trim()) return text;
    const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(
      new RegExp(`@${escaped}(?=$|[\\s.,!?;:)\\]}>])`, "g"),
      `@${mention.displayName.trim()}`,
    );
  }, body);
}

export function whatsappWebInboundContactCustomFields(
  base: Record<string, unknown> | undefined,
  isGroup: boolean,
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!base) return undefined;
  const participants = Array.isArray(metadata.groupParticipants)
    ? metadata.groupParticipants
    : [];
  return {
    ...base,
    ...(isGroup && participants.length
      ? {
          whatsappWebParticipants: participants,
          whatsappWebParticipantCount: participants.length,
        }
      : {}),
  };
}

export function whatsappWebMessageDirection(
  message: Pick<WhatsAppWebInboundMessage, "fromMe">,
): "inbound" | "outbound" {
  return message.fromMe ? "outbound" : "inbound";
}

export function whatsappWebContactNamePolicy(
  message: Pick<WhatsAppWebInboundMessage, "fromMe" | "isGroup">,
  identity: Pick<
    ReturnType<typeof whatsappWebConversationIdentity>,
    "phone" | "name"
  >,
): { name: string; preserveExisting: boolean } {
  const preserveExisting = message.fromMe && !message.isGroup;
  return {
    name: preserveExisting ? identity.phone : identity.name,
    preserveExisting,
  };
}

export class WhatsAppWebRuntime {
  private readonly engines = new Map<string, BaileysWhatsAppWebEngine>();
  private nextScanAt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RuntimeOptions) {
    // Lease renewal must not depend on the serial job tick: one slow job
    // (media download, CRM full sync) stalling the loop past the 45s lease
    // would let another worker claim a live session and open a second
    // socket over the same credentials.
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch(() => undefined);
    }, 15_000);
    this.heartbeatTimer.unref();
  }

  async tick(): Promise<void> {
    if (Date.now() < this.nextScanAt) {
      await this.heartbeat();
      return;
    }
    this.nextScanAt = Date.now() + 5_000;
    await this.recycleExpiredQrSessions();
    await this.heartbeat();
    await this.retryInboundMessages();
    const claimed = await this.options.sql.begin(async (tx) => {
      const rows = await tx<Array<SessionCandidate>>`
        SELECT s.channel_id,s.organization_id
        FROM whatsapp_web_sessions s
        JOIN channels c
          ON c.id=s.channel_id
         AND c.organization_id=s.organization_id
         AND c.deleted_at IS NULL
        WHERE c.provider='whatsapp_web'
          AND c.connection_status<>'ARCHIVED'
          AND (
            (
              s.status IN (
                'initializing','reconnecting','disconnected','error'
              )
              AND (s.lease_expires_at IS NULL OR s.lease_expires_at<now())
            )
            OR (
              s.status IN ('connected','connecting')
              AND s.lease_expires_at IS NOT NULL
              AND s.lease_expires_at<now()
            )
          )
          AND (s.next_restart_at IS NULL OR s.next_restart_at<=now())
        ORDER BY s.updated_at
        FOR UPDATE OF s SKIP LOCKED
        LIMIT 1`;
      const candidate = rows[0];
      if (!candidate) return null;
      await tx`
        UPDATE whatsapp_web_sessions
        SET assigned_worker_id=${this.options.workerId},
          lease_expires_at=now()+interval '45 seconds',
          last_heartbeat_at=now(),
          status='initializing',
          updated_at=now()
        WHERE channel_id=${candidate.channel_id}::uuid
          AND organization_id=${candidate.organization_id}::uuid`;
      return candidate;
    });
    if (!claimed || this.engines.has(claimed.channel_id)) return;
    await this.start(claimed);
  }

  async sendText(input: {
    channelId: string;
    recipient: string;
    text: string;
    mentionedJids?: string[];
  }): Promise<{ providerMessageId: string }> {
    const engine = this.engines.get(input.channelId);
    if (!engine)
      throw whatsappWebDeliveryError(
        new Error("WHATSAPP_WEB_SESSION_NOT_CONNECTED"),
      );
    try {
      return await engine.sendText(
        input.recipient,
        input.text,
        input.mentionedJids,
      );
    } catch (error) {
      throw whatsappWebDeliveryError(error);
    }
  }

  async sendMedia(input: {
    channelId: string;
    recipient: string;
    bytes: Uint8Array;
    mimeType: string;
    filename: string;
    caption?: string;
  }): Promise<{ providerMessageId: string }> {
    const engine = this.engines.get(input.channelId);
    if (!engine)
      throw whatsappWebDeliveryError(
        new Error("WHATSAPP_WEB_SESSION_NOT_CONNECTED"),
      );
    try {
      return await engine.sendMedia(input);
    } catch (error) {
      throw whatsappWebDeliveryError(error);
    }
  }

  async shutdown(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await Promise.allSettled(
      [...this.engines.values()].map((engine) => engine.disconnect()),
    );
    this.engines.clear();
  }

  private storage(organizationId: string): WhatsAppWebAuthStorage {
    const { sql, encryptionKey } = this.options;
    return {
      readCredentials: async (channelId) => {
        const rows = await sql<Array<{ value: string | null }>>`
          SELECT encrypted_credentials value
          FROM whatsapp_web_sessions
          WHERE organization_id=${organizationId}::uuid
            AND channel_id=${channelId}::uuid`;
        return rows[0]?.value
          ? decryptSecret(rows[0].value, encryptionKey)
          : null;
      },
      writeCredentials: async (channelId, serialized) => {
        await sql`
          UPDATE whatsapp_web_sessions
          SET encrypted_credentials=${encryptSecret(
            serialized,
            encryptionKey,
          )},updated_at=now()
          WHERE organization_id=${organizationId}::uuid
            AND channel_id=${channelId}::uuid`;
      },
      readKey: async (channelId, type, id) => {
        const rows = await sql<Array<{ value: string }>>`
          SELECT encrypted_value value
          FROM whatsapp_web_signal_keys
          WHERE organization_id=${organizationId}::uuid
            AND channel_id=${channelId}::uuid
            AND key_type=${type}
            AND key_id=${id}`;
        return rows[0]?.value
          ? decryptSecret(rows[0].value, encryptionKey)
          : null;
      },
      applyKeyBatch: async (channelId, mutations) => {
        const encrypted = mutations.map((mutation) => ({
          ...mutation,
          serialized:
            mutation.serialized === null
              ? null
              : encryptSecret(mutation.serialized, encryptionKey),
        }));
        await sql.begin(async (tx) => {
          for (const mutation of encrypted) {
            if (mutation.serialized === null) {
              await tx`
                DELETE FROM whatsapp_web_signal_keys
                WHERE organization_id=${organizationId}::uuid
                  AND channel_id=${channelId}::uuid
                  AND key_type=${mutation.type}
                  AND key_id=${mutation.id}`;
              continue;
            }
            await tx`
              INSERT INTO whatsapp_web_signal_keys(
                organization_id,channel_id,key_type,key_id,encrypted_value
              )
              VALUES(
                ${organizationId}::uuid,${channelId}::uuid,
                ${mutation.type},${mutation.id},${mutation.serialized}
              )
              ON CONFLICT(channel_id,key_type,key_id)
              DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,
                updated_at=now()`;
          }
        });
      },
      deleteAll: async (channelId) => {
        await sql.begin(async (tx) => {
          await tx`
            DELETE FROM whatsapp_web_signal_keys
            WHERE organization_id=${organizationId}::uuid
              AND channel_id=${channelId}::uuid`;
          await tx`
            UPDATE whatsapp_web_sessions
            SET encrypted_credentials=NULL,encrypted_qr=NULL,
              qr_expires_at=NULL,updated_at=now()
            WHERE organization_id=${organizationId}::uuid
              AND channel_id=${channelId}::uuid`;
        });
      },
    };
  }

  private async start(session: SessionCandidate): Promise<void> {
    const { channel_id: channelId, organization_id: organizationId } = session;
    const engine = new BaileysWhatsAppWebEngine(
      channelId,
      this.storage(organizationId),
      {
        onStatus: async (status) => {
          // A replaced engine (see onError) must not clobber the state owned
          // by the engine currently registered for this channel.
          const mapped = this.engines.get(channelId);
          if (mapped && mapped !== engine) return;
          await this.options.sql`
            UPDATE whatsapp_web_sessions
            SET status=${status},
              last_heartbeat_at=now(),
              assigned_worker_id=CASE
                WHEN ${status} IN (
                  'reconnecting','disconnected','logged_out','error'
                ) THEN NULL
                ELSE assigned_worker_id
              END,
              lease_expires_at=CASE
                WHEN ${status} IN (
                  'reconnecting','disconnected','logged_out','error'
                ) THEN NULL
                ELSE lease_expires_at
              END,
              next_restart_at=CASE
                WHEN ${status}='reconnecting'
                  THEN now()+interval '5 seconds'
                ELSE next_restart_at
              END,
              last_disconnected_at=CASE
                WHEN ${status} IN ('disconnected','logged_out','error')
                  THEN now()
                ELSE last_disconnected_at
              END,
              updated_at=now()
            WHERE organization_id=${organizationId}::uuid
              AND channel_id=${channelId}::uuid
              AND assigned_worker_id=${this.options.workerId}`;
          // The pairing ended or the socket dropped: without this the
          // channel card keeps showing "connected" (channels.connection_status
          // is only touched here) and the UI never offers the QR re-pair
          // flow, even though whatsapp_web_sessions already moved on.
          if (
            ["reconnecting", "disconnected", "logged_out", "error"].includes(
              status,
            )
          )
            await this.options.sql`
              UPDATE channels
              SET status='disconnected',connection_status='DISCONNECTED',
                health_state='UNKNOWN',updated_at=now()
              WHERE organization_id=${organizationId}::uuid
                AND id=${channelId}::uuid`;
          await this.options.publish(
            organizationId,
            "channel.session_state_changed",
            channelId,
            channelId,
            { status },
          );
          if (
            ["reconnecting", "disconnected", "logged_out", "error"].includes(
              status,
            ) &&
            this.engines.get(channelId) === engine
          )
            this.engines.delete(channelId);
        },
        onQr: async (qrDataUrl, expiresAt) => {
          await this.options.sql`
            UPDATE whatsapp_web_sessions
            SET encrypted_qr=${encryptSecret(
              qrDataUrl,
              this.options.encryptionKey,
            )},qr_expires_at=${expiresAt},status='qr_ready',
              last_heartbeat_at=now(),updated_at=now()
            WHERE organization_id=${organizationId}::uuid
              AND channel_id=${channelId}::uuid
              AND assigned_worker_id=${this.options.workerId}`;
          await this.options.publish(
            organizationId,
            "channel.qr_updated",
            channelId,
            channelId,
            { expiresAt: expiresAt.toISOString() },
          );
        },
        onConnected: async ({ phoneNumber, pushName }) => {
          await this.options.sql.begin(async (tx) => {
            await tx`
              UPDATE whatsapp_web_sessions
              SET status='connected',encrypted_qr=NULL,qr_expires_at=NULL,
                phone_number=${phoneNumber},push_name=${pushName},
                restart_attempts=0,next_restart_at=NULL,
                last_connected_at=now(),last_heartbeat_at=now(),
                last_error=NULL,last_error_code=NULL,updated_at=now()
              WHERE organization_id=${organizationId}::uuid
                AND channel_id=${channelId}::uuid
                AND assigned_worker_id=${this.options.workerId}`;
            await tx`
              UPDATE channels
              SET status='connected',connection_status='ACTIVE',
                health_state='HEALTHY',
                phone_number=COALESCE(${phoneNumber},phone_number),
                updated_at=now()
              WHERE organization_id=${organizationId}::uuid
                AND id=${channelId}::uuid`;
          });
          const sessions = await this.options.sql<
            Array<{ device_info: Record<string, unknown> | null }>
          >`SELECT device_info FROM whatsapp_web_sessions
             WHERE organization_id=${organizationId}::uuid
               AND channel_id=${channelId}::uuid`;
          const contactSyncVersion = Number(
            sessions[0]?.device_info?.whatsappContactSyncVersion ?? 0,
          );
          if (contactSyncVersion < 1) {
            // Fire-and-forget: on a fresh pairing the app-state sync key can
            // arrive shortly after connection open, so a resync rejection
            // must not fail onConnected (which would tear the session down
            // and retry the full resync on every reconnect).
            void engine
              .resyncContacts()
              .then(async () => {
                await this.options.sql`
                  UPDATE whatsapp_web_sessions
                  SET device_info=device_info||${this.options.sql.json({
                    whatsappContactSyncVersion: 1,
                    whatsappContactSyncedAt: new Date().toISOString(),
                  })},updated_at=now()
                  WHERE organization_id=${organizationId}::uuid
                    AND channel_id=${channelId}::uuid`;
              })
              .catch((error) => {
                console.warn(
                  JSON.stringify({
                    event: "whatsapp_web.contact_resync_failed",
                    channelId,
                    error:
                      error instanceof Error
                        ? error.message.slice(0, 200)
                        : "resync_error",
                  }),
                );
              });
          }
        },
        onMessage: async (message) => {
          try {
            await this.ingest(organizationId, channelId, message);
          } catch (error) {
            // Baileys has already acked this message and will not redeliver;
            // park it for replay instead of losing it to a transient failure.
            await this.enqueueInboundRetry(
              organizationId,
              channelId,
              message,
              error,
            );
          }
        },
        onMessageIgnored: async ({
          providerMessageId,
          rawType,
          reason,
          fromMe,
          timestamp,
        }) => {
          await this.recordIgnoredMessage(organizationId, channelId, {
            providerMessageId,
            rawType,
            reason,
            fromMe,
            timestamp,
          });
          console.info(
            JSON.stringify({
              event: "whatsapp_web.transport_message_ignored",
              channelId,
              providerMessageId,
              rawType,
              reason,
            }),
          );
        },
        onMessageMutation: async (mutation) => {
          await this.applyMessageMutation(organizationId, channelId, mutation);
        },
        onMessageError: ({ providerMessageId, error }) => {
          console.warn(
            JSON.stringify({
              event: "whatsapp_web.inbound_message_ignored",
              channelId,
              providerMessageId,
              errorCode: error.message.slice(0, 120),
            }),
          );
        },
        onGroupMetadata: async (groups) => {
          const changedConversations = await this.options.sql.begin(
            async (tx) => {
              const conversationIds = new Set<string>();
              for (const group of groups) {
                const name = group.name.trim();
                if (!name || !group.chatId.endsWith("@g.us")) continue;
                const contacts = await tx<Array<{ id: string }>>`
                  UPDATE contacts
                  SET first_name=${name.split(" ")[0] ?? name},
                    display_name=${name},
                    custom_fields=custom_fields||${tx.json({
                      whatsappWebParticipants: group.participants,
                      whatsappWebParticipantCount: group.participants.length,
                    })},
                    updated_at=now()
                  WHERE organization_id=${organizationId}::uuid
                    AND custom_fields->>'whatsappWebChatId'=${group.chatId}
                  RETURNING id
                `;
                if (!contacts.length) continue;
                await tx`
                  UPDATE messages
                  SET metadata=jsonb_set(
                    metadata,'{chatName}',to_jsonb(${name}::text),true
                  ),updated_at=now()
                  WHERE organization_id=${organizationId}::uuid
                    AND channel_id=${channelId}::uuid
                    AND metadata->>'chatId'=${group.chatId}
                    AND metadata->>'isGroup'='true'
                `;
                const conversations = await tx<Array<{ id: string }>>`
                  SELECT id
                  FROM conversations
                  WHERE organization_id=${organizationId}::uuid
                    AND channel_id=${channelId}::uuid
                    AND contact_id=ANY(${contacts.map((contact) => contact.id)}::uuid[])
                `;
                for (const conversation of conversations)
                  conversationIds.add(conversation.id);
              }
              return [...conversationIds];
            },
          );
          for (const conversationId of changedConversations)
            await this.options.publish(
              organizationId,
              "conversation.group_name_updated",
              conversationId,
              conversationId,
              {},
            );
        },
        onContacts: async (contacts: WhatsAppWebContact[]) => {
          for (const contact of contacts) {
            const identifiers = [
              ...new Set(
                [contact.id, contact.lid, contact.phoneNumber].filter(
                  (value): value is string => Boolean(value),
                ),
              ),
            ];
            const phones = [
              ...new Set(
                identifiers
                  .map(phoneFromWhatsAppJid)
                  .filter((value): value is string => Boolean(value)),
              ),
            ];
            const updated = await this.options.sql<Array<{ id: string }>>`
              UPDATE contacts contact
              SET first_name=${contact.displayName.split(" ")[0] ?? contact.displayName},
                display_name=${contact.displayName},
                custom_fields=contact.custom_fields||${this.options.sql.json({
                  whatsappDisplayName: contact.displayName,
                  whatsappDisplayNameSource: "contact_sync",
                })},
                updated_at=now()
              WHERE contact.organization_id=${organizationId}::uuid
                AND (
                  contact.display_name=contact.normalized_phone
                  OR contact.display_name~'^\\+?[0-9 ()-]+$'
                )
                AND EXISTS(
                  SELECT 1 FROM conversations conversation
                  WHERE conversation.organization_id=contact.organization_id
                    AND conversation.contact_id=contact.id
                    AND conversation.channel_id=${channelId}::uuid
                )
                AND (
                  contact.normalized_phone=ANY(${phones}::text[])
                  OR contact.custom_fields->>'whatsappWebChatId'=ANY(${identifiers}::text[])
                  OR EXISTS(
                    SELECT 1 FROM messages message
                    WHERE message.organization_id=contact.organization_id
                      AND message.channel_id=${channelId}::uuid
                      AND message.contact_id=contact.id
                      AND message.metadata->>'chatId'=ANY(${identifiers}::text[])
                  )
                )
              RETURNING contact.id`;
            for (const row of updated) {
              const conversations = await this.options.sql<
                Array<{ id: string }>
              >`
                SELECT id FROM conversations
                WHERE organization_id=${organizationId}::uuid
                  AND channel_id=${channelId}::uuid
                  AND contact_id=${row.id}::uuid`;
              for (const conversation of conversations)
                await this.options.publish(
                  organizationId,
                  "conversation.contact_updated",
                  conversation.id,
                  conversation.id,
                  { contactId: row.id },
                );
            }
          }
        },
        onGroupParticipantEvent: async ({ group, action, participantJids }) => {
          const eventType = `group.participant_${
            action === "add"
              ? "added"
              : action === "remove"
                ? "removed"
                : action === "promote"
                  ? "promoted"
                  : action === "demote"
                    ? "demoted"
                    : "modified"
          }`;
          const eventFingerprint = crypto
            .createHash("sha256")
            .update(
              [channelId, group.chatId, action, ...participantJids].join("|"),
            )
            .digest("hex");
          const conversations = await this.options.sql<Array<{ id: string }>>`
            SELECT conversation.id
            FROM conversations conversation
            JOIN contacts contact ON contact.id=conversation.contact_id
            WHERE conversation.organization_id=${organizationId}::uuid
              AND conversation.channel_id=${channelId}::uuid
              AND contact.custom_fields->>'whatsappWebChatId'=${group.chatId}
          `;
          for (const conversation of conversations) {
            const correlationId = crypto.randomUUID();
            const payload = {
              channelId,
              chatId: group.chatId,
              chatName: group.name,
              isGroup: true,
              action,
              participantJids,
              participants: group.participants,
              participantCount: group.participants.length,
              eventFingerprint,
            };
            const inserted = await this.options.sql<Array<{ id: string }>>`
              INSERT INTO automation_events(
                organization_id,event_type,aggregate_type,aggregate_id,
                conversation_id,correlation_id,origin,depth,payload
              )
              SELECT ${organizationId}::uuid,${eventType},'conversation',
                ${conversation.id}::uuid,${conversation.id}::uuid,
                ${correlationId}::uuid,'whatsapp_web',0,
                ${this.options.sql.json(payload as never)}
              WHERE NOT EXISTS(
                SELECT 1 FROM automation_events
                WHERE organization_id=${organizationId}::uuid
                  AND event_type=${eventType}
                  AND conversation_id=${conversation.id}::uuid
                  AND payload->>'eventFingerprint'=${eventFingerprint}
                  AND created_at>now()-interval '15 seconds'
              )
              RETURNING id
            `;
            if (!inserted.length) continue;
            await this.options.publish(
              organizationId,
              eventType,
              conversation.id,
              conversation.id,
              payload,
            );
          }
        },
        listKnownGroupIds: async () => {
          const rows = await this.options.sql<Array<{ chat_id: string }>>`
            SELECT DISTINCT custom_fields->>'whatsappWebChatId' chat_id
            FROM contacts
            WHERE organization_id=${organizationId}::uuid
              AND custom_fields->>'whatsappWebConversationType'='group'
              AND custom_fields->>'whatsappWebChatId' LIKE '%@g.us'
          `;
          return rows.map((row) => row.chat_id);
        },
        onMessageStatus: async ({ providerMessageId, status }) => {
          const mapped =
            status >= 4
              ? "read"
              : status >= 3
                ? "delivered"
                : status >= 2
                  ? "sent"
                  : null;
          if (!mapped) return;
          await this.options.repository.status({
            organizationId,
            providerMessageId,
            status: mapped,
            providerTimestamp: new Date(),
            eventKey: `whatsapp_web:${providerMessageId}:${mapped}`,
            payload: { provider: "whatsapp_web", baileysStatus: status },
          });
        },
        onError: async (error) => {
          const mapped = this.engines.get(channelId);
          if (mapped && mapped !== engine) {
            // This engine was already replaced; only make sure its socket
            // dies instead of resetting the healthy successor's session.
            void engine.disconnect().catch(() => undefined);
            return;
          }
          await this.options.sql`
            UPDATE whatsapp_web_sessions
            SET status='error',last_error_code='WHATSAPP_WEB_RUNTIME_ERROR',
              last_error=${error.message.slice(0, 500)},
              restart_attempts=restart_attempts+1,
              next_restart_at=now()+
                (LEAST(300,restart_attempts*restart_attempts+5)*
                  interval '1 second'),
              lease_expires_at=NULL,assigned_worker_id=NULL,updated_at=now()
            WHERE organization_id=${organizationId}::uuid
              AND channel_id=${channelId}::uuid`;
          this.engines.delete(channelId);
          // The Baileys socket keeps ingesting (and writing signal keys) if
          // left open, which corrupts shared auth state once a restarted
          // engine attaches to the same credentials.
          void engine.disconnect().catch(() => undefined);
        },
      },
    );
    this.engines.set(channelId, engine);
    await engine.connect().catch(async (error) => {
      this.engines.delete(channelId);
      throw error;
    });
  }

  private async enqueueInboundRetry(
    organizationId: string,
    channelId: string,
    message: WhatsAppWebInboundMessage,
    cause: unknown,
  ): Promise<void> {
    const reason = (
      cause instanceof Error ? cause.message : String(cause)
    ).slice(0, 500);
    try {
      await this.options.sql`
        INSERT INTO whatsapp_web_inbound_retries(
          organization_id,channel_id,provider_message_id,message,
          next_attempt_at,last_error
        ) VALUES(
          ${organizationId}::uuid,${channelId}::uuid,
          ${message.providerMessageId},
          ${this.options.sql.json({
            ...message,
            timestamp: message.timestamp.toISOString(),
          } as never)},
          now()+interval '10 seconds',${reason}
        )
        ON CONFLICT(channel_id,provider_message_id) DO NOTHING`;
      console.warn(
        JSON.stringify({
          event: "whatsapp_web.inbound_retry_enqueued",
          channelId,
          providerMessageId: message.providerMessageId,
          reason,
        }),
      );
    } catch (enqueueError) {
      console.error(
        JSON.stringify({
          event: "whatsapp_web.inbound_retry_enqueue_failed",
          channelId,
          providerMessageId: message.providerMessageId,
          reason,
        }),
        enqueueError,
      );
      throw cause instanceof Error ? cause : new Error(reason);
    }
  }

  private async retryInboundMessages(): Promise<void> {
    const rows = await this.options.sql<Array<Record<string, unknown>>>`
      WITH candidate AS(
        SELECT id FROM whatsapp_web_inbound_retries
        WHERE (status='pending' AND next_attempt_at<=now())
           OR (status='processing' AND locked_at<now()-interval '2 minutes')
        ORDER BY next_attempt_at
        FOR UPDATE SKIP LOCKED
        LIMIT 5)
      UPDATE whatsapp_web_inbound_retries r
      SET status='processing',locked_at=now(),
        locked_by=${this.options.workerId},
        attempt_count=r.attempt_count+1,updated_at=now()
      FROM candidate WHERE r.id=candidate.id
      RETURNING r.*`;
    for (const row of rows) {
      const stored = (row.message ?? {}) as Record<string, unknown>;
      const message = {
        ...stored,
        timestamp: new Date(String(stored.timestamp ?? row.created_at)),
      } as WhatsAppWebInboundMessage;
      try {
        await this.ingest(
          String(row.organization_id),
          String(row.channel_id),
          message,
        );
        await this.options.sql`
          DELETE FROM whatsapp_web_inbound_retries
          WHERE id=${String(row.id)}::uuid`;
      } catch (error) {
        const dead = Number(row.attempt_count) >= Number(row.max_attempts);
        await this.options.sql`
          UPDATE whatsapp_web_inbound_retries
          SET status=${dead ? "dead_letter" : "pending"},
            last_error=${(error instanceof Error ? error.message : "inbound_retry_error").slice(0, 500)},
            next_attempt_at=now()+
              (LEAST(600,attempt_count*attempt_count*5)*interval '1 second'),
            locked_at=NULL,locked_by=NULL,updated_at=now()
          WHERE id=${String(row.id)}::uuid`;
      }
    }
  }

  private async ingest(
    organizationId: string,
    channelId: string,
    message: WhatsAppWebInboundMessage,
  ): Promise<void> {
    const identity = whatsappWebConversationIdentity(message);
    const contactName = whatsappWebContactNamePolicy(message, identity);
    const contactCustomFields = whatsappWebInboundContactCustomFields(
      identity.contactCustomFields,
      message.isGroup,
      message.metadata,
    );
    const mentions = await this.resolveMentionNames(
      organizationId,
      channelId,
      message,
    );
    const displayText = formatWhatsAppWebMentions(message.text, mentions);
    const stored = await this.options.repository.incoming({
      organizationId,
      channelId,
      phone: identity.phone,
      name: contactName.name,
      preserveContactName: contactName.preserveExisting,
      ...(contactCustomFields ? { contactCustomFields } : {}),
      text: message.text,
      type: message.type,
      providerMessageId: message.providerMessageId,
      providerTimestamp: message.timestamp,
      metadata: {
        provider: "whatsapp_web",
        chatId: message.chatId,
        ...(message.chatName ? { chatName: message.chatName } : {}),
        senderJid: message.senderJid,
        senderName: message.senderName,
        isGroup: message.isGroup,
        fromMe: message.fromMe,
        rawType: message.rawType,
        ...message.metadata,
        ...(mentions.length ? { mentions } : {}),
        ...(displayText !== message.text ? { displayText } : {}),
      },
      ...(message.attachmentMetadata
        ? {
            attachmentMetadata: {
              ...message.attachmentMetadata,
              ...(message.serializedMediaMessage
                ? {
                    encryptedMediaDescriptor: encryptSecret(
                      message.serializedMediaMessage,
                      this.options.encryptionKey,
                    ),
                  }
                : {}),
            },
          }
        : {}),
      provider: "whatsapp_web",
      direction: whatsappWebMessageDirection(message),
      traceId: crypto.randomUUID(),
    });
    await this.reconcileMessageMutations(
      organizationId,
      channelId,
      message.providerMessageId,
    );
    await this.options.onInboundStored(organizationId, stored);
  }

  async applyMessageMutation(
    organizationId: string,
    channelId: string,
    mutation: WhatsAppWebMessageMutation,
  ): Promise<void> {
    await this.options.sql`
      INSERT INTO whatsapp_web_message_mutations(
        organization_id,channel_id,event_provider_message_id,
        target_provider_message_id,mutation_type,message_type,body,
        metadata,provider_timestamp
      ) VALUES(
        ${organizationId}::uuid,${channelId}::uuid,
        ${mutation.providerMessageId},${mutation.targetProviderMessageId},
        ${mutation.action},${mutation.type},${mutation.text},
        ${this.options.sql.json(mutation.metadata as never)},
        ${mutation.timestamp}
      )
      ON CONFLICT(channel_id,event_provider_message_id) DO NOTHING`;
    await this.reconcileMessageMutations(
      organizationId,
      channelId,
      mutation.targetProviderMessageId,
    );
  }

  async recordIgnoredMessage(
    organizationId: string,
    channelId: string,
    message: {
      providerMessageId: string;
      rawType: string;
      reason: string;
      fromMe: boolean;
      timestamp: Date;
    },
  ): Promise<void> {
    await this.options.sql`
      INSERT INTO whatsapp_web_ignored_messages(
        organization_id,channel_id,provider_message_id,raw_type,
        reason,direction,provider_timestamp
      ) VALUES(
        ${organizationId}::uuid,${channelId}::uuid,
        ${message.providerMessageId},${message.rawType},${message.reason},
        ${message.fromMe ? "outbound" : "inbound"},${message.timestamp}
      )
      ON CONFLICT(channel_id,provider_message_id) DO NOTHING`;
  }

  async reconcileMessageMutations(
    organizationId: string,
    channelId: string,
    targetProviderMessageId: string,
  ): Promise<void> {
    const applied = await this.options.sql.begin(async (tx) => {
      const mutations = await tx<Array<Record<string, unknown>>>`
        SELECT * FROM whatsapp_web_message_mutations
        WHERE organization_id=${organizationId}::uuid
          AND channel_id=${channelId}::uuid
          AND target_provider_message_id=${targetProviderMessageId}
          AND status='pending'
        ORDER BY provider_timestamp,created_at
        FOR UPDATE`;
      const changed: Array<{
        messageId: string;
        conversationId: string;
        action: string;
      }> = [];
      for (const mutation of mutations) {
        const action = String(mutation.mutation_type);
        const mutationMetadata =
          mutation.metadata &&
          typeof mutation.metadata === "object" &&
          !Array.isArray(mutation.metadata)
            ? (mutation.metadata as Record<string, unknown>)
            : {};
        const rows = await tx<Array<Record<string, unknown>>>`
          UPDATE messages
          SET body=CASE WHEN ${action}='revoke'
                THEN 'Bu mesaj silindi'
                ELSE ${String(mutation.body ?? "")}
              END,
              type=CASE WHEN ${action}='revoke'
                THEN 'text'
                ELSE ${String(mutation.message_type ?? "text")}
              END,
              metadata=metadata||${tx.json({
                ...mutationMetadata,
                whatsappMutation: action,
                mutationProviderMessageId: String(
                  mutation.event_provider_message_id,
                ),
                whatsappMutationTimestamp: new Date(
                  String(mutation.provider_timestamp),
                ).toISOString(),
                ...(action === "revoke" ? { revoked: true } : { edited: true }),
              } as never)},
              updated_at=now()
          WHERE organization_id=${organizationId}::uuid
            AND channel_id=${channelId}::uuid
            AND provider_message_id=${targetProviderMessageId}
            AND COALESCE(
              NULLIF(metadata->>'whatsappMutationTimestamp','')::timestamptz,
              '-infinity'::timestamptz
            )<=${String(mutation.provider_timestamp)}::timestamptz
            AND (
              ${action}='revoke'
              OR metadata->>'revoked' IS DISTINCT FROM 'true'
            )
          RETURNING id,conversation_id`;
        const row = rows[0];
        if (!row) {
          const targets = await tx<Array<{ id: string }>>`
            SELECT id FROM messages
            WHERE organization_id=${organizationId}::uuid
              AND channel_id=${channelId}::uuid
              AND provider_message_id=${targetProviderMessageId}`;
          if (targets[0])
            await tx`
              UPDATE whatsapp_web_message_mutations
              SET status='ignored',applied_message_id=${targets[0].id}::uuid,
                applied_at=now(),updated_at=now()
              WHERE id=${String(mutation.id)}::uuid`;
          continue;
        }
        if (action === "revoke")
          await tx`
            UPDATE message_attachments
            SET processing_status='deleted',deleted_at=COALESCE(deleted_at,now()),
              updated_at=now()
            WHERE organization_id=${organizationId}::uuid
              AND message_id=${String(row.id)}::uuid`;
        await tx`
          UPDATE whatsapp_web_message_mutations
          SET status='applied',applied_message_id=${String(row.id)}::uuid,
            applied_at=now(),updated_at=now()
          WHERE id=${String(mutation.id)}::uuid`;
        changed.push({
          messageId: String(row.id),
          conversationId: String(row.conversation_id),
          action,
        });
      }
      return changed;
    });
    for (const mutation of applied)
      await this.options.publish(
        organizationId,
        "message.updated",
        mutation.messageId,
        mutation.conversationId,
        { messageId: mutation.messageId, action: mutation.action },
      );
  }

  private async resolveMentionNames(
    organizationId: string,
    channelId: string,
    message: WhatsAppWebInboundMessage,
  ): Promise<Array<{ jid: string; displayName: string }>> {
    const mentionedJids = Array.isArray(message.metadata.mentionedJids)
      ? message.metadata.mentionedJids.filter(
          (jid): jid is string => typeof jid === "string" && jid.length > 0,
        )
      : [];
    if (!message.isGroup || !mentionedJids.length) return [];
    const aliases =
      message.metadata.mentionedJidAliases &&
      typeof message.metadata.mentionedJidAliases === "object" &&
      !Array.isArray(message.metadata.mentionedJidAliases)
        ? (message.metadata.mentionedJidAliases as Record<string, unknown>)
        : {};
    const candidateJids = [
      ...new Set(
        mentionedJids.flatMap((jid) => [
          jid,
          typeof aliases[jid] === "string" ? aliases[jid] : jid,
        ]),
      ),
    ];
    const rows = await this.options.sql<
      Array<{ sender_jid: string; sender_name: string }>
    >`
      SELECT metadata->>'senderJid' sender_jid,
        metadata->>'senderName' sender_name
      FROM messages
      WHERE organization_id=${organizationId}::uuid
        AND channel_id=${channelId}::uuid
        AND metadata->>'chatId'=${message.chatId}
        AND metadata->>'senderJid'=ANY(${candidateJids}::text[])
        AND NULLIF(BTRIM(metadata->>'senderName'),'') IS NOT NULL
      ORDER BY COALESCE(provider_timestamp,sent_at) DESC
      LIMIT 200
    `;
    const names = new Map<string, string>();
    for (const row of rows) {
      const name = row.sender_name.trim();
      if (!name || /^\+?\d+$/.test(name) || name === jidUser(row.sender_jid))
        continue;
      if (!names.has(row.sender_jid)) names.set(row.sender_jid, name);
    }
    return mentionedJids.flatMap((jid) => {
      const alias = typeof aliases[jid] === "string" ? aliases[jid] : jid;
      const displayName = names.get(jid) ?? names.get(alias);
      return displayName ? [{ jid, displayName }] : [];
    });
  }

  private async heartbeat(): Promise<void> {
    if (!this.engines.size) return;
    await this.options.sql`
      UPDATE whatsapp_web_sessions
      SET last_heartbeat_at=now(),
        lease_expires_at=now()+interval '45 seconds',
        updated_at=now()
      WHERE assigned_worker_id=${this.options.workerId}
        AND channel_id=ANY(${[...this.engines.keys()]}::uuid[])`;
  }

  private async recycleExpiredQrSessions(): Promise<void> {
    const expired = await this.options.sql<Array<{ channel_id: string }>>`
      SELECT channel_id
      FROM whatsapp_web_sessions
      WHERE status='qr_ready'
        AND qr_expires_at IS NOT NULL
        AND qr_expires_at<=now()
        AND (
          assigned_worker_id=${this.options.workerId}
          OR lease_expires_at IS NULL
          OR lease_expires_at<now()
        )`;
    for (const session of expired) {
      const engine = this.engines.get(session.channel_id);
      if (engine) await engine.disconnect();
      this.engines.delete(session.channel_id);
      await this.options.sql`
        UPDATE whatsapp_web_sessions
        SET status='initializing',
          encrypted_qr=NULL,
          qr_expires_at=NULL,
          assigned_worker_id=NULL,
          lease_expires_at=NULL,
          next_restart_at=now(),
          updated_at=now()
        WHERE channel_id=${session.channel_id}::uuid
          AND status IN ('qr_ready','disconnected')
          AND (
            assigned_worker_id=${this.options.workerId}
            OR lease_expires_at IS NULL
            OR lease_expires_at<now()
          )`;
    }
  }
}

import type { DatabaseClient } from "./index";

const BITRIX_MEDIA_PLACEHOLDER =
  /\[(?:image|file|disk|attachment)(?:=[^\]]*)?\]/gi;
const BITRIX_OPERATOR_PREFIX =
  /^\s*\[b\][\s\S]*?:\s*\[\/b\]\s*(?:\[br\s*\/?\])?\s*/i;
// Only strip tags Bitrix actually emits; a generic [word] matcher would also
// delete legitimate bracketed text an operator typed (e.g. "[KDV dahil]").
const BITRIX_BBCODE_TAG =
  /\[\/?(?:b|i|u|s|p|br|code|quote|url|img|image|video|audio|file|disk|attachment|size|color|font|list|li|ul|ol|table|tr|td|th|center|justify|user|chat|call|icon|rating|put|send|spoiler|sub|sup)(?:=[^\]]*)?\s*\/?\]/gi;

/** Convert Bitrix BBCode to the formatting understood by WhatsApp text messages. */
export function normalizeBitrixOperatorMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  const messageContent = raw.replace(BITRIX_OPERATOR_PREFIX, "");
  const visibleContent = messageContent
    .replace(BITRIX_MEDIA_PLACEHOLDER, "")
    .replace(/\[br\s*\/?\]/gi, " ")
    .replace(BITRIX_BBCODE_TAG, "")
    .trim();
  if (!visibleContent) return null;

  const normalized = raw
    .replace(/\[br\s*\/?\]/gi, "\n")
    .replace(/\[\/?p\]/gi, "\n")
    .replace(/\[b\]([\s\S]*?)\[\/b\]/gi, "*$1*")
    .replace(/\[i\]([\s\S]*?)\[\/i\]/gi, "_$1_")
    .replace(/\[s\]([\s\S]*?)\[\/s\]/gi, "~$1~")
    .replace(/\[code\]([\s\S]*?)\[\/code\]/gi, "`$1`")
    .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, "$2 ($1)")
    .replace(/\[url\]([\s\S]*?)\[\/url\]/gi, "$1")
    .replace(/\[u\]([\s\S]*?)\[\/u\]/gi, "$1")
    .replace(BITRIX_MEDIA_PLACEHOLDER, "")
    .replace(BITRIX_BBCODE_TAG, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized.replace(/[*_~`\s]/g, "") ? normalized : null;
}

export interface ClaimedCrmJob {
  id: string;
  organizationId: string;
  connectionId: string;
  jobType: string;
  aggregateId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
  authMode: string;
  portalUrl: string | null;
  credentialsEncrypted: string | null;
  settings: Record<string, unknown>;
  automationDefaultChannelId: string | null;
}
export interface ClaimedCrmWebhook {
  id: string;
  organizationId: string;
  connectionId: string;
  eventType: string;
  payload: Record<string, unknown>;
  settings: Record<string, unknown>;
  authMode: string;
  portalUrl: string | null;
  credentialsEncrypted: string | null;
}

function bitrixWebhookData(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (
    typeof payload.data === "object" &&
    payload.data !== null &&
    !Array.isArray(payload.data)
  )
    return payload.data as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  const unsafeSegments = new Set(["__proto__", "constructor", "prototype"]);
  for (const [key, value] of Object.entries(payload)) {
    if (!key.startsWith("data[")) continue;
    const segments = [...key.matchAll(/\[([^\]]+)\]/g)].map(
      (match) => match[1] ?? "",
    );
    if (
      !segments.length ||
      segments.some((segment) => !segment || unsafeSegments.has(segment))
    )
      continue;

    let cursor: Record<string, unknown> | unknown[] = data;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const last = index === segments.length - 1;
      const numericSegment = /^\d+$/.test(segment);
      const keyOrIndex = numericSegment ? Number(segment) : segment;
      if (last) {
        if (Array.isArray(cursor) && typeof keyOrIndex === "number")
          cursor[keyOrIndex] = value;
        else if (!Array.isArray(cursor) && typeof keyOrIndex === "string")
          cursor[keyOrIndex] = value;
        break;
      }

      const nextIsNumeric = /^\d+$/.test(segments[index + 1]!);
      let child: unknown;
      if (Array.isArray(cursor) && typeof keyOrIndex === "number")
        child = cursor[keyOrIndex];
      else if (!Array.isArray(cursor) && typeof keyOrIndex === "string")
        child = cursor[keyOrIndex];
      if (typeof child !== "object" || child === null) {
        child = nextIsNumeric ? [] : {};
        if (Array.isArray(cursor) && typeof keyOrIndex === "number")
          cursor[keyOrIndex] = child;
        else if (!Array.isArray(cursor) && typeof keyOrIndex === "string")
          cursor[keyOrIndex] = child;
      }
      cursor = child as Record<string, unknown> | unknown[];
    }
  }
  return data;
}

export class CrmWorkerRepository {
  constructor(private readonly sql: DatabaseClient) {}
  async claimJob(workerId: string): Promise<ClaimedCrmJob | null> {
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`WITH candidate AS(SELECT j.id FROM crm_sync_jobs j JOIN integration_connections c ON c.id=j.connection_id WHERE ((j.status IN('pending','retry') AND j.next_attempt_at<=now() AND (j.locked_at IS NULL OR j.locked_at<now()-interval '2 minutes')) OR (j.status='processing' AND j.locked_at<now()-interval '2 minutes')) AND c.status='connected' ORDER BY j.next_attempt_at,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1) UPDATE crm_sync_jobs j SET status='processing',locked_at=now(),locked_by=${workerId},attempt_count=j.attempt_count+1,updated_at=now() FROM candidate, integration_connections c WHERE j.id=candidate.id AND c.id=j.connection_id RETURNING j.*,c.auth_mode,c.portal_url,c.credentials_encrypted,c.settings,c.automation_default_channel_id`;
    const row = rows[0];
    return row
      ? {
          id: String(row.id),
          organizationId: String(row.organization_id),
          connectionId: String(row.connection_id),
          jobType: String(row.job_type),
          aggregateId: String(row.aggregate_id),
          idempotencyKey: String(row.idempotency_key),
          payload: (row.payload ?? {}) as Record<string, unknown>,
          attemptCount: Number(row.attempt_count),
          maxAttempts: Number(row.max_attempts),
          authMode: String(row.auth_mode),
          portalUrl: row.portal_url ? String(row.portal_url) : null,
          credentialsEncrypted: row.credentials_encrypted
            ? String(row.credentials_encrypted)
            : null,
          settings: (row.settings ?? {}) as Record<string, unknown>,
          automationDefaultChannelId: row.automation_default_channel_id
            ? String(row.automation_default_channel_id)
            : null,
        }
      : null;
  }
  async timelineContext(job: ClaimedCrmJob) {
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`SELECT l.entity_type,l.external_id,m.body,m.direction,m.type AS message_type,
        m.status,m.provider_message_id,m.conversation_id,
        COALESCE(m.provider_timestamp,m.sent_at,m.created_at)::text AS sent_at,
        contact.display_name AS contact_name,contact.normalized_phone,
        sender.full_name AS sender_name,channel.id AS channel_id,
        channel.name AS channel_name,channel.phone_number AS channel_phone,
        channel.phone_number_id,channel.business_account_id,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('storageKey',a.storage_key,'filename',COALESCE(a.stored_filename,a.provider_filename),'mimeType',COALESCE(a.stored_mime_type,a.provider_mime_type),'size',COALESCE(a.stored_size,a.provider_file_size)) ORDER BY a.created_at) FROM message_attachments a WHERE a.message_id=m.id AND a.organization_id=m.organization_id AND a.deleted_at IS NULL AND a.processing_status='stored' AND a.scan_status='clean' AND a.storage_key IS NOT NULL),'[]'::jsonb) AS attachments,
        (SELECT count(*)::int FROM message_attachments a WHERE a.message_id=m.id AND a.organization_id=m.organization_id AND a.deleted_at IS NULL AND a.processing_status NOT IN('stored','failed','deleted')) AS pending_attachment_count
      FROM crm_entity_links l
      JOIN messages m ON m.id=${job.aggregateId}::uuid AND m.organization_id=l.organization_id
      JOIN conversations conversation ON conversation.id=m.conversation_id AND conversation.organization_id=m.organization_id
      JOIN channels channel ON channel.id=conversation.channel_id AND channel.organization_id=conversation.organization_id
      LEFT JOIN contacts contact ON contact.id=m.contact_id AND contact.organization_id=m.organization_id
      LEFT JOIN users sender ON sender.id=m.sender_id
      WHERE l.organization_id=${job.organizationId}::uuid
        AND l.connection_id=${job.connectionId}::uuid
        AND l.conversation_id=m.conversation_id
        AND l.unavailable_at IS NULL
      ORDER BY l.created_at LIMIT 1`;
    return rows[0] ?? null;
  }
  async responsibleContext(job: ClaimedCrmJob) {
    const userId =
      typeof job.payload.userId === "string" ? job.payload.userId : null;
    if (!userId) return null;
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`SELECT l.entity_type,l.external_id,m.external_user_id FROM crm_entity_links l JOIN crm_user_mappings m ON m.connection_id=l.connection_id AND m.organization_id=l.organization_id AND m.local_user_id=${userId}::uuid AND m.active=true WHERE l.organization_id=${job.organizationId}::uuid AND l.connection_id=${job.connectionId}::uuid AND l.conversation_id=${job.aggregateId}::uuid AND l.unavailable_at IS NULL ORDER BY l.created_at LIMIT 1`;
    return rows[0] ?? null;
  }
  async complete(job: ClaimedCrmJob, details: Record<string, unknown> = {}) {
    await this.sql.begin(async (tx) => {
      await tx`UPDATE crm_sync_jobs SET status='completed',completed_at=now(),locked_at=NULL,locked_by=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=now() WHERE id=${job.id}::uuid`;
      await tx`INSERT INTO crm_sync_logs(organization_id,connection_id,job_id,level,operation,message,details) VALUES(${job.organizationId}::uuid,${job.connectionId}::uuid,${job.id}::uuid,'info',${job.jobType},'CRM job completed',${tx.json(details as never)})`;
    });
  }
  async fail(
    job: ClaimedCrmJob,
    input: {
      code: string;
      message: string;
      retryable: boolean;
      delay: number | null;
    },
  ) {
    const dead =
      !input.retryable ||
      input.delay === null ||
      job.attemptCount >= job.maxAttempts;
    await this.sql.begin(async (tx) => {
      await tx`UPDATE crm_sync_jobs SET status=${dead ? "dead_letter" : "retry"},next_attempt_at=CASE WHEN ${input.delay}::int IS NULL THEN next_attempt_at ELSE now()+(${input.delay}::int*interval '1 millisecond') END,locked_at=NULL,locked_by=NULL,last_error_code=${input.code},last_error_message=${input.message},updated_at=now() WHERE id=${job.id}::uuid`;
      await tx`INSERT INTO crm_sync_logs(organization_id,connection_id,job_id,level,operation,message,details) VALUES(${job.organizationId}::uuid,${job.connectionId}::uuid,${job.id}::uuid,${dead ? "error" : "warn"},${job.jobType},${dead ? "CRM job moved to dead letter" : "CRM job scheduled for retry"},${tx.json({ code: input.code, retryable: input.retryable } as never)})`;
    });
  }
  async claimWebhook(
    workerId = "crm-worker",
  ): Promise<ClaimedCrmWebhook | null> {
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`WITH candidate AS(SELECT id FROM crm_webhook_events WHERE (status='pending' OR (status='processing' AND (locked_at IS NULL OR locked_at<now()-interval '2 minutes'))) ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE crm_webhook_events e SET status='processing',locked_at=now(),locked_by=${workerId},attempt_count=e.attempt_count+1 FROM candidate, integration_connections c WHERE e.id=candidate.id AND c.id=e.connection_id RETURNING e.*,c.settings,c.auth_mode,c.portal_url,c.credentials_encrypted`;
    const row = rows[0];
    return row
      ? {
          id: String(row.id),
          organizationId: String(row.organization_id),
          connectionId: String(row.connection_id),
          eventType: String(row.event_type),
          payload: (row.payload ?? {}) as Record<string, unknown>,
          settings: (row.settings ?? {}) as Record<string, unknown>,
          authMode: String(row.auth_mode),
          portalUrl: row.portal_url ? String(row.portal_url) : null,
          credentialsEncrypted: row.credentials_encrypted
            ? String(row.credentials_encrypted)
            : null,
        }
      : null;
  }
  async processResponsibleWebhook(
    webhook: ClaimedCrmWebhook,
    normalized?: {
      entityType: string;
      externalId: string;
      externalUserId: string;
    },
  ) {
    const data =
      typeof webhook.payload.data === "object" && webhook.payload.data !== null
        ? (webhook.payload.data as Record<string, unknown>)
        : webhook.payload;
    const entityType = String(
        normalized?.entityType ?? data.entityType ?? data.ENTITY_TYPE ?? "",
      ).toLowerCase(),
      externalId = String(
        normalized?.externalId ??
          data.externalId ??
          data.ID ??
          data.ENTITY_ID ??
          "",
      ),
      externalUserId = String(
        normalized?.externalUserId ??
          data.responsibleId ??
          data.ASSIGNED_BY_ID ??
          "",
      );
    if (!entityType || !externalId || !externalUserId) return false;
    return this.sql.begin(async (tx) => {
      const rows = await tx<
        Array<Record<string, unknown>>
      >`SELECT l.conversation_id,m.local_user_id,c.assignee_id,c.operation_version FROM crm_entity_links l JOIN crm_user_mappings m ON m.connection_id=l.connection_id AND m.organization_id=l.organization_id AND m.external_user_id=${externalUserId} AND m.local_user_id IS NOT NULL AND m.active=true JOIN conversations c ON c.id=l.conversation_id AND c.organization_id=l.organization_id WHERE l.organization_id=${webhook.organizationId}::uuid AND l.connection_id=${webhook.connectionId}::uuid AND l.entity_type=${entityType} AND l.external_id=${externalId}`;
      let changed = false;
      for (const row of rows) {
        const localUserId =
          typeof row.local_user_id === "string" ? row.local_user_id : "";
        if (!localUserId || String(row.assignee_id ?? "") === localUserId)
          continue;
        const version = Number(row.operation_version) + 1;
        await tx`UPDATE conversations SET assignee_id=${localUserId}::uuid,operation_version=${version},updated_at=now() WHERE id=${String(row.conversation_id)}::uuid AND organization_id=${webhook.organizationId}::uuid`;
        await tx`INSERT INTO assignment_history(organization_id,conversation_id,to_user_id,reason,origin,version) VALUES(${webhook.organizationId}::uuid,${String(row.conversation_id)}::uuid,${localUserId}::uuid,'Bitrix24 responsible changed','bitrix24',${version})`;
        changed = true;
      }
      return changed;
    });
  }
  async updateConnectionCredentials(
    connectionId: string,
    encryptedCredentials: string,
  ) {
    await this
      .sql`UPDATE integration_connections SET credentials_encrypted=${encryptedCredentials},updated_at=now() WHERE id=${connectionId}::uuid`;
  }
  /** Bitrix24 fires ONAPPUNINSTALL when the portal admin removes the app. Mirror
   * the manual DELETE /api/v1/integrations/:id path so a stale, credential-less
   * connection can't keep the worker retrying against a revoked token. */
  async disconnectOnAppUninstall(webhook: ClaimedCrmWebhook) {
    await this.sql.begin(async (tx) => {
      await tx`UPDATE integration_connections SET status='disconnected',credentials_encrypted=NULL,webhook_token_hash=NULL,updated_at=now() WHERE id=${webhook.connectionId}::uuid`;
      await tx`INSERT INTO crm_sync_logs(organization_id,connection_id,job_id,level,operation,message,details) VALUES(${webhook.organizationId}::uuid,${webhook.connectionId}::uuid,NULL,'info','app_uninstall','Bitrix24 app uninstalled by portal admin; connection disconnected and credentials cleared',${tx.json({ webhookId: webhook.id } as never)})`;
    });
  }
  async upsertCrmUser(
    job: ClaimedCrmJob,
    user: {
      externalId: string;
      name: string;
      email: string | null;
      active: boolean;
    },
  ) {
    await this
      .sql`INSERT INTO crm_user_mappings(organization_id,connection_id,external_user_id,external_snapshot,active) VALUES(${job.organizationId}::uuid,${job.connectionId}::uuid,${user.externalId},${this.sql.json(user as never)},${user.active}) ON CONFLICT(connection_id,external_user_id) DO UPDATE SET external_snapshot=EXCLUDED.external_snapshot,active=EXCLUDED.active,last_synced_at=now(),updated_at=now()`;
  }
  async replacePipelines(
    job: ClaimedCrmJob,
    pipelines: Array<{
      externalId: string;
      name: string;
      entityType: string;
      stages: Array<{ externalId: string; name: string; order: number }>;
    }>,
  ) {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM crm_pipeline_cache WHERE organization_id=${job.organizationId}::uuid AND connection_id=${job.connectionId}::uuid`;
      for (const pipeline of pipelines)
        for (const stage of pipeline.stages)
          await tx`INSERT INTO crm_pipeline_cache(organization_id,connection_id,entity_type,pipeline_external_id,pipeline_name,stage_external_id,stage_name,stage_order,fetched_at,stale_at) VALUES(${job.organizationId}::uuid,${job.connectionId}::uuid,${pipeline.entityType},${pipeline.externalId},${pipeline.name},${stage.externalId},${stage.name},${stage.order},now(),now()+interval '1 hour')`;
      await tx`UPDATE integration_connections SET last_sync_at=now(),updated_at=now() WHERE id=${job.connectionId}::uuid`;
    });
  }
  async processOperatorMessage(webhook: ClaimedCrmWebhook) {
    if (webhook.eventType.toUpperCase() !== "ONIMCONNECTORMESSAGEADD")
      return false;
    const data = bitrixWebhookData(webhook.payload);
    const connectorId = String(data.CONNECTOR ?? "");
    const lineId = String(data.LINE ?? "");
    const messages = Array.isArray(data.MESSAGES) ? data.MESSAGES : [];
    let processed = false;
    for (const item of messages) {
      const entry = (item ?? {}) as Record<string, unknown>;
      const chat = (entry.chat ?? {}) as Record<string, unknown>;
      const message = (entry.message ?? {}) as Record<string, unknown>;
      const im = (entry.im ?? {}) as Record<string, unknown>;
      const externalChatId = String(chat.id ?? "");
      const externalMessageId = String(im.message_id ?? message.id ?? "");
      const imChatId = String(im.chat_id ?? "");
      const text = normalizeBitrixOperatorMessage(message.text);
      if (
        !connectorId ||
        !lineId ||
        !externalChatId ||
        !externalMessageId ||
        !imChatId ||
        !text
      )
        continue;
      const timelineMessage = await this.sql.begin(async (tx) => {
        const session = (
          await tx<Array<Record<string, unknown>>>`
          SELECT s.conversation_id,c.channel_id,c.contact_id
          FROM bitrix_open_channel_sessions s
          JOIN conversations c ON c.id=s.conversation_id
          JOIN bitrix_open_channel_bindings binding
            ON binding.integration_connection_id=s.integration_connection_id
           AND binding.organization_id=s.organization_id
           AND binding.brixchat_channel_id=c.channel_id
          WHERE s.organization_id=${webhook.organizationId}::uuid
            AND s.integration_connection_id=${webhook.connectionId}::uuid
            AND (s.external_user_code=${externalChatId} OR s.external_chat_id=${externalChatId})
            AND binding.connector_id=${connectorId}
            AND binding.line_id=${lineId}
            AND binding.status='active'
            AND COALESCE((binding.settings->>'outgoingEnabled')::boolean,true)=true
            AND NOT EXISTS (
              SELECT 1
              FROM channels organization_channel
              WHERE organization_channel.organization_id=s.organization_id
                AND organization_channel.deleted_at IS NULL
                AND organization_channel.provider IN ('whatsapp_web','meta')
                AND regexp_replace(COALESCE(organization_channel.phone_number,''),'[^0-9]','','g')<>''
                AND (
                  regexp_replace(COALESCE(organization_channel.phone_number,''),'[^0-9]','','g')
                    =regexp_replace(${externalChatId},'[^0-9]','','g')
                  OR (
                    length(regexp_replace(COALESCE(organization_channel.phone_number,''),'[^0-9]','','g'))>=10
                    AND length(regexp_replace(${externalChatId},'[^0-9]','','g'))>=10
                    AND right(regexp_replace(COALESCE(organization_channel.phone_number,''),'[^0-9]','','g'),10)
                      =right(regexp_replace(${externalChatId},'[^0-9]','','g'),10)
                  )
                )
            )
          LIMIT 1`
        )[0];
        if (!session) return null;
        const mirroredEcho = (
          await tx<Array<Record<string, unknown>>>`
          WITH candidate AS (
            SELECT link.id
            FROM bitrix_open_channel_message_links link
            JOIN messages original
              ON original.id=link.local_message_id
             AND original.organization_id=link.organization_id
            JOIN crm_webhook_events webhook_event
              ON webhook_event.id=${webhook.id}::uuid
             AND webhook_event.organization_id=link.organization_id
             AND webhook_event.connection_id=${webhook.connectionId}::uuid
            WHERE link.organization_id=${webhook.organizationId}::uuid
              AND link.conversation_id=${String(session.conversation_id)}::uuid
              AND link.direction='outbound'
              AND link.external_chat_id=${imChatId}
              AND link.source_marker LIKE 'channel:%'
              AND (
                (
                  link.status='synced'
                  AND btrim(original.body)<>''
                  AND (
                    btrim(original.body)=${text}
                    -- Bitrix (and our own group mirroring) can prepend an
                    -- arbitrary "Name: " prefix -- the WhatsApp sender's
                    -- name, the responding operator's name, etc. Rather than
                    -- reconstructing every possible prefix, accept any echo
                    -- whose text ends with the original body, capped at a
                    -- sane prefix length to avoid matching unrelated replies.
                    OR (
                      length(${text})>length(btrim(original.body))
                      AND length(${text})-length(btrim(original.body))<=100
                      AND right(${text},length(btrim(original.body)))=btrim(original.body)
                    )
                  )
                  AND link.created_at BETWEEN webhook_event.received_at-interval '2 minutes'
                                          AND webhook_event.received_at+interval '1 minute'
                )
                OR (
                  link.status='echo_suppressed'
                  AND link.external_message_id=${externalMessageId}
                )
              )
            ORDER BY
              CASE WHEN link.status='echo_suppressed' THEN 0 ELSE 1 END,
              abs(extract(epoch FROM (webhook_event.received_at-link.created_at))),
              link.created_at
            LIMIT 1
            FOR UPDATE OF link
          )
          UPDATE bitrix_open_channel_message_links link
          SET status='echo_suppressed',external_message_id=${externalMessageId},updated_at=now()
          FROM candidate
          WHERE link.id=candidate.id
          RETURNING link.local_message_id`
        )[0];
        if (mirroredEcho) {
          processed = true;
          return null;
        }
        const duplicate = (
          await tx`
          SELECT 1 FROM messages WHERE organization_id=${webhook.organizationId}::uuid AND conversation_id=${String(session.conversation_id)}::uuid AND metadata->>'bitrixEventKey'=${`${webhook.id}:${externalMessageId}`}`
        )[0];
        if (duplicate) return null;
        const inserted = await tx<Array<Record<string, unknown>>>`
          INSERT INTO messages(organization_id,conversation_id,channel_id,contact_id,client_message_id,direction,type,status,body,metadata)
          VALUES(${webhook.organizationId}::uuid,${String(session.conversation_id)}::uuid,${String(session.channel_id)}::uuid,${String(session.contact_id)}::uuid,gen_random_uuid(),'outbound','text','pending',${text},${tx.json({ origin: "bitrix_open_channels", bitrixEventKey: `${webhook.id}:${externalMessageId}`, bitrixMessageId: externalMessageId, bitrixImChatId: imChatId, bitrixExternalChatId: externalChatId, bitrixConnectorId: connectorId, bitrixLineId: lineId, bitrixConnectionId: webhook.connectionId } as never)}) RETURNING id`;
        if (!inserted[0]) return null;
        await tx`INSERT INTO bitrix_open_channel_message_links(organization_id,conversation_id,local_message_id,external_chat_id,external_message_id,direction,source_marker) VALUES(${webhook.organizationId}::uuid,${String(session.conversation_id)}::uuid,${String(inserted[0].id)}::uuid,${externalChatId},${externalMessageId},'outbound',${`bitrix:${webhook.id}:${externalMessageId}`}) ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO outbox_jobs(organization_id,aggregate_type,aggregate_id,job_type,payload) VALUES(${webhook.organizationId}::uuid,'message',${String(inserted[0].id)}::uuid,'message.send',${tx.json({ traceId: crypto.randomUUID() } as never)})`;
        await tx`UPDATE conversations SET last_message_id=${String(inserted[0].id)}::uuid,last_message_at=now(),updated_at=now() WHERE id=${String(session.conversation_id)}::uuid`;
        processed = true;
        return {
          messageId: String(inserted[0].id),
          conversationId: String(session.conversation_id),
        };
      });
      if (timelineMessage)
        await this.enqueueTimeline({
          organizationId: webhook.organizationId,
          messageId: timelineMessage.messageId,
          conversationId: timelineMessage.conversationId,
        });
    }
    return processed;
  }
  async processOpenChannelSessionEvent(webhook: ClaimedCrmWebhook) {
    const eventType = webhook.eventType.toUpperCase();
    if (
      eventType !== "ONIMCONNECTORDIALOGSTART" &&
      eventType !== "ONIMCONNECTORDIALOGFINISH"
    )
      return false;
    const data = bitrixWebhookData(webhook.payload);
    const connectorId = String(data.CONNECTOR ?? "");
    const lineId = String(data.LINE ?? "");
    const dialogs = Array.isArray(data.DATA) ? data.DATA : [];
    let processed = false;
    for (const item of dialogs) {
      const dialog = (item ?? {}) as Record<string, unknown>;
      const connector = (dialog.connector ?? {}) as Record<string, unknown>;
      const session = (dialog.session ?? {}) as Record<string, unknown>;
      const chat = (dialog.chat ?? {}) as Record<string, unknown>;
      const user = (dialog.user ?? {}) as Record<string, unknown>;
      const sessionId = String(session.id ?? "");
      const externalChatId = String(connector.chat_id ?? chat.id ?? "");
      const externalUserCode = String(connector.user_id ?? user.id ?? "");
      if (
        !connectorId ||
        !lineId ||
        (!sessionId && !externalChatId && !externalUserCode)
      )
        continue;
      const rows = await this.sql<Array<Record<string, unknown>>>`
        UPDATE bitrix_open_channel_sessions
        SET status=${eventType === "ONIMCONNECTORDIALOGFINISH" ? "closed" : "open"},
            closed_at=${eventType === "ONIMCONNECTORDIALOGFINISH" ? new Date() : null},
            last_synced_at=now(),
            updated_at=now()
        WHERE organization_id=${webhook.organizationId}::uuid
          AND integration_connection_id=${webhook.connectionId}::uuid
          AND connector_id=${connectorId}
          AND line_id=${lineId}
          AND (
            ${eventType !== "ONIMCONNECTORDIALOGFINISH"}
            OR EXISTS(
              SELECT 1
              FROM conversations conversation
              JOIN bitrix_open_channel_bindings binding
                ON binding.organization_id=conversation.organization_id
               AND binding.integration_connection_id=${webhook.connectionId}::uuid
               AND binding.brixchat_channel_id=conversation.channel_id
               AND binding.connector_id=${connectorId}
               AND binding.line_id=${lineId}
              WHERE conversation.id=bitrix_open_channel_sessions.conversation_id
                AND COALESCE((binding.settings->>'sessionCloseSync')::boolean,true)=true
            )
          )
          AND (
            (${sessionId}<>'' AND external_session_id=${sessionId})
            OR (${externalChatId}<>'' AND external_chat_id=${externalChatId})
            OR (${externalUserCode}<>'' AND external_user_code=${externalUserCode})
          )
        RETURNING id`;
      processed = processed || Boolean(rows[0]);
    }
    return processed;
  }
  async touchOpenChannelEvent(webhook: ClaimedCrmWebhook) {
    if (!webhook.eventType.toUpperCase().startsWith("ONIMCONNECTOR"))
      return false;
    const data = bitrixWebhookData(webhook.payload);
    const connectorId = String(data.CONNECTOR ?? "");
    const lineId = String(data.LINE ?? "");
    if (!connectorId || !lineId) return false;
    const rows = await this.sql<Array<Record<string, unknown>>>`
      UPDATE bitrix_open_channel_bindings
      SET last_event_at=now(),updated_at=now()
      WHERE organization_id=${webhook.organizationId}::uuid
        AND integration_connection_id=${webhook.connectionId}::uuid
        AND connector_id=${connectorId}
        AND line_id=${lineId}
      RETURNING id`;
    return Boolean(rows[0]);
  }
  async completeWebhook(id: string) {
    await this
      .sql`UPDATE crm_webhook_events SET status='processed',processed_at=now(),locked_at=NULL,locked_by=NULL WHERE id=${id}::uuid`;
  }
  async failWebhook(id: string, error: string) {
    await this
      .sql`UPDATE crm_webhook_events SET status=CASE WHEN attempt_count>=5 THEN 'failed' ELSE 'pending' END,last_error=${error},locked_at=NULL,locked_by=NULL WHERE id=${id}::uuid`;
  }
  async enqueueTimeline(input: {
    organizationId: string;
    messageId: string;
    conversationId: string;
  }) {
    await this
      .sql`INSERT INTO crm_sync_jobs(organization_id,connection_id,job_type,aggregate_type,aggregate_id,idempotency_key,payload)
        SELECT ${input.organizationId}::uuid,l.connection_id,'timeline.comment',
          'message',${input.messageId},${`timeline:${input.messageId}`},
          ${this.sql.json({ conversationId: input.conversationId } as never)}
        FROM crm_entity_links l
        JOIN integration_connections c
          ON c.id=l.connection_id
         AND c.status='connected'
        JOIN conversations conversation
          ON conversation.id=l.conversation_id
         AND conversation.organization_id=l.organization_id
        LEFT JOIN bitrix_open_channel_bindings binding
          ON binding.integration_connection_id=l.connection_id
         AND binding.organization_id=l.organization_id
         AND binding.brixchat_channel_id=conversation.channel_id
        WHERE l.organization_id=${input.organizationId}::uuid
          AND l.conversation_id=${input.conversationId}::uuid
          AND l.unavailable_at IS NULL
          AND COALESCE((c.settings->>'timelineEnabled')::boolean,true)=true
          AND (
            c.bitrix_mode='crm_context'
            OR (
              c.bitrix_mode='both'
              AND COALESCE(binding.settings->>'timelinePolicy','session_summary')='per_message'
            )
          )
        ORDER BY l.created_at
        LIMIT 1
        ON CONFLICT(connection_id,idempotency_key) DO NOTHING`;
  }
}

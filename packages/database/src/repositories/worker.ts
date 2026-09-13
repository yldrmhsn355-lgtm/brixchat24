import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "./index";
import { classifyDeliveryFailure } from "./delivery-failure";

type StoredMessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";
const deliveryRank: Record<Exclude<StoredMessageStatus, "failed">, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

export function nextStoredMessageStatus(
  current: StoredMessageStatus,
  incoming: StoredMessageStatus,
): StoredMessageStatus {
  if (current === "failed") return "failed";
  if (incoming === "failed")
    return current === "delivered" || current === "read" ? current : "failed";
  return deliveryRank[incoming] >= deliveryRank[current] ? incoming : current;
}

export function inboundAutomationEventTypes(input: {
  provider?: string | undefined;
  isGroup: boolean;
  hasMentions: boolean;
}) {
  return [
    "message.received",
    ...(input.provider === "whatsapp_web" && input.isGroup
      ? [
          "group.message.received",
          "group.keyword_matched",
          ...(input.hasMentions ? ["group.mentioned"] : []),
        ]
      : []),
  ];
}

export interface ClaimedOutbox {
  id: string;
  organizationId: string;
  messageId: string;
  attemptCount: number;
  maxAttempts: number;
  traceId: string;
  jobType: string;
}
export interface DeliveryContext {
  messageId: string;
  organizationId: string;
  conversationId: string;
  channelId: string;
  phoneNumberId: string;
  recipient: string;
  text: string;
  clientMessageId: string;
  provider: string;
  platform: string;
  credentialsEncrypted: string | null;
  businessAccountId: string | null;
  messageType: string;
  metadata: Record<string, unknown>;
  attachment: {
    storageKey: string;
    filename: string;
    mimeType: string;
    type: string;
  } | null;
}

function deliveryRecipient(row: Record<string, unknown>): string {
  const customFields =
    row.custom_fields &&
    typeof row.custom_fields === "object" &&
    !Array.isArray(row.custom_fields)
      ? (row.custom_fields as Record<string, unknown>)
      : {};
  if (
    row.provider === "telegram" &&
    typeof customFields.telegramChatId === "string"
  )
    return customFields.telegramChatId;
  return row.provider === "whatsapp_web" &&
    typeof customFields.whatsappWebChatId === "string"
    ? customFields.whatsappWebChatId
    : String(row.normalized_phone);
}
export interface ClaimedWebhook {
  id: string;
  organizationId: string;
  channelId: string;
  payload: Record<string, unknown>;
  eventKey: string;
  eventType: string;
}
export class WorkerRepository {
  constructor(private readonly sql: DatabaseClient) {}
  async claimOutbox(workerId: string): Promise<ClaimedOutbox | null> {
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`WITH candidate AS(SELECT o.id FROM outbox_jobs o LEFT JOIN messages m ON o.aggregate_type='message' AND m.id=o.aggregate_id LEFT JOIN channels ch ON ch.id=m.channel_id LEFT JOIN whatsapp_web_sessions s ON s.channel_id=ch.id AND s.organization_id=ch.organization_id WHERE ((o.status IN('pending','retry') AND o.next_attempt_at<=now() AND (o.locked_at IS NULL OR o.locked_at<now()-interval '2 minutes')) OR (o.status='processing' AND o.locked_at<now()-interval '2 minutes')) AND (ch.provider IS DISTINCT FROM 'whatsapp_web' OR s.channel_id IS NULL OR (s.status='connected' AND s.assigned_worker_id=${workerId})) ORDER BY o.next_attempt_at FOR UPDATE OF o SKIP LOCKED LIMIT 1) UPDATE outbox_jobs o SET status='processing',locked_at=now(),locked_by=${workerId},attempt_count=o.attempt_count+1,updated_at=now() FROM candidate WHERE o.id=candidate.id RETURNING o.*`;
    const row = rows[0];
    if (!row) return null;
    const payload = (row.payload ?? {}) as Record<string, unknown>,
      job = {
        id: String(row.id),
        organizationId: String(row.organization_id),
        messageId: String(row.aggregate_id),
        attemptCount: Number(row.attempt_count),
        maxAttempts: Number(row.max_attempts),
        traceId: String(payload.traceId ?? crypto.randomUUID()),
        jobType: String(row.job_type),
      };
    await this
      .sql`INSERT INTO message_flow_events(organization_id,message_id,trace_id,event_type,source,payload) VALUES(${job.organizationId}::uuid,${job.messageId}::uuid,${job.traceId}::uuid,'outbox.claimed','worker',${this.sql.json({ workerId } as never)}),(${job.organizationId}::uuid,${job.messageId}::uuid,${job.traceId}::uuid,'provider.request_started','worker','{}'::jsonb)`;
    return job;
  }
  async deliveryContext(job: ClaimedOutbox): Promise<DeliveryContext | null> {
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`SELECT m.id message_id,m.organization_id,m.conversation_id,m.channel_id,m.body,m.client_message_id,m.type,m.metadata,ct.normalized_phone,ct.custom_fields,ch.provider,coalesce(ch.platform,'whatsapp') platform,ch.phone_number_id,ch.business_account_id,coalesce(pa.encrypted_credentials,ch.credentials_encrypted) credentials_encrypted,a.storage_key,a.stored_filename,a.stored_mime_type,a.attachment_type FROM messages m JOIN contacts ct ON ct.id=m.contact_id AND ct.organization_id=m.organization_id JOIN channels ch ON ch.id=m.channel_id AND ch.organization_id=m.organization_id LEFT JOIN provider_accounts pa ON pa.id=ch.provider_account_id AND pa.organization_id=ch.organization_id AND pa.archived_at IS NULL LEFT JOIN LATERAL(SELECT storage_key,stored_filename,stored_mime_type,attachment_type FROM message_attachments WHERE message_id=m.id AND processing_status='stored' AND scan_status='clean' ORDER BY created_at LIMIT 1)a ON true WHERE m.id=${job.messageId}::uuid AND m.organization_id=${job.organizationId}::uuid AND ch.deleted_at IS NULL AND ch.status='connected' AND coalesce(ch.connection_status,'ACTIVE')='ACTIVE'`;
    const row = rows[0];
    return row
      ? {
          messageId: String(row.message_id),
          organizationId: String(row.organization_id),
          conversationId: String(row.conversation_id),
          channelId: String(row.channel_id),
          phoneNumberId: String(row.phone_number_id ?? "fake-phone"),
          recipient: deliveryRecipient(row),
          text: String(row.body),
          clientMessageId: String(row.client_message_id),
          provider: String(row.provider),
          platform: String(row.platform),
          credentialsEncrypted: row.credentials_encrypted
            ? String(row.credentials_encrypted)
            : null,
          businessAccountId: row.business_account_id
            ? String(row.business_account_id)
            : null,
          messageType: String(row.type),
          metadata: (row.metadata ?? {}) as Record<string, unknown>,
          attachment: row.storage_key
            ? {
                storageKey: String(row.storage_key),
                filename: String(row.stored_filename ?? "attachment"),
                mimeType: String(
                  row.stored_mime_type ?? "application/octet-stream",
                ),
                type: String(row.attachment_type ?? row.type),
              }
            : null,
        }
      : null;
  }
  async complete(
    job: ClaimedOutbox,
    providerMessageId: string,
  ): Promise<StoredMessageStatus> {
    return this.sql.begin(async (tx) => {
      await tx`UPDATE messages SET status='sent',provider_message_id=${providerMessageId},updated_at=now() WHERE id=${job.messageId}::uuid AND organization_id=${job.organizationId}::uuid AND status='pending'`;
      const pendingStatuses = await tx<Array<Record<string, unknown>>>`
        SELECT status,provider_timestamp,payload,event_key
        FROM pending_message_status_events
        WHERE organization_id=${job.organizationId}::uuid
          AND provider_message_id=${providerMessageId}
        ORDER BY provider_timestamp NULLS LAST,created_at
        FOR UPDATE`;
      let finalStatus: StoredMessageStatus = "sent";
      let bufferedFailure: ReturnType<typeof classifyDeliveryFailure> | null =
        null;
      for (const pending of pendingStatuses) {
        const incoming = String(pending.status) as StoredMessageStatus;
        const inserted = await tx`
          INSERT INTO message_status_events(
            organization_id,
            message_id,
            provider_message_id,
            status,
            provider_timestamp,
            payload,
            event_key
          ) VALUES(
            ${job.organizationId}::uuid,
            ${job.messageId}::uuid,
            ${providerMessageId},
            ${incoming},
            ${pending.provider_timestamp ? String(pending.provider_timestamp) : null}::timestamptz,
            ${tx.json((pending.payload ?? {}) as never)},
            ${String(pending.event_key)}
          )
          ON CONFLICT(organization_id,event_key) DO NOTHING
          RETURNING id`;
        if (inserted.length) {
          const previousStatus = finalStatus;
          finalStatus = nextStoredMessageStatus(finalStatus, incoming);
          if (
            incoming === "failed" &&
            previousStatus !== "failed" &&
            finalStatus === "failed"
          )
            bufferedFailure = classifyDeliveryFailure({
              payload: (pending.payload ?? {}) as Record<string, unknown>,
            });
        }
      }
      if (pendingStatuses.length) {
        await tx`UPDATE messages SET status=${finalStatus}::message_status,error_code=CASE WHEN ${bufferedFailure?.errorCode ?? null}::text IS NULL THEN error_code ELSE ${bufferedFailure?.errorCode ?? null} END,error_message=CASE WHEN ${bufferedFailure?.errorCode ?? null}::text IS NULL THEN error_message ELSE 'Provider delivery status failed' END,updated_at=now() WHERE id=${job.messageId}::uuid AND organization_id=${job.organizationId}::uuid`;
        await tx`DELETE FROM pending_message_status_events WHERE organization_id=${job.organizationId}::uuid AND provider_message_id=${providerMessageId}`;
        if (bufferedFailure)
          await tx`
            INSERT INTO automation_events(
              organization_id,event_type,aggregate_type,aggregate_id,
              conversation_id,correlation_id,origin,depth,payload
            )
            SELECT message.organization_id,'message.delivery_failed','message',
              message.id,message.conversation_id,message.id,
              'provider.delivery',0,
              jsonb_build_object(
                'messageId',message.id,
                'channelId',message.channel_id,
                'errorCode',${bufferedFailure.errorCode},
                'retryable',false,
                'failureCategory',${bufferedFailure.category},
                'customerRelated',${bufferedFailure.customerRelated},
                'automationEligible',${bufferedFailure.automationEligible},
                'metaCode',${bufferedFailure.metaCode}
              )
            FROM messages message
            WHERE message.id=${job.messageId}::uuid
              AND message.organization_id=${job.organizationId}::uuid
            ON CONFLICT(organization_id,event_type,correlation_id,origin)
            DO NOTHING
          `;
      }
      await tx`UPDATE outbox_jobs SET status='completed',completed_at=now(),locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${job.id}::uuid`;
      await tx`UPDATE channels SET last_successful_message_at=now(),last_outbound_at=now(),updated_at=now() WHERE id=(SELECT channel_id FROM messages WHERE id=${job.messageId}::uuid)`;
      await tx`INSERT INTO bitrix_open_channel_jobs(organization_id,integration_connection_id,conversation_id,local_message_id,job_type,idempotency_key,payload)
        SELECT m.organization_id,ic.id,m.conversation_id,m.id,
          'open_channels.outgoing',${`outgoing-provider:${providerMessageId}`},
          ${tx.json({ providerMessageId } as never)}
            || jsonb_build_object(
              'sourceMarker',concat('channel:',m.channel_id,':',channel.provider,':',${providerMessageId}::text),
              'provider',channel.provider,
              'bindingId',binding.id
            )
        FROM messages m
        JOIN channels channel
          ON channel.id=m.channel_id
         AND channel.organization_id=m.organization_id
        JOIN bitrix_open_channel_bindings binding
          ON binding.organization_id=m.organization_id
         AND binding.brixchat_channel_id=m.channel_id
         AND binding.status='active'
        JOIN integration_connections ic
          ON ic.id=binding.integration_connection_id
         AND ic.organization_id=binding.organization_id
        WHERE m.id=${job.messageId}::uuid
          AND m.organization_id=${job.organizationId}::uuid
          AND m.direction='outbound'
          AND m.type<>'reaction'
          AND m.metadata->>'origin' IS DISTINCT FROM 'bitrix_open_channels'
          AND ic.provider='bitrix24'
          AND ic.status='connected'
          AND ic.bitrix_mode IN('open_channels','both')
          AND COALESCE((binding.settings->>'outgoingEnabled')::boolean,true)=true
        ON CONFLICT(integration_connection_id,idempotency_key) DO NOTHING`;
      await tx`INSERT INTO message_flow_events(organization_id,message_id,trace_id,event_type,source,payload) VALUES(${job.organizationId}::uuid,${job.messageId}::uuid,${job.traceId}::uuid,'provider.request_succeeded','worker',${tx.json({ providerMessageId })}),(${job.organizationId}::uuid,${job.messageId}::uuid,${job.traceId}::uuid,'message.status_updated','worker',${tx.json({ status: finalStatus })})`;
      return finalStatus;
    });
  }
  async fail(
    job: ClaimedOutbox,
    input: {
      code: string;
      retryable: boolean;
      delay: number | null;
      message?: string;
    },
  ) {
    const dead =
      !input.retryable ||
      job.attemptCount >= job.maxAttempts ||
      input.delay === null;
    const failure = classifyDeliveryFailure({ errorCode: input.code });
    await this.sql.begin(async (tx) => {
      await tx`UPDATE outbox_jobs SET status=${dead ? "dead_letter" : "retry"},next_attempt_at=CASE WHEN ${input.delay}::int IS NULL THEN next_attempt_at ELSE now()+(${input.delay}::int*interval '1 millisecond') END,last_error=${input.code},locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${job.id}::uuid`;
      if (dead) {
        await tx`UPDATE messages SET status='failed',error_code=${failure.errorCode},error_message=${input.message ?? "Message delivery failed"},updated_at=now() WHERE id=${job.messageId}::uuid AND organization_id=${job.organizationId}::uuid`;
        await tx`
          INSERT INTO automation_events(
            organization_id,event_type,aggregate_type,aggregate_id,
            conversation_id,correlation_id,origin,depth,payload
          )
          SELECT message.organization_id,'message.delivery_failed','message',
            message.id,message.conversation_id,message.id,
            'provider.delivery',0,
            jsonb_build_object(
              'messageId',message.id,
              'channelId',message.channel_id,
              'errorCode',left(${failure.errorCode},128),
              'retryable',false,
              'failureCategory',${failure.category},
              'customerRelated',${failure.customerRelated},
              'automationEligible',${failure.automationEligible},
              'metaCode',${failure.metaCode}
            )
          FROM messages message
          WHERE message.id=${job.messageId}::uuid
            AND message.organization_id=${job.organizationId}::uuid
          ON CONFLICT(organization_id,event_type,correlation_id,origin)
          DO NOTHING
        `;
      }
      await tx`INSERT INTO message_flow_events(organization_id,message_id,trace_id,event_type,source,payload) VALUES(${job.organizationId}::uuid,${job.messageId}::uuid,${job.traceId}::uuid,'provider.request_failed','worker',${tx.json({ code: input.code, retryable: input.retryable })})`;
    });
  }
  async claimWebhook(workerId = "worker"): Promise<ClaimedWebhook | null> {
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`WITH candidate AS(SELECT id FROM provider_webhook_events WHERE (status='pending' OR (status='processing' AND (locked_at IS NULL OR locked_at<now()-interval '2 minutes'))) ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE provider_webhook_events e SET status='processing',locked_at=now(),locked_by=${workerId},attempt_count=e.attempt_count+1 FROM candidate WHERE e.id=candidate.id RETURNING e.*`;
    const row = rows[0];
    return row
      ? {
          id: String(row.id),
          organizationId: String(row.organization_id),
          channelId: String(row.channel_id),
          payload: (row.payload ?? {}) as Record<string, unknown>,
          eventKey: String(row.provider_event_key),
          eventType: String(row.event_type),
        }
      : null;
  }
  async completeWebhook(id: string) {
    await this.sql`
      WITH completed AS (
        UPDATE provider_webhook_events
        SET status='processed',processed_at=now(),locked_at=NULL,locked_by=NULL
        WHERE id=${id}::uuid
        RETURNING channel_id,received_at
      )
      UPDATE channels c
        SET last_webhook_result='processed',health_state=CASE WHEN connection_status='ACTIVE' THEN 'HEALTHY' ELSE health_state END,updated_at=now()
      FROM completed
      WHERE c.id=completed.channel_id
        AND c.last_webhook_at<=completed.received_at`;
  }
  async failWebhook(id: string, error: string) {
    await this.sql`
      WITH failed AS (
        UPDATE provider_webhook_events
        SET
          status=CASE WHEN attempt_count>=5 THEN 'failed' ELSE 'pending' END,
          last_error=${error},locked_at=NULL,locked_by=NULL
        WHERE id=${id}::uuid
        RETURNING channel_id,received_at,status
      )
      UPDATE channels c
      SET
        last_webhook_result=CASE
          WHEN failed.status='failed' THEN 'failed'
          ELSE 'retrying'
        END,
        health_state=CASE WHEN failed.status='failed' THEN 'UNHEALTHY' ELSE 'WARNING' END,
        last_health_error=${error},
        updated_at=now()
      FROM failed
      WHERE c.id=failed.channel_id
        AND c.last_webhook_at<=failed.received_at`;
  }
  /**
   * Upserts the contact for `phone`, then reuses an open/waiting/archived
   * conversation for that contact+channel or creates a new one (running a
   * matching assignment rule on creation). Shared by `incoming()` (inbound
   * WhatsApp messages) and `resolveConversationForPhone()` (CRM-automation
   * triggered outbound sends with no prior inbound message).
   */
  private async resolveContactAndConversation(
    tx: TransactionSql,
    input: {
      organizationId: string;
      channelId: string;
      phone: string;
      name: string;
      providerTimestamp: Date;
      contactCustomFields?: Record<string, unknown>;
      preserveContactName?: boolean;
    },
  ): Promise<{ contactId: string; conversationId: string; conversationCreated: boolean }> {
    const contacts = await tx<
      Array<Record<string, unknown>>
    >`INSERT INTO contacts(organization_id,first_name,display_name,normalized_phone,custom_fields) VALUES(${input.organizationId}::uuid,${input.name.split(" ")[0] ?? input.name},${input.name},${input.phone},${tx.json((input.contactCustomFields ?? {}) as never)}) ON CONFLICT(organization_id,normalized_phone) DO UPDATE SET first_name=CASE WHEN ${input.preserveContactName === true} THEN contacts.first_name WHEN EXCLUDED.display_name=EXCLUDED.normalized_phone THEN contacts.first_name ELSE EXCLUDED.first_name END,display_name=CASE WHEN ${input.preserveContactName === true} THEN contacts.display_name WHEN EXCLUDED.display_name=EXCLUDED.normalized_phone THEN contacts.display_name ELSE EXCLUDED.display_name END,custom_fields=contacts.custom_fields||EXCLUDED.custom_fields,updated_at=now() RETURNING id`;
    const contactId = String(contacts[0]!.id);
    await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            concat_ws(
              ':',
              ${input.organizationId}::text,
              ${input.channelId}::text,
              ${contactId}::text
            ),
            0
          )
        )`;
    const existing = await tx<
      Array<Record<string, unknown>>
    >`SELECT id,status FROM conversations WHERE organization_id=${input.organizationId}::uuid AND channel_id=${input.channelId}::uuid AND contact_id=${contactId}::uuid AND status IN('open','waiting','archived') AND NOT EXISTS (SELECT 1 FROM conversation_operation_history superseded WHERE superseded.organization_id=conversations.organization_id AND superseded.conversation_id=conversations.id AND superseded.operation='conversation.canonicalized') ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,created_at DESC LIMIT 1 FOR UPDATE`;
    let conversationId = existing[0] ? String(existing[0].id) : "";
    if (conversationId && String(existing[0]!.status) === "archived")
      await tx`
          UPDATE conversations
          SET
            status='open',
            closed_at=NULL,
            operation_version=operation_version+1,
            updated_at=now()
          WHERE id=${conversationId}::uuid
            AND organization_id=${input.organizationId}::uuid`;
    let conversationCreated = false;
    if (!conversationId) {
      const created = await tx<
        Array<Record<string, unknown>>
      >`INSERT INTO conversations(organization_id,channel_id,contact_id,status,customer_service_window_expires_at) VALUES(${input.organizationId}::uuid,${input.channelId}::uuid,${contactId}::uuid,'open',${input.providerTimestamp}::timestamptz+interval '24 hours') RETURNING id`;
      conversationId = String(created[0]!.id);
      conversationCreated = true;
      const rules = await tx<Array<Record<string, unknown>>>`
          SELECT id,strategy,config FROM assignment_rules
          WHERE organization_id=${input.organizationId}::uuid AND active
          ORDER BY priority,name LIMIT 1`;
      const rule = rules[0];
      if (rule) {
        const config = (rule.config ?? {}) as Record<string, unknown>;
        const configured = Array.isArray(config.userIds)
          ? config.userIds.filter((id): id is string => typeof id === "string")
          : [];
        const candidates = configured.length
          ? await tx<Array<Record<string, unknown>>>`
                SELECT u.id FROM users u JOIN organization_members om ON om.user_id=u.id
                WHERE om.organization_id=${input.organizationId}::uuid AND u.is_active AND u.id IN (${tx(configured)})`
          : String(rule.strategy) === "least_loaded"
            ? await tx<Array<Record<string, unknown>>>`
                  SELECT u.id FROM users u JOIN organization_members om ON om.user_id=u.id
                  LEFT JOIN agent_capacity_status ac ON ac.user_id=u.id AND ac.organization_id=om.organization_id
                  WHERE om.organization_id=${input.organizationId}::uuid AND u.is_active
                  ORDER BY COALESCE(ac.active_count,0),COALESCE(ac.last_assigned_at,'epoch'::timestamptz),u.id`
            : await tx<Array<Record<string, unknown>>>`
                  SELECT u.id FROM users u JOIN organization_members om ON om.user_id=u.id
                  LEFT JOIN agent_capacity_status ac ON ac.user_id=u.id AND ac.organization_id=om.organization_id
                  WHERE om.organization_id=${input.organizationId}::uuid AND u.is_active
                  ORDER BY ac.last_assigned_at NULLS FIRST,ac.last_assigned_at,u.id`;
        const fixed =
          String(rule.strategy) === "fixed" && typeof config.userId === "string"
            ? candidates.find(
                (candidate) => String(candidate.id) === String(config.userId),
              )
            : null;
        const selected = fixed ?? candidates[0];
        if (selected) {
          const assignedUserId = String(selected.id);
          await tx`UPDATE conversations SET assignee_id=${assignedUserId}::uuid,operation_version=operation_version+1,updated_at=now() WHERE id=${conversationId}::uuid`;
          await tx`INSERT INTO conversation_assignments(organization_id,conversation_id,user_id,origin,version) VALUES(${input.organizationId}::uuid,${conversationId}::uuid,${assignedUserId}::uuid,'rule',1)`;
          await tx`INSERT INTO assignment_history(organization_id,conversation_id,to_user_id,reason,origin,version,rule_id) VALUES(${input.organizationId}::uuid,${conversationId}::uuid,${assignedUserId}::uuid,'Automatic assignment','rule',1,${String(rule.id)}::uuid)`;
          await tx`INSERT INTO agent_capacity_status(organization_id,user_id,active_count,last_assigned_at) VALUES(${input.organizationId}::uuid,${assignedUserId}::uuid,1,now()) ON CONFLICT(organization_id,user_id) DO UPDATE SET active_count=agent_capacity_status.active_count+1,last_assigned_at=now(),updated_at=now()`;
        }
      }
    }
    return { contactId, conversationId, conversationCreated };
  }

  /**
   * Resolves (or creates) the contact+conversation for a phone number with
   * no inbound message involved — used by CRM-automation-rule-triggered
   * outbound sends (e.g. Bitrix24 "Outgoing webhook" business-process step)
   * that only supply a phone number, not a WhatsApp message to record.
   */
  async resolveConversationForPhone(input: {
    organizationId: string;
    channelId: string;
    phone: string;
    name?: string;
  }): Promise<{ contactId: string; conversationId: string }> {
    return this.sql.begin(async (tx) => {
      const { contactId, conversationId } =
        await this.resolveContactAndConversation(tx, {
          organizationId: input.organizationId,
          channelId: input.channelId,
          phone: input.phone,
          name: input.name?.trim() || input.phone,
          providerTimestamp: new Date(),
        });
      return { contactId, conversationId };
    });
  }

  async incoming(input: {
    organizationId: string;
    channelId: string;
    phone: string;
    name: string;
    text: string;
    type: string;
    providerMessageId: string;
    providerTimestamp: Date;
    metadata: Record<string, unknown>;
    contactCustomFields?: Record<string, unknown>;
    preserveContactName?: boolean;
    attachmentMetadata?: Record<string, unknown>;
    provider?: string;
    direction?: "inbound" | "outbound";
    traceId: string;
  }) {
    return this.sql.begin(async (tx) => {
      const direction = input.direction ?? "inbound";
      const initialStatus: StoredMessageStatus =
        direction === "outbound" ? "sent" : "delivered";
      const { contactId, conversationId, conversationCreated } =
        await this.resolveContactAndConversation(tx, {
          organizationId: input.organizationId,
          channelId: input.channelId,
          phone: input.phone,
          name: input.name,
          providerTimestamp: input.providerTimestamp,
          ...(input.contactCustomFields
            ? { contactCustomFields: input.contactCustomFields }
            : {}),
          ...(input.preserveContactName !== undefined
            ? { preserveContactName: input.preserveContactName }
            : {}),
        });
      const rows = await tx<
        Array<Record<string, unknown>>
      >`INSERT INTO messages(organization_id,conversation_id,channel_id,contact_id,direction,type,status,body,provider_message_id,provider_timestamp,metadata) VALUES(${input.organizationId}::uuid,${conversationId}::uuid,${input.channelId}::uuid,${contactId}::uuid,${direction}::message_direction,${input.type},${initialStatus}::message_status,${input.text},${input.providerMessageId},${input.providerTimestamp},${tx.json(input.metadata as never)}) ON CONFLICT(channel_id,provider_message_id) DO NOTHING RETURNING id`;
      const row = rows[0];
      if (!row)
        return {
          created: false,
          conversationId,
          messageId: null,
          conversationCreated: false,
        };
      const messageId = String(row.id);
      const pendingStatuses = await tx<Array<Record<string, unknown>>>`
        SELECT status,provider_timestamp,payload,event_key
        FROM pending_message_status_events
        WHERE organization_id=${input.organizationId}::uuid
          AND provider_message_id=${input.providerMessageId}
        ORDER BY provider_timestamp NULLS LAST,created_at
        FOR UPDATE`;
      if (pendingStatuses.length) {
        let status: StoredMessageStatus = initialStatus;
        for (const pending of pendingStatuses) {
          const candidate = String(pending.status) as StoredMessageStatus;
          status = nextStoredMessageStatus(status, candidate);
          await tx`INSERT INTO message_status_events(organization_id,message_id,provider_message_id,status,provider_timestamp,payload,event_key) VALUES(${input.organizationId}::uuid,${messageId}::uuid,${input.providerMessageId},${candidate},${pending.provider_timestamp ? String(pending.provider_timestamp) : null}::timestamptz,${tx.json((pending.payload ?? {}) as never)},${String(pending.event_key)}) ON CONFLICT(organization_id,event_key) DO NOTHING`;
        }
        await tx`UPDATE messages SET status=${status}::message_status,updated_at=now() WHERE id=${messageId}::uuid`;
        await tx`DELETE FROM pending_message_status_events WHERE organization_id=${input.organizationId}::uuid AND provider_message_id=${input.providerMessageId}`;
      }
      if (input.type !== "reaction")
        await tx`
          UPDATE conversations
          SET
            last_message_id=CASE
              WHEN last_message_id IS NULL OR last_message_at<=${input.providerTimestamp}
                THEN ${messageId}::uuid
              ELSE last_message_id
            END,
            last_message_at=CASE
              WHEN last_message_id IS NULL OR last_message_at<=${input.providerTimestamp}
                THEN ${input.providerTimestamp}
              ELSE last_message_at
            END,
            unread_count=unread_count+CASE WHEN ${direction}='inbound' THEN 1 ELSE 0 END,
            customer_service_window_expires_at=CASE
              WHEN ${direction}='inbound' THEN GREATEST(
                COALESCE(customer_service_window_expires_at,'-infinity'::timestamptz),
                ${input.providerTimestamp}::timestamptz+interval '24 hours'
              )
              ELSE customer_service_window_expires_at
            END,
            updated_at=now()
          WHERE id=${conversationId}::uuid
            AND organization_id=${input.organizationId}::uuid`;
      await tx`UPDATE channels SET
        last_inbound_at=CASE WHEN ${direction}='inbound' THEN GREATEST(COALESCE(last_inbound_at,'-infinity'::timestamptz),${input.providerTimestamp}) ELSE last_inbound_at END,
        last_outbound_at=CASE WHEN ${direction}='outbound' THEN GREATEST(COALESCE(last_outbound_at,'-infinity'::timestamptz),${input.providerTimestamp}) ELSE last_outbound_at END,
        updated_at=now()
        WHERE id=${input.channelId}::uuid AND organization_id=${input.organizationId}::uuid AND deleted_at IS NULL`;
      await tx`INSERT INTO message_flow_events(organization_id,message_id,trace_id,event_type,source) VALUES(${input.organizationId}::uuid,${messageId}::uuid,${input.traceId}::uuid,${direction === "outbound" ? "provider.echo_processed" : "webhook.processed"},'worker')`;
      let attachmentId: string | null = null;
      const attachmentMetadata = input.attachmentMetadata ?? input.metadata;
      if (
        ["image", "document", "audio", "video", "sticker"].includes(
          input.type,
        ) &&
        typeof attachmentMetadata.id === "string"
      ) {
        const providerMediaId = attachmentMetadata.id;
        const providerMimeType = String(
          attachmentMetadata.mime_type ?? "application/octet-stream",
        );
        const providerFilename = String(
          attachmentMetadata.filename ?? `${input.type}-${messageId}`,
        );
        const attachmentType =
          input.type === "audio" && attachmentMetadata.voice === true
            ? "voice"
            : input.type;
        const attachments = await tx<
          Array<Record<string, unknown>>
        >`INSERT INTO message_attachments(organization_id,message_id,channel_id,provider,provider_media_id,provider_mime_type,provider_filename,attachment_type,metadata) VALUES(${input.organizationId}::uuid,${messageId}::uuid,${input.channelId}::uuid,${input.provider ?? "meta"},${providerMediaId},${providerMimeType},${providerFilename},${attachmentType},${tx.json(attachmentMetadata as never)}) ON CONFLICT(channel_id,provider_media_id) WHERE provider_media_id IS NOT NULL DO UPDATE SET updated_at=now() RETURNING id`;
        attachmentId = attachments[0] ? String(attachments[0].id) : null;
        if (attachmentId)
          await tx`INSERT INTO media_processing_jobs(organization_id,attachment_id,job_type,trace_id) VALUES(${input.organizationId}::uuid,${attachmentId}::uuid,'media.download',${input.traceId}::uuid) ON CONFLICT(attachment_id,job_type) DO NOTHING`;
      }
      if (direction === "inbound" && input.type !== "reaction") {
        const isGroup = input.metadata.isGroup === true;
        const mentionedJids = Array.isArray(input.metadata.mentionedJids)
          ? input.metadata.mentionedJids.filter(
              (jid): jid is string => typeof jid === "string" && jid.length > 0,
            )
          : [];
        const automationPayload = {
          messageId,
          type: input.type,
          text: input.text,
          displayText:
            typeof input.metadata.displayText === "string"
              ? input.metadata.displayText
              : input.text,
          channelId: input.channelId,
          isGroup,
          ...(typeof input.metadata.chatId === "string"
            ? { chatId: input.metadata.chatId }
            : {}),
          ...(typeof input.metadata.chatName === "string"
            ? { chatName: input.metadata.chatName }
            : {}),
          ...(typeof input.metadata.senderJid === "string"
            ? { senderJid: input.metadata.senderJid }
            : {}),
          ...(typeof input.metadata.senderName === "string"
            ? { senderName: input.metadata.senderName }
            : {}),
          ...(mentionedJids.length ? { mentionedJids } : {}),
          ...(Array.isArray(input.metadata.mentions)
            ? { mentions: input.metadata.mentions }
            : {}),
        };
        const eventTypes = inboundAutomationEventTypes({
          provider: input.provider,
          isGroup,
          hasMentions: mentionedJids.length > 0,
        });
        for (const eventType of eventTypes)
          await tx`INSERT INTO automation_events(organization_id,event_type,aggregate_type,aggregate_id,conversation_id,correlation_id,origin,depth,payload) VALUES(${input.organizationId}::uuid,${eventType},'message',${messageId}::uuid,${conversationId}::uuid,${input.traceId}::uuid,${input.provider ?? "meta"},0,${tx.json(automationPayload as never)}) ON CONFLICT(organization_id,event_type,correlation_id,origin) DO NOTHING`;
        // AI orchestration enqueue: cheap transactional insert only when an
        // enabled agent assignment + workspace AI toggle exist for the
        // channel. Full eligibility (pause/takeover/mode) is evaluated by
        // the AI claim loop; not_before implements the reply debounce so
        // rapid consecutive customer messages batch into one AI turn.
        if (!isGroup)
          await tx`INSERT INTO ai_run_requests(organization_id,conversation_id,channel_id,contact_id,agent_id,message_ids,dedupe_key,not_before,next_attempt_at)
            SELECT ${input.organizationId}::uuid,${conversationId}::uuid,${input.channelId}::uuid,${contactId}::uuid,
              COALESCE(conv_ai.agent_id,assignment.agent_id),
              ${tx.json([messageId] as never)},${`msg:${messageId}`},
              now()+make_interval(secs=>settings.debounce_ms/1000.0),
              now()+make_interval(secs=>settings.debounce_ms/1000.0)
            FROM ai_agent_channel_assignments assignment
            JOIN ai_settings settings ON settings.organization_id=assignment.organization_id
            LEFT JOIN ai_conversation_settings conv_ai ON conv_ai.conversation_id=${conversationId}::uuid
            JOIN ai_agents agent ON agent.id=COALESCE(conv_ai.agent_id,assignment.agent_id)
            WHERE assignment.organization_id=${input.organizationId}::uuid
              AND assignment.channel_id=${input.channelId}::uuid
              AND assignment.enabled=true
              AND settings.enabled=true
              AND agent.status='active'
              AND COALESCE(conv_ai.status,'active')<>'disabled'
            ON CONFLICT(organization_id,dedupe_key) DO NOTHING`;
        await tx`INSERT INTO bitrix_open_channel_jobs(organization_id,integration_connection_id,conversation_id,local_message_id,job_type,idempotency_key,payload)
          SELECT ${input.organizationId}::uuid,ic.id,${conversationId}::uuid,${messageId}::uuid,
            'open_channels.incoming',${`incoming:${messageId}`},
            ${tx.json({ sourceMarker: `channel:${input.channelId}:${input.provider ?? "meta"}:${input.providerMessageId}`, provider: input.provider ?? "meta" } as never)}
              || jsonb_build_object('bindingId',binding.id)
          FROM bitrix_open_channel_bindings binding
          JOIN integration_connections ic
            ON ic.id=binding.integration_connection_id
           AND ic.organization_id=binding.organization_id
          WHERE binding.organization_id=${input.organizationId}::uuid
            AND binding.brixchat_channel_id=${input.channelId}::uuid
            AND binding.status='active'
            AND ic.provider='bitrix24'
            AND ic.status='connected'
            AND ic.bitrix_mode IN('open_channels','both')
            AND COALESCE((binding.settings->>'incomingEnabled')::boolean,true)=true
          ON CONFLICT(integration_connection_id,idempotency_key) DO NOTHING`;
        await tx`INSERT INTO bitrix_open_channel_jobs(organization_id,integration_connection_id,conversation_id,local_message_id,job_type,idempotency_key,payload,status,last_error)
          SELECT ${input.organizationId}::uuid,ic.id,${conversationId}::uuid,${messageId}::uuid,
            'open_channels.crm',${`crm:${conversationId}:${messageId}`},
            ${tx.json({ sourceMarker: `channel:${input.channelId}:${input.provider ?? "meta"}:${input.providerMessageId}`, provider: input.provider ?? "meta" } as never)}
              || jsonb_build_object('bindingId',binding.id),
            CASE WHEN EXISTS(
              SELECT 1 FROM bitrix_open_channel_jobs active_job
              WHERE active_job.organization_id=${input.organizationId}::uuid
                AND active_job.integration_connection_id=ic.id
                AND active_job.conversation_id=${conversationId}::uuid
                AND active_job.job_type='open_channels.crm'
                AND active_job.status IN('pending','retry','processing','manual_review','dead_letter')
            ) THEN 'blocked' ELSE 'pending' END,
            CASE WHEN EXISTS(
              SELECT 1 FROM bitrix_open_channel_jobs active_job
              WHERE active_job.organization_id=${input.organizationId}::uuid
                AND active_job.integration_connection_id=ic.id
                AND active_job.conversation_id=${conversationId}::uuid
                AND active_job.job_type='open_channels.crm'
                AND active_job.status IN('pending','retry','processing','manual_review','dead_letter')
            ) THEN 'CRM_REVIEW_PENDING' ELSE NULL END
          FROM bitrix_open_channel_bindings binding
          JOIN integration_connections ic
            ON ic.id=binding.integration_connection_id
           AND ic.organization_id=binding.organization_id
          WHERE binding.organization_id=${input.organizationId}::uuid
            AND binding.brixchat_channel_id=${input.channelId}::uuid
            AND binding.status='active'
            AND ic.provider='bitrix24'
            AND ic.status='connected'
            AND ic.bitrix_mode IN('open_channels','both')
            AND ${input.metadata.isGroup === true}=false
            AND EXISTS(
              SELECT 1 FROM channels crm_channel
              WHERE crm_channel.id=${input.channelId}::uuid
                AND crm_channel.organization_id=${input.organizationId}::uuid
                AND coalesce(crm_channel.platform,'whatsapp')='whatsapp'
            )
            AND binding.settings->>'autoCrmMode' IN('lead','contact_and_deal')
            AND NOT EXISTS(
              SELECT 1 FROM crm_contact_exclusions exclusion
              WHERE exclusion.organization_id=${input.organizationId}::uuid
                AND exclusion.normalized_phone=(
                  SELECT contact.normalized_phone FROM contacts contact
                  WHERE contact.id=${contactId}::uuid
                    AND contact.organization_id=${input.organizationId}::uuid
                )
                AND exclusion.archived_at IS NULL
            )
          ON CONFLICT DO NOTHING`;
      }
      if (
        direction === "outbound" &&
        input.type !== "reaction" &&
        input.metadata.origin !== "bitrix_open_channels"
      )
        await tx`INSERT INTO bitrix_open_channel_jobs(organization_id,integration_connection_id,conversation_id,local_message_id,job_type,idempotency_key,payload)
          SELECT ${input.organizationId}::uuid,ic.id,${conversationId}::uuid,${messageId}::uuid,
            'open_channels.outgoing',${`outgoing-provider:${input.providerMessageId}`},
            ${tx.json({ sourceMarker: `channel:${input.channelId}:${input.provider ?? "meta"}:${input.providerMessageId}`, provider: input.provider ?? "meta", providerMessageId: input.providerMessageId } as never)}
              || jsonb_build_object('bindingId',binding.id)
          FROM bitrix_open_channel_bindings binding
          JOIN integration_connections ic
            ON ic.id=binding.integration_connection_id
           AND ic.organization_id=binding.organization_id
          WHERE binding.organization_id=${input.organizationId}::uuid
            AND binding.brixchat_channel_id=${input.channelId}::uuid
            AND binding.status='active'
            AND ic.provider='bitrix24'
            AND ic.status='connected'
            AND ic.bitrix_mode IN('open_channels','both')
            AND COALESCE((binding.settings->>'outgoingEnabled')::boolean,true)=true
          ON CONFLICT(integration_connection_id,idempotency_key) DO NOTHING`;
      return {
        created: true,
        conversationId,
        messageId,
        conversationCreated,
        attachmentId,
      };
    });
  }
  async status(input: {
    organizationId: string;
    providerMessageId: string;
    status: "sent" | "delivered" | "read" | "failed";
    providerTimestamp: Date;
    eventKey: string;
    payload: Record<string, unknown>;
  }) {
    const failure =
      input.status === "failed"
        ? classifyDeliveryFailure({ payload: input.payload })
        : null;
    return this.sql.begin(async (tx) => {
      const rows = await tx<
        Array<Record<string, unknown>>
      >`SELECT id,conversation_id,status FROM messages WHERE organization_id=${input.organizationId}::uuid AND provider_message_id=${input.providerMessageId} FOR UPDATE`;
      const row = rows[0];
      if (!row) {
        await tx`INSERT INTO pending_message_status_events(organization_id,provider_message_id,status,provider_timestamp,payload,event_key) VALUES(${input.organizationId}::uuid,${input.providerMessageId},${input.status},${input.providerTimestamp},${tx.json(input.payload as never)},${input.eventKey}) ON CONFLICT(organization_id,event_key) DO NOTHING`;
        return {
          pending: true,
          duplicate: false,
          messageId: null,
          conversationId: null,
          status: input.status,
          errorCode: null,
          failureCategory: null,
          customerRelated: null,
          automationEligible: null,
        };
      }
      const current = String(row.status) as StoredMessageStatus;
      // Failed is terminal: a later provider delivery/read callback must not
      // make a permanently failed message appear successful. Conversely, a
      // message already delivered/read should not regress to failed.
      const next = nextStoredMessageStatus(current, input.status);
      const events =
        await tx`INSERT INTO message_status_events(organization_id,message_id,provider_message_id,status,provider_timestamp,payload,event_key) VALUES(${input.organizationId}::uuid,${String(row.id)}::uuid,${input.providerMessageId},${input.status},${input.providerTimestamp},${tx.json(input.payload as never)},${input.eventKey}) ON CONFLICT(organization_id,event_key) DO NOTHING RETURNING id`;
      if (events.length === 0)
        return {
          duplicate: true,
          messageId: String(row.id),
          conversationId: String(row.conversation_id),
          status: current,
          errorCode: null,
          failureCategory: null,
          customerRelated: null,
          automationEligible: null,
        };
      const actionableFailure =
        failure && current !== "failed" && next === "failed" ? failure : null;
      await tx`UPDATE messages SET status=${next}::message_status,error_code=CASE WHEN ${actionableFailure?.errorCode ?? null}::text IS NULL THEN error_code ELSE ${actionableFailure?.errorCode ?? null} END,error_message=CASE WHEN ${actionableFailure?.errorCode ?? null}::text IS NULL THEN error_message ELSE 'Provider delivery status failed' END,updated_at=now() WHERE id=${String(row.id)}::uuid`;
      if (actionableFailure)
        await tx`
          INSERT INTO automation_events(
            organization_id,event_type,aggregate_type,aggregate_id,
            conversation_id,correlation_id,origin,depth,payload
          )
          SELECT message.organization_id,'message.delivery_failed','message',
            message.id,message.conversation_id,message.id,
            'provider.delivery',0,
            jsonb_build_object(
              'messageId',message.id,
              'channelId',message.channel_id,
              'errorCode',${actionableFailure.errorCode},
              'retryable',false,
              'failureCategory',${actionableFailure.category},
              'customerRelated',${actionableFailure.customerRelated},
              'automationEligible',${actionableFailure.automationEligible},
              'metaCode',${actionableFailure.metaCode}
            )
          FROM messages message
          WHERE message.id=${String(row.id)}::uuid
            AND message.organization_id=${input.organizationId}::uuid
          ON CONFLICT(organization_id,event_type,correlation_id,origin)
          DO NOTHING
        `;
      return {
        duplicate: false,
        messageId: String(row.id),
        conversationId: String(row.conversation_id),
        status: next,
        errorCode: actionableFailure?.errorCode ?? null,
        failureCategory: actionableFailure?.category ?? null,
        customerRelated: actionableFailure?.customerRelated ?? null,
        automationEligible: actionableFailure?.automationEligible ?? null,
      };
    });
  }

  async pruneOrphanedPendingStatuses(
    retentionHours: number,
    limit = 1_000,
  ): Promise<number> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      WITH candidates AS (
        SELECT pending.id
        FROM pending_message_status_events pending
        WHERE pending.created_at < now()-(${retentionHours}::int*interval '1 hour')
          AND NOT EXISTS (
            SELECT 1
            FROM messages message
            WHERE message.organization_id=pending.organization_id
              AND message.provider_message_id=pending.provider_message_id
          )
        ORDER BY pending.created_at
        FOR UPDATE OF pending SKIP LOCKED
        LIMIT ${limit}
      )
      DELETE FROM pending_message_status_events pending
      USING candidates
      WHERE pending.id=candidates.id
      RETURNING pending.id`;
    return rows.length;
  }
}

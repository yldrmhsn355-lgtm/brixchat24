import { createHash, randomUUID } from "node:crypto";
import {
  CAMPAIGN_RECIPIENT_LIMIT,
  normalizeCampaignPhone,
  type CampaignRecipientInput,
} from "@brixchat/shared";
import {
  ConversationRepository,
  MessageRepository,
  type DatabaseClient,
} from "./index";
import { BillingRepository } from "./billing";

export type CampaignContent =
  | { type: "text"; text: string }
  | { type: "template"; templateId: string; variables: Record<string, string> };
export interface CampaignDraftInput {
  organizationId: string;
  userId: string;
  requestKey: string;
  channelId: string;
  name: string;
  content: CampaignContent;
  recipients: CampaignRecipientInput[];
}
export interface CampaignRow {
  id: string;
  organization_id: string;
  channel_id: string;
  created_by: string;
  name: string;
  content: CampaignContent;
  content_hash: string;
  status: string;
  dry_run_token: string | null;
  dry_run_at: Date | null;
  dry_run_result: CampaignDryRun | null;
}
export interface CampaignDryRun {
  recipientCount: number;
  eligibleCount: number;
  blockedCount: number;
  blockers: string[];
  recipients: Array<{
    id: string;
    phone: string;
    name: string;
    reason: string | null;
  }>;
  messagePreview: string;
  /** A dry run never enqueues a provider operation. */
  messagesQueued: 0;
}
export function campaignError(code: string, statusCode = 409): never {
  throw Object.assign(new Error(code), { statusCode });
}

export class CampaignRepository {
  private readonly sql: DatabaseClient;
  constructor(client: DatabaseClient) {
    // postgres.js transaction clients expose savepoint rather than begin.
    // Preserve one atomic transaction when composing the existing repositories.
    this.sql = new Proxy(client, {
      get(target, property, receiver) {
        if (property === "begin" && typeof target.begin !== "function")
          return (callback: (tx: DatabaseClient) => Promise<unknown>) =>
            (
              target as unknown as {
                savepoint: (
                  fn: (tx: DatabaseClient) => Promise<unknown>,
                ) => Promise<unknown>;
              }
            ).savepoint((tx) => callback(new CampaignRepository(tx).sql));
        return Reflect.get(target, property, receiver);
      },
    });
  }

  async assertManager(organizationId: string, userId: string) {
    const rows = await this.sql`
      SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id
      WHERE m.organization_id=${organizationId}::uuid AND m.user_id=${userId}::uuid
        AND m.role IN ('owner','admin') AND u.is_active AND u.suspended_at IS NULL`;
    if (!rows[0]) campaignError("campaign_manager_required", 403);
  }

  async createDraft(input: CampaignDraftInput) {
    await this.assertManager(input.organizationId, input.userId);
    if (
      !input.recipients.length ||
      input.recipients.length > CAMPAIGN_RECIPIENT_LIMIT
    )
      campaignError("campaign_recipient_count_invalid", 400);
    const seen = new Set<string>();
    const recipients = input.recipients
      .map((recipient) => {
        const phone = normalizeCampaignPhone(recipient.phone);
        if (!phone || recipient.name.length > 120)
          campaignError("campaign_recipient_invalid", 400);
        if (seen.has(phone)) campaignError("campaign_duplicate_recipient", 400);
        seen.add(phone);
        return { phone, name: recipient.name.trim() };
      })
      .sort((a, b) => a.phone.localeCompare(b.phone));
    const content =
      input.content.type === "text"
        ? { type: "text" as const, text: input.content.text.trim() }
        : {
            type: "template" as const,
            templateId: input.content.templateId,
            variables: Object.fromEntries(
              Object.entries(input.content.variables).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            ),
          };
    if (
      content.type === "text" &&
      (!content.text ||
        content.text.length > 4096 ||
        /\{\{.*?\}\}/s.test(content.text))
    )
      campaignError("campaign_text_invalid", 400);
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          channelId: input.channelId,
          name: input.name.trim(),
          content,
          recipients,
        }),
      )
      .digest("hex");
    return this.sql.begin(async (tx) => {
      // Serialize identical request keys before checking/inserting, including retries.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.organizationId}:${input.requestKey}`},0))`;
      const [existing] = await tx<
        CampaignRow[]
      >`SELECT * FROM campaigns WHERE organization_id=${input.organizationId}::uuid AND request_key=${input.requestKey}::uuid`;
      if (existing) {
        if (existing.content_hash !== hash)
          campaignError("campaign_idempotency_conflict");
        return { campaign: existing, created: false };
      }
      const channels =
        await tx`SELECT id FROM channels WHERE organization_id=${input.organizationId}::uuid
        AND id=${input.channelId}::uuid AND deleted_at IS NULL AND status='connected'
        AND COALESCE(connection_status,'ACTIVE')='ACTIVE' AND COALESCE(platform,'whatsapp')='whatsapp'
        AND provider IN ('meta','whatsapp_web') FOR SHARE`;
      if (!channels[0]) campaignError("campaign_connected_channel_required");
      const [campaign] = await tx<
        CampaignRow[]
      >`INSERT INTO campaigns(organization_id,channel_id,created_by,name,content,request_key,content_hash)
        VALUES(${input.organizationId}::uuid,${input.channelId}::uuid,${input.userId}::uuid,${input.name.trim()},${tx.json(content)},${input.requestKey}::uuid,${hash}) RETURNING *`;
      if (!campaign) throw new Error("campaign_insert_failed");
      await tx`INSERT INTO campaign_recipients ${tx(
        recipients.map((recipient) => ({
          organization_id: input.organizationId,
          campaign_id: campaign.id,
          phone: recipient.phone,
          name: recipient.name,
        })),
      )}`;
      await tx`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata)
        VALUES(${input.organizationId}::uuid,${input.userId}::uuid,'campaign.created','campaign',${campaign.id}::uuid,
          ${tx.json({ recipientCount: recipients.length, channelId: input.channelId })})`;
      return { campaign, created: true };
    });
  }

  async get(organizationId: string, id: string) {
    const [campaign] = await this.sql<
      CampaignRow[]
    >`SELECT * FROM campaigns WHERE organization_id=${organizationId}::uuid AND id=${id}::uuid`;
    if (!campaign) campaignError("campaign_not_found", 404);
    return campaign;
  }

  async list(organizationId: string) {
    return this
      .sql`SELECT c.id,c.name,c.channel_id,c.status,c.created_at,c.started_at,c.completed_at,
      count(r.id)::int recipient_count,
      count(r.id) FILTER(WHERE r.status IN ('pending','queued'))::int pending_count,
      count(r.id) FILTER(WHERE r.status='sent')::int sent_count,
      count(r.id) FILTER(WHERE r.status='failed')::int failed_count,
      count(r.id) FILTER(WHERE r.status='canceled')::int canceled_count
      FROM campaigns c LEFT JOIN campaign_recipients r ON r.campaign_id=c.id AND r.organization_id=c.organization_id
      WHERE c.organization_id=${organizationId}::uuid GROUP BY c.id ORDER BY c.created_at DESC LIMIT 100`;
  }

  async options(organizationId: string) {
    const channels = await this
      .sql`SELECT id,name,phone_number,provider FROM channels
      WHERE organization_id=${organizationId}::uuid AND deleted_at IS NULL AND status='connected'
        AND COALESCE(connection_status,'ACTIVE')='ACTIVE' AND COALESCE(platform,'whatsapp')='whatsapp'
        AND provider IN ('meta','whatsapp_web') ORDER BY name`;
    const templates = await this
      .sql`SELECT t.id,t.name,t.language,t.body_text,tc.channel_id,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('key',lower(v.component)||'.'||v.position::text,'required',v.required,'defaultValue',v.default_value)
        ORDER BY v.component,v.position) FROM message_template_variables v WHERE v.template_id=t.id),'[]'::jsonb) variables
      FROM message_templates t JOIN message_template_channels tc ON tc.template_id=t.id AND tc.organization_id=t.organization_id
      WHERE t.organization_id=${organizationId}::uuid AND t.status='approved' AND t.deleted_at IS NULL ORDER BY t.name,t.language`;
    return { channels, templates };
  }

  async recipients(organizationId: string, campaignId: string) {
    await this.get(organizationId, campaignId);
    return this
      .sql`SELECT id,phone,name,status,error_code,message_id FROM campaign_recipients
      WHERE organization_id=${organizationId}::uuid AND campaign_id=${campaignId}::uuid ORDER BY phone`;
  }

  async evaluate(
    campaign: CampaignRow,
    recipientId?: string,
  ): Promise<CampaignDryRun> {
    const blockers: string[] = [];
    const [channel] = await this
      .sql`SELECT id,status,provider,deleted_at,COALESCE(connection_status,'ACTIVE') connection_status
      FROM channels WHERE organization_id=${campaign.organization_id}::uuid AND id=${campaign.channel_id}::uuid`;
    if (
      !channel ||
      channel.deleted_at ||
      channel.status !== "connected" ||
      channel.connection_status !== "ACTIVE"
    )
      blockers.push("campaign_connected_channel_required");
    if (channel && !["meta", "whatsapp_web"].includes(String(channel.provider)))
      blockers.push("campaign_provider_unsupported");
    try {
      await this.assertManager(campaign.organization_id, campaign.created_by);
    } catch {
      blockers.push("campaign_manager_required");
    }
    const policy = await new BillingRepository(this.sql).policy(
      campaign.organization_id,
      "outgoing_messages",
    );
    if (!policy.allowed) blockers.push(policy.code ?? "campaign_plan_blocked");
    const rows = await this.sql<
      Array<{
        id: string;
        phone: string;
        name: string;
        consent: boolean;
        window_open: boolean;
      }>
    >`
      SELECT r.id,r.phone,r.name,
        EXISTS(SELECT 1 FROM consent_records cr WHERE cr.organization_id=r.organization_id
          AND cr.subject_reference_hash=encode(sha256(convert_to(r.phone,'UTF8')),'hex') AND cr.purpose='whatsapp'
          AND cr.status='granted' AND cr.withdrawn_at IS NULL) consent,
        EXISTS(SELECT 1 FROM contacts ct JOIN conversations cv ON cv.contact_id=ct.id AND cv.organization_id=ct.organization_id
          WHERE ct.organization_id=r.organization_id AND ct.normalized_phone=r.phone AND cv.channel_id=${campaign.channel_id}::uuid
            AND cv.status IN ('open','waiting') AND cv.customer_service_window_expires_at>now()) window_open
      FROM campaign_recipients r WHERE r.organization_id=${campaign.organization_id}::uuid AND r.campaign_id=${campaign.id}::uuid
        AND (${recipientId ?? null}::uuid IS NULL OR r.id=${recipientId ?? null}::uuid) ORDER BY r.phone`;
    if (policy.limit !== null && policy.usage + rows.length > policy.limit)
      blockers.push("campaign_quota_insufficient");
    let messagePreview =
      campaign.content.type === "text" ? campaign.content.text : "";
    if (campaign.content.type === "template") {
      const resolved = await this.resolveTemplate(campaign);
      if (resolved.reason) blockers.push(resolved.reason);
      messagePreview = resolved.text;
    }
    const recipients = rows.map((row) => ({
      id: row.id,
      phone: row.phone,
      name: row.name,
      reason: !row.consent
        ? "whatsapp_opt_in_missing"
        : campaign.content.type === "text" && !row.window_open
          ? "WHATSAPP_TEMPLATE_REQUIRED"
          : null,
    }));
    const blockedCount = recipients.filter((row) => row.reason !== null).length;
    return {
      recipientCount: rows.length,
      eligibleCount: rows.length - blockedCount,
      blockedCount,
      blockers,
      recipients,
      messagePreview,
      messagesQueued: 0,
    };
  }

  private async resolveTemplate(campaign: CampaignRow): Promise<{
    reason: string | null;
    text: string;
    metadata: Record<string, unknown>;
  }> {
    if (campaign.content.type !== "template")
      return { reason: null, text: "", metadata: {} };
    const [template] = await this
      .sql`SELECT t.* FROM message_templates t JOIN message_template_channels tc
      ON tc.template_id=t.id AND tc.organization_id=t.organization_id
      WHERE t.organization_id=${campaign.organization_id}::uuid AND t.id=${campaign.content.templateId}::uuid
        AND tc.channel_id=${campaign.channel_id}::uuid AND t.status='approved' AND t.deleted_at IS NULL`;
    if (!template)
      return {
        reason: "campaign_approved_template_required",
        text: "",
        metadata: {},
      };
    // Campaigns currently compose text components; media headers require the media upload flow.
    const components = Array.isArray(template.components)
      ? (template.components as Array<Record<string, unknown>>)
      : [];
    if (
      components.some(
        (component) =>
          String(component.type).toUpperCase() === "HEADER" &&
          component.format &&
          String(component.format).toUpperCase() !== "TEXT",
      )
    )
      return {
        reason: "campaign_template_media_required",
        text: String(template.body_text),
        metadata: {},
      };
    const variables = await this
      .sql`SELECT component,position,default_value,required,missing_policy FROM message_template_variables
      WHERE template_id=${campaign.content.templateId}::uuid ORDER BY component,position`;
    let text = String(template.body_text ?? "");
    const resolution: Array<{ key: string; value: string }> = [];
    for (const variable of variables) {
      const key = `${String(variable.component).toLowerCase()}.${Number(variable.position)}`;
      const value =
        campaign.content.variables[key] ??
        (variable.missing_policy === "default"
          ? String(variable.default_value ?? "")
          : "");
      if (!value && variable.required)
        return {
          reason: "campaign_template_variables_missing",
          text,
          metadata: {},
        };
      resolution.push({ key, value });
      if (key.startsWith("body."))
        text = text.split(`{{${Number(variable.position)}}}`).join(value);
    }
    if (/\{\{.*?\}\}/s.test(text))
      return {
        reason: "campaign_template_variables_missing",
        text,
        metadata: {},
      };
    return {
      reason: null,
      text,
      metadata: {
        templateId: campaign.content.templateId,
        templateName: String(template.name),
        language: String(template.language),
        templateComponents: components,
        variables: Object.fromEntries(
          resolution.map((variable) => [variable.key, variable.value]),
        ),
        variableResolution: resolution,
        orderedVariables: resolution.map((variable) => variable.value),
      },
    };
  }

  /** No network calls inside this transaction. Row locks and message/outbox inserts commit together. */
  async processNextRecipient(): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const [campaign] = await tx<CampaignRow[]>`SELECT c.* FROM campaigns c
        WHERE c.status IN ('queued','processing') AND EXISTS(SELECT 1 FROM campaign_recipients r
          WHERE r.organization_id=c.organization_id AND r.campaign_id=c.id AND r.status='pending')
        ORDER BY c.started_at FOR UPDATE OF c SKIP LOCKED LIMIT 1`;
      if (!campaign) return false;
      const [recipient] = await tx<
        Array<{
          id: string;
          phone: string;
          name: string;
          client_message_id: string;
        }>
      >`
        SELECT id,phone,name,client_message_id FROM campaign_recipients WHERE organization_id=${campaign.organization_id}::uuid
          AND campaign_id=${campaign.id}::uuid AND status='pending' ORDER BY phone FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!recipient) return false;
      await tx`UPDATE campaigns SET status='processing',updated_at=now() WHERE id=${campaign.id}::uuid AND organization_id=${campaign.organization_id}::uuid`;
      try {
        await tx.savepoint(async (inner) => {
          const repo = new CampaignRepository(
            inner as unknown as DatabaseClient,
          );
          const client = repo.sql;
          const evaluated = await repo.evaluate(campaign, recipient.id);
          if (
            evaluated.messagePreview !== campaign.dry_run_result?.messagePreview
          )
            campaignError("campaign_preview_changed");
          const reason =
            evaluated.blockers[0] ?? evaluated.recipients[0]?.reason;
          if (reason) campaignError(reason);
          if (evaluated.eligibleCount !== 1)
            campaignError("campaign_recipient_unavailable");
          const billing = new BillingRepository(client);
          const entitlement = await billing.reserveUsage({
            organizationId: campaign.organization_id,
            eventKey: `message.outgoing:${recipient.client_message_id}`,
            metric: "outgoing_messages",
          });
          if (!entitlement.allowed)
            campaignError(entitlement.code ?? "campaign_plan_blocked");
          const conversation = await new ConversationRepository(
            client,
          ).startOutbound({
            organizationId: campaign.organization_id,
            userId: campaign.created_by,
            role: "admin",
            channelId: campaign.channel_id,
            normalizedPhone: recipient.phone,
            displayName: recipient.name || recipient.phone,
          });
          if (conversation.kind !== "ok")
            campaignError("campaign_connected_channel_required");
          const traceId = randomUUID();
          let messageId: string;
          if (campaign.content.type === "text") {
            const result = await new MessageRepository(client).createOutbound({
              organizationId: campaign.organization_id,
              conversationId: conversation.conversationId,
              senderId: campaign.created_by,
              role: "admin",
              clientMessageId: recipient.client_message_id,
              expectedChannelId: campaign.channel_id,
              text: campaign.content.text,
              traceId,
              metadata: {
                campaignId: campaign.id,
                campaignRecipientId: recipient.id,
                origin: "campaign",
              },
            });
            messageId = result.message.id;
          } else {
            const template = await repo.resolveTemplate(campaign);
            if (template.reason) campaignError(template.reason);
            const [message] = await inner<
              Array<{ id: string }>
            >`INSERT INTO messages(
              organization_id,conversation_id,channel_id,contact_id,client_message_id,direction,type,status,body,sender_id,metadata)
              SELECT ${campaign.organization_id}::uuid,c.id,c.channel_id,c.contact_id,${recipient.client_message_id}::uuid,
                'outbound','template','pending',${template.text},${campaign.created_by}::uuid,
                ${inner.json({ ...template.metadata, campaignId: campaign.id, campaignRecipientId: recipient.id, origin: "campaign" } as never)}
              FROM conversations c WHERE c.id=${conversation.conversationId}::uuid AND c.organization_id=${campaign.organization_id}::uuid
              RETURNING id`;
            if (!message) throw new Error("campaign_message_insert_failed");
            messageId = message.id;
            await inner`INSERT INTO outbox_jobs(organization_id,aggregate_type,aggregate_id,job_type,payload)
              VALUES(${campaign.organization_id}::uuid,'message',${messageId}::uuid,'template.send',${inner.json({ messageId, traceId })})`;
            await inner`INSERT INTO template_send_events(organization_id,template_id,message_id,status)
              VALUES(${campaign.organization_id}::uuid,${campaign.content.templateId}::uuid,${messageId}::uuid,'pending')`;
            await inner`UPDATE message_templates SET usage_count=usage_count+1,last_used_at=now(),updated_at=now()
              WHERE organization_id=${campaign.organization_id}::uuid AND id=${campaign.content.templateId}::uuid`;
            await inner`UPDATE conversations SET last_message_id=${messageId}::uuid,last_message_at=now(),updated_at=now()
              WHERE organization_id=${campaign.organization_id}::uuid AND id=${conversation.conversationId}::uuid`;
          }
          await inner`UPDATE campaign_recipients SET status='queued',message_id=${messageId}::uuid,updated_at=now()
            WHERE organization_id=${campaign.organization_id}::uuid AND id=${recipient.id}::uuid`;
        });
      } catch (error) {
        // Validation failures are terminal per recipient; infrastructure errors roll back for retry.
        if (!(error instanceof Error) || !("statusCode" in error)) throw error;
        await tx`UPDATE campaign_recipients SET status='failed',error_code=${error.message},updated_at=now()
          WHERE organization_id=${campaign.organization_id}::uuid AND id=${recipient.id}::uuid`;
      }
      return true;
    });
  }

  async reconcileStatuses() {
    await this
      .sql`UPDATE campaign_recipients r SET status=CASE WHEN m.status='failed' THEN 'failed' ELSE 'sent' END,
      error_code=CASE WHEN m.status='failed' THEN COALESCE(m.error_code,'delivery_failed') ELSE NULL END,updated_at=now()
      FROM messages m WHERE m.organization_id=r.organization_id AND m.id=r.message_id AND r.status='queued'
        AND m.status IN ('sent','delivered','read','failed')`;
    await this
      .sql`UPDATE campaigns c SET status='completed',completed_at=now(),updated_at=now()
      WHERE c.status IN ('queued','processing') AND NOT EXISTS(SELECT 1 FROM campaign_recipients r
        WHERE r.organization_id=c.organization_id AND r.campaign_id=c.id AND r.status IN ('pending','queued'))`;
  }

  /** At most one provider attempt for campaign messages, including recovery after process death. */
  async beginDelivery(
    organizationId: string,
    messageId: string,
  ): Promise<boolean> {
    const rows = await this
      .sql`UPDATE messages SET metadata=metadata || jsonb_build_object('campaignDeliveryStartedAt',now())
      WHERE organization_id=${organizationId}::uuid AND id=${messageId}::uuid
        AND metadata->>'campaignId' IS NOT NULL AND metadata->>'campaignDeliveryStartedAt' IS NULL
        AND EXISTS(SELECT 1 FROM campaigns c JOIN users u ON u.id=c.created_by
          JOIN organization_members om ON om.organization_id=c.organization_id AND om.user_id=c.created_by
          WHERE c.id::text=messages.metadata->>'campaignId' AND c.organization_id=messages.organization_id
            AND c.status IN ('queued','processing') AND u.is_active AND u.suspended_at IS NULL AND om.role IN ('owner','admin'))
        AND EXISTS(SELECT 1 FROM contacts ct JOIN consent_records cr ON cr.organization_id=ct.organization_id
          AND cr.subject_reference_hash=encode(sha256(convert_to(ct.normalized_phone,'UTF8')),'hex')
          WHERE ct.id=messages.contact_id AND ct.organization_id=messages.organization_id AND cr.purpose='whatsapp'
            AND cr.status='granted' AND cr.withdrawn_at IS NULL)
        AND (messages.type='template' OR EXISTS(SELECT 1 FROM conversations cv WHERE cv.id=messages.conversation_id
          AND cv.organization_id=messages.organization_id AND cv.customer_service_window_expires_at>now())) RETURNING id`;
    return Boolean(rows[0]);
  }

  /** The supplied evaluator is read-only and shared with enqueue-time eligibility checks. */
  async dryRun(
    organizationId: string,
    id: string,
    userId: string,
    evaluate: (
      repository: CampaignRepository,
      campaign: CampaignRow,
    ) => Promise<CampaignDryRun> = (repository, campaign) =>
      repository.evaluate(campaign),
  ) {
    await this.assertManager(organizationId, userId);
    return this.sql.begin(async (tx) => {
      const [campaign] = await tx<
        CampaignRow[]
      >`SELECT * FROM campaigns WHERE organization_id=${organizationId}::uuid AND id=${id}::uuid FOR UPDATE`;
      if (!campaign) campaignError("campaign_not_found", 404);
      if (campaign.status !== "draft")
        campaignError("campaign_already_started");
      const result = await evaluate(
        new CampaignRepository(tx as unknown as DatabaseClient),
        campaign,
      );
      const token = randomUUID();
      await tx`UPDATE campaigns SET dry_run_token=${token}::uuid,dry_run_at=now(),dry_run_result=${tx.json(result as never)},updated_at=now()
        WHERE organization_id=${organizationId}::uuid AND id=${id}::uuid`;
      return { ...result, token };
    });
  }

  async start(
    organizationId: string,
    id: string,
    userId: string,
    token: string,
    confirmedRecipientCount: number,
  ) {
    await this.assertManager(organizationId, userId);
    return this.sql.begin(async (tx) => {
      const [campaign] = await tx<
        CampaignRow[]
      >`SELECT * FROM campaigns WHERE organization_id=${organizationId}::uuid AND id=${id}::uuid FOR UPDATE`;
      if (!campaign) campaignError("campaign_not_found", 404);
      if (campaign.dry_run_token !== token)
        campaignError("campaign_dry_run_required");
      if (campaign.status !== "draft") {
        if (campaign.status === "canceled") campaignError("campaign_canceled");
        return { started: false, status: campaign.status };
      }
      const result = campaign.dry_run_result;
      if (
        !campaign.dry_run_at ||
        Date.now() - new Date(campaign.dry_run_at).getTime() > 600_000
      )
        campaignError("campaign_dry_run_expired");
      if (
        !result ||
        result.blockers.length ||
        result.blockedCount ||
        !result.eligibleCount
      )
        campaignError("campaign_dry_run_blocked");
      if (confirmedRecipientCount !== result.recipientCount)
        campaignError("campaign_confirmation_mismatch");
      await tx`UPDATE campaigns SET status='queued',started_at=now(),updated_at=now() WHERE id=${id}::uuid AND organization_id=${organizationId}::uuid`;
      await tx`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata)
        VALUES(${organizationId}::uuid,${userId}::uuid,'campaign.started','campaign',${id}::uuid,${tx.json({ confirmedRecipientCount })})`;
      return { started: true, status: "queued" };
    });
  }

  async cancel(organizationId: string, id: string, userId: string) {
    await this.assertManager(organizationId, userId);
    return this.sql.begin(async (tx) => {
      const campaign =
        await tx`SELECT id FROM campaigns WHERE organization_id=${organizationId}::uuid AND id=${id}::uuid FOR UPDATE`;
      if (!campaign[0]) campaignError("campaign_not_found", 404);
      await tx`UPDATE campaigns SET status='canceled',updated_at=now() WHERE organization_id=${organizationId}::uuid AND id=${id}::uuid AND status IN ('draft','queued','processing')`;
      // Already queued provider jobs are reported separately and are not recalled.
      await tx`UPDATE campaign_recipients SET status='canceled',updated_at=now() WHERE organization_id=${organizationId}::uuid AND campaign_id=${id}::uuid AND status='pending'`;
      return { canceled: true };
    });
  }
}

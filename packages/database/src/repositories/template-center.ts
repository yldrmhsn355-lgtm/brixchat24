import type { DatabaseClient } from "./index";

export type TemplateListInput = {
  organizationId: string;
  userId: string;
  role: string;
  channelId?: string | undefined;
  businessAccountId?: string | undefined;
  language?: string | undefined;
  category?: string | undefined;
  status?: string | undefined;
  quality?: string | undefined;
  usage?: "used" | "unused" | undefined;
  search?: string | undefined;
  page: number;
  limit: number;
};

export class TemplateCenterRepository {
  constructor(private readonly sql: DatabaseClient) {}

  async existingSyncRun(organizationId: string, idempotencyKey: string) {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT id,status FROM template_sync_runs
      WHERE organization_id=${organizationId}::uuid
        AND idempotency_key=${idempotencyKey}`;
    return rows[0] ?? null;
  }

  async startSyncRun(input: {
    organizationId: string;
    channelId: string;
    businessAccountId: string;
    idempotencyKey: string;
  }) {
    const rows = await this.sql<Array<{ id: string }>>`
      INSERT INTO template_sync_runs(
        organization_id,channel_id,business_account_id,idempotency_key,status
      ) VALUES(
        ${input.organizationId}::uuid,${input.channelId}::uuid,
        ${input.businessAccountId},${input.idempotencyKey},'running'
      ) RETURNING id`;
    return rows[0]!.id;
  }

  async completeSyncRun(input: {
    runId: string;
    received: number;
    created: number;
    updated: number;
    archived: number;
  }) {
    await this.sql`
      UPDATE template_sync_runs SET status='completed',
        templates_received=${input.received},
        templates_created=${input.created},
        templates_updated=${input.updated},
        templates_archived=${input.archived},pages_received=1,completed_at=now()
      WHERE id=${input.runId}::uuid`;
  }

  async failSyncRun(runId: string, code: string) {
    await this.sql`
      UPDATE template_sync_runs SET status='failed',last_error=${code},
        error_details=${this.sql.json({ code } as never)},completed_at=now()
      WHERE id=${runId}::uuid`;
  }

  async notifySyncFailure(input: {
    organizationId: string;
    channelId: string;
    runId: string;
    code: string;
  }) {
    await this.sql`
      INSERT INTO notifications(
        organization_id,user_id,type,title,body,metadata
      ) VALUES(
        ${input.organizationId}::uuid,null,'template.sync_failed',
        'WhatsApp Şablon Senkronizasyonu Başarısız',
        ${`Kanal şablonları senkronize edilemedi: ${input.code}`},
        ${this.sql.json(input as never)}
      )`;
  }

  async list(input: TemplateListInput) {
    const offset = (input.page - 1) * input.limit;
    const commonFilter = this.sql`
      mt.organization_id=${input.organizationId}::uuid
      AND mt.deleted_at IS NULL
      AND (${input.channelId ?? null}::uuid IS NULL OR EXISTS(
        SELECT 1 FROM message_template_channels mtcf
        WHERE mtcf.template_id=mt.id
          AND mtcf.channel_id=${input.channelId ?? null}::uuid
      ))
      AND (${input.businessAccountId ?? null}::text IS NULL OR mt.business_account_id=${input.businessAccountId ?? null})
      AND (${input.language ?? null}::text IS NULL OR mt.language=${input.language ?? null})
      AND (${input.category ?? null}::text IS NULL OR mt.category=${input.category ?? null})
      AND (${input.status ?? null}::text IS NULL OR mt.status=${input.status ?? null})
      AND (${input.quality ?? null}::text IS NULL OR mt.quality_score=${input.quality ?? null})
      AND (${input.usage ?? null}::text IS NULL
        OR (${input.usage ?? null}='used' AND mt.usage_count>0)
        OR (${input.usage ?? null}='unused' AND mt.usage_count=0))
      AND (${input.search ?? null}::text IS NULL
        OR mt.name ILIKE ${`%${input.search ?? ""}%`}
        OR mt.body_text ILIKE ${`%${input.search ?? ""}%`})
      AND (${!["agent", "team_lead"].includes(input.role)} OR EXISTS(
        SELECT 1 FROM message_template_channels mtca
        JOIN channel_user_ownership cuo
          ON cuo.organization_id=mtca.organization_id
         AND cuo.channel_id=mtca.channel_id
        WHERE mtca.template_id=mt.id AND cuo.user_id=${input.userId}::uuid
      ))`;
    const [countRows, data, syncRows] = await Promise.all([
      this.sql<Array<{ count: number }>>`
        SELECT count(*)::int count FROM message_templates mt
        WHERE ${commonFilter}`,
      this.sql`
        SELECT mt.id,mt.family_id,mt.business_account_id,
               mt.provider_template_id,mt.name,mt.normalized_name,mt.language,
               mt.category,mt.status,mt.quality_score,mt.rejection_reason,
               mt.header_type,mt.header_text,mt.body_text,mt.footer_text,
               mt.buttons,mt.components,mt.parameter_format,mt.last_synced_at,
               mt.usage_count,mt.last_used_at,mt.version,mt.internal_label,
               mt.folder,
               (SELECT count(*)::int FROM message_template_variables v
                WHERE v.template_id=mt.id) variable_count,
               COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                   'id',ch.id,'name',ch.name,'phoneNumber',ch.phone_number,
                   'phoneNumberId',ch.phone_number_id
                 ) ORDER BY ch.name)
                 FROM message_template_channels mtc
                 JOIN channels ch ON ch.id=mtc.channel_id
                                      AND ch.deleted_at IS NULL
                 WHERE mtc.template_id=mt.id
               ),'[]'::jsonb) channels
        FROM message_templates mt
        WHERE ${commonFilter}
        ORDER BY mt.updated_at DESC
        LIMIT ${input.limit} OFFSET ${offset}`,
      this.sql`
        SELECT id,status,templates_received,templates_created,
               templates_updated,templates_archived,last_error,started_at,
               completed_at
        FROM template_sync_runs
        WHERE organization_id=${input.organizationId}::uuid
          AND (${input.channelId ?? null}::uuid IS NULL
               OR channel_id=${input.channelId ?? null}::uuid)
        ORDER BY started_at DESC LIMIT 1`,
    ]);
    return {
      data,
      meta: {
        page: input.page,
        limit: input.limit,
        total: Number(countRows[0]?.count ?? 0),
        lastSync: syncRows[0] ?? null,
      },
    };
  }

  async summary(input: {
    organizationId: string;
    userId: string;
    role: string;
    channelId?: string | undefined;
    businessAccountId?: string | undefined;
  }) {
    const rows = await this.sql`
      SELECT count(*)::int total,
             count(*) FILTER (WHERE mt.status='approved')::int approved,
             count(*) FILTER (WHERE mt.status IN ('pending','in_review'))::int pending,
             count(*) FILTER (WHERE mt.status='rejected')::int rejected,
             count(*) FILTER (WHERE mt.status='paused')::int paused,
             count(*) FILTER (WHERE mt.status='disabled')::int disabled,
             count(*) FILTER (WHERE mt.status='draft')::int draft
      FROM message_templates mt
      WHERE mt.organization_id=${input.organizationId}::uuid
        AND mt.deleted_at IS NULL
        AND (${input.businessAccountId ?? null}::text IS NULL OR mt.business_account_id=${input.businessAccountId ?? null})
        AND (${input.channelId ?? null}::uuid IS NULL OR EXISTS(
          SELECT 1 FROM message_template_channels mtc
          WHERE mtc.template_id=mt.id
            AND mtc.channel_id=${input.channelId ?? null}::uuid
        ))
        AND (${!["agent", "team_lead"].includes(input.role)} OR EXISTS(
          SELECT 1 FROM message_template_channels mtca
          JOIN channel_user_ownership cuo
            ON cuo.organization_id=mtca.organization_id
           AND cuo.channel_id=mtca.channel_id
          WHERE mtca.template_id=mt.id AND cuo.user_id=${input.userId}::uuid
        ))`;
    return rows[0] ?? {};
  }

  async families(organizationId: string) {
    return this.sql`
      SELECT f.id,f.business_account_id,f.normalized_name,f.default_language,
             f.fallback_language,f.internal_label,f.folder,
             COALESCE(jsonb_agg(jsonb_build_object(
               'id',mt.id,'language',mt.language,'status',mt.status,
               'quality',mt.quality_score
             ) ORDER BY mt.language) FILTER (WHERE mt.id IS NOT NULL),'[]'::jsonb) variants
      FROM message_template_families f
      LEFT JOIN message_templates mt ON mt.family_id=f.id
                                     AND mt.deleted_at IS NULL
      WHERE f.organization_id=${organizationId}::uuid
      GROUP BY f.id
      ORDER BY f.updated_at DESC`;
  }

  async managementTemplate(
    organizationId: string,
    templateId: string,
    channelId?: string,
  ) {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT mt.*,ch.provider,ch.credentials_encrypted,
             ch.business_account_id channel_waba,ch.phone_number_id
      FROM message_templates mt
      JOIN message_template_channels mtc ON mtc.template_id=mt.id
      JOIN channels ch ON ch.id=mtc.channel_id AND ch.deleted_at IS NULL
      WHERE mt.id=${templateId}::uuid
        AND mt.organization_id=${organizationId}::uuid
        AND mt.deleted_at IS NULL
        AND (${channelId ?? null}::uuid IS NULL OR ch.id=${channelId ?? null}::uuid)
      ORDER BY ch.created_at LIMIT 1`;
    return rows[0] ?? null;
  }

  async editableTemplate(organizationId: string, templateId: string) {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT mt.*,
             (SELECT mtc.channel_id FROM message_template_channels mtc
              WHERE mtc.template_id=mt.id
              ORDER BY mtc.created_at LIMIT 1) edit_channel_id
      FROM message_templates mt
      WHERE mt.id=${templateId}::uuid
        AND mt.organization_id=${organizationId}::uuid
        AND mt.deleted_at IS NULL`;
    return rows[0] ?? null;
  }

  async dependencies(organizationId: string, templateId: string) {
    return this.sql`
      SELECT dependency_type,dependency_id,dependency_label
      FROM message_template_dependencies
      WHERE organization_id=${organizationId}::uuid
        AND template_id=${templateId}::uuid`;
  }

  async saveProviderSubmission(input: {
    organizationId: string;
    templateId: string;
    actorId: string;
    providerTemplateId?: string;
    status: string;
    category?: string;
    raw: Record<string, unknown>;
  }) {
    return this.sql.begin(async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        UPDATE message_templates SET
          provider_template_id=COALESCE(${input.providerTemplateId ?? null},provider_template_id),
          status=${input.status},category=COALESCE(${input.category ?? null},category),
          provider_payload=provider_payload || ${tx.json(input.raw as never)},
          version=version+1,updated_by=${input.actorId}::uuid,updated_at=now()
        WHERE id=${input.templateId}::uuid
          AND organization_id=${input.organizationId}::uuid
        RETURNING *`;
      await tx`
        INSERT INTO message_template_versions(
          organization_id,template_id,version,source,snapshot,actor_id,
          provider_result
        ) VALUES(
          ${input.organizationId}::uuid,${input.templateId}::uuid,
          ${Number(rows[0]!.version)},'provider_submit',
          ${tx.json(rows[0] as never)},${input.actorId}::uuid,
          ${tx.json(input.raw as never)}
        )`;
      return rows[0]!;
    });
  }

  async softDelete(
    organizationId: string,
    templateId: string,
    actorId: string,
  ) {
    await this.sql`
      UPDATE message_templates SET status='deleted',deleted_at=now(),
        updated_by=${actorId}::uuid,updated_at=now()
      WHERE id=${templateId}::uuid AND organization_id=${organizationId}::uuid`;
  }

  async analytics(organizationId: string, templateId: string) {
    const [rows, automation, replies] = await Promise.all([
      this.sql`
        SELECT count(*)::int sent,
               count(*) FILTER (WHERE m.status IN ('sent','delivered','read'))::int accepted,
               count(*) FILTER (WHERE m.status IN ('delivered','read'))::int delivered,
               count(*) FILTER (WHERE m.status='read')::int read,
               count(*) FILTER (WHERE m.status='failed')::int failed
        FROM template_send_events tse
        JOIN messages m ON m.id=tse.message_id
                       AND m.organization_id=tse.organization_id
        WHERE tse.organization_id=${organizationId}::uuid
          AND tse.template_id=${templateId}::uuid`,
      this.sql`
        SELECT count(*)::int usage FROM message_template_dependencies
        WHERE organization_id=${organizationId}::uuid
          AND template_id=${templateId}::uuid
          AND dependency_type='automation'`,
      this.sql<Array<{ replied: number }>>`
        SELECT count(DISTINCT sent.message_id)::int replied
        FROM (
          SELECT tse.message_id,m.conversation_id,m.created_at
          FROM template_send_events tse
          JOIN messages m ON m.id=tse.message_id
                         AND m.organization_id=tse.organization_id
          WHERE tse.organization_id=${organizationId}::uuid
            AND tse.template_id=${templateId}::uuid
        ) sent
        WHERE EXISTS(
          SELECT 1 FROM messages inbound
          WHERE inbound.organization_id=${organizationId}::uuid
            AND inbound.conversation_id=sent.conversation_id
            AND inbound.direction='inbound'
            AND inbound.created_at>sent.created_at
        )`,
    ]);
    return {
      ...(rows[0] ?? {}),
      automationUsage: Number(automation[0]?.usage ?? 0),
      replied: Number(replies[0]?.replied ?? 0),
    };
  }

  async detail(input: {
    organizationId: string;
    templateId: string;
    userId: string;
    role: string;
  }) {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT mt.*,f.default_language,f.fallback_language
      FROM message_templates mt
      LEFT JOIN message_template_families f ON f.id=mt.family_id
      WHERE mt.id=${input.templateId}::uuid
        AND mt.organization_id=${input.organizationId}::uuid
        AND mt.deleted_at IS NULL
        AND (${!["agent", "team_lead"].includes(input.role)} OR EXISTS(
          SELECT 1 FROM message_template_channels mtc
          JOIN channel_user_ownership cuo
            ON cuo.organization_id=mtc.organization_id
           AND cuo.channel_id=mtc.channel_id
          WHERE mtc.template_id=mt.id AND cuo.user_id=${input.userId}::uuid
        ))`;
    if (!rows[0]) return null;
    const [variables, channels, dependencies, versions, recentUsage, auditHistory] =
      await Promise.all([
        this.sql`SELECT component,position,variable_name,internal_key,example_value,default_value,source,required,missing_policy,formatter FROM message_template_variables WHERE template_id=${input.templateId}::uuid ORDER BY component,position`,
        this.sql`SELECT ch.id,ch.name,ch.phone_number,ch.phone_number_id,ch.business_account_id FROM message_template_channels mtc JOIN channels ch ON ch.id=mtc.channel_id AND ch.deleted_at IS NULL WHERE mtc.organization_id=${input.organizationId}::uuid AND mtc.template_id=${input.templateId}::uuid ORDER BY ch.name`,
        this.sql`SELECT id,dependency_type,dependency_id,dependency_label,config,created_at FROM message_template_dependencies WHERE organization_id=${input.organizationId}::uuid AND template_id=${input.templateId}::uuid ORDER BY dependency_type,dependency_label`,
        this.sql`SELECT id,version,source,actor_id,provider_result,created_at FROM message_template_versions WHERE organization_id=${input.organizationId}::uuid AND template_id=${input.templateId}::uuid ORDER BY version DESC LIMIT 20`,
        this.sql`SELECT tse.status,tse.created_at,m.id message_id,m.provider_message_id,c.id conversation_id,coalesce(ct.display_name,ct.first_name) contact_name FROM template_send_events tse JOIN messages m ON m.id=tse.message_id AND m.organization_id=tse.organization_id JOIN conversations c ON c.id=m.conversation_id JOIN contacts ct ON ct.id=m.contact_id WHERE tse.organization_id=${input.organizationId}::uuid AND tse.template_id=${input.templateId}::uuid ORDER BY tse.created_at DESC LIMIT 20`,
        this.sql`SELECT action,actor_id,metadata,created_at FROM audit_logs WHERE organization_id=${input.organizationId}::uuid AND entity_type='template' AND entity_id=${input.templateId}::uuid ORDER BY created_at DESC LIMIT 30`,
      ]);
    const { provider_payload: _, ...safe } = rows[0];
    return {
      ...safe,
      providerPayload: rows[0].provider_payload,
      variables,
      channels,
      dependencies,
      versions,
      recentUsage,
      auditHistory,
    };
  }

  async channelTemplates(input: {
    organizationId: string;
    channelId: string;
    userId: string;
    role: string;
  }) {
    return this.sql`
      SELECT mt.id,mt.family_id,mt.name,mt.language,mt.category,mt.status,
             mt.body_text,mt.components,mt.last_synced_at
      FROM message_templates mt
      JOIN message_template_channels mtc
        ON mtc.template_id=mt.id AND mtc.channel_id=${input.channelId}::uuid
      WHERE mt.organization_id=${input.organizationId}::uuid
        AND mt.deleted_at IS NULL
        AND (${!["agent", "team_lead"].includes(input.role)} OR EXISTS(
          SELECT 1 FROM channel_user_ownership cuo
          WHERE cuo.organization_id=mt.organization_id
            AND cuo.channel_id=mtc.channel_id
            AND cuo.user_id=${input.userId}::uuid
        ))
      ORDER BY mt.name,mt.language`;
  }

  async availableForAutomation(input: {
    organizationId: string;
    templateId: string;
    channelId: string;
  }) {
    const rows = await this.sql`
      SELECT mt.id
      FROM message_templates mt
      JOIN message_template_channels mtc ON mtc.template_id=mt.id
      WHERE mt.id=${input.templateId}::uuid
        AND mt.organization_id=${input.organizationId}::uuid
        AND mtc.channel_id=${input.channelId}::uuid
        AND mt.status='approved' AND mt.deleted_at IS NULL`;
    return Boolean(rows[0]);
  }
}

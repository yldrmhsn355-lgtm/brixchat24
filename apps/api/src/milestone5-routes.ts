import { Readable, Transform } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { can, type Permission } from "@brixchat/auth";
import type {
  DatabaseClient,
  MediaCleanupAuditInput,
} from "@brixchat/database";
import {
  AutomationRepository,
  ConversationLabelRepository,
  Milestone5Repository,
  QuickReplyRepository,
  TemplateCenterRepository,
} from "@brixchat/database";
import {
  BitrixRestClient,
  BitrixRestOpenChannelsConnector,
  FakeBitrixOpenChannelsConnector,
  LocalObjectStorageProvider,
  MediaScanError,
  type MalwareScanner,
  type ObjectStorageProvider,
  bothModeTimelinePolicy,
  attachmentContentDisposition,
  decryptSecret,
  encryptSecret,
  mimeAllowed,
  normalizeMediaMime,
  mediaByteRange,
  sniffMime,
  sanitizeFilename,
  scanStoredObject,
  storageKey,
  isAvailableAutomationAction,
  isAvailableAutomationOperator,
  automationActionConfigError,
  evaluateCondition,
  normalizeAutomationText,
  valueRequiredOperators,
  automationActionCatalog,
  automationConditionFieldCatalog,
  automationNodeCatalog,
  automationOperatorCatalog,
  automationTriggerCatalog,
  compileLegacyLinearDefinition,
  compileAutomationGraph,
  validateAutomationGraph,
  isKnownAutomationField,
  isSupportedAutomationTrigger,
  normalizeCrmPhone,
  resolveLineQueueResponsibleExternalUserId,
  safeEqual,
} from "@brixchat/integrations";
import type { TransactionSql } from "postgres";
import { z } from "zod";

type Authorize = (
  permission: Permission,
) => (request: FastifyRequest) => Promise<void>;
type Row = Record<string, unknown>;
const DEFAULT_MEDIA_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const searchSchema = z.object({
  q: z.string().trim().min(2).max(120),
  type: z
    .enum([
      "all",
      "conversations",
      "messages",
      "contacts",
      "notes",
      "attachments",
      "bitrix",
    ])
    .default("all"),
  conversationId: z.string().uuid().optional(),
  channelId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
const ruleSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(500).optional(),
  trigger: z.object({
    type: z
      .string()
      .min(2)
      .max(80)
      .refine(
        isSupportedAutomationTrigger,
        "Desteklenmeyen otomasyon tetikleyicisi.",
      ),
    config: z.record(z.string(), z.unknown()).default({}),
  }),
  conditions: z
    .array(
      z.object({
        field: z
          .string()
          .refine(isKnownAutomationField, "Bilinmeyen otomasyon koşul alanı."),
        operator: z
          .string()
          .refine(
            isAvailableAutomationOperator,
            "Bilinmeyen otomasyon koşul operatörü.",
          ),
        value: z.unknown(),
      }),
    )
    .max(20)
    .default([]),
  actions: z
    .array(
      z.object({
        type: z
          .string()
          .refine(
            isAvailableAutomationAction,
            "Bu otomasyon aksiyonu henüz kullanıma açık değil.",
          ),
        config: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1)
    .max(20),
  priority: z.number().int().min(0).max(1000).default(100),
  stopProcessing: z.boolean().default(false),
});
const templateAutomationConfig = z.object({
  templateId: z.string().uuid(),
  channelId: z.string().uuid(),
  languagePolicy: z.enum(["contact", "fallback", "fixed"]).default("contact"),
  fixedLanguage: z.string().min(2).max(20).optional(),
  missingPolicy: z.enum(["block", "default", "manual"]).default("block"),
  timeZone: z.string().min(3).max(80).default("Europe/Istanbul"),
  repeatLimitMinutes: z.number().int().min(1).max(525600).default(1440),
  requireOptIn: z.boolean().default(true),
});
const labelAutomationConfig = z.object({
  labelId: z.string().uuid(),
  expiresAt: z.string().datetime().optional(),
  expiresInMinutes: z.number().int().min(1).max(525600).optional(),
});
const assignUserAutomationConfig = z.object({
  userId: z.string().uuid(),
});
const openSchema = z
  .object({
    mode: z.enum(["crm_context", "open_channels", "both"]),
    brixchatChannelId: z.string().uuid().optional(),
    lineId: z.string().min(1).max(100).optional(),
    incomingEnabled: z.boolean().default(true),
    outgoingEnabled: z.boolean().default(true),
    deliveryStatusSync: z.boolean().default(true),
    sessionCloseSync: z.boolean().default(true),
    autoCrmMode: z
      .enum(["disabled", "lead", "contact_and_deal"])
      .default("disabled"),
    crmSourceId: z.string().min(1).max(100).default("WEB"),
    responsibleExternalUserId: z.string().min(1).max(100).optional(),
    pipelineId: z.string().min(1).max(100).optional(),
    stageId: z.string().min(1).max(100).optional(),
    timelinePolicy: z
      .enum(["per_message", "session_summary", "disabled"])
      .optional(),
  })
  .superRefine((value, context) => {
    if (
      value.mode !== "crm_context" &&
      (!value.lineId || !value.brixchatChannelId)
    )
      context.addIssue({
        code: "custom",
        message:
          "Open Channels mode requires a Bitrix line and BrixChat channel",
      });
    if (
      value.autoCrmMode === "contact_and_deal" &&
      (!value.pipelineId || !value.stageId)
    )
      context.addIssue({
        code: "custom",
        message: "Contact and deal mode requires a pipeline and stage",
      });
  });
const crmContactExclusionSchema = z.object({
  phone: z.string().trim().min(8).max(40),
  displayName: z.string().trim().min(1).max(160).optional(),
  reason: z.string().trim().min(3).max(240).default("internal_contact"),
  archivePendingJobs: z.boolean().default(true),
});

function openChannelsBindingSettings(
  input: z.infer<typeof openSchema>,
  _queueUserIds?: string[],
) {
  const responsibleExternalUserId =
    input.mode === "crm_context"
      ? (input.responsibleExternalUserId ?? null)
      : null;
  return {
    incomingEnabled: input.incomingEnabled,
    outgoingEnabled: input.outgoingEnabled,
    deliveryStatusSync: input.deliveryStatusSync,
    sessionCloseSync: input.sessionCloseSync,
    autoCrmMode: input.autoCrmMode,
    crmSourceId: input.crmSourceId,
    ...(responsibleExternalUserId ? { responsibleExternalUserId } : {}),
    pipelineId: input.pipelineId,
    stageId: input.stageId,
    timelinePolicy: bothModeTimelinePolicy(input.mode, input.timelinePolicy),
  };
}

function segments(text: string, q: string) {
  const value = text.slice(0, 500),
    lower = value.toLocaleLowerCase(),
    needle = q.toLocaleLowerCase(),
    result: Array<{ text: string; match: boolean }> = [];
  let at = 0,
    index = lower.indexOf(needle);
  while (index >= 0 && result.length < 12) {
    if (index > at) result.push({ text: value.slice(at, index), match: false });
    result.push({ text: value.slice(index, index + q.length), match: true });
    at = index + q.length;
    index = lower.indexOf(needle, at);
  }
  if (at < value.length) result.push({ text: value.slice(at), match: false });
  return result.length ? result : [{ text: value, match: false }];
}
function mapMessageRow(row: Row) {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    clientMessageId: row.client_message_id
      ? String(row.client_message_id)
      : null,
    providerMessageId: row.provider_message_id
      ? String(row.provider_message_id)
      : null,
    body: String(row.body ?? ""),
    type: String(row.type ?? "text"),
    direction: String(row.direction),
    status: String(row.status),
    sentAt: new Date(
      String(
        row.display_at ??
          row.provider_timestamp ??
          row.sent_at ??
          row.created_at,
      ),
    ).toISOString(),
    senderName: String(row.sender_name ?? "Customer"),
    metadata: (row.metadata ?? {}) as Row,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
  };
}
function event(type: string, org: string, id: string, payload: Row = {}) {
  return {
    eventId: crypto.randomUUID(),
    eventType: type,
    organizationId: org,
    entityType: type.startsWith("attachment") ? "attachment" : "operation",
    entityId: id,
    occurredAt: new Date().toISOString(),
    payloadVersion: 1,
    payload,
  };
}

function limitMediaUploadStream(body: Readable, maxBytes: number) {
  let size = 0;
  let exceeded = false;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        exceeded = true;
        callback(new Error("MEDIA_TOO_LARGE"));
        return;
      }
      callback(null, chunk);
    },
  });
  body.once("error", (error) => limiter.destroy(error));
  return {
    stream: body.pipe(limiter),
    exceeded: () => exceeded,
  };
}

export function registerMilestone5Routes(
  app: FastifyInstance,
  sql: DatabaseClient,
  options: {
    authorize: Authorize;
    publish: (organizationId: string, event: Row) => Promise<void>;
    storage: ObjectStorageProvider;
    malwareScanner: MalwareScanner;
    recordMediaCleanupRequired: (
      input: MediaCleanupAuditInput,
    ) => Promise<void>;
    storageProvider?: string;
    storageBucket?: string;
    mediaUploadLimitBytes?: number;
    redisPing: () => Promise<string>;
    redisHealthTimeoutMs?: number;
    metricsApiKey?: string;
    runtimeMetrics?: () => string;
    appEncryptionKey?: string;
    bitrixClientId?: string;
    bitrixClientSecret?: string;
    apiPublicUrl: string;
    webUrl: string;
    enforceBilling?: (
      organizationId: string,
      metric: string,
    ) => Promise<{ allowed: boolean; code: string | null }>;
    enforceStorage?: (
      organizationId: string,
      bytes: number,
    ) => Promise<{ allowed: boolean; code: string | null }>;
    acquireStorageLock?: (
      organizationId: string,
    ) => Promise<{ release: () => Promise<void> }>;
  },
) {
  const conversationLabelRepository = new ConversationLabelRepository(sql);
  const automationRepository = new AutomationRepository(sql);
  const templateRepository = new TemplateCenterRepository(sql);
  const quickReplyRepository = new QuickReplyRepository(sql);
  const milestone5Repository = new Milestone5Repository(sql);
  const quickSql = quickReplyRepository.query.bind(quickReplyRepository);
  const storageProvider = options.storageProvider ?? "local";
  const storageBucket = options.storageBucket ?? null;
  const openChannelsConnector = (connection: Row) => {
    if (String(connection.auth_mode) === "fake")
      return new FakeBitrixOpenChannelsConnector();
    if (!options.appEncryptionKey)
      throw new Error("OPEN_CHANNELS_ENCRYPTION_KEY_MISSING");
    const raw = connection.credentials_encrypted;
    if (!raw) throw new Error("OPEN_CHANNELS_CREDENTIALS_MISSING");
    const credentials = JSON.parse(
      decryptSecret(String(raw), options.appEncryptionKey),
    ) as {
      webhookUrl?: string;
      accessToken?: string;
      refreshToken?: string;
      accessTokenExpiresAt?: string;
      clientEndpoint?: string;
      serverEndpoint?: string;
    };
    const client = new BitrixRestClient({
      ...(credentials.webhookUrl ? { webhookUrl: credentials.webhookUrl } : {}),
      ...(credentials.accessToken
        ? { accessToken: credentials.accessToken }
        : {}),
      ...(credentials.refreshToken
        ? { refreshToken: credentials.refreshToken }
        : {}),
      ...(credentials.accessTokenExpiresAt
        ? { accessTokenExpiresAt: credentials.accessTokenExpiresAt }
        : {}),
      portalUrl: String(connection.portal_url ?? ""),
      ...(options.bitrixClientId ? { clientId: options.bitrixClientId } : {}),
      ...(options.bitrixClientSecret
        ? { clientSecret: options.bitrixClientSecret }
        : {}),
      onTokenRefresh: async (update) => {
        const encrypted = encryptSecret(
          JSON.stringify({
            ...credentials,
            accessToken: update.accessToken,
            ...(update.refreshToken
              ? { refreshToken: update.refreshToken }
              : {}),
            accessTokenExpiresAt: update.accessTokenExpiresAt,
            ...(update.clientEndpoint
              ? { clientEndpoint: update.clientEndpoint }
              : {}),
            ...(update.serverEndpoint
              ? { serverEndpoint: update.serverEndpoint }
              : {}),
          }),
          options.appEncryptionKey!,
        );
        await milestone5Repository.updateIntegrationCredentials(
          String(connection.id),
          encrypted,
        );
      },
    });
    return new BitrixRestOpenChannelsConnector(client, {
      connectorId: `brixchat_${String(connection.id).replaceAll("-", "").slice(0, 20)}`,
      placementHandler: `${options.webUrl}/app/integrations/bitrix24/open-channels`,
      eventHandler: `${options.apiPublicUrl}/webhooks/bitrix24/${String(connection.public_id)}`,
    });
  };
  const mediaUploadLimitBytes = Math.max(
    1,
    options.mediaUploadLimitBytes ?? DEFAULT_MEDIA_UPLOAD_LIMIT_BYTES,
  );
  const recordMediaCleanupRequired = async (input: {
    organizationId: string;
    actorId: string;
    storageKey: string;
    reason: string;
    scanStatus?: string;
  }) => {
    try {
      await options.recordMediaCleanupRequired({
        ...input,
        storageProvider,
        storageBucket,
      });
    } catch {
      process.stderr.write(
        JSON.stringify({
          level: "error",
          event: "media.cleanup_required",
          organizationId: input.organizationId,
          storageKey: input.storageKey,
          reason: input.reason,
        }) + "\n",
      );
    }
  };
  const deleteOrRecordCleanup = async (input: {
    organizationId: string;
    actorId: string;
    storageKey: string;
    reason: string;
    scanStatus?: string;
  }) => {
    try {
      await options.storage.deleteObject({ key: input.storageKey });
    } catch {
      await recordMediaCleanupRequired(input);
    }
  };

  const prepareAutomationDefinition = async (
    body: unknown,
    organizationId: string,
  ) => {
    const definition = ruleSchema.parse(body);
    const normalizedActions = definition.actions.map((action) => ({
      ...action,
      config:
        action.type === "send_whatsapp_template"
          ? templateAutomationConfig.parse(action.config)
          : action.type === "add_label" || action.type === "remove_label"
            ? labelAutomationConfig.parse(action.config)
            : action.type === "assign_user"
              ? assignUserAutomationConfig.parse(action.config)
              : action.config,
    }));
    // Runtime-parity guard: any config the worker would block at run time
    // (automationActionConfigError) must be rejected here, not published.
    for (const action of normalizedActions) {
      const runtimeConfigError = automationActionConfigError(
        action.type,
        (action.config ?? {}) as Record<string, unknown>,
      );
      if (runtimeConfigError)
        throw Object.assign(new Error(runtimeConfigError), {
          statusCode: 400,
        });
    }
    for (const condition of definition.conditions)
      if (
        valueRequiredOperators.has(condition.operator) &&
        normalizeAutomationText(condition.value) === ""
      )
        throw Object.assign(new Error("automation_condition_value_required"), {
          statusCode: 400,
        });
    for (const action of normalizedActions) {
      if (action.type === "send_whatsapp_template") {
        const config = templateAutomationConfig.parse(action.config);
        if (
          !(await templateRepository.availableForAutomation({
            organizationId,
            templateId: config.templateId,
            channelId: config.channelId,
          }))
        )
          throw Object.assign(new Error("automation_template_invalid"), {
            statusCode: 400,
          });
      }
      if (action.type === "add_label" || action.type === "remove_label") {
        const config = labelAutomationConfig.parse(action.config);
        if (
          !(await conversationLabelRepository.isActiveInOrganization(
            organizationId,
            config.labelId,
          ))
        )
          throw Object.assign(new Error("automation_label_invalid"), {
            statusCode: 400,
          });
      }
      if (action.type === "assign_user") {
        const config = assignUserAutomationConfig.parse(action.config);
        const member = await automationRepository.query`
          SELECT 1
          FROM users u
          JOIN organization_members member
            ON member.user_id=u.id
           AND member.organization_id=${organizationId}::uuid
          WHERE u.id=${config.userId}::uuid
            AND u.is_active=true
            AND u.suspended_at IS NULL`;
        if (!member.length)
          throw Object.assign(new Error("automation_assignee_invalid"), {
            statusCode: 400,
          });
      }
    }
    return { definition, normalizedActions };
  };

  const insertAutomationVersion = async (input: {
    tx: TransactionSql;
    organizationId: string;
    ruleId: string;
    version: number;
    actorId: string;
    definition: z.infer<typeof ruleSchema>;
    normalizedActions: Array<{
      type: string;
      config: Record<string, unknown>;
    }>;
  }) => {
    const compiledDefinition = compileLegacyLinearDefinition({
      trigger: input.definition.trigger,
      conditions: input.definition.conditions,
      actions: input.normalizedActions,
    });
    const sourceGraph = {
      mode: "legacy-linear",
      trigger: input.definition.trigger,
      conditions: input.definition.conditions,
      actions: input.normalizedActions,
    };
    const versions = await input.tx<Row[]>`INSERT INTO automation_rule_versions(
        organization_id,rule_id,version,created_by,permission_snapshot,
        source_graph,compiled_definition,compiler_version,definition_checksum
      ) VALUES(
        ${input.organizationId}::uuid,${input.ruleId}::uuid,${input.version},
        ${input.actorId}::uuid,
        ${input.tx.json({ actorId: input.actorId } as never)},
        ${input.tx.json(sourceGraph as never)},
        ${input.tx.json(compiledDefinition as never)},
        ${compiledDefinition.compilerVersion},
        ${compiledDefinition.checksum}
      ) RETURNING id`;
    const versionId = String(versions[0]!.id);
    await input.tx`
      INSERT INTO automation_rule_triggers(version_id,trigger_type,config)
      VALUES(
        ${versionId}::uuid,
        ${input.definition.trigger.type},
        ${input.tx.json(input.definition.trigger.config as never)}
      )`;
    for (const [position, condition] of input.definition.conditions.entries())
      await input.tx`
        INSERT INTO automation_rule_conditions(
          version_id,position,field,operator,value
        ) VALUES(
          ${versionId}::uuid,${position},${condition.field},
          ${condition.operator},${input.tx.json(condition.value as never)}
        )`;
    for (const [position, action] of input.normalizedActions.entries())
      await input.tx`
        INSERT INTO automation_rule_actions(
          version_id,position,action_type,config
        ) VALUES(
          ${versionId}::uuid,${position},${action.type},
          ${input.tx.json(action.config as never)}
        )`;
    return versionId;
  };

  const automationDetail = async (
    organizationId: string,
    ruleId: string,
    selector: "draft" | "published",
  ) => {
    const rule = (
      await automationRepository.query<Row[]>`
        SELECT *
        FROM automation_rules
        WHERE id=${ruleId}::uuid
          AND organization_id=${organizationId}::uuid`
    )[0];
    if (!rule) return null;
    const selectedVersion =
      selector === "published"
        ? Number(rule.published_version ?? 0)
        : Number(rule.draft_version);
    if (!selectedVersion) return { rule, definition: null };
    const version = (
      await automationRepository.query<Row[]>`
        SELECT *
        FROM automation_rule_versions
        WHERE rule_id=${ruleId}::uuid
          AND version=${selectedVersion}`
    )[0];
    if (!version) return { rule, definition: null };
    const [triggers, conditions, actions] = await Promise.all([
      sql<Row[]>`
        SELECT trigger_type,config
        FROM automation_rule_triggers
        WHERE version_id=${String(version.id)}::uuid`,
      sql<Row[]>`
        SELECT position,field,operator,value
        FROM automation_rule_conditions
        WHERE version_id=${String(version.id)}::uuid
        ORDER BY position`,
      sql<Row[]>`
        SELECT position,action_type,config
        FROM automation_rule_actions
        WHERE version_id=${String(version.id)}::uuid
        ORDER BY position`,
    ]);
    return {
      rule,
      definition: {
        selectedVersion,
        compilerVersion: version.compiler_version
          ? Number(version.compiler_version)
          : null,
        definitionChecksum: version.definition_checksum
          ? String(version.definition_checksum)
          : null,
        trigger: triggers[0]
          ? {
              type: String(triggers[0].trigger_type),
              config: triggers[0].config ?? {},
            }
          : null,
        conditions: conditions.map((condition) => ({
          position: Number(condition.position),
          field: String(condition.field),
          operator: String(condition.operator),
          value: condition.value,
        })),
        actions: actions.map((action) => ({
          position: Number(action.position),
          type: String(action.action_type),
          config: action.config ?? {},
        })),
      },
    };
  };

  const presentAutomationDetail = (
    result: NonNullable<Awaited<ReturnType<typeof automationDetail>>>,
  ) => ({
    id: String(result.rule.id),
    name: String(result.rule.name),
    description: result.rule.description
      ? String(result.rule.description)
      : null,
    status: String(result.rule.status),
    priority: Number(result.rule.priority),
    stopProcessing: Boolean(result.rule.stop_processing),
    draftVersion: Number(result.rule.draft_version),
    publishedVersion: result.rule.published_version
      ? Number(result.rule.published_version)
      : null,
    lastRunAt: result.rule.last_run_at
      ? new Date(String(result.rule.last_run_at)).toISOString()
      : null,
    createdAt: new Date(String(result.rule.created_at)).toISOString(),
    updatedAt: new Date(String(result.rule.updated_at)).toISOString(),
    ...(result.definition ?? {
      selectedVersion: null,
      trigger: null,
      conditions: [],
      actions: [],
    }),
  });
  const redisHealthTimeoutMs = Math.max(
    1,
    options.redisHealthTimeoutMs ?? 1_500,
  );
  const checkRedis = async (): Promise<{ healthy: boolean }> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        options.redisPing(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("redis_ping_timeout")),
            redisHealthTimeoutMs,
          );
        }),
      ]);
      return { healthy: response === "PONG" };
    } catch {
      return { healthy: false };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  app.get(
    "/api/v1/provider-capabilities",
    { preHandler: options.authorize("inbox:read") },
    async () => ({
      data: {
        textMessages: true,
        templateMessages: true,
        mediaMessages: true,
        reactions: true,
        locations: true,
        contacts: true,
        groupConversations: false,
      },
    }),
  );
  app.get(
    "/api/v1/search",
    { preHandler: options.authorize("search:use") },
    async (request) => {
      const q = searchSchema.parse(request.query),
        org = request.claims!.organizationId,
        like = `%${q.q}%`;
      const rows = await milestone5Repository.search({
        organizationId: org,
        conversationId: q.conversationId,
        channelId: q.channelId,
        restricted: ["agent", "team_lead"].includes(request.claims!.role),
        userId: request.claims!.sub,
        like,
        type: q.type,
        limit: q.limit,
      });
      return {
        data: rows.map((r) => ({
          id: String(r.id),
          type: r.kind,
          title: String(r.title ?? ""),
          preview: String(r.preview ?? ""),
          conversationId: r.conversation_id,
          messageId: r.message_id,
          attachmentId: r.attachment_id,
          occurredAt: new Date(String(r.occurred_at)).toISOString(),
          highlights: segments(String(r.preview ?? r.title ?? ""), q.q),
        })),
      };
    },
  );

  app.get<{ Params: { id: string; messageId: string } }>(
    "/api/v1/conversations/:id/messages/around/:messageId",
    { preHandler: options.authorize("search:use") },
    async (request, reply) => {
      const org = request.claims!.organizationId;
      const target = await milestone5Repository.messageDisplayAt({
        organizationId: org,
        conversationId: request.params.id,
        messageId: request.params.messageId,
        restricted: ["agent", "team_lead"].includes(request.claims!.role),
        userId: request.claims!.sub,
      });
      if (!target[0])
        return reply.code(404).send({
          error: { code: "message_not_found", message: "Message not found" },
        });
      const at = new Date(String(target[0].display_at));
      const before = await milestone5Repository.messagesAround({
        organizationId: org,
        conversationId: request.params.id,
        at,
        side: "before",
      });
      const after = await milestone5Repository.messagesAround({
        organizationId: org,
        conversationId: request.params.id,
        at,
        side: "after",
      });
      return {
        data: {
          messages: [...before.reverse(), ...after.slice(0, 20)].map(
            mapMessageRow,
          ),
          targetMessageId: request.params.messageId,
          previousCursor: before[0]?.display_at ?? null,
          nextCursor: after.length > 20 ? after[19]?.display_at : null,
        },
      };
    },
  );

  app.get<{ Params: { messageId: string } }>(
    "/api/v1/messages/:messageId/attachments",
    { preHandler: options.authorize("attachments:read") },
    async (r) => ({
      data: await milestone5Repository.messageAttachments({
        organizationId: r.claims!.organizationId,
        messageId: r.params.messageId,
        restricted: ["agent", "team_lead"].includes(r.claims!.role),
        userId: r.claims!.sub,
      }),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/attachments/:id",
    { preHandler: options.authorize("attachments:read") },
    async (r, reply) => {
      const rows = await sql<
        Row[]
      >`SELECT a.* FROM message_attachments a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id WHERE a.id=${r.params.id}::uuid AND a.organization_id=${r.claims!.organizationId}::uuid AND (${!["agent", "team_lead"].includes(r.claims!.role)} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${r.claims!.sub}::uuid))`;
      return rows[0]
        ? { data: rows[0] }
        : reply.code(404).send({
            error: {
              code: "attachment_not_found",
              message: "Attachment not found",
            },
          });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/attachments/:id/download-url",
    { preHandler: options.authorize("attachments:download") },
    async (r, reply) => {
      const rows = await sql<
        Row[]
      >`SELECT a.storage_key,a.scan_status,a.processing_status,coalesce(a.stored_filename,a.provider_filename,'attachment') download_filename FROM message_attachments a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id WHERE a.id=${r.params.id}::uuid AND a.organization_id=${r.claims!.organizationId}::uuid AND (${!["agent", "team_lead"].includes(r.claims!.role)} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${r.claims!.sub}::uuid))`;
      const a = rows[0];
      if (
        !a ||
        a.processing_status !== "stored" ||
        a.scan_status !== "clean" ||
        !a.storage_key
      )
        return reply.code(409).send({
          error: {
            code: "attachment_unavailable",
            message: "Attachment is unavailable",
          },
        });
      const signed = await options.storage.createSignedDownloadUrl({
        key: String(a.storage_key),
        expiresInSeconds: 300,
        downloadFilename: String(a.download_filename),
      });
      await milestone5Repository.recordMediaDownloadAudit({
        organizationId: r.claims!.organizationId,
        attachmentId: r.params.id,
        actorId: r.claims!.sub,
      });
      return { data: signed };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/attachments/:id/retry",
    { preHandler: options.authorize("attachments:retry") },
    async (r, reply) => {
      const rows = await sql<Row[]>`WITH retryable_attachment AS (
          SELECT a.id,a.organization_id
          FROM message_attachments a
          WHERE a.id=${r.params.id}::uuid
            AND a.organization_id=${r.claims!.organizationId}::uuid
            AND a.processing_status='failed'
          FOR UPDATE
        ), queued AS (
          INSERT INTO media_processing_jobs(organization_id,attachment_id,job_type)
          SELECT organization_id,id,'media.download'
          FROM retryable_attachment
          ON CONFLICT(attachment_id,job_type) DO UPDATE SET
            status='pending',
            attempt_count=0,
            next_attempt_at=now(),
            locked_at=NULL,
            locked_by=NULL,
            last_error=NULL,
            completed_at=NULL,
            updated_at=now()
          WHERE media_processing_jobs.organization_id=EXCLUDED.organization_id
          RETURNING attachment_id,organization_id
        )
        UPDATE message_attachments a SET
          processing_status='pending',
          next_attempt_at=now(),
          last_error_code=CASE WHEN a.last_error_code IN('MEDIA_SCAN_CLEANUP_FAILED','MEDIA_OBJECT_CLEANUP_FAILED') THEN a.last_error_code ELSE NULL END,
          last_error_message=CASE WHEN a.last_error_code IN('MEDIA_SCAN_CLEANUP_FAILED','MEDIA_OBJECT_CLEANUP_FAILED') THEN a.last_error_message ELSE NULL END,
          updated_at=now()
        FROM queued
        WHERE a.id=queued.attachment_id
          AND a.organization_id=queued.organization_id
        RETURNING a.id`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "attachment_not_found",
            message: "Attachment not found",
          },
        });
      return { data: { queued: true } };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/attachments/:id/thumbnail-url",
    { preHandler: options.authorize("attachments:read") },
    async (r, reply) => {
      const rows = await sql<
        Row[]
      >`SELECT a.metadata->>'thumbnailKey' thumbnail_key,a.scan_status,a.processing_status FROM message_attachments a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id WHERE a.id=${r.params.id}::uuid AND a.organization_id=${r.claims!.organizationId}::uuid AND (${!["agent", "team_lead"].includes(r.claims!.role)} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${r.claims!.sub}::uuid))`;
      const attachment = rows[0];
      if (
        !attachment?.thumbnail_key ||
        attachment.processing_status !== "stored" ||
        attachment.scan_status !== "clean"
      )
        return reply.code(404).send({
          error: {
            code: "thumbnail_unavailable",
            message: "Thumbnail is unavailable",
          },
        });
      return {
        data: await options.storage.createSignedDownloadUrl({
          key: String(attachment.thumbnail_key),
          expiresInSeconds: 180,
        }),
      };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/attachments/:id",
    { preHandler: options.authorize("attachments:delete") },
    async (r) => {
      const rows = await sql<
        Row[]
      >`UPDATE message_attachments SET processing_status='deleted',deleted_at=now(),updated_at=now() WHERE id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid RETURNING storage_key`;
      if (rows[0]?.storage_key)
        await options.storage.deleteObject({
          key: String(rows[0].storage_key),
        });
      await options.publish(
        r.claims!.organizationId,
        event("attachment.deleted", r.claims!.organizationId, r.params.id),
      );
      return { data: { deleted: Boolean(rows[0]) } };
    },
  );
  app.get<{ Querystring: { token: string; download?: string } }>(
    "/api/v1/media/object",
    async (r, reply) => {
      if (!("verify" in options.storage))
        return reply.code(404).send({
          error: {
            code: "direct_storage_download_required",
            message: "Use the signed storage URL.",
          },
        });
      const value = (options.storage as LocalObjectStorageProvider).verify(
        String(r.query.token ?? ""),
      );
      if (!value)
        return reply.code(403).send({
          error: {
            code: "signed_url_invalid",
            message: "Signed URL invalid",
          },
        });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of Readable.fromWeb((await options.storage.getObject({ key: value.key })) as never)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > DEFAULT_MEDIA_UPLOAD_LIMIT_BYTES) return reply.code(413).send();
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      const metadata = await sql<Row[]>`SELECT stored_mime_type FROM message_attachments WHERE storage_key=${value.key} AND processing_status='stored' AND scan_status='clean' AND deleted_at IS NULL LIMIT 1`;
      const mime = normalizeMediaMime(String(metadata[0]?.stored_mime_type || sniffMime(bytes) || 'application/octet-stream'));
      const inline = r.query.download !== '1' && /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|opus|mpeg|aac|mp4|webm)|video\/(mp4|webm|3gpp))$/.test(mime);
      reply
        .header("content-type", inline ? mime : "application/octet-stream")
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .header('accept-ranges', 'bytes')
        .header(
          "content-disposition",
          attachmentContentDisposition(value.downloadFilename ?? "attachment").replace(/^attachment/, inline ? 'inline' : 'attachment'),
        );
      let range: ReturnType<typeof mediaByteRange>;
      try { range = mediaByteRange(r.headers.range, bytes.length); }
      catch { return reply.code(416).header('content-range', `bytes */${bytes.length}`).send(); }
      if (range) return reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${bytes.length}`).header('content-length', range.end - range.start + 1).send(bytes.subarray(range.start, range.end + 1));
      return reply.header('content-length', bytes.length).send(bytes);
    },
  );
  app.post<{ Querystring: { conversationId: string } }>(
    "/api/v1/media/uploads",
    {
      preHandler: options.authorize("message:send"),
      bodyLimit: mediaUploadLimitBytes,
    },
    async (r, reply) => {
      const conversationId = z.string().uuid().parse(r.query.conversationId),
        filename = sanitizeFilename(
          String(r.headers["x-filename"] ?? "attachment"),
        ),
        mime = normalizeMediaMime(String(r.headers["x-mime-type"] ?? "application/octet-stream"));
      if (!mimeAllowed(mime))
        return reply.code(415).send({
          error: { code: "media_type_denied", message: "Media type denied" },
        });
      const conversation = (
        await sql<
          Row[]
        >`SELECT c.channel_id,c.contact_id,c.customer_service_window_expires_at,ch.status FROM conversations c JOIN channels ch ON ch.id=c.channel_id AND ch.organization_id=c.organization_id WHERE c.id=${conversationId}::uuid AND c.organization_id=${r.claims!.organizationId}::uuid AND (${!["agent", "team_lead"].includes(r.claims!.role)} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${r.claims!.sub}::uuid))`
      )[0];
      if (!conversation)
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      if (String(conversation.status) !== "connected")
        return reply.code(409).send({
          error: {
            code: "channel_not_connected",
            message: "Channel is not connected",
          },
        });
      if (
        !conversation.customer_service_window_expires_at ||
        new Date(String(conversation.customer_service_window_expires_at)) <=
          new Date()
      )
        return reply.code(409).send({
          error: {
            code: "WHATSAPP_TEMPLATE_REQUIRED",
            message:
              "A template is required outside the customer service window",
          },
        });
      const key = storageKey(r.claims!.organizationId, filename);
      const limitedBody = limitMediaUploadStream(
        r.body as Readable,
        mediaUploadLimitBytes,
      );
      let stored: Awaited<ReturnType<ObjectStorageProvider["putObject"]>>;
      try {
        stored = await options.storage.putObject({
          key,
          body: limitedBody.stream,
          contentType: mime,
        });
      } catch (error) {
        await deleteOrRecordCleanup({
          organizationId: r.claims!.organizationId,
          actorId: r.claims!.sub,
          storageKey: key,
          reason: limitedBody.exceeded()
            ? "MEDIA_TOO_LARGE"
            : "MEDIA_UPLOAD_FAILED",
        });
        if (limitedBody.exceeded())
          return reply.code(413).send({
            error: {
              code: "MEDIA_TOO_LARGE",
              message: "Media exceeds the upload limit",
            },
          });
        throw error;
      }
      const storageLock = await options.acquireStorageLock?.(
        r.claims!.organizationId,
      );
      let rows!: { messageId: unknown; attachmentId: unknown };
      try {
        const storageBilling = await options.enforceStorage?.(
          r.claims!.organizationId,
          stored.size,
        );
        if (storageBilling && !storageBilling.allowed) {
          await options.storage
            .deleteObject({ key: stored.key })
            .catch(() => undefined);
          return reply.code(409).send({
            error: {
              code: storageBilling.code,
              message: "Abonelik planınızın depolama kotası dolu.",
            },
          });
        }
        try {
          await scanStoredObject({
            storage: options.storage,
            scanner: options.malwareScanner,
            key: stored.key,
          });
        } catch (error) {
          if (!(error instanceof MediaScanError)) throw error;
          if (error.cleanupFailed && error.storageKey)
            await recordMediaCleanupRequired({
              organizationId: r.claims!.organizationId,
              actorId: r.claims!.sub,
              storageKey: error.storageKey,
              reason: error.code,
              scanStatus: error.scanStatus,
            });
          return reply.code(error.retryable ? 503 : 422).send({
            error: {
              code: error.code,
              message: error.retryable
                ? "Media scanning is temporarily unavailable"
                : "Media was rejected by malware scanning",
            },
          });
        }
        const type = mime.startsWith("image/")
          ? "image"
          : mime.startsWith("video/")
            ? "video"
            : mime.startsWith("audio/")
              ? "audio"
              : "document";
        try {
          rows = await sql.begin(async (tx) => {
            const m = await tx<
              Row[]
            >`INSERT INTO messages(organization_id,conversation_id,channel_id,contact_id,client_message_id,direction,type,status,body,sender_id,metadata) VALUES(${r.claims!.organizationId}::uuid,${conversationId}::uuid,${String(conversation.channel_id)}::uuid,${String(conversation.contact_id)}::uuid,gen_random_uuid(),'outbound',${type},'pending',${filename},${r.claims!.sub}::uuid,${tx.json({ attachment: true } as never)}) RETURNING id,client_message_id`;
            const a = await tx<
              Row[]
            >`INSERT INTO message_attachments(organization_id,message_id,channel_id,provider,provider_filename,attachment_type,storage_provider,storage_bucket,storage_key,stored_mime_type,stored_filename,stored_size,stored_sha256,processing_status,scan_status,stored_at) VALUES(${r.claims!.organizationId}::uuid,${String(m[0]!.id)}::uuid,${String(conversation.channel_id)}::uuid,'upload',${filename},${type},${storageProvider},${storageBucket},${stored.key},${mime},${filename},${stored.size},${stored.sha256},'stored','clean',now()) RETURNING id`;
            await tx`INSERT INTO outbox_jobs(organization_id,aggregate_type,aggregate_id,job_type,payload) VALUES(${r.claims!.organizationId}::uuid,'message',${String(m[0]!.id)}::uuid,'message.send',${tx.json({ traceId: crypto.randomUUID(), attachmentId: a[0]!.id } as never)})`;
            return { messageId: m[0]!.id, attachmentId: a[0]!.id };
          });
        } catch (error) {
          await deleteOrRecordCleanup({
            organizationId: r.claims!.organizationId,
            actorId: r.claims!.sub,
            storageKey: stored.key,
            reason: "MEDIA_DATABASE_TRANSACTION_FAILED",
            scanStatus: "clean",
          });
          throw error;
        }
      } finally {
        await storageLock?.release();
      }
      return reply.code(201).send({ data: rows });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/quick-replies/:id/attachments",
    {
      preHandler: options.authorize("quick_replies:create"),
      bodyLimit: mediaUploadLimitBytes,
    },
    async (r, reply) => {
      const filename = sanitizeFilename(
          String(r.headers["x-filename"] ?? "attachment"),
        ),
        mime = normalizeMediaMime(String(r.headers["x-mime-type"] ?? "application/octet-stream"));
      if (!mimeAllowed(mime))
        return reply.code(415).send({
          error: { code: "media_type_denied", message: "Media type denied" },
        });
      const quickReply = (
        await quickSql<Row[]>`
          SELECT qr.id FROM quick_replies qr
          WHERE qr.id=${r.params.id}::uuid
            AND qr.organization_id=${r.claims!.organizationId}::uuid
            AND qr.status<>'deleted'
            AND (
              qr.scope='personal' AND qr.owner_user_id=${r.claims!.sub}::uuid
              OR qr.scope='organization'
                AND ${can(r.claims!.role, "quick_replies:manage_workspace")}
              OR qr.scope='team'
                AND ${can(r.claims!.role, "quick_replies:manage_team")}
                AND (
                  ${["owner", "admin"].includes(r.claims!.role)}
                  OR EXISTS(
                    SELECT 1 FROM team_members tm
                    WHERE tm.organization_id=qr.organization_id
                      AND tm.team_id=qr.team_id
                      AND tm.user_id=${r.claims!.sub}::uuid
                  )
                )
            )
            AND NOT EXISTS(
              SELECT 1 FROM quick_reply_attachments qra
              WHERE qra.quick_reply_id=qr.id
            )`
      )[0];
      if (!quickReply)
        return reply.code(409).send({
          error: {
            code: "quick_reply_attachment_unavailable",
            message:
              "Hazır cevap bulunamadı, yönetilemiyor veya zaten bir eki var.",
          },
        });
      const key = storageKey(r.claims!.organizationId, filename);
      const limitedBody = limitMediaUploadStream(
        r.body as Readable,
        mediaUploadLimitBytes,
      );
      let stored: Awaited<ReturnType<ObjectStorageProvider["putObject"]>>;
      try {
        stored = await options.storage.putObject({
          key,
          body: limitedBody.stream,
          contentType: mime,
        });
        await scanStoredObject({
          storage: options.storage,
          scanner: options.malwareScanner,
          key: stored.key,
        });
      } catch (error) {
        await deleteOrRecordCleanup({
          organizationId: r.claims!.organizationId,
          actorId: r.claims!.sub,
          storageKey: key,
          reason: limitedBody.exceeded()
            ? "MEDIA_TOO_LARGE"
            : error instanceof MediaScanError
              ? error.code
              : "QUICK_REPLY_MEDIA_UPLOAD_FAILED",
        });
        if (limitedBody.exceeded())
          return reply.code(413).send({
            error: {
              code: "MEDIA_TOO_LARGE",
              message: "Media exceeds the upload limit",
            },
          });
        if (error instanceof MediaScanError)
          return reply.code(error.retryable ? 503 : 422).send({
            error: {
              code: error.code,
              message: error.retryable
                ? "Media scanning is temporarily unavailable"
                : "Media was rejected by malware scanning",
            },
          });
        throw error;
      }
      const type = mime.startsWith("image/")
        ? "image"
        : mime.startsWith("video/")
          ? "video"
          : mime.startsWith("audio/")
            ? "audio"
            : "document";
      const storageLock = await options.acquireStorageLock?.(
        r.claims!.organizationId,
      );
      try {
        const storageBilling = await options.enforceStorage?.(
          r.claims!.organizationId,
          stored.size,
        );
        if (storageBilling && !storageBilling.allowed) {
          await options.storage
            .deleteObject({ key: stored.key })
            .catch(() => undefined);
          return reply.code(409).send({
            error: {
              code: storageBilling.code,
              message: "Abonelik planınızın depolama kotası dolu.",
            },
          });
        }
        try {
          const rows = await quickSql<Row[]>`
            INSERT INTO quick_reply_attachments(
              organization_id,quick_reply_id,storage_key,filename,mime_type,
              size_bytes,attachment_type,scan_status,created_by
            ) VALUES(
              ${r.claims!.organizationId}::uuid,${r.params.id}::uuid,
              ${stored.key},${filename},${mime},${stored.size},${type},'clean',
              ${r.claims!.sub}::uuid
            ) RETURNING id,filename,mime_type,size_bytes,attachment_type,scan_status`;
          return reply.code(201).send({ data: rows[0] });
        } catch (error) {
          await deleteOrRecordCleanup({
            organizationId: r.claims!.organizationId,
            actorId: r.claims!.sub,
            storageKey: stored.key,
            reason: "QUICK_REPLY_MEDIA_DATABASE_FAILED",
            scanStatus: "clean",
          });
          throw error;
        }
      } finally {
        await storageLock?.release();
      }
    },
  );

  app.delete<{ Params: { id: string; attachmentId: string } }>(
    "/api/v1/quick-replies/:id/attachments/:attachmentId",
    { preHandler: options.authorize("quick_replies:create") },
    async (r, reply) => {
      const rows = await quickSql<Row[]>`
        SELECT qra.storage_key FROM quick_reply_attachments qra
        JOIN quick_replies qr
          ON qr.id=qra.quick_reply_id
          AND qr.organization_id=qra.organization_id
        WHERE qra.id=${r.params.attachmentId}::uuid
          AND qra.quick_reply_id=${r.params.id}::uuid
          AND qra.organization_id=${r.claims!.organizationId}::uuid
          AND (
            qr.scope='personal' AND qr.owner_user_id=${r.claims!.sub}::uuid
            OR qr.scope='organization'
              AND ${can(r.claims!.role, "quick_replies:manage_workspace")}
            OR qr.scope='team'
              AND ${can(r.claims!.role, "quick_replies:manage_team")}
              AND (
                ${["owner", "admin"].includes(r.claims!.role)}
                OR EXISTS(
                  SELECT 1 FROM team_members tm
                  WHERE tm.organization_id=qr.organization_id
                    AND tm.team_id=qr.team_id
                    AND tm.user_id=${r.claims!.sub}::uuid
                )
              )
          )`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "quick_reply_attachment_not_found",
            message: "Hazır cevap eki bulunamadı.",
          },
        });
      try {
        await options.storage.deleteObject({
          key: String(rows[0].storage_key),
        });
      } catch {
        return reply.code(503).send({
          error: {
            code: "quick_reply_attachment_cleanup_failed",
            message: "Ek güvenli biçimde silinemedi; kayıt korundu.",
          },
        });
      }
      await quickSql`
        DELETE FROM quick_reply_attachments
        WHERE id=${r.params.attachmentId}::uuid
          AND organization_id=${r.claims!.organizationId}::uuid`;
      return reply.code(204).send();
    },
  );

  app.post<{
    Params: { id: string; attachmentId: string };
    Querystring: { conversationId: string };
  }>(
    "/api/v1/quick-replies/:id/attachments/:attachmentId/send",
    {
      preHandler: [
        options.authorize("quick_replies:read"),
        options.authorize("message:send"),
      ],
    },
    async (r, reply) => {
      const conversationId = z.string().uuid().parse(r.query.conversationId);
      const source = (
        await quickSql<Row[]>`
          SELECT qra.*,c.channel_id,c.contact_id,
            c.customer_service_window_expires_at,ch.status channel_status
          FROM quick_reply_attachments qra
          JOIN quick_replies qr
            ON qr.id=qra.quick_reply_id
            AND qr.organization_id=qra.organization_id
          JOIN conversations c
            ON c.id=${conversationId}::uuid
            AND c.organization_id=qr.organization_id
          JOIN channels ch
            ON ch.id=c.channel_id
            AND ch.organization_id=c.organization_id
          WHERE qra.id=${r.params.attachmentId}::uuid
            AND qra.quick_reply_id=${r.params.id}::uuid
            AND qra.organization_id=${r.claims!.organizationId}::uuid
            AND qra.scan_status='clean'
            AND qr.status='active'
            AND (qr.channel_id IS NULL OR qr.channel_id=c.channel_id)
            AND (
              qr.scope='organization'
              OR qr.scope='personal' AND qr.owner_user_id=${r.claims!.sub}::uuid
              OR qr.scope='team' AND EXISTS(
                SELECT 1 FROM team_members tm
                WHERE tm.organization_id=qr.organization_id
                  AND tm.team_id=qr.team_id
                  AND tm.user_id=${r.claims!.sub}::uuid
              )
            )
            AND (
              ${!["agent", "team_lead"].includes(r.claims!.role)}
              OR EXISTS(
                SELECT 1 FROM channel_user_ownership cuo
                WHERE cuo.organization_id=c.organization_id
                  AND cuo.channel_id=c.channel_id
                  AND cuo.user_id=${r.claims!.sub}::uuid
              )
            )`
      )[0];
      if (!source)
        return reply.code(404).send({
          error: {
            code: "quick_reply_attachment_not_found",
            message: "Gönderilebilir hazır cevap eki bulunamadı.",
          },
        });
      if (String(source.channel_status) !== "connected")
        return reply.code(409).send({
          error: {
            code: "channel_not_connected",
            message: "Channel is not connected",
          },
        });
      if (
        !source.customer_service_window_expires_at ||
        new Date(String(source.customer_service_window_expires_at)) <=
          new Date()
      )
        return reply.code(409).send({
          error: {
            code: "WHATSAPP_TEMPLATE_REQUIRED",
            message:
              "A template is required outside the customer service window",
          },
        });
      const copiedKey = storageKey(
        r.claims!.organizationId,
        String(source.filename),
      );
      const copied = await options.storage.putObject({
        key: copiedKey,
        body: Readable.fromWeb(
          (await options.storage.getObject({
            key: String(source.storage_key),
          })) as never,
        ),
        contentType: String(source.mime_type),
      });
      try {
        const result = await quickReplyRepository.begin(async (tx) => {
          const messages = await tx<Row[]>`
            INSERT INTO messages(
              organization_id,conversation_id,channel_id,contact_id,
              client_message_id,direction,type,status,body,sender_id,metadata
            ) VALUES(
              ${r.claims!.organizationId}::uuid,${conversationId}::uuid,
              ${String(source.channel_id)}::uuid,${String(source.contact_id)}::uuid,
              gen_random_uuid(),'outbound',${String(source.attachment_type)},
              'pending',${String(source.filename)},${r.claims!.sub}::uuid,
              ${tx.json({ attachment: true, quickReplyId: r.params.id } as never)}
            ) RETURNING id`;
          const attachments = await tx<Row[]>`
            INSERT INTO message_attachments(
              organization_id,message_id,channel_id,provider,provider_filename,
              attachment_type,storage_provider,storage_bucket,storage_key,
              stored_mime_type,stored_filename,stored_size,stored_sha256,
              processing_status,scan_status,stored_at
            ) VALUES(
              ${r.claims!.organizationId}::uuid,${String(messages[0]!.id)}::uuid,
              ${String(source.channel_id)}::uuid,'quick_reply',
              ${String(source.filename)},${String(source.attachment_type)},
              ${storageProvider},${storageBucket},${copied.key},
              ${String(source.mime_type)},${String(source.filename)},
              ${copied.size},${copied.sha256},'stored','clean',now()
            ) RETURNING id`;
          await tx`
            INSERT INTO outbox_jobs(
              organization_id,aggregate_type,aggregate_id,job_type,payload
            ) VALUES(
              ${r.claims!.organizationId}::uuid,'message',
              ${String(messages[0]!.id)}::uuid,'message.send',
              ${tx.json({
                traceId: crypto.randomUUID(),
                attachmentId: attachments[0]!.id,
              } as never)}
            )`;
          return {
            messageId: messages[0]!.id,
            attachmentId: attachments[0]!.id,
          };
        });
        return reply.code(201).send({ data: result });
      } catch (error) {
        await deleteOrRecordCleanup({
          organizationId: r.claims!.organizationId,
          actorId: r.claims!.sub,
          storageKey: copied.key,
          reason: "QUICK_REPLY_ATTACHMENT_SEND_DATABASE_FAILED",
          scanStatus: "clean",
        });
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/automations/catalog",
    { preHandler: options.authorize("automations:read") },
    async () => ({
      data: {
        nodes: automationNodeCatalog(),
        triggers: automationTriggerCatalog,
        fields: automationConditionFieldCatalog,
        operators: automationOperatorCatalog,
        actions: automationActionCatalog,
      },
    }),
  );
  app.post(
    "/api/v1/automations/validate-graph",
    { preHandler: options.authorize("automations:update") },
    async (r) => {
      const body = z
        .object({
          mode: z.enum(["branching", "linear"]).default("branching"),
          nodes: z
            .array(
              z.object({
                id: z.string(),
                type: z.string(),
                category: z.string(),
                position: z.object({ x: z.number(), y: z.number() }),
                config: z.record(z.string(), z.unknown()),
              }),
            )
            .max(500),
          edges: z
            .array(
              z.object({
                id: z.string(),
                source: z.string(),
                target: z.string(),
                handle: z.string().optional(),
                label: z.string().optional(),
              }),
            )
            .max(1000),
        })
        .parse(r.body);
      const graph = { nodes: body.nodes, edges: body.edges };
      const options = { mode: body.mode };
      const issues = validateAutomationGraph(graph as never, options);
      return {
        data: {
          valid: issues.length === 0,
          issues,
          compiled: issues.length
            ? null
            : compileAutomationGraph(graph as never, options),
        },
      };
    },
  );
  app.get(
    "/api/v1/automations",
    { preHandler: options.authorize("automations:read") },
    async (r) => ({
      data: await automationRepository.query`SELECT * FROM automation_rules WHERE organization_id=${r.claims!.organizationId}::uuid AND status<>'archived' ORDER BY updated_at DESC,priority,name`,
    }),
  );
  app.post(
    "/api/v1/automations",
    { preHandler: options.authorize("automations:create") },
    async (r, reply) => {
      const b = ruleSchema.parse(r.body),
        org = r.claims!.organizationId;
      const billing = await options.enforceBilling?.(org, "automations");
      if (billing && !billing.allowed)
        return reply.code(409).send({
          error: {
            code: billing.code,
            message:
              "Abonelik planınız yeni otomasyon oluşturmaya izin vermiyor.",
          },
        });
      const templateActions = b.actions
        .filter((action) => action.type === "send_whatsapp_template")
        .map((action) => templateAutomationConfig.parse(action.config));
      const labelActions = b.actions
        .filter(
          (action) =>
            action.type === "add_label" || action.type === "remove_label",
        )
        .map((action) => ({
          type: action.type,
          config: labelAutomationConfig.parse(action.config),
        }));
      const normalizedActions = b.actions.map((action) => ({
        ...action,
        config:
          action.type === "send_whatsapp_template"
            ? templateAutomationConfig.parse(action.config)
            : action.type === "add_label" || action.type === "remove_label"
              ? labelAutomationConfig.parse(action.config)
              : action.type === "assign_user"
                ? assignUserAutomationConfig.parse(action.config)
                : action.config,
      }));
      for (const config of templateActions) {
        const available = await templateRepository.availableForAutomation({
          organizationId: org,
          templateId: config.templateId,
          channelId: config.channelId,
        });
        if (!available)
          return reply.code(400).send({
            error: {
              code: "automation_template_invalid",
              message: "Otomasyon ÅŸablonu bu workspace ve kanala ait deÄŸil.",
            },
          });
      }
      for (const action of labelActions) {
        const available =
          await conversationLabelRepository.isActiveInOrganization(
            org,
            action.config.labelId,
          );
        if (!available)
          return reply.code(400).send({
            error: {
              code: "automation_label_invalid",
              message:
                "Otomasyon etiketi etkin değil veya bu workspace'e ait değil.",
            },
          });
      }
      for (const action of normalizedActions) {
        if (action.type !== "assign_user") continue;
        const config = assignUserAutomationConfig.parse(action.config);
        const member = await automationRepository.query`
          SELECT 1
          FROM users u
          JOIN organization_members member
            ON member.user_id=u.id
           AND member.organization_id=${org}::uuid
          WHERE u.id=${config.userId}::uuid
            AND u.is_active=true
            AND u.suspended_at IS NULL`;
        if (!member.length)
          return reply.code(400).send({
            error: {
              code: "automation_assignee_invalid",
              message: "Atanacak etkin ekip üyesi bulunamadı.",
            },
          });
      }
      const duplicate = await automationRepository.query<Row[]>`
        SELECT id FROM automation_rules
        WHERE organization_id=${org}::uuid
          AND lower(name)=lower(${b.name})
          AND status<>'archived'`;
      if (duplicate.length)
        return reply.code(409).send({
          error: {
            code: "automation_name_conflict",
            message: "Bu adla etkin bir otomasyon zaten var.",
          },
        });
      const result = await automationRepository.begin(async (tx) => {
        const existing = await tx<
          Row[]
        >`SELECT id,draft_version FROM automation_rules WHERE organization_id=${org}::uuid AND name=${b.name} FOR UPDATE`;
        const rules = existing[0]
          ? await tx<
              Row[]
            >`UPDATE automation_rules SET description=${b.description ?? null},priority=${b.priority},stop_processing=${b.stopProcessing},status='draft',draft_version=draft_version+1,updated_by=${r.claims!.sub}::uuid,updated_at=now() WHERE id=${String(existing[0].id)}::uuid RETURNING *`
          : await tx<
              Row[]
            >`INSERT INTO automation_rules(organization_id,name,description,priority,stop_processing,created_by,updated_by) VALUES(${org}::uuid,${b.name},${b.description ?? null},${b.priority},${b.stopProcessing},${r.claims!.sub}::uuid,${r.claims!.sub}::uuid) RETURNING *`;
        const id = String(rules[0]!.id);
        await insertAutomationVersion({
          tx,
          organizationId: org,
          ruleId: id,
          version: Number(rules[0]!.draft_version ?? 1),
          actorId: r.claims!.sub,
          definition: b,
          normalizedActions,
        });
        for (const config of templateActions)
          await tx`INSERT INTO message_template_dependencies(organization_id,template_id,dependency_type,dependency_id,dependency_label,config) VALUES(${org}::uuid,${config.templateId}::uuid,'automation',${id},${b.name},${tx.json(config as never)}) ON CONFLICT(organization_id,template_id,dependency_type,dependency_id) DO UPDATE SET dependency_label=EXCLUDED.dependency_label,config=EXCLUDED.config,updated_at=now()`;
        return rules[0];
      });
      return reply.code(201).send({
        data: result ? { ...result, id: String(result.id) } : null,
      });
    },
  );
  app.get<{ Params: { id: string }; Querystring: { version?: string } }>(
    "/api/v1/automations/:id",
    { preHandler: options.authorize("automations:read") },
    async (r, reply) => {
      const selector = z
        .enum(["draft", "published"])
        .default("draft")
        .parse(r.query.version);
      const result = await automationDetail(
        r.claims!.organizationId,
        r.params.id,
        selector,
      );
      if (!result)
        return reply.code(404).send({
          error: {
            code: "automation_not_found",
            message: "Otomasyon bulunamadı.",
          },
        });
      return { data: presentAutomationDetail(result) };
    },
  );
  app.put<{ Params: { id: string } }>(
    "/api/v1/automations/:id",
    { preHandler: options.authorize("automations:update") },
    async (r, reply) => {
      const organizationId = r.claims!.organizationId;
      const { definition, normalizedActions } =
        await prepareAutomationDefinition(r.body, organizationId);
      const updated = await automationRepository.begin(async (tx) => {
        const existing = (
          await tx<Row[]>`
            SELECT *
            FROM automation_rules
            WHERE id=${r.params.id}::uuid
              AND organization_id=${organizationId}::uuid
            FOR UPDATE`
        )[0];
        if (!existing) return null;
        if (String(existing.status) === "archived")
          throw Object.assign(new Error("automation_archived"), {
            statusCode: 409,
          });
        const conflict = await tx<Row[]>`
          SELECT id FROM automation_rules
          WHERE organization_id=${organizationId}::uuid
            AND id<>${r.params.id}::uuid
            AND lower(name)=lower(${definition.name})
            AND status<>'archived'`;
        if (conflict.length)
          throw Object.assign(new Error("automation_name_conflict"), {
            statusCode: 409,
          });
        const version = Number(existing.draft_version) + 1;
        const rows = await tx<Row[]>`
          UPDATE automation_rules SET
            name=${definition.name},
            description=${definition.description ?? null},
            priority=${definition.priority},
            stop_processing=${definition.stopProcessing},
            draft_version=${version},
            updated_by=${r.claims!.sub}::uuid,
            updated_at=now()
          WHERE id=${r.params.id}::uuid
          RETURNING *`;
        await insertAutomationVersion({
          tx,
          organizationId,
          ruleId: r.params.id,
          version,
          actorId: r.claims!.sub,
          definition,
          normalizedActions,
        });
        await tx`
          DELETE FROM message_template_dependencies
          WHERE organization_id=${organizationId}::uuid
            AND dependency_type='automation'
            AND dependency_id=${r.params.id}`;
        for (const action of normalizedActions) {
          if (action.type !== "send_whatsapp_template") continue;
          const config = templateAutomationConfig.parse(action.config);
          await tx`
            INSERT INTO message_template_dependencies(
              organization_id,template_id,dependency_type,dependency_id,
              dependency_label,config
            ) VALUES(
              ${organizationId}::uuid,${config.templateId}::uuid,'automation',
              ${r.params.id},${definition.name},${tx.json(config as never)}
            )
            ON CONFLICT(
              organization_id,template_id,dependency_type,dependency_id
            ) DO UPDATE SET
              dependency_label=EXCLUDED.dependency_label,
              config=EXCLUDED.config,
              updated_at=now()`;
        }
        return rows[0]!;
      });
      if (!updated)
        return reply.code(404).send({
          error: {
            code: "automation_not_found",
            message: "Otomasyon bulunamadı.",
          },
        });
      return { data: { ...updated, id: String(updated.id) } };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/automations/:id/publish",
    { preHandler: options.authorize("automations:publish") },
    async (r, reply) => {
      const result = await automationRepository.begin(async (tx) => {
        const rules = await tx<Row[]>`
          SELECT id,draft_version FROM automation_rules
          WHERE id=${r.params.id}::uuid
            AND organization_id=${r.claims!.organizationId}::uuid
            AND status<>'archived'
          FOR UPDATE`;
        if (!rules[0]) return { kind: "not_found" as const };
        const draftVersion = Number(rules[0].draft_version);
        // Legacy drafts may predate save-time validation; publishing a
        // config the runtime would block must fail loudly here instead.
        const actions = await tx<Row[]>`
          SELECT a.action_type,a.config
          FROM automation_rule_actions a
          JOIN automation_rule_versions v ON v.id=a.version_id
          WHERE v.rule_id=${r.params.id}::uuid AND v.version=${draftVersion}`;
        for (const action of actions) {
          const configError = automationActionConfigError(
            String(action.action_type),
            (action.config ?? {}) as Record<string, unknown>,
          );
          if (configError)
            return { kind: "invalid" as const, code: configError };
        }
        const rows = await tx<
          Row[]
        >`UPDATE automation_rules SET status='active',published_version=draft_version,updated_by=${r.claims!.sub}::uuid,updated_at=now() WHERE id=${r.params.id}::uuid RETURNING *`;
        await tx`UPDATE automation_rule_versions SET status='archived' WHERE rule_id=${r.params.id}::uuid AND status='published' AND version<>${draftVersion}`;
        await tx`UPDATE automation_rule_versions SET status='published',published_at=now() WHERE rule_id=${r.params.id}::uuid AND version=${draftVersion}`;
        return { kind: "published" as const, rule: rows[0]! };
      });
      if (result.kind === "not_found")
        return reply.code(404).send({
          error: {
            code: "automation_not_found",
            message: "Yayınlanabilir otomasyon bulunamadı.",
          },
        });
      if (result.kind === "invalid")
        return reply.code(400).send({
          error: {
            code: result.code,
            message:
              "Otomasyon aksiyon ayarları eksik veya geçersiz; yayınlamadan önce düzeltin.",
          },
        });
      return { data: result.rule };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/automations/:id/pause",
    { preHandler: options.authorize("automations:pause") },
    async (r, reply) => {
      const rows = await automationRepository.query<Row[]>`
        UPDATE automation_rules SET
          status='paused',
          updated_by=${r.claims!.sub}::uuid,
          updated_at=now()
        WHERE id=${r.params.id}::uuid
          AND organization_id=${r.claims!.organizationId}::uuid
          AND status='active'
        RETURNING *`;
      if (!rows[0])
        return reply.code(409).send({
          error: {
            code: "automation_not_active",
            message: "Yalnızca etkin otomasyon duraklatılabilir.",
          },
        });
      return { data: rows[0] };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/automations/:id/resume",
    { preHandler: options.authorize("automations:pause") },
    async (r, reply) => {
      const rows = await automationRepository.query<Row[]>`
        UPDATE automation_rules SET
          status='active',
          updated_by=${r.claims!.sub}::uuid,
          updated_at=now()
        WHERE id=${r.params.id}::uuid
          AND organization_id=${r.claims!.organizationId}::uuid
          AND status='paused'
          AND published_version IS NOT NULL
        RETURNING *`;
      if (!rows[0])
        return reply.code(409).send({
          error: {
            code: "automation_not_resumable",
            message: "Otomasyon duraklatılmış ve yayınlanmış olmalıdır.",
          },
        });
      return { data: rows[0] };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/automations/:id/archive",
    { preHandler: options.authorize("automations:update") },
    async (r, reply) => {
      const rows = await automationRepository.query<Row[]>`
        UPDATE automation_rules SET
          status='archived',
          updated_by=${r.claims!.sub}::uuid,
          updated_at=now()
        WHERE id=${r.params.id}::uuid
          AND organization_id=${r.claims!.organizationId}::uuid
          AND status<>'archived'
        RETURNING *`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "automation_not_found",
            message: "Arşivlenecek otomasyon bulunamadı.",
          },
        });
      return { data: rows[0] };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/automations/:id",
    { preHandler: options.authorize("automations:update") },
    async (r, reply) => {
      const rows = await automationRepository.query<Row[]>`
        UPDATE automation_rules SET
          status='archived',
          updated_by=${r.claims!.sub}::uuid,
          updated_at=now()
        WHERE id=${r.params.id}::uuid
          AND organization_id=${r.claims!.organizationId}::uuid
          AND status<>'archived'
        RETURNING id,status`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "automation_not_found",
            message: "Silinecek otomasyon bulunamadı.",
          },
        });
      return { data: { id: String(rows[0].id), status: "archived" } };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/automations/:id/duplicate",
    { preHandler: options.authorize("automations:create") },
    async (r, reply) => {
      const organizationId = r.claims!.organizationId;
      const billing = await options.enforceBilling?.(
        organizationId,
        "automations",
      );
      if (billing && !billing.allowed)
        return reply.code(409).send({
          error: {
            code: billing.code,
            message:
              "Abonelik planınız yeni otomasyon oluşturmaya izin vermiyor.",
          },
        });
      const source = await automationDetail(
        organizationId,
        r.params.id,
        "draft",
      );
      if (!source?.definition?.trigger)
        return reply.code(404).send({
          error: {
            code: "automation_not_found",
            message: "Kopyalanacak otomasyon bulunamadı.",
          },
        });
      const baseName = `${String(source.rule.name)} (Kopya)`;
      const existingNames = await automationRepository.query<Row[]>`
        SELECT name FROM automation_rules
        WHERE organization_id=${organizationId}::uuid
          AND name LIKE ${`${baseName}%`}`;
      const usedNames = new Set(existingNames.map((row) => String(row.name)));
      let name = baseName;
      for (let suffix = 2; usedNames.has(name); suffix++)
        name = `${baseName.replace(/\)$/, "")} ${suffix})`;
      const { definition, normalizedActions } =
        await prepareAutomationDefinition(
          {
            name,
            description: source.rule.description ?? undefined,
            priority: Number(source.rule.priority),
            stopProcessing: Boolean(source.rule.stop_processing),
            trigger: source.definition.trigger,
            conditions: source.definition.conditions.map((condition) => ({
              field: condition.field,
              operator: condition.operator,
              value: condition.value,
            })),
            actions: source.definition.actions.map((action) => ({
              type: action.type,
              config: action.config,
            })),
          },
          organizationId,
        );
      const created = await automationRepository.begin(async (tx) => {
        const rows = await tx<Row[]>`
          INSERT INTO automation_rules(
            organization_id,name,description,priority,stop_processing,
            created_by,updated_by
          ) VALUES(
            ${organizationId}::uuid,${definition.name},
            ${definition.description ?? null},${definition.priority},
            ${definition.stopProcessing},${r.claims!.sub}::uuid,
            ${r.claims!.sub}::uuid
          ) RETURNING *`;
        await insertAutomationVersion({
          tx,
          organizationId,
          ruleId: String(rows[0]!.id),
          version: 1,
          actorId: r.claims!.sub,
          definition,
          normalizedActions,
        });
        return rows[0]!;
      });
      return reply
        .code(201)
        .send({ data: { ...created, id: String(created.id) } });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/automations/:id/dry-run",
    { preHandler: options.authorize("automations:update") },
    async (r) => {
      const context = z.record(z.string(), z.unknown()).parse(r.body ?? {});
      const rows = await automationRepository.query<
        Row[]
      >`SELECT c.field,c.operator,c.value FROM automation_rules ar JOIN automation_rule_versions v ON v.rule_id=ar.id AND v.version=ar.draft_version LEFT JOIN automation_rule_conditions c ON c.version_id=v.id WHERE ar.id=${r.params.id}::uuid AND ar.organization_id=${r.claims!.organizationId}::uuid ORDER BY c.position`;
      const evaluations = rows
        .filter((x) => x.field)
        .map((x) => ({
          field: String(x.field),
          operator: String(x.operator),
          value: x.value,
          matched: evaluateCondition(
            {
              field: String(x.field),
              operator: String(x.operator),
              value: x.value,
            },
            context,
          ),
        }));
      return {
        data: {
          matched: evaluations.every((evaluation) => evaluation.matched),
          evaluations,
          dryRun: true,
        },
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/automations/:id/runs",
    { preHandler: options.authorize("automations:runs:read") },
    async (r) => ({
      data: await automationRepository.query`
        SELECT run.*,
          COALESCE((
            SELECT json_agg(step ORDER BY step.position)
            FROM automation_run_steps step
            WHERE step.run_id=run.id
          ), '[]'::json) steps
        FROM automation_runs run
        WHERE run.rule_id=${r.params.id}::uuid
          AND run.organization_id=${r.claims!.organizationId}::uuid
        ORDER BY run.started_at DESC LIMIT 100
      `,
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/open-channels",
    { preHandler: options.authorize("open_channels:read") },
    async (r) => {
      const state = (
        await automationRepository.query<
          Row[]
        >`SELECT ic.bitrix_mode,ic.open_channels_status,ic.settings->'openChannels' AS open_channels_settings,oc.* FROM integration_connections ic LEFT JOIN bitrix_open_channel_connectors oc ON oc.integration_connection_id=ic.id WHERE ic.id=${r.params.id}::uuid AND ic.organization_id=${r.claims!.organizationId}::uuid`
      )[0];
      if (!state) return { data: null };
      const bindings = await automationRepository.query<
        Row[]
      >`SELECT id,brixchat_channel_id,connector_id,line_id,status,settings,last_event_at,last_success_at,last_error,created_at,updated_at FROM bitrix_open_channel_bindings WHERE integration_connection_id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid ORDER BY created_at`;
      return { data: { ...state, bindings } };
    },
  );
  app.get(
    "/api/v1/channels/bitrix24-bindings",
    { preHandler: options.authorize("open_channels:read") },
    async (r) => {
      const [rows, connections] = await Promise.all([
        automationRepository.query<Row[]>`
          SELECT
            channel.id AS channel_id,
            binding.id AS binding_id,
            binding.integration_connection_id,
            binding.connector_id,
            binding.line_id,
            binding.status AS binding_status,
            binding.settings,
            binding.last_event_at,
            binding.last_success_at,
            binding.last_error,
            connection.name AS connection_name,
            connection.portal_url,
            connection.status AS connection_status
          FROM channels channel
          LEFT JOIN bitrix_open_channel_bindings binding
            ON binding.organization_id=channel.organization_id
           AND binding.brixchat_channel_id=channel.id
          LEFT JOIN integration_connections connection
            ON connection.id=binding.integration_connection_id
           AND connection.organization_id=binding.organization_id
          WHERE channel.organization_id=${r.claims!.organizationId}::uuid
            AND channel.deleted_at IS NULL
            AND (
              channel.platform='whatsapp'
              OR channel.provider IN ('meta', 'whatsapp_web', 'fake')
            )
          ORDER BY channel.created_at
        `,
        automationRepository.query<Row[]>`
          SELECT id,name,portal_url,status,auth_mode
          FROM integration_connections
          WHERE organization_id=${r.claims!.organizationId}::uuid
            AND provider='bitrix24'
            AND status='connected'
          ORDER BY created_at
        `,
      ]);
      return {
        data: {
          bindings: rows.map((row) => ({
            channelId: String(row.channel_id),
            binding: row.binding_id
              ? {
                  id: String(row.binding_id),
                  integrationConnectionId: String(
                    row.integration_connection_id,
                  ),
                  connectorId: String(row.connector_id),
                  lineId: String(row.line_id),
                  status: String(row.binding_status),
                  settings: (row.settings ?? {}) as Record<string, unknown>,
                  lastEventAt: row.last_event_at
                    ? new Date(String(row.last_event_at)).toISOString()
                    : null,
                  lastSuccessAt: row.last_success_at
                    ? new Date(String(row.last_success_at)).toISOString()
                    : null,
                  lastError: row.last_error ? String(row.last_error) : null,
                }
              : null,
            connection: row.integration_connection_id
              ? {
                  id: String(row.integration_connection_id),
                  name: String(row.connection_name ?? "Bitrix24"),
                  portalUrl: row.portal_url ? String(row.portal_url) : null,
                  status: String(row.connection_status ?? "connected"),
                }
              : null,
          })),
          connections: connections.map((connection) => ({
            id: String(connection.id),
            name: String(connection.name ?? "Bitrix24"),
            portalUrl: connection.portal_url
              ? String(connection.portal_url)
              : null,
            status: String(connection.status),
            authMode: String(connection.auth_mode),
          })),
        },
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/open-channels/lines",
    { preHandler: options.authorize("open_channels:read") },
    async (r, reply) => {
      const connection = (
        await automationRepository.query<
          Row[]
        >`SELECT * FROM integration_connections WHERE id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid AND provider='bitrix24' AND status='connected'`
      )[0];
      if (!connection)
        return reply.code(404).send({
          error: {
            code: "connection_not_found",
            message: "Connected Bitrix24 integration not found",
          },
        });
      return { data: await openChannelsConnector(connection).listLines() };
    },
  );
  app.put<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/open-channels",
    { preHandler: options.authorize("open_channels:manage") },
    async (r, reply) => {
      const b = openSchema.parse(r.body);
      const targetConnection = (
        await automationRepository.query<
          Row[]
        >`SELECT * FROM integration_connections WHERE id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid AND provider='bitrix24' AND status='connected'`
      )[0];
      if (!targetConnection)
        return reply.code(404).send({
          error: {
            code: "connection_not_found",
            message: "Connected Bitrix24 integration not found",
          },
        });
      const selectedLine = b.lineId
        ? (await openChannelsConnector(targetConnection).listLines()).find(
            (line) => line.id === b.lineId,
          )
        : null;
      if (b.lineId && !selectedLine?.active)
        return reply.code(409).send({
          error: {
            code: "bitrix_line_unavailable",
            message: "Selected Bitrix line is inactive or unavailable",
          },
        });
      const settings = {
        ...openChannelsBindingSettings(b, selectedLine?.queueUserIds),
        lineOwnership: "existing",
      };
      if (b.brixchatChannelId) {
        const channel = (
          await automationRepository.query<
            Row[]
          >`SELECT id FROM channels WHERE id=${b.brixchatChannelId}::uuid AND organization_id=${r.claims!.organizationId}::uuid AND connection_status='ACTIVE' AND deleted_at IS NULL`
        )[0];
        if (!channel)
          return reply.code(404).send({
            error: {
              code: "channel_not_found",
              message: "Active BrixChat channel not found",
            },
          });
      }
      if (b.brixchatChannelId && b.lineId) {
        const current = (
          await automationRepository.query<
            Row[]
          >`SELECT integration_connection_id,line_id FROM bitrix_open_channel_bindings WHERE organization_id=${r.claims!.organizationId}::uuid AND brixchat_channel_id=${b.brixchatChannelId}::uuid LIMIT 1`
        )[0];
        if (
          current &&
          (String(current.integration_connection_id) !== r.params.id ||
            String(current.line_id) !== b.lineId)
        )
          return reply.code(409).send({
            error: {
              code: "open_channel_remap_confirmation_required",
              message:
                "Use the confirmed remap operation to change a WhatsApp channel's Bitrix portal or line",
            },
          });
        const conflict = (
          await automationRepository.query<
            Row[]
          >`SELECT brixchat_channel_id,line_id FROM bitrix_open_channel_bindings WHERE organization_id=${r.claims!.organizationId}::uuid AND integration_connection_id=${r.params.id}::uuid AND line_id=${b.lineId} AND brixchat_channel_id<>${b.brixchatChannelId}::uuid AND status<>'archived' LIMIT 1`
        )[0];
        if (conflict)
          return reply.code(409).send({
            error: {
              code: "open_channel_binding_conflict",
              message:
                "Each WhatsApp channel and Bitrix line can be used by only one Open Channel mapping",
            },
          });
      }
      if (b.autoCrmMode === "contact_and_deal") {
        const stage = (
          await automationRepository.query<
            Row[]
          >`SELECT 1 FROM crm_pipeline_cache WHERE organization_id=${r.claims!.organizationId}::uuid AND connection_id=${r.params.id}::uuid AND pipeline_external_id=${b.pipelineId!} AND stage_external_id=${b.stageId!} LIMIT 1`
        )[0];
        if (!stage)
          return reply.code(409).send({
            error: {
              code: "crm_pipeline_stage_stale",
              message: "Selected Bitrix pipeline or stage is unavailable",
            },
          });
      }
      const updatedConnection = (
        await automationRepository.query<
          Row[]
        >`UPDATE integration_connections SET bitrix_mode=${b.mode},updated_at=now() WHERE id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid RETURNING id`
      )[0];
      if (!updatedConnection)
        return reply.code(404).send({
          error: {
            code: "connection_not_found",
            message: "Bitrix24 connection not found",
          },
        });
      let binding: Row | null = null;
      if (b.brixchatChannelId && b.lineId) {
        const connectorId =
          (
            await automationRepository.query<
              Row[]
            >`SELECT connector_id FROM bitrix_open_channel_connectors WHERE integration_connection_id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid`
          )[0]?.connector_id ??
          `brixchat_${r.params.id.replaceAll("-", "").slice(0, 20)}`;
        await automationRepository.query`DELETE FROM bitrix_open_channel_bindings WHERE organization_id=${r.claims!.organizationId}::uuid AND integration_connection_id=${r.params.id}::uuid AND line_id=${b.lineId} AND status='archived' AND brixchat_channel_id<>${b.brixchatChannelId}::uuid`;
        binding =
          (
            await automationRepository.query<
              Row[]
            >`INSERT INTO bitrix_open_channel_bindings(organization_id,integration_connection_id,brixchat_channel_id,connector_id,line_id,status,settings)
              VALUES(${r.claims!.organizationId}::uuid,${r.params.id}::uuid,${b.brixchatChannelId}::uuid,${String(connectorId)},${b.lineId},'registered',${sql.json(settings as never)})
              ON CONFLICT(organization_id,brixchat_channel_id) DO UPDATE SET
                integration_connection_id=excluded.integration_connection_id,
                connector_id=excluded.connector_id,
                line_id=excluded.line_id,
                status=CASE
                  WHEN bitrix_open_channel_bindings.integration_connection_id=excluded.integration_connection_id
                    AND bitrix_open_channel_bindings.line_id=excluded.line_id
                    THEN bitrix_open_channel_bindings.status
                  ELSE 'registered'
                END,
                settings=excluded.settings || jsonb_build_object(
                  'lineOwnership',
                  COALESCE(bitrix_open_channel_bindings.settings->>'lineOwnership','existing')
                ),
                last_error=NULL,
                updated_at=now()
              RETURNING *`
          )[0] ?? null;
      }
      return {
        data: {
          updated: true,
          mode: b.mode,
          brixchatChannelId: b.brixchatChannelId,
          lineId: b.lineId,
          ...settings,
          binding,
        },
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/open-channels/register",
    { preHandler: options.authorize("open_channels:manage") },
    async (r) => {
      const connection = (
        await automationRepository.query<
          Row[]
        >`SELECT id,public_id,name,auth_mode,status,portal_url,credentials_encrypted FROM integration_connections WHERE id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid`
      )[0];
      if (!connection) return { data: null };
      if (String(connection.status) !== "connected")
        return {
          data: null,
          error: {
            code: "integration_not_connected",
            message: "Bitrix24 connection is not connected",
          },
        };
      const connector = openChannelsConnector(connection);
      const result = await connector.register({
        name: String(connection.name),
      });
      const rows = await sql.begin(async (tx) => {
        const saved = await tx<
          Row[]
        >`INSERT INTO bitrix_open_channel_connectors(organization_id,integration_connection_id,connector_id,status,last_error) VALUES(${r.claims!.organizationId}::uuid,${r.params.id}::uuid,${result.connectorId},'registered',NULL) ON CONFLICT(integration_connection_id) DO UPDATE SET connector_id=excluded.connector_id,status='registered',last_error=NULL,updated_at=now() RETURNING *`;
        await tx`UPDATE bitrix_open_channel_bindings SET connector_id=${result.connectorId},updated_at=now() WHERE integration_connection_id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid`;
        await tx`UPDATE integration_connections SET open_channels_status='registered',updated_at=now() WHERE id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid`;
        return saved;
      });
      return { data: rows[0] };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/open-channels/crm-exclusions",
    { preHandler: options.authorize("open_channels:read") },
    async (r) => ({
      data: await automationRepository.query<Row[]>`
        SELECT exclusion.id,exclusion.normalized_phone,exclusion.display_name,
          exclusion.reason,exclusion.created_at,exclusion.updated_at,
          creator.full_name AS created_by_name
        FROM crm_contact_exclusions exclusion
        JOIN integration_connections connection
          ON connection.organization_id=exclusion.organization_id
         AND connection.id=${r.params.id}::uuid
         AND connection.provider='bitrix24'
        LEFT JOIN users creator ON creator.id=exclusion.created_by
        WHERE exclusion.organization_id=${r.claims!.organizationId}::uuid
          AND exclusion.archived_at IS NULL
        ORDER BY exclusion.display_name NULLS LAST,exclusion.normalized_phone`,
    }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/open-channels/crm-exclusions",
    { preHandler: options.authorize("open_channels:manage") },
    async (r, reply) => {
      const body = crmContactExclusionSchema.parse(r.body);
      const normalizedPhone = normalizeCrmPhone(body.phone);
      if (!normalizedPhone)
        return reply.code(400).send({
          error: {
            code: "crm_exclusion_phone_invalid",
            message: "CRM exclusion requires a valid international phone",
          },
        });
      const result = await automationRepository.begin(async (tx) => {
        const exclusions = await tx<Row[]>`
          INSERT INTO crm_contact_exclusions(
            organization_id,normalized_phone,display_name,reason,created_by
          )
          SELECT ${r.claims!.organizationId}::uuid,${normalizedPhone},
            ${body.displayName ?? null},${body.reason},${r.claims!.sub}::uuid
          FROM integration_connections connection
          WHERE connection.id=${r.params.id}::uuid
            AND connection.organization_id=${r.claims!.organizationId}::uuid
            AND connection.provider='bitrix24'
          ON CONFLICT(organization_id,normalized_phone)
            WHERE archived_at IS NULL
          DO UPDATE SET display_name=excluded.display_name,
            reason=excluded.reason,updated_at=now()
          RETURNING *`;
        if (!exclusions[0]) return null;
        const archived = body.archivePendingJobs
          ? await tx<Row[]>`
              UPDATE bitrix_open_channel_jobs job
              SET status='archived',completed_at=now(),
                last_error='CRM_CONTACT_EXCLUDED',locked_at=NULL,
                locked_by=NULL,updated_at=now()
              FROM conversations conversation
              JOIN contacts contact
                ON contact.id=conversation.contact_id
               AND contact.organization_id=conversation.organization_id
              WHERE job.organization_id=${r.claims!.organizationId}::uuid
                AND job.conversation_id=conversation.id
                AND contact.normalized_phone=${normalizedPhone}
                AND job.job_type='open_channels.crm'
                AND job.status IN(
                  'pending','retry','processing','manual_review','dead_letter','blocked'
                )
              RETURNING job.id`
          : [];
        await tx`
          INSERT INTO audit_logs(
            organization_id,actor_id,action,entity_type,entity_id,metadata
          ) VALUES(
            ${r.claims!.organizationId}::uuid,${r.claims!.sub}::uuid,
            'bitrix_open_channel.crm_contact_excluded','integration',
            ${r.params.id}::uuid,
            ${tx.json({ normalizedPhone, archivedJobCount: archived.length } as never)}
          )`;
        return { exclusion: exclusions[0], archivedJobCount: archived.length };
      });
      if (!result)
        return reply.code(404).send({
          error: {
            code: "bitrix_connection_not_found",
            message: "Bitrix24 connection not found",
          },
        });
      return { data: result };
    },
  );
  app.delete<{ Params: { id: string; exclusionId: string } }>(
    "/api/v1/integrations/:id/open-channels/crm-exclusions/:exclusionId",
    { preHandler: options.authorize("open_channels:manage") },
    async (r, reply) => {
      const rows = await automationRepository.query<Row[]>`
        UPDATE crm_contact_exclusions exclusion
        SET archived_at=now(),updated_at=now()
        WHERE exclusion.id=${r.params.exclusionId}::uuid
          AND exclusion.organization_id=${r.claims!.organizationId}::uuid
          AND exclusion.archived_at IS NULL
          AND EXISTS(
            SELECT 1 FROM integration_connections connection
            WHERE connection.id=${r.params.id}::uuid
              AND connection.organization_id=exclusion.organization_id
              AND connection.provider='bitrix24'
          )
        RETURNING exclusion.id`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "crm_exclusion_not_found",
            message: "CRM exclusion not found",
          },
        });
      await automationRepository.query`
        INSERT INTO audit_logs(
          organization_id,actor_id,action,entity_type,entity_id,metadata
        ) VALUES(
          ${r.claims!.organizationId}::uuid,${r.claims!.sub}::uuid,
          'bitrix_open_channel.crm_contact_exclusion_archived','integration',
          ${r.params.id}::uuid,
          ${sql.json({ exclusionId: r.params.exclusionId } as never)}
        )`;
      return { data: { id: r.params.exclusionId, archived: true } };
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/api/v1/integrations/:id/open-channels/jobs",
    { preHandler: options.authorize("open_channels:read") },
    async (r) => {
      const { limit, offset } = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .parse(r.query);
      const rows = await automationRepository.query<Row[]>`SELECT
          job.id,
          job.conversation_id,
          job.job_type,
          job.status,
          job.attempt_count,
          job.max_attempts,
          job.last_error,
          job.created_at,
          job.updated_at,
          contact.display_name AS contact_name,
          contact.normalized_phone,
          channel.name AS channel_name,
          (
            SELECT count(*)::int
            FROM bitrix_open_channel_jobs sibling
            WHERE sibling.organization_id=job.organization_id
              AND sibling.integration_connection_id=job.integration_connection_id
              AND sibling.conversation_id=job.conversation_id
              AND sibling.job_type='open_channels.crm'
              AND sibling.status IN(
                'manual_review','dead_letter','blocked'
              )
          ) AS related_job_count,
          count(*) OVER()::int AS total_cases,
          (
            SELECT count(*)::int
            FROM bitrix_open_channel_jobs outstanding
            WHERE outstanding.organization_id=job.organization_id
              AND outstanding.integration_connection_id=job.integration_connection_id
              AND outstanding.job_type='open_channels.crm'
              AND outstanding.status IN(
                'manual_review','dead_letter','blocked'
              )
          ) AS total_jobs
        FROM bitrix_open_channel_jobs job
        JOIN conversations conversation
          ON conversation.id=job.conversation_id
         AND conversation.organization_id=job.organization_id
        JOIN contacts contact
          ON contact.id=conversation.contact_id
         AND contact.organization_id=job.organization_id
        JOIN channels channel
          ON channel.id=conversation.channel_id
         AND channel.organization_id=job.organization_id
        WHERE job.organization_id=${r.claims!.organizationId}::uuid
          AND job.integration_connection_id=${r.params.id}::uuid
          AND job.status IN('manual_review','dead_letter')
        ORDER BY job.updated_at DESC
        LIMIT ${limit} OFFSET ${offset}`;
      return {
        data: rows,
        meta: {
          totalCases: Number(rows[0]?.total_cases ?? 0),
          totalJobs: Number(rows[0]?.total_jobs ?? 0),
          limit,
          offset,
        },
      };
    },
  );
  app.post<{ Params: { id: string; jobId: string } }>(
    "/api/v1/integrations/:id/open-channels/jobs/:jobId/retry",
    { preHandler: options.authorize("open_channels:manage") },
    async (r, reply) => {
      z.object({ confirm: z.literal("RETRY") }).parse(r.body);
      const job = (
        await automationRepository.query<
          Row[]
        >`UPDATE bitrix_open_channel_jobs SET status='pending',attempt_count=0,next_attempt_at=now(),locked_at=NULL,locked_by=NULL,last_error=NULL,completed_at=NULL,updated_at=now() WHERE id=${r.params.jobId}::uuid AND organization_id=${r.claims!.organizationId}::uuid AND integration_connection_id=${r.params.id}::uuid AND status='dead_letter' RETURNING id`
      )[0];
      if (!job)
        return reply.code(409).send({
          error: {
            code: "open_channel_job_not_retryable",
            message:
              "Only dead-letter Open Channel jobs can be retried directly",
          },
        });
      await automationRepository.query`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata) VALUES(${r.claims!.organizationId}::uuid,${r.claims!.sub}::uuid,'bitrix_open_channel.job_retried','integration',${r.params.id}::uuid,${sql.json({ jobId: r.params.jobId } as never)})`;
      return { data: { id: r.params.jobId, status: "pending" } };
    },
  );
  app.post<{ Params: { id: string; jobId: string } }>(
    "/api/v1/integrations/:id/open-channels/jobs/:jobId/resolve",
    { preHandler: options.authorize("open_channels:manage") },
    async (r, reply) => {
      const body = z
        .object({
          confirm: z.literal("LINK_CRM_ENTITY"),
          entityType: z.enum(["contact", "lead", "deal", "company"]),
          externalId: z.string().trim().regex(/^\d+$/).max(100),
        })
        .parse(r.body);
      const job = (
        await automationRepository.query<
          Row[]
        >`SELECT job.id,job.conversation_id,conversation.contact_id FROM bitrix_open_channel_jobs job JOIN conversations conversation ON conversation.id=job.conversation_id AND conversation.organization_id=job.organization_id WHERE job.id=${r.params.jobId}::uuid AND job.organization_id=${r.claims!.organizationId}::uuid AND job.integration_connection_id=${r.params.id}::uuid AND job.status='manual_review'`
      )[0];
      if (!job)
        return reply.code(409).send({
          error: {
            code: "open_channel_job_not_resolvable",
            message: "Only manual-review Open Channel jobs can be resolved",
          },
        });
      await automationRepository.begin(async (tx) => {
        await tx`INSERT INTO crm_entity_links(organization_id,connection_id,conversation_id,contact_id,entity_type,external_id,match_source,match_confidence,created_by) VALUES(${r.claims!.organizationId}::uuid,${r.params.id}::uuid,${String(job.conversation_id)}::uuid,${String(job.contact_id)}::uuid,${body.entityType},${body.externalId},'manual',1,${r.claims!.sub}::uuid) ON CONFLICT(connection_id,conversation_id,entity_type) DO UPDATE SET external_id=excluded.external_id,contact_id=excluded.contact_id,match_source='manual',match_confidence=1,unavailable_at=NULL,created_by=excluded.created_by,updated_at=now()`;
        await tx`UPDATE bitrix_open_channel_jobs SET status='pending',attempt_count=0,next_attempt_at=now(),locked_at=NULL,locked_by=NULL,last_error=NULL,completed_at=NULL,updated_at=now() WHERE id=${r.params.jobId}::uuid`;
        await tx`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata) VALUES(${r.claims!.organizationId}::uuid,${r.claims!.sub}::uuid,'bitrix_open_channel.job_resolved','integration',${r.params.id}::uuid,${tx.json({ jobId: r.params.jobId, entityType: body.entityType, externalId: body.externalId } as never)})`;
      });
      return { data: { id: r.params.jobId, status: "pending" } };
    },
  );
  app.post<{ Params: { id: string; jobId: string } }>(
    "/api/v1/integrations/:id/open-channels/jobs/:jobId/archive",
    { preHandler: options.authorize("open_channels:manage") },
    async (r, reply) => {
      z.object({ confirm: z.literal("ARCHIVE") }).parse(r.body);
      const archived = await automationRepository.begin(async (tx) => {
        const head = (
          await tx<Row[]>`
            SELECT conversation_id FROM bitrix_open_channel_jobs
            WHERE id=${r.params.jobId}::uuid
              AND organization_id=${r.claims!.organizationId}::uuid
              AND integration_connection_id=${r.params.id}::uuid
              AND status IN('manual_review','dead_letter')
            FOR UPDATE`
        )[0];
        if (!head) return null;
        const rows = await tx<Row[]>`
          UPDATE bitrix_open_channel_jobs
          SET status='archived',locked_at=NULL,locked_by=NULL,
            completed_at=now(),updated_at=now()
          WHERE organization_id=${r.claims!.organizationId}::uuid
            AND integration_connection_id=${r.params.id}::uuid
            AND conversation_id=${String(head.conversation_id)}::uuid
            AND job_type='open_channels.crm'
            AND status IN('manual_review','dead_letter','blocked')
          RETURNING id`;
        return rows;
      });
      if (!archived)
        return reply.code(409).send({
          error: {
            code: "open_channel_job_not_archivable",
            message: "Open Channel job is no longer awaiting review",
          },
        });
      await automationRepository.query`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata) VALUES(${r.claims!.organizationId}::uuid,${r.claims!.sub}::uuid,'bitrix_open_channel.job_archived','integration',${r.params.id}::uuid,${sql.json({ jobId: r.params.jobId, archivedJobCount: archived.length } as never)})`;
      return {
        data: {
          id: r.params.jobId,
          status: "archived",
          archivedJobCount: archived.length,
        },
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/open-channels/ensure",
    { preHandler: options.authorize("open_channels:manage") },
    async (r, reply) => {
      const { channelId } = z
        .object({
          channelId: z.string().uuid(),
          confirm: z.literal("CREATE_NEW"),
        })
        .parse(r.body);
      const connection = (
        await automationRepository.query<
          Row[]
        >`SELECT ic.*,connector.connector_id FROM integration_connections ic JOIN bitrix_open_channel_connectors connector ON connector.integration_connection_id=ic.id WHERE ic.id=${r.params.id}::uuid AND ic.organization_id=${r.claims!.organizationId}::uuid AND ic.provider='bitrix24' AND ic.status='connected'`
      )[0];
      if (!connection)
        return reply.code(404).send({
          error: {
            code: "connector_not_registered",
            message: "Register the Bitrix connector before adding channels",
          },
        });
      const channel = (
        await automationRepository.query<
          Row[]
        >`SELECT id,name FROM channels WHERE id=${channelId}::uuid AND organization_id=${r.claims!.organizationId}::uuid AND connection_status='ACTIVE' AND deleted_at IS NULL`
      )[0];
      if (!channel)
        return reply.code(409).send({
          error: {
            code: "channel_unavailable",
            message: "Selected BrixChat channel is unavailable",
          },
        });
      const existing = (
        await automationRepository.query<
          Row[]
        >`SELECT * FROM bitrix_open_channel_bindings WHERE organization_id=${r.claims!.organizationId}::uuid AND brixchat_channel_id=${channelId}::uuid`
      )[0];
      if (
        existing &&
        String(existing.integration_connection_id) !== r.params.id
      )
        return reply.code(409).send({
          error: {
            code: "open_channel_binding_conflict",
            message: "This WhatsApp channel is already bound to another portal",
          },
        });
      const connector = openChannelsConnector(connection);
      if (existing)
        return reply.code(409).send({
          error: {
            code: "open_channel_already_bound",
            message:
              "This WhatsApp channel is already bound. Use the confirmed remap operation to change it.",
          },
        });
      const lines = await connector.listLines();
      const desiredName = `BrixChat24 - ${String(channel.name)}`.slice(0, 100);
      const rootSettings = (connection.settings ?? {}) as Record<
        string,
        unknown
      >;
      const legacy = (rootSettings.openChannels ?? {}) as Record<
        string,
        unknown
      >;
      const reference = lines.find(
        (line) =>
          line.id === String(legacy.lineId ?? "") &&
          line.queueUserIds.length > 0,
      );
      const responsible =
        typeof legacy.responsibleExternalUserId === "string"
          ? [legacy.responsibleExternalUserId]
          : [];
      const queueUserIds =
        reference?.queueUserIds ??
        lines.find((line) => line.queueUserIds.length > 0)?.queueUserIds ??
        responsible;
      if (!queueUserIds.length)
        return reply.code(409).send({
          error: {
            code: "open_channel_queue_required",
            message:
              "Select at least one Bitrix operator before creating the line",
          },
        });
      const lineId = (
        await connector.createLine({
          name: desiredName,
          queueUserIds,
        })
      ).lineId;
      try {
        const legacySettings = { ...legacy };
        delete legacySettings.brixchatChannelId;
        delete legacySettings.lineId;
        delete legacySettings.responsibleExternalUserId;
        const responsibleExternalUserId =
          resolveLineQueueResponsibleExternalUserId(queueUserIds);
        const settings = {
          incomingEnabled: true,
          outgoingEnabled: true,
          deliveryStatusSync: true,
          sessionCloseSync: true,
          autoCrmMode: "disabled",
          crmSourceId: "WEB",
          timelinePolicy: bothModeTimelinePolicy(
            String(connection.bitrix_mode ?? "both"),
          ),
          ...legacySettings,
          lineOwnership: "brixchat_created",
          ...(responsibleExternalUserId ? { responsibleExternalUserId } : {}),
        };
        const status = await connector.configure({
          connectorId: String(connection.connector_id),
          lineId,
          channelId,
          channelName: String(channel.name),
          channelUrl: `${options.webUrl}/app/inbox?channel=${channelId}`,
        });
        const binding = await sql.begin(async (tx) => {
          const rows = await tx<
            Row[]
          >`INSERT INTO bitrix_open_channel_bindings(organization_id,integration_connection_id,brixchat_channel_id,connector_id,line_id,status,settings,last_success_at,last_error)
          VALUES(${r.claims!.organizationId}::uuid,${r.params.id}::uuid,${channelId}::uuid,${String(connection.connector_id)},${lineId},'active',${tx.json(settings as never)},now(),NULL)
          ON CONFLICT(organization_id,brixchat_channel_id) DO UPDATE SET
            integration_connection_id=excluded.integration_connection_id,
            connector_id=excluded.connector_id,
            line_id=excluded.line_id,
            status='active',
            settings=excluded.settings,
            last_success_at=now(),
            last_error=NULL,
            updated_at=now()
          RETURNING *`;
          await tx`UPDATE bitrix_open_channel_connectors SET status='active',last_success_at=now(),last_error=NULL,updated_at=now() WHERE integration_connection_id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid`;
          await tx`UPDATE integration_connections SET open_channels_status='active',updated_at=now() WHERE id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid`;
          return rows[0]!;
        });
        return {
          data: {
            binding,
            createdLine: true,
            status,
          },
        };
      } catch (reason) {
        await connector
          .deactivate({
            connectorId: String(connection.connector_id),
            lineId,
          })
          .catch(() => undefined);
        try {
          await connector.deleteLine({ lineId });
        } catch (cleanupError) {
          throw Object.assign(
            new Error("BITRIX_LINE_PROVISIONING_COMPENSATION_FAILED"),
            {
              cause: reason,
              cleanupError,
              statusCode: 502,
              code: "bitrix_line_compensation_failed",
            },
          );
        }
        throw reason;
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/open-channels/remap",
    { preHandler: options.authorize("open_channels:manage") },
    async (r, reply) => {
      z.object({ confirm: z.literal("REMAP") })
        .passthrough()
        .parse(r.body);
      const b = openSchema.parse(r.body);
      if (!b.brixchatChannelId || !b.lineId)
        return reply.code(400).send({
          error: {
            code: "open_channels_configuration_incomplete",
            message: "Remapping requires a WhatsApp channel and Bitrix line",
          },
        });
      const channelId = b.brixchatChannelId!;
      const lineId = b.lineId!;
      const organizationId = r.claims!.organizationId;
      const targetConnection = (
        await sql<
          Row[]
        >`SELECT ic.*,connector.connector_id FROM integration_connections ic JOIN bitrix_open_channel_connectors connector ON connector.integration_connection_id=ic.id AND connector.organization_id=ic.organization_id WHERE ic.id=${r.params.id}::uuid AND ic.organization_id=${organizationId}::uuid AND ic.provider='bitrix24' AND ic.status='connected'`
      )[0];
      if (!targetConnection)
        return reply.code(404).send({
          error: {
            code: "connector_not_registered",
            message: "Register the target Bitrix connector before remapping",
          },
        });
      const channel = (
        await sql<
          Row[]
        >`SELECT id,name FROM channels WHERE id=${channelId}::uuid AND organization_id=${organizationId}::uuid AND connection_status='ACTIVE' AND deleted_at IS NULL`
      )[0];
      if (!channel)
        return reply.code(409).send({
          error: {
            code: "channel_unavailable",
            message: "Selected BrixChat channel is unavailable",
          },
        });
      const conflict = (
        await sql<
          Row[]
        >`SELECT brixchat_channel_id FROM bitrix_open_channel_bindings WHERE organization_id=${organizationId}::uuid AND integration_connection_id=${r.params.id}::uuid AND line_id=${lineId} AND brixchat_channel_id<>${channelId}::uuid AND status<>'archived' LIMIT 1`
      )[0];
      if (conflict)
        return reply.code(409).send({
          error: {
            code: "open_channel_binding_conflict",
            message:
              "The selected Bitrix line is already mapped to another WhatsApp channel",
          },
        });
      if (b.autoCrmMode === "contact_and_deal") {
        const stage = (
          await sql<
            Row[]
          >`SELECT 1 FROM crm_pipeline_cache WHERE organization_id=${organizationId}::uuid AND connection_id=${r.params.id}::uuid AND pipeline_external_id=${b.pipelineId!} AND stage_external_id=${b.stageId!} LIMIT 1`
        )[0];
        if (!stage)
          return reply.code(409).send({
            error: {
              code: "crm_pipeline_stage_stale",
              message: "Selected Bitrix pipeline or stage is unavailable",
            },
          });
      }
      const previous = (
        await sql<
          Row[]
        >`SELECT binding.*,ic.public_id,ic.name,ic.auth_mode,ic.status AS connection_status,ic.portal_url,ic.credentials_encrypted,ic.settings AS connection_settings,ic.bitrix_mode,ic.open_channels_status FROM bitrix_open_channel_bindings binding JOIN integration_connections ic ON ic.id=binding.integration_connection_id AND ic.organization_id=binding.organization_id WHERE binding.organization_id=${organizationId}::uuid AND binding.brixchat_channel_id=${channelId}::uuid`
      )[0];
      const mappingChanged =
        Boolean(previous) &&
        (String(previous!.integration_connection_id) !== r.params.id ||
          String(previous!.line_id) !== lineId);
      const targetConnector = openChannelsConnector(targetConnection);
      const selectedLine = (await targetConnector.listLines()).find(
        (line) => line.id === lineId,
      );
      if (!selectedLine?.active)
        return reply.code(409).send({
          error: {
            code: "bitrix_line_unavailable",
            message: "Selected Bitrix line is inactive or unavailable",
          },
        });
      const status = await targetConnector.configure({
        connectorId: String(targetConnection.connector_id),
        lineId,
        channelId,
        channelName: String(channel.name),
        channelUrl: `${options.webUrl}/app/inbox?channel=${channelId}`,
      });
      if (mappingChanged && String(previous!.status) === "active") {
        try {
          await openChannelsConnector({
            ...previous!,
            settings: previous!.connection_settings,
            status: previous!.connection_status,
          }).deactivate({
            connectorId: String(previous!.connector_id),
            lineId: String(previous!.line_id),
          });
        } catch (reason) {
          await targetConnector
            .deactivate({
              connectorId: String(targetConnection.connector_id),
              lineId,
            })
            .catch(() => undefined);
          return reply.code(502).send({
            error: {
              code: "previous_open_channel_deactivation_failed",
              message:
                reason instanceof Error
                  ? reason.message
                  : "Previous Open Channel could not be deactivated",
            },
          });
        }
      }
      const settings = {
        ...openChannelsBindingSettings(b, selectedLine.queueUserIds),
        lineOwnership: "existing",
      };
      let result: { binding: Row; closedSessionCount: number };
      try {
        result = await sql.begin(async (tx) => {
          await tx`DELETE FROM bitrix_open_channel_bindings WHERE organization_id=${organizationId}::uuid AND integration_connection_id=${r.params.id}::uuid AND line_id=${lineId} AND status='archived' AND brixchat_channel_id<>${channelId}::uuid`;
          const binding = (
            await tx<
              Row[]
            >`INSERT INTO bitrix_open_channel_bindings(organization_id,integration_connection_id,brixchat_channel_id,connector_id,line_id,status,settings,last_success_at,last_error)
            VALUES(${organizationId}::uuid,${r.params.id}::uuid,${channelId}::uuid,${String(targetConnection.connector_id)},${lineId},'active',${tx.json(settings as never)},now(),NULL)
            ON CONFLICT(organization_id,brixchat_channel_id) DO UPDATE SET
              integration_connection_id=excluded.integration_connection_id,
              connector_id=excluded.connector_id,
              line_id=excluded.line_id,
              status='active',
              settings=excluded.settings,
              last_success_at=now(),
              last_error=NULL,
              updated_at=now()
            RETURNING *`
          )[0]!;
          const closedSessions = mappingChanged
            ? await tx<
                Row[]
              >`UPDATE bitrix_open_channel_sessions session SET status='closed',closed_at=COALESCE(session.closed_at,now()),updated_at=now() FROM conversations conversation WHERE session.conversation_id=conversation.id AND session.organization_id=${organizationId}::uuid AND conversation.organization_id=session.organization_id AND conversation.channel_id=${channelId}::uuid AND session.status='open' AND (session.integration_connection_id<>${r.params.id}::uuid OR COALESCE(session.line_id,'')<>${lineId}) RETURNING session.id`
            : [];
          await tx`UPDATE integration_connections SET bitrix_mode=${b.mode},open_channels_status='active',updated_at=now() WHERE id=${r.params.id}::uuid AND organization_id=${organizationId}::uuid`;
          await tx`UPDATE bitrix_open_channel_connectors SET status='active',last_success_at=now(),last_error=NULL,updated_at=now() WHERE integration_connection_id=${r.params.id}::uuid AND organization_id=${organizationId}::uuid`;
          if (
            mappingChanged &&
            String(previous!.integration_connection_id) !== r.params.id
          ) {
            const oldActive = (
              await tx<
                Row[]
              >`SELECT 1 FROM bitrix_open_channel_bindings WHERE integration_connection_id=${String(previous!.integration_connection_id)}::uuid AND organization_id=${organizationId}::uuid AND brixchat_channel_id<>${channelId}::uuid AND status='active' LIMIT 1`
            )[0];
            if (!oldActive) {
              await tx`UPDATE bitrix_open_channel_connectors SET status='disabled',updated_at=now() WHERE integration_connection_id=${String(previous!.integration_connection_id)}::uuid AND organization_id=${organizationId}::uuid`;
              await tx`UPDATE integration_connections SET open_channels_status='disabled',updated_at=now() WHERE id=${String(previous!.integration_connection_id)}::uuid AND organization_id=${organizationId}::uuid`;
            }
          }
          await tx`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata) VALUES(${organizationId}::uuid,${r.claims!.sub}::uuid,'bitrix_open_channel.remapped','channel',${channelId}::uuid,${tx.json(
            {
              previousIntegrationConnectionId: previous
                ? String(previous.integration_connection_id)
                : null,
              previousLineId: previous ? String(previous.line_id) : null,
              integrationConnectionId: r.params.id,
              lineId,
              mappingChanged,
              closedSessionCount: closedSessions.length,
            } as never,
          )})`;
          return { binding, closedSessionCount: closedSessions.length };
        });
      } catch (reason) {
        await targetConnector
          .deactivate({
            connectorId: String(targetConnection.connector_id),
            lineId,
          })
          .catch(() => undefined);
        if (mappingChanged && String(previous!.status) === "active")
          await openChannelsConnector({
            ...previous!,
            settings: previous!.connection_settings,
            status: previous!.connection_status,
          })
            .configure({
              connectorId: String(previous!.connector_id),
              lineId: String(previous!.line_id),
              channelId,
              channelName: String(channel.name),
              channelUrl: `${options.webUrl}/app/inbox?channel=${channelId}`,
            })
            .catch(() => undefined);
        throw reason;
      }
      return {
        data: {
          ...result,
          remapped: mappingChanged,
          previous: previous
            ? {
                integrationConnectionId: String(
                  previous.integration_connection_id,
                ),
                lineId: String(previous.line_id),
              }
            : null,
          status,
        },
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/open-channels/activate",
    { preHandler: options.authorize("open_channels:manage") },
    async (r, reply) => {
      const { channelId } = z
        .object({
          confirm: z.literal("ACTIVATE"),
          channelId: z.string().uuid(),
        })
        .parse(r.body);
      const connection = (
        await sql<Row[]>`SELECT
            ic.*,
            binding.id AS binding_id,
            binding.connector_id,
            binding.line_id,
            binding.settings AS binding_settings,
            binding.status AS binding_status
          FROM integration_connections ic
          JOIN bitrix_open_channel_connectors connector
            ON connector.integration_connection_id=ic.id
          JOIN bitrix_open_channel_bindings binding
            ON binding.integration_connection_id=ic.id
           AND binding.organization_id=ic.organization_id
           AND binding.brixchat_channel_id=${channelId}::uuid
          WHERE ic.id=${r.params.id}::uuid
            AND ic.organization_id=${r.claims!.organizationId}::uuid
            AND ic.provider='bitrix24'
            AND ic.status='connected'`
      )[0];
      if (!connection)
        return reply.code(404).send({
          error: {
            code: "connector_not_registered",
            message: "Register the Bitrix connector before activation",
          },
        });
      const lineId = String(connection.line_id ?? "");
      if (!lineId || !channelId)
        return reply.code(409).send({
          error: {
            code: "open_channels_configuration_incomplete",
            message: "Select a Bitrix line and BrixChat channel first",
          },
        });
      const channel = (
        await sql<
          Row[]
        >`SELECT id,name FROM channels WHERE id=${channelId}::uuid AND organization_id=${r.claims!.organizationId}::uuid AND connection_status='ACTIVE' AND deleted_at IS NULL`
      )[0];
      if (!channel)
        return reply.code(409).send({
          error: {
            code: "channel_unavailable",
            message: "Selected BrixChat channel is unavailable",
          },
        });
      const connector = openChannelsConnector(connection);
      const lines = await connector.listLines();
      const selectedLine = lines.find((line) => line.id === lineId);
      if (!selectedLine?.active)
        return reply.code(409).send({
          error: {
            code: "bitrix_line_unavailable",
            message: "Selected Bitrix line is inactive or unavailable",
          },
        });
      const status = await connector.configure({
        connectorId: String(connection.connector_id),
        lineId,
        channelId,
        channelName: String(channel.name),
        channelUrl: `${options.webUrl}/app/inbox`,
      });
      await sql.begin(async (tx) => {
        await tx`UPDATE bitrix_open_channel_bindings SET status='active',last_success_at=now(),last_error=NULL,updated_at=now() WHERE id=${String(connection.binding_id)}::uuid AND organization_id=${r.claims!.organizationId}::uuid`;
        await tx`UPDATE bitrix_open_channel_connectors SET status='active',last_success_at=now(),last_error=NULL,updated_at=now() WHERE integration_connection_id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid`;
        await tx`UPDATE integration_connections SET open_channels_status='active',updated_at=now() WHERE id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid`;
      });
      return { data: status };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/open-channels/deactivate",
    { preHandler: options.authorize("open_channels:manage") },
    async (r, reply) => {
      const { channelId } = z
        .object({
          confirm: z.literal("DEACTIVATE"),
          channelId: z.string().uuid(),
        })
        .parse(r.body);
      const connection = (
        await sql<
          Row[]
        >`SELECT ic.*,binding.id AS binding_id,binding.connector_id,binding.line_id FROM integration_connections ic JOIN bitrix_open_channel_bindings binding ON binding.integration_connection_id=ic.id AND binding.organization_id=ic.organization_id AND binding.brixchat_channel_id=${channelId}::uuid WHERE ic.id=${r.params.id}::uuid AND ic.organization_id=${r.claims!.organizationId}::uuid`
      )[0];
      if (!connection || !connection.line_id)
        return reply.code(404).send({
          error: {
            code: "active_connector_not_found",
            message: "Active Bitrix connector not found",
          },
        });
      await openChannelsConnector(connection).deactivate({
        connectorId: String(connection.connector_id),
        lineId: String(connection.line_id),
      });
      await sql.begin(async (tx) => {
        await tx`UPDATE bitrix_open_channel_bindings SET status='disabled',updated_at=now() WHERE id=${String(connection.binding_id)}::uuid AND organization_id=${r.claims!.organizationId}::uuid`;
        const active = (
          await tx<
            Row[]
          >`SELECT 1 FROM bitrix_open_channel_bindings WHERE integration_connection_id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid AND status='active' LIMIT 1`
        )[0];
        if (!active) {
          await tx`UPDATE bitrix_open_channel_connectors SET status='disabled',updated_at=now() WHERE integration_connection_id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid`;
          await tx`UPDATE integration_connections SET open_channels_status='disabled',updated_at=now() WHERE id=${r.params.id}::uuid AND organization_id=${r.claims!.organizationId}::uuid`;
        }
      });
      return { data: { status: "disabled" } };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/open-channels/health",
    { preHandler: options.authorize("open_channels:read") },
    async (r, reply) => {
      const { channelId } = z
        .object({ channelId: z.string().uuid() })
        .parse(r.body);
      const connection = (
        await sql<
          Row[]
        >`SELECT ic.*,binding.id AS binding_id,binding.connector_id,binding.line_id FROM integration_connections ic JOIN bitrix_open_channel_bindings binding ON binding.integration_connection_id=ic.id AND binding.organization_id=ic.organization_id AND binding.brixchat_channel_id=${channelId}::uuid WHERE ic.id=${r.params.id}::uuid AND ic.organization_id=${r.claims!.organizationId}::uuid`
      )[0];
      if (!connection || !connection.line_id)
        return reply.code(404).send({
          error: {
            code: "connector_not_configured",
            message: "Bitrix connector is not configured",
          },
        });
      const status = await openChannelsConnector(connection).status({
        connectorId: String(connection.connector_id),
        lineId: String(connection.line_id),
      });
      await automationRepository.query`UPDATE bitrix_open_channel_bindings SET status=${status.active && status.configured && !status.error ? "active" : "warning"},last_success_at=CASE WHEN ${status.active && status.configured && !status.error} THEN now() ELSE last_success_at END,last_error=${status.error ? "BITRIX_CONNECTOR_STATUS_ERROR" : null},updated_at=now() WHERE id=${String(connection.binding_id)}::uuid AND organization_id=${r.claims!.organizationId}::uuid`;
      return { data: status };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/open-channels/test-outgoing",
    { preHandler: options.authorize("open_channels:test") },
    async (r, reply) => {
      const b = z
          .object({
            conversationId: z.string().uuid(),
            text: z.string().min(1).max(4096),
            eventKey: z.string().min(4),
          })
          .parse(r.body),
        org = r.claims!.organizationId;
      const connection = (
        await sql<
          Row[]
        >`SELECT id FROM integration_connections WHERE id=${r.params.id}::uuid AND organization_id=${org}::uuid`
      )[0];
      if (!connection)
        return reply.code(404).send({
          error: {
            code: "connection_not_found",
            message: "Connection not found",
          },
        });
      const inserted = await sql<
        Row[]
      >`INSERT INTO bitrix_open_channel_events(organization_id,integration_connection_id,provider_event_key,event_type,payload) VALUES(${org}::uuid,${r.params.id}::uuid,${b.eventKey},'operator.message',${sql.json(b as never)}) ON CONFLICT(integration_connection_id,provider_event_key) DO NOTHING RETURNING id`;
      return {
        data: { accepted: Boolean(inserted[0]), duplicate: !inserted[0] },
      };
    },
  );

  app.get(
    "/api/v1/retention",
    { preHandler: options.authorize("retention:read") },
    async (r) => ({
      data:
        (
          await sql<
            Row[]
          >`SELECT * FROM organization_retention_settings WHERE organization_id=${r.claims!.organizationId}::uuid`
        )[0] ?? null,
    }),
  );
  app.post(
    "/api/v1/retention/dry-run",
    { preHandler: options.authorize("retention:manage") },
    async (r) => {
      const rows = await sql<
        Row[]
      >`WITH s AS(SELECT coalesce(media_retention_days,180) days,coalesce(legal_hold,false) hold FROM organization_retention_settings WHERE organization_id=${r.claims!.organizationId}::uuid),c AS(SELECT count(*)::int count FROM message_attachments,s WHERE organization_id=${r.claims!.organizationId}::uuid AND NOT s.hold AND deleted_at IS NULL AND created_at<now()-(s.days*interval '1 day')) INSERT INTO retention_jobs(organization_id,job_type,dry_run,status,eligible_count,completed_at) SELECT ${r.claims!.organizationId}::uuid,'retention.media',true,'completed',count,now() FROM c RETURNING *`;
      return { data: rows[0] };
    },
  );
  app.post(
    "/api/v1/retention/run",
    { preHandler: options.authorize("retention:manage") },
    async (r, reply) => {
      const settings = (
        await sql<
          Row[]
        >`SELECT legal_hold,automatic_purge_enabled FROM organization_retention_settings WHERE organization_id=${r.claims!.organizationId}::uuid`
      )[0];
      if (settings?.legal_hold)
        return reply.code(409).send({
          error: { code: "legal_hold", message: "Legal hold is active" },
        });
      const rows = await sql<
        Row[]
      >`INSERT INTO retention_jobs(organization_id,job_type,dry_run,status) VALUES(${r.claims!.organizationId}::uuid,'retention.media',false,'pending') RETURNING *`;
      return reply.code(202).send({ data: rows[0] });
    },
  );
  app.get("/health/live", async () => ({ status: "ok", service: "api" }));
  app.get("/health/ready", async (_, reply) => {
    // Only Postgres blocks readiness (it's a hard dependency for nearly
    // every request). Redis/object storage/the malware scanner are
    // reported for observability but never fail the deploy's healthcheck
    // gate on their own -- a transient hiccup in any one of them (e.g. a
    // fresh container's first Redis PING outracing a cold connection)
    // must not take the whole API offline for every route that doesn't
    // even touch that dependency.
    try {
      await sql`SELECT 1`;
    } catch {
      return reply.code(503).send({ status: "down" });
    }
    const [redis, storage, malwareScanner] = await Promise.all([
      checkRedis(),
      options.storage.healthCheck(),
      options.malwareScanner.healthCheck(),
    ]);
    const fullyHealthy =
      redis.healthy && storage.healthy && malwareScanner.healthy;
    return reply.code(200).send({
      status: fullyHealthy ? "ready" : "degraded",
      dependencies: {
        postgresql: "ok",
        redis,
        objectStorage: storage,
        malwareScanner,
      },
    });
  });
  app.get(
    "/health/dependencies",
    { preHandler: options.authorize("operations:health:read") },
    async (_, reply) => {
      const [redis, objectStorage, malwareScanner] = await Promise.all([
        checkRedis(),
        options.storage.healthCheck(),
        options.malwareScanner.healthCheck(),
      ]);
      return reply.code(redis.healthy ? 200 : 503).send({
        status: redis.healthy ? "ok" : "degraded",
        dependencies: {
          postgresql: "ok",
          redis,
          objectStorage,
          mediaWorker: "configured",
          messageWorker: "configured",
          crmWorker: "configured",
          automationWorker: "configured",
          metaCapability: "configured",
          bitrixCapability: "configured",
          openChannels: "fake-ready",
          malwareScanner,
          realtime: "configured",
        },
      });
    },
  );
  app.get("/metrics", async (r, reply) => {
    const providedMetricsKey = r.headers["x-metrics-api-key"];
    if (
      !options.metricsApiKey ||
      typeof providedMetricsKey !== "string" ||
      !safeEqual(providedMetricsKey, options.metricsApiKey)
    )
      return reply.code(403).send("forbidden");
    const rows = await sql<
      Row[]
    >`SELECT metric_name,label_key,metric_value FROM operational_metrics`;
    reply.type("text/plain; version=0.0.4");
    const databaseMetrics =
      [
        "# HELP brixchat_info Brixchat24 operational metrics",
        "# TYPE brixchat_info gauge",
        "brixchat_info 1",
        ...rows.map(
          (x) =>
            `${x.metric_name}${x.label_key ? `{${x.label_key}}` : ""} ${x.metric_value}`,
        ),
      ].join("\n") + "\n";
    return databaseMetrics + (options.runtimeMetrics?.() ?? "");
  });
}

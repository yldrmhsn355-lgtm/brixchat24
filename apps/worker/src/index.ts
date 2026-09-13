import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import {
  resolveAutomationRuntimeConfig,
  resolveServiceDatabaseUrl,
  resolveWorkerHealthPort,
} from "@brixchat/config";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import IORedis from "ioredis";
import sharp from "sharp";
import {
  AiWorkerRepository,
  BillingRepository,
  CampaignRepository,
  classifyDeliveryFailure,
  CrmWorkerRepository,
  WorkerRepository,
  type ClaimedCrmJob,
  type ClaimedCrmWebhook,
} from "@brixchat/database";
import {
  processAiKnowledgeDocument,
  processAiRunRequest,
  type AiOrchestratorDeps,
} from "./ai-orchestrator";
import {
  Bitrix24Provider,
  BitrixError,
  BitrixRestClient,
  type StoredBitrixTokens,
  FakeBitrix24Provider,
  bitrixEventEntityReference,
  createMessagingProvider,
  decryptSecret,
  deterministicEventKey,
  encryptSecret,
  normalizePhone,
  matchOpenChannelsCustomerToExistingCrm,
  openChannelsCustomerLockKey,
  resolveReusableCustomerLinks,
  resolveOpenChannelsAutoCrmSettings,
  syncOpenChannelsCustomerToCrm,
  resolveOpenChannelsLeadResponsibleOverride,
  resolveTemplateVariables,
  ProviderError,
  retryDelay,
  crmRetryDelay,
  type CrmProvider,
  type FakeBitrixScenario,
  type TemplateVariableMapping,
  createObjectStorageProvider,
  createMalwareScanner,
  detectMediaMime,
  mediaLimitBytes,
  prepareWhatsAppAudio,
  storageKey,
  mediaRetryDelay,
  objectStorageLocation,
  scanStoredObject,
  evaluateCondition,
  loopAllowed,
  FakeBitrixOpenChannelsConnector,
  BitrixRestOpenChannelsConnector,
  bothModeTimelinePolicy,
  OpenChannelsError,
  shouldFallbackToDirectCrmLead,
  validateProductionConfig,
  metaWebhookFieldFromEventType,
  metaWebhookRealtimeEventType,
  normalizeMetaWebhookField,
  normalizeTemplateName,
  GoogleDriveAdapter,
  FolderPolicyService,
  StorageProviderError,
  refreshGoogleAccessToken,
} from "@brixchat/integrations";
import {
  mediaCleanupRequired,
  mediaObjectCleanupFailureDisposition,
  mediaProcessingFailureDisposition,
  mediaStoredClean,
  outboundMediaNeedsCleanAttachment,
} from "./media-safety";
import {
  probeWorkerHealth,
  resolvePositiveMilliseconds,
} from "./worker-health";
import { metaMessageContent } from "./meta-message-content";
import { WhatsAppWebRuntime } from "./whatsapp-web-runtime";
import { downloadWhatsAppWebMedia } from "@brixchat/whatsapp-web";
import { bitrixTimelineComment } from "./bitrix-timeline-comment";
import { bitrixTimelineFilename } from "./bitrix-timeline-attachment";
import { downloadInboundMedia } from "./inbound-media-source";
import {
  automationActionConfigError,
  bitrixDeliveryFailureBlockReason,
  automationFailureDecision,
  redactedAutomationError,
} from "./automation-runtime";
import {
  planCompiledAutomation,
  type PlannedAutomationAction,
} from "./automation-plan";
import { workerBitrixRequestPolicy } from "./bitrix-request-policy";
import { scanPlatformAlerts } from "./platform-alerts";

const database = resolveServiceDatabaseUrl(process.env, "worker");
const databaseUrl = database.url;
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6381";
const automationRuntimeConfig = resolveAutomationRuntimeConfig(process.env);
const encryptionKey =
  process.env.APP_ENCRYPTION_KEY ??
  (process.env.APP_ENCRYPTION_KEY_FILE
    ? readFileSync(process.env.APP_ENCRYPTION_KEY_FILE, "utf8").trim()
    : undefined);
const googleTokenEncryptionKey =
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY ??
  (process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_FILE
    ? readFileSync(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_FILE, "utf8").trim()
    : encryptionKey);
const bitrixClientId = process.env.BITRIX24_CLIENT_ID;
const bitrixClientSecret = process.env.BITRIX24_CLIENT_SECRET;
const workerId = `worker-${crypto.randomUUID()}`;
const sql = postgres(databaseUrl, {
  max: Number(process.env.WORKER_DATABASE_POOL_MAX ?? 5),
});
const repository = new WorkerRepository(sql);
const crmRepository = new CrmWorkerRepository(sql);
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: 1 });
const production =
  (process.env.APP_ENV ?? process.env.NODE_ENV) === "production";
if (production) {
  const checks = validateProductionConfig(
    {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ...(encryptionKey ? { APP_ENCRYPTION_KEY: encryptionKey } : {}),
    },
    { scope: "worker" },
  ).checks;
  const fatal = checks.filter((check) => check.status === "fatal");
  if (fatal.length) {
    process.stderr.write(
      JSON.stringify({
        level: "fatal",
        event: "configuration.invalid",
        checks: fatal,
      }) + "\n",
    );
    process.exit(1);
  }
  if (database.source === "DATABASE_URL")
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        event: "configuration.database_role_fallback",
        service: "worker",
        source: database.source,
      }) + "\n",
    );
}
const messagingMode =
  process.env.MESSAGING_PROVIDER_MODE ?? (production ? "meta" : "fake");
if (production && messagingMode !== "meta")
  throw new Error("MESSAGING_PROVIDER_MODE_MUST_BE_META_IN_PRODUCTION");
const provider = createMessagingProvider({
  mode: messagingMode === "meta" ? "meta" : "fake",
  fakeMode:
    (process.env.FAKE_PROVIDER_MODE as
      "success" | "temporary_error" | "permanent_error" | undefined) ??
    "success",
  apiVersion: process.env.META_WHATSAPP_API_VERSION ?? "v25.0",
});
const storage = createObjectStorageProvider(
  process.env,
  process.env.API_PUBLIC_URL ?? "http://localhost:4400",
  encryptionKey ?? "local-media-signing-secret",
);
const storageLocation = objectStorageLocation(process.env);
const scanner = createMalwareScanner(process.env);

let stopping = false;
let healthy = true;
let processedTicks = 0;
let failedTicks = 0;
let lastTickAt = Date.now();
let nextTemplateSyncScanAt = 0;
const templateSyncIntervalMs = Math.max(
  60_000,
  Number(process.env.TEMPLATE_SYNC_INTERVAL_MS ?? 15 * 60_000),
);
const workerHealthDependencyTimeoutMs = resolvePositiveMilliseconds(
  process.env.WORKER_HEALTH_DEPENDENCY_TIMEOUT_MS,
  2_500,
);
const workerHealthMaxTickAgeMs = resolvePositiveMilliseconds(
  process.env.WORKER_HEALTH_MAX_TICK_AGE_MS,
  60_000,
);
const pendingMessageStatusRetentionHours = Math.min(
  720,
  Math.max(
    24,
    Number(process.env.PENDING_MESSAGE_STATUS_RETENTION_HOURS ?? 72) || 72,
  ),
);

async function publish(
  organizationId: string,
  eventType: string,
  entityId: string,
  conversationId: string,
  payload: Record<string, unknown>,
) {
  return redis.publish(
    `brixchat:${organizationId}`,
    JSON.stringify({
      eventId: crypto.randomUUID(),
      eventType,
      organizationId,
      entityType: eventType.startsWith("message") ? "message" : "conversation",
      entityId,
      conversationId,
      occurredAt: new Date().toISOString(),
      payloadVersion: 1,
      payload,
    }),
  );
}

const whatsappWebRuntime =
  process.env.WHATSAPP_WEB_ENABLED === "true" && encryptionKey
    ? new WhatsAppWebRuntime({
        sql,
        repository,
        encryptionKey,
        workerId,
        publish,
        onInboundStored: projectInboundMessage,
      })
    : null;

async function projectInboundMessage(
  organizationId: string,
  result: {
    created: boolean;
    messageId: string | null;
    conversationId: string;
    conversationCreated: boolean;
  },
) {
  if (!result.created || !result.messageId) return;
  await crmRepository.enqueueTimeline({
    organizationId,
    messageId: result.messageId,
    conversationId: result.conversationId,
  });
  if (result.conversationCreated) {
    await publish(
      organizationId,
      "conversation.created",
      result.conversationId,
      result.conversationId,
      {},
    );
  }
  await publish(
    organizationId,
    "message.created",
    result.messageId,
    result.conversationId,
    {
      messageId: result.messageId,
    },
  );
}

async function processOutbox() {
  const job = await repository.claimOutbox(workerId);
  if (!job) return;
  const context = await repository.deliveryContext(job);
  if (!context) {
    await repository.fail(job, {
      code: "MESSAGE_CONTEXT_NOT_FOUND",
      retryable: false,
      delay: null,
    });
    return;
  }

  let deliveryCompleted = false;
  let campaignAttemptStarted = false;
  try {
    const deliveryProvider =
      context.provider === "whatsapp_web"
        ? null
        : createMessagingProvider({
            provider: context.provider,
            platform: context.platform,
            allowDevelopmentFake: !production,
            fakeMode:
              (process.env.FAKE_PROVIDER_MODE as
                | "success"
                | "temporary_error"
                | "permanent_error"
                | undefined) ?? "success",
            apiVersion: process.env.META_WHATSAPP_API_VERSION ?? "v25.0",
          });
    if (outboundMediaNeedsCleanAttachment(context))
      throw new ProviderError(
        "MEDIA_NOT_READY",
        true,
        "A clean stored attachment is required before delivery",
      );
    let storedAccessToken: string | undefined;
    if (context.credentialsEncrypted && encryptionKey) {
      try {
        const credentials = JSON.parse(
          decryptSecret(context.credentialsEncrypted, encryptionKey),
        ) as { accessToken?: unknown };
        if (typeof credentials.accessToken === "string")
          storedAccessToken = credentials.accessToken;
      } catch {
        throw new ProviderError(
          "PROVIDER_CREDENTIALS_INVALID",
          false,
          "Stored credentials cannot be decrypted",
        );
      }
    }
    const accessToken =
      storedAccessToken ?? process.env.META_WHATSAPP_ACCESS_TOKEN;
    const common = {
      channelId: context.channelId,
      phoneNumberId: context.phoneNumberId,
      recipient: context.recipient,
      idempotencyKey: context.clientMessageId,
      ...(accessToken ? { accessToken } : {}),
    };
    const attachment = context.attachment;
    if (
      context.metadata.campaignId &&
      !(await new CampaignRepository(sql).beginDelivery(
        job.organizationId,
        job.messageId,
      ))
    )
      throw new ProviderError(
        "CAMPAIGN_DELIVERY_BLOCKED_OR_UNCERTAIN",
        false,
        "Campaign delivery is blocked or a previous provider attempt needs review",
      );
    campaignAttemptStarted = Boolean(context.metadata.campaignId);
    const result =
      context.provider === "whatsapp_web"
        ? await (async () => {
            if (!whatsappWebRuntime)
              throw new ProviderError(
                "WHATSAPP_WEB_RUNTIME_DISABLED",
                true,
                "WhatsApp Web runtime is disabled",
              );
            if (!attachment)
              return whatsappWebRuntime.sendText({
                channelId: context.channelId,
                recipient: context.recipient,
                text: context.text,
                ...(Array.isArray(context.metadata.mentionedJids)
                  ? {
                      mentionedJids: context.metadata.mentionedJids.filter(
                        (jid): jid is string => typeof jid === "string",
                      ),
                    }
                  : {}),
              });
            const source = Readable.fromWeb(
              (await storage.getObject({
                key: attachment.storageKey,
              })) as never,
            );
            const chunks: Buffer[] = [];
            for await (const chunk of source)
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const media = await prepareWhatsAppAudio({ bytes: Buffer.concat(chunks), mimeType: attachment.mimeType, filename: attachment.filename });
            return whatsappWebRuntime.sendMedia({
              channelId: context.channelId,
              recipient: context.recipient,
              ...media,
              ...(context.text !== attachment.filename
                ? { caption: context.text }
                : {}),
            });
          })()
        : attachment
          ? await (async () => {
              const source = Readable.fromWeb(
                (await storage.getObject({
                  key: attachment.storageKey,
                })) as never,
              );
              const chunks: Buffer[] = [];
              for await (const chunk of source)
                chunks.push(
                  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                );
              const media = await prepareWhatsAppAudio({ bytes: Buffer.concat(chunks), mimeType: attachment.mimeType, filename: attachment.filename });
              const uploaded = await deliveryProvider!.uploadMedia({
                phoneNumberId: context.phoneNumberId,
                contentType: media.mimeType,
                filename: media.filename,
                bytes: media.bytes,
                ...(accessToken ? { accessToken } : {}),
              });
              return deliveryProvider!.sendMedia({
                ...common,
                mediaType: (["image", "video", "audio"].includes(
                  attachment.type,
                )
                  ? attachment.type
                  : "document") as "image" | "video" | "audio" | "document",
                mediaId: uploaded.mediaId,
                filename: media.filename,
                ...(context.text !== attachment.filename
                  ? { caption: context.text }
                  : {}),
              });
            })()
          : context.messageType === "template"
            ? await deliveryProvider!.sendTemplate({
                ...common,
                templateName: String(context.metadata.templateName),
                language: String(context.metadata.language),
                variables: Array.isArray(context.metadata.orderedVariables)
                  ? context.metadata.orderedVariables.map(String)
                  : [],
                ...(Array.isArray(context.metadata.variableResolution)
                  ? {
                      componentParameters: context.metadata.variableResolution
                        .filter(
                          (
                            item,
                          ): item is {
                            key: string;
                            value: string;
                          } =>
                            typeof item === "object" &&
                            item !== null &&
                            typeof (item as { key?: unknown }).key ===
                              "string" &&
                            typeof (item as { value?: unknown }).value ===
                              "string",
                        )
                        .map((item) => {
                          const [component, rawPosition] = item.key.split(".");
                          return {
                            component: component ?? "body",
                            position: Number(rawPosition ?? 0),
                            value: item.value,
                          };
                        }),
                    }
                  : {}),
              })
            : context.messageType === "interactive"
              ? await deliveryProvider!.sendInteractive({
                  ...common,
                  interactive:
                    context.metadata.interactive &&
                    typeof context.metadata.interactive === "object"
                      ? (context.metadata.interactive as Record<
                          string,
                          unknown
                        >)
                      : {},
                })
              : context.messageType === "reaction"
                ? await deliveryProvider!.sendReaction({
                    ...common,
                    messageId: String(context.metadata.messageId),
                    emoji: context.text,
                  })
                : await deliveryProvider!.sendMessage({
                    ...common,
                    text: context.text,
                    ...(typeof context.metadata.replyToMessageId === "string"
                      ? { replyToMessageId: context.metadata.replyToMessageId }
                      : {}),
                  });
    const finalStatus = await repository.complete(
      job,
      result.providerMessageId,
    );
    deliveryCompleted = true;
    if (
      context.metadata.origin === "bitrix_open_channels" &&
      typeof context.metadata.bitrixConnectionId === "string"
    )
      await sql`INSERT INTO bitrix_open_channel_jobs(organization_id,integration_connection_id,conversation_id,local_message_id,job_type,idempotency_key,payload)
        SELECT ${job.organizationId}::uuid,binding.integration_connection_id,
          ${context.conversationId}::uuid,${job.messageId}::uuid,
          'open_channels.delivery',${`delivery:${job.messageId}`},
          ${sql.json({ providerMessageId: result.providerMessageId } as never)}
            || jsonb_build_object('bindingId',binding.id)
        FROM bitrix_open_channel_bindings binding
        WHERE binding.integration_connection_id=${context.metadata.bitrixConnectionId}::uuid
          AND binding.organization_id=${job.organizationId}::uuid
          AND binding.brixchat_channel_id=${context.channelId}::uuid
          AND binding.status='active'
          AND COALESCE((binding.settings->>'deliveryStatusSync')::boolean,true)=true
        ON CONFLICT(integration_connection_id,idempotency_key) DO NOTHING`;
    await publish(
      job.organizationId,
      "message.status_changed",
      job.messageId,
      context.conversationId,
      {
        status: finalStatus,
        providerMessageId: result.providerMessageId,
      },
    );
  } catch (error) {
    if (deliveryCompleted) {
      process.stderr.write(
        JSON.stringify({
          level: "error",
          event: "message.post_delivery_projection_failed",
          messageId: job.messageId,
        }) + "\n",
      );
      return;
    }
    const normalized = campaignAttemptStarted
      ? new ProviderError(
          "CAMPAIGN_DELIVERY_UNCERTAIN",
          false,
          "Provider attempt was not confirmed; review delivery before sending again",
        )
      : error instanceof ProviderError
        ? error
        : new ProviderError("PROVIDER_UNKNOWN", true, "Unknown provider error");
    const failure = classifyDeliveryFailure({ errorCode: normalized.code });
    await repository.fail(job, {
      code: normalized.code,
      retryable: context.metadata.campaignId ? false : normalized.retryable,
      delay: retryDelay(job.attemptCount),
      message: normalized.message,
    });
    await publish(
      job.organizationId,
      "message.status_changed",
      job.messageId,
      context.conversationId,
      {
        status:
          normalized.retryable && !context.metadata.campaignId
            ? "pending"
            : "failed",
        errorCode: failure.errorCode,
        failureCategory: failure.category,
        customerRelated: failure.customerRelated,
        automationEligible: failure.automationEligible,
      },
    );
  }
}

type MetaMessage = {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: Record<string, unknown>;
  document?: Record<string, unknown>;
  audio?: Record<string, unknown>;
  video?: Record<string, unknown>;
  sticker?: Record<string, unknown>;
  reaction?: { emoji?: string; message_id?: string };
  context?: { id?: string; from?: string; referred_product?: unknown };
  location?: Record<string, unknown>;
  contacts?: unknown[];
  telegram?: { chatId?: string; username?: string | null };
};
type MetaStatus = {
  id?: string;
  status?: string;
  timestamp?: string;
  errors?: unknown[];
};

function changes(
  payload: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const entries = Array.isArray(payload.changes) ? payload.changes : [];
  return entries.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null,
  );
}

async function processScheduledTemplateSync() {
  if (Date.now() < nextTemplateSyncScanAt) return;
  nextTemplateSyncScanAt =
    Date.now() + Math.min(templateSyncIntervalMs, 60_000);
  const channels = await sql<Array<Record<string, unknown>>>`
    SELECT ch.*,coalesce(pa.encrypted_credentials,ch.credentials_encrypted) resolved_credentials_encrypted
    FROM channels ch
    LEFT JOIN provider_accounts pa
      ON pa.id=ch.provider_account_id
      AND pa.organization_id=ch.organization_id
      AND pa.archived_at IS NULL
    WHERE ch.deleted_at IS NULL
      AND ch.status='connected'
      AND coalesce(ch.connection_status,'ACTIVE')='ACTIVE'
      AND ch.business_account_id IS NOT NULL
      AND NOT EXISTS(
        SELECT 1 FROM template_sync_runs running
        WHERE running.channel_id=ch.id
          AND running.status='running'
          AND running.started_at>now()-interval '30 minutes'
      )
      AND NOT EXISTS(
        SELECT 1 FROM template_sync_runs recent
        WHERE recent.channel_id=ch.id
          AND recent.status='completed'
          AND recent.completed_at>
            now()-(${templateSyncIntervalMs}::bigint*interval '1 millisecond')
      )
    ORDER BY (
      SELECT max(completed_at) FROM template_sync_runs previous
      WHERE previous.channel_id=ch.id AND previous.status='completed'
    ) NULLS FIRST
    LIMIT 1`;
  const channel = channels[0];
  if (!channel) return;

  const organizationId = String(channel.organization_id);
  const channelId = String(channel.id);
  const businessAccountId = String(channel.business_account_id);
  const bucket = Math.floor(Date.now() / templateSyncIntervalMs);
  const idempotencyKey = `periodic:${channelId}:${bucket}`;
  const runs = await sql<Array<{ id: string }>>`
    INSERT INTO template_sync_runs(
      organization_id,channel_id,business_account_id,idempotency_key,status
    ) VALUES(
      ${organizationId}::uuid,${channelId}::uuid,${businessAccountId},
      ${idempotencyKey},'running'
    )
    ON CONFLICT DO NOTHING
    RETURNING id`;
  const runId = runs[0]?.id;
  if (!runId) return;

  try {
    let accessToken: string | undefined;
    if (channel.resolved_credentials_encrypted && encryptionKey) {
      const decrypted = JSON.parse(
        decryptSecret(
          String(channel.resolved_credentials_encrypted),
          encryptionKey,
        ),
      ) as { accessToken?: unknown };
      if (typeof decrypted.accessToken === "string")
        accessToken = decrypted.accessToken;
    }
    const channelProvider = createMessagingProvider({
      provider: String(channel.provider),
      platform: String(channel.platform ?? "whatsapp"),
      allowDevelopmentFake: !production,
      fakeMode:
        (process.env.FAKE_PROVIDER_MODE as
          "success" | "temporary_error" | "permanent_error" | undefined) ??
        "success",
      apiVersion: process.env.META_WHATSAPP_API_VERSION ?? "v25.0",
    });
    const templates = await channelProvider.listTemplates({
      businessAccountId,
      ...(accessToken ? { accessToken } : {}),
    });
    const seen: string[] = [];
    let created = 0;
    let updated = 0;
    for (const item of templates) {
      const normalizedName = normalizeTemplateName(item.name);
      const family = await sql<Array<{ id: string }>>`
        INSERT INTO message_template_families(
          organization_id,business_account_id,normalized_name,default_language
        ) VALUES(
          ${organizationId}::uuid,${businessAccountId},${normalizedName},
          ${item.language}
        )
        ON CONFLICT(organization_id,business_account_id,normalized_name)
        DO UPDATE SET updated_at=now()
        RETURNING id`;
      const rows = await sql<Array<{ id: string; inserted: boolean }>>`
        INSERT INTO message_templates(
          organization_id,channel_id,business_account_id,family_id,provider,
          provider_template_id,name,normalized_name,language,category,status,
          quality_score,rejection_reason,header_type,header_text,body_text,
          footer_text,buttons,components,parameter_format,provider_payload,
          last_synced_at
        ) VALUES(
          ${organizationId}::uuid,${channelId}::uuid,${businessAccountId},
          ${family[0]!.id}::uuid,${String(channel.provider)},
          ${item.providerTemplateId},${item.name},${normalizedName},
          ${item.language},${item.category},${item.status},
          ${item.qualityScore ?? null},${item.rejectionReason ?? null},
          ${item.headerType ?? null},${item.headerText ?? null},${item.bodyText},
          ${item.footerText ?? null},${sql.json((item.buttons ?? []) as never)},
          ${sql.json((item.components ?? []) as never)},
          ${item.parameterFormat ?? "positional"},
          ${sql.json(item.providerPayload as never)},now()
        )
        ON CONFLICT(
          organization_id,business_account_id,normalized_name,language
        ) WHERE business_account_id IS NOT NULL
            AND normalized_name IS NOT NULL
            AND deleted_at IS NULL
        DO UPDATE SET
          family_id=EXCLUDED.family_id,
          provider_template_id=EXCLUDED.provider_template_id,
          previous_category=CASE
            WHEN message_templates.category<>EXCLUDED.category
            THEN message_templates.category
            ELSE message_templates.previous_category
          END,
          category=EXCLUDED.category,status=EXCLUDED.status,
          quality_score=EXCLUDED.quality_score,
          rejection_reason=EXCLUDED.rejection_reason,
          header_type=EXCLUDED.header_type,header_text=EXCLUDED.header_text,
          body_text=EXCLUDED.body_text,footer_text=EXCLUDED.footer_text,
          buttons=EXCLUDED.buttons,components=EXCLUDED.components,
          parameter_format=EXCLUDED.parameter_format,
          provider_payload=EXCLUDED.provider_payload,last_synced_at=now(),
          updated_at=now(),version=message_templates.version+1
        RETURNING id,(xmax=0) inserted`;
      const templateId = rows[0]!.id;
      seen.push(templateId);
      if (rows[0]!.inserted) created++;
      else updated++;
      await sql`INSERT INTO message_template_channels(organization_id,template_id,channel_id) VALUES(${organizationId}::uuid,${templateId}::uuid,${channelId}::uuid) ON CONFLICT DO NOTHING`;
      await sql`DELETE FROM message_template_components WHERE template_id=${templateId}::uuid`;
      for (const [position, component] of (item.components ?? []).entries())
        await sql`INSERT INTO message_template_components(template_id,component_type,position,payload) VALUES(${templateId}::uuid,${String(component.type ?? "UNKNOWN").toLowerCase()},${position},${sql.json(component as never)})`;
      await sql`DELETE FROM message_template_variables WHERE template_id=${templateId}::uuid`;
      for (const variable of item.variables)
        await sql`INSERT INTO message_template_variables(template_id,component,position,variable_name,internal_key,example_value,source,required,missing_policy) VALUES(${templateId}::uuid,${variable.component},${variable.position},${variable.variableName},${variable.variableName},${variable.exampleValue ?? null},'provider',true,'manual')`;
    }
    const archived = await sql`
      UPDATE message_templates SET status='archived',updated_at=now()
      WHERE organization_id=${organizationId}::uuid
        AND business_account_id=${businessAccountId}
        AND provider_template_id IS NOT NULL
        AND NOT(id=ANY(${seen}::uuid[]))
        AND status<>'archived' AND deleted_at IS NULL
      RETURNING id`;
    await sql`UPDATE template_sync_runs SET status='completed',templates_received=${templates.length},templates_created=${created},templates_updated=${updated},templates_archived=${archived.length},pages_received=1,completed_at=now() WHERE id=${runId}::uuid`;
    await sql`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata) VALUES(${organizationId}::uuid,null,'template.sync_completed','channel',${channelId}::uuid,${sql.json({ source: "periodic", received: templates.length, created, updated, archived: archived.length } as never)})`;
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "template_sync_failed";
    await sql`UPDATE template_sync_runs SET status='failed',last_error=${code},error_details=${sql.json({ code, source: "periodic" } as never)},completed_at=now() WHERE id=${runId}::uuid`;
    await sql`INSERT INTO notifications(organization_id,user_id,type,title,body,metadata) VALUES(${organizationId}::uuid,null,'template.sync_failed','WhatsApp Şablon Senkronizasyonu Başarısız',${`Kanal şablonları otomatik olarak senkronize edilemedi: ${code}`},${sql.json({ channelId, runId, code, source: "periodic" } as never)})`;
  }
}

const templateWebhookFields = new Set([
  "message_template_components_update",
  "message_template_quality_update",
  "message_template_status_update",
  "template_category_update",
  "template_correct_category_detection",
]);

async function projectTemplateWebhook(input: {
  organizationId: string;
  channelId: string;
  eventKey: string;
  field: string;
  value: Record<string, unknown>;
}) {
  if (!templateWebhookFields.has(input.field)) return null;
  const providerTemplateId =
    typeof input.value.message_template_id === "string"
      ? input.value.message_template_id
      : typeof input.value.id === "string"
        ? input.value.id
        : null;
  const name =
    typeof input.value.message_template_name === "string"
      ? input.value.message_template_name
      : typeof input.value.name === "string"
        ? input.value.name
        : null;
  const language =
    typeof input.value.message_template_language === "string"
      ? input.value.message_template_language
      : typeof input.value.language === "string"
        ? input.value.language
        : null;
  const eventKey = deterministicEventKey({
    eventKey: input.eventKey,
    field: input.field,
    providerTemplateId,
    value: input.value,
  });
  const channelRows = await sql<
    Array<{ business_account_id: string | null }>
  >`SELECT business_account_id FROM channels WHERE id=${input.channelId}::uuid AND organization_id=${input.organizationId}::uuid`;
  const businessAccountId =
    channelRows[0]?.business_account_id ?? `channel:${input.channelId}`;
  const inserted = await sql`
    INSERT INTO template_webhook_events(
      organization_id,business_account_id,provider_event_key,field,
      provider_template_id,payload,status,processed_at
    ) VALUES(
      ${input.organizationId}::uuid,${businessAccountId},${eventKey},
      ${input.field},${providerTemplateId},${sql.json(input.value as never)},
      'processed',now()
    ) ON CONFLICT(organization_id,provider_event_key) DO NOTHING
    RETURNING id`;
  if (!inserted[0]) return { duplicate: true };

  const statusValue = [
    input.value.event,
    input.value.status,
    input.value.new_status,
  ].find((value): value is string => typeof value === "string");
  const qualityValue = [
    input.value.new_quality_score,
    input.value.quality_score,
    input.value.quality,
  ].find((value): value is string => typeof value === "string");
  const categoryValue = [
    input.value.correct_category,
    input.value.new_category,
    input.value.category,
  ].find((value): value is string => typeof value === "string");
  const rejectionReason = [
    input.value.reason,
    input.value.rejected_reason,
  ].find((value): value is string => typeof value === "string");
  const components = Array.isArray(input.value.components)
    ? input.value.components
    : null;
  const updated = await sql<Array<{ id: string }>>`
    UPDATE message_templates mt
    SET status=COALESCE(${statusValue?.toLowerCase() ?? null},mt.status),
        quality_score=COALESCE(${qualityValue ?? null},mt.quality_score),
        previous_category=CASE WHEN ${categoryValue ?? null}::text IS NOT NULL AND mt.category<>${categoryValue ?? null} THEN mt.category ELSE mt.previous_category END,
        category=COALESCE(${categoryValue ?? null},mt.category),
        rejection_reason=COALESCE(${rejectionReason ?? null},mt.rejection_reason),
        components=COALESCE(${components ? sql.json(components as never) : null}::jsonb,mt.components),
        provider_payload=mt.provider_payload || ${sql.json({ lastWebhook: input.value } as never)},
        version=mt.version+1,
        last_synced_at=now(),
        updated_at=now()
    WHERE mt.organization_id=${input.organizationId}::uuid
      AND mt.deleted_at IS NULL
      AND (
        (${providerTemplateId}::text IS NOT NULL AND mt.provider_template_id=${providerTemplateId})
        OR (
          ${providerTemplateId}::text IS NULL
          AND ${name}::text IS NOT NULL
          AND mt.normalized_name=${name}
          AND (${language}::text IS NULL OR mt.language=${language})
        )
      )
    RETURNING mt.id`;
  const templateId = updated[0]?.id;
  if (templateId) {
    const important =
      input.field !== "message_template_components_update" ||
      ["rejected", "paused", "disabled"].includes(
        statusValue?.toLowerCase() ?? "",
      );
    if (important)
      await sql`
        INSERT INTO notifications(organization_id,user_id,type,title,body,metadata)
        VALUES(
          ${input.organizationId}::uuid,null,${`template.${input.field}`},
          'WhatsApp ÅŸablon GÃ¼ncellemesi',
          ${
            statusValue
              ? `Åablon durumu ${statusValue} olarak gÃ¼ncellendi.`
              : qualityValue
                ? `Åablon kalite durumu ${qualityValue} olarak gÃ¼ncellendi.`
                : categoryValue
                  ? `Åablon kategorisi ${categoryValue} olarak gÃ¼ncellendi.`
                  : "WhatsApp ÅŸablonu Meta tarafÄ±ndan gÃ¼ncellendi."
          },
          ${sql.json({ templateId, field: input.field } as never)}
        )`;
  }
  return { duplicate: false, templateId: templateId ?? null };
}

async function processWebhook() {
  const event = await repository.claimWebhook();
  if (!event) return;

  // One malformed entry must not sink the other messages in the same
  // webhook payload; failures are collected and the event retries, with
  // provider_message_id idempotency skipping the already-ingested ones.
  const entryFailures: string[] = [];
  try {
    for (const change of changes(event.payload)) {
      const field = normalizeMetaWebhookField(
        change.field ?? metaWebhookFieldFromEventType(event.eventType),
      );
      const value = (change.value ?? {}) as Record<string, unknown>;
      await projectTemplateWebhook({
        organizationId: event.organizationId,
        channelId: event.channelId,
        eventKey: event.eventKey,
        field,
        value,
      });
      const contacts = Array.isArray(value.contacts)
        ? (value.contacts as Array<{
            wa_id?: string;
            profile?: { name?: string };
          }>)
        : [];

      for (const message of Array.isArray(value.messages)
        ? (value.messages as MetaMessage[])
        : []) {
        try {
          const phone = message.telegram?.chatId
            ? `telegram:${message.telegram.chatId}`
            : normalizePhone(message.from ?? contacts[0]?.wa_id ?? "");
          const type = message.type ?? "unsupported";
          const content = metaMessageContent(
            message as unknown as Record<string, unknown>,
            type,
          );
          const timestamp = new Date(
            Number(message.timestamp ?? Date.now() / 1000) * 1000,
          );
          const metadataValue = message[type as keyof MetaMessage];
          const rawMetadata =
            typeof metadataValue === "object" && metadataValue !== null
              ? (metadataValue as Record<string, unknown>)
              : {};
          const providerMetadata = message.telegram
            ? { ...rawMetadata, telegram: message.telegram }
            : rawMetadata;
          const context = message.context as { id?: unknown } | undefined;
          const metadata =
            context?.id && typeof context.id === "string"
              ? { ...providerMetadata, replyToMessageId: context.id }
              : type === "reaction" && message.reaction?.message_id
                ? {
                    ...providerMetadata,
                    reactionTargetMessageId: message.reaction.message_id,
                  }
                : providerMetadata;
          const result = await repository.incoming({
            organizationId: event.organizationId,
            channelId: event.channelId,
            phone,
            name: contacts[0]?.profile?.name ?? phone,
            text: content,
            type,
            providerMessageId: message.id ?? deterministicEventKey(message),
            providerTimestamp: timestamp,
            metadata,
            ...(message.telegram?.chatId
              ? {
                  contactCustomFields: {
                    telegramChatId: message.telegram.chatId,
                    telegramUsername: message.telegram.username ?? null,
                    whatsappWebPhoneResolved: false,
                  },
                }
              : {}),
            traceId: crypto.randomUUID(),
          });
          await projectInboundMessage(event.organizationId, result);
        } catch (error) {
          entryFailures.push(
            `message ${message.id ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      for (const status of Array.isArray(value.statuses)
        ? (value.statuses as MetaStatus[])
        : []) {
        try {
          if (
            !status.id ||
            !["sent", "delivered", "read", "failed"].includes(
              status.status ?? "",
            )
          )
            continue;
          const result = await repository.status({
            organizationId: event.organizationId,
            providerMessageId: status.id,
            status: status.status as "sent" | "delivered" | "read" | "failed",
            providerTimestamp: new Date(
              Number(status.timestamp ?? Date.now() / 1000) * 1000,
            ),
            eventKey: deterministicEventKey({
              event: event.eventKey,
              id: status.id,
              status: status.status,
              timestamp: status.timestamp,
            }),
            payload: status as Record<string, unknown>,
          });
          if (result?.messageId)
            await sql`
            UPDATE template_send_events
            SET status=${String(status.status)}
            WHERE organization_id=${event.organizationId}::uuid
              AND message_id=${result.messageId}::uuid`;
          if (
            result &&
            !result.duplicate &&
            result.messageId &&
            result.conversationId
          ) {
            await publish(
              event.organizationId,
              "message.status_changed",
              result.messageId,
              result.conversationId,
              {
                status: result.status,
                ...(result.errorCode
                  ? {
                      errorCode: result.errorCode,
                      failureCategory: result.failureCategory,
                      customerRelated: result.customerRelated,
                      automationEligible: result.automationEligible,
                    }
                  : {}),
              },
            );
          }
        } catch (error) {
          entryFailures.push(
            `status ${status.id ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (field !== "messages") {
        await publish(
          event.organizationId,
          metaWebhookRealtimeEventType(field),
          event.id,
          event.channelId,
          {
            field,
            channelId: event.channelId,
            eventKey: event.eventKey,
            valueKeys: Object.keys(value).slice(0, 32),
          },
        );
      }
    }
    if (entryFailures.length)
      throw new Error(
        `WEBHOOK_PARTIAL_FAILURE: ${entryFailures.join("; ").slice(0, 400)}`,
      );
    await repository.completeWebhook(event.id);
  } catch (error) {
    await repository.failWebhook(
      event.id,
      error instanceof Error ? error.message : "webhook_error",
    );
  }
}

type CrmConnection = Pick<
  ClaimedCrmJob,
  | "connectionId"
  | "authMode"
  | "portalUrl"
  | "credentialsEncrypted"
  | "settings"
>;

function bitrixRestClient(connection: CrmConnection) {
  if (!connection.credentialsEncrypted || !encryptionKey)
    throw new BitrixError("AUTH", false, "CRM credentials are not configured");
  const credentials = JSON.parse(
    decryptSecret(connection.credentialsEncrypted, encryptionKey),
  ) as {
    webhookUrl?: string;
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: string;
    clientEndpoint?: string;
    serverEndpoint?: string;
  };
  return new BitrixRestClient({
    // Worker jobs own retry/backoff and idempotency. Keeping provider-level
    // retries here could outlive the five-minute stale-lock window and let a
    // second worker claim the same job while the first request is still live.
    ...workerBitrixRequestPolicy,
    ...(credentials.webhookUrl ? { webhookUrl: credentials.webhookUrl } : {}),
    ...(connection.portalUrl ? { portalUrl: connection.portalUrl } : {}),
    ...(credentials.accessToken
      ? { accessToken: credentials.accessToken }
      : {}),
    ...(credentials.refreshToken
      ? { refreshToken: credentials.refreshToken }
      : {}),
    ...(credentials.accessTokenExpiresAt
      ? { accessTokenExpiresAt: credentials.accessTokenExpiresAt }
      : {}),
    ...(bitrixClientId ? { clientId: bitrixClientId } : {}),
    ...(bitrixClientSecret ? { clientSecret: bitrixClientSecret } : {}),
    onTokenRefresh: async (update) => {
      const encrypted = encryptSecret(
        JSON.stringify({
          ...credentials,
          accessToken: update.accessToken,
          ...(update.refreshToken ? { refreshToken: update.refreshToken } : {}),
          accessTokenExpiresAt: update.accessTokenExpiresAt,
          ...(update.clientEndpoint
            ? { clientEndpoint: update.clientEndpoint }
            : {}),
          ...(update.serverEndpoint
            ? { serverEndpoint: update.serverEndpoint }
            : {}),
        }),
        encryptionKey,
      );
      await crmRepository.updateConnectionCredentials(
        connection.connectionId,
        encrypted,
      );
    },
    withRefreshLock: async <T>(
      fn: (freshest: StoredBitrixTokens | null) => Promise<T>,
    ): Promise<T> =>
      sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`bitrix_token_refresh:${connection.connectionId}`},0))`;
        const stored = await tx<
          Array<Record<string, unknown>>
        >`SELECT credentials_encrypted FROM integration_connections WHERE id=${connection.connectionId}::uuid`;
        let freshest: StoredBitrixTokens | null = null;
        const encryptedCredentials = stored[0]?.credentials_encrypted;
        if (encryptedCredentials && encryptionKey) {
          try {
            const parsed = JSON.parse(
              decryptSecret(String(encryptedCredentials), encryptionKey),
            ) as {
              accessToken?: string;
              refreshToken?: string;
              accessTokenExpiresAt?: string;
            };
            freshest = {
              accessToken: parsed.accessToken ?? null,
              refreshToken: parsed.refreshToken ?? null,
              accessTokenExpiresAt: parsed.accessTokenExpiresAt ?? null,
            };
          } catch {
            freshest = null;
          }
        }
        return fn(freshest);
      }) as Promise<T>,
  });
}

function crmProvider(connection: CrmConnection): CrmProvider {
  if (connection.authMode === "fake")
    return new FakeBitrix24Provider(
      String(
        connection.settings.fakeScenario ?? "success",
      ) as FakeBitrixScenario,
    );
  return new Bitrix24Provider(
    bitrixRestClient(connection),
    connection.portalUrl ?? "",
  );
}

async function bitrixTimelineAttachments(context: Record<string, unknown>) {
  const maxBytes = Number(
    process.env.BITRIX_TIMELINE_FILE_MAX_BYTES ?? 10_000_000,
  );
  const attachments = Array.isArray(context.attachments)
    ? context.attachments
    : [];
  const files: Array<{ filename: string; contentBase64: string }> = [];
  for (const item of attachments.slice(0, 5)) {
    const attachment = (item ?? {}) as Record<string, unknown>;
    const storageKey = String(attachment.storageKey ?? "");
    const filename = bitrixTimelineFilename(
      String(attachment.filename ?? "whatsapp-attachment"),
      String(attachment.mimeType ?? "application/octet-stream"),
    );
    const storedSize = Number(attachment.size ?? 0);
    if (!storageKey || storedSize <= 0 || storedSize > maxBytes) continue;
    const source = Readable.fromWeb(
      (await storage.getObject({ key: storageKey })) as never,
    );
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes)
        throw new BitrixError(
          "VALIDATION",
          false,
          "Bitrix timeline attachment exceeds the configured size limit",
        );
      chunks.push(buffer);
    }
    files.push({
      filename,
      contentBase64: Buffer.concat(chunks).toString("base64"),
    });
  }
  return files;
}

async function processCrmJob() {
  const job = await crmRepository.claimJob(workerId);
  if (!job) return;
  try {
    const provider = crmProvider(job);
    if (job.jobType === "timeline.comment") {
      const context = await crmRepository.timelineContext(job);
      if (!context)
        throw new BitrixError(
          "NOT_FOUND",
          false,
          "CRM timeline context not found",
        );
      if (
        String(context.direction) === "outbound" &&
        String(context.status) === "pending"
      )
        throw new BitrixError(
          "TEMPORARY",
          true,
          "Outbound message is awaiting its provider result",
        );
      if (Number(context.pending_attachment_count ?? 0) > 0)
        throw new BitrixError(
          "TEMPORARY",
          true,
          "CRM timeline attachment is still processing",
        );
      const attachments = await bitrixTimelineAttachments(context);
      const result = await provider.addTimelineComment({
        entityType: String(context.entity_type) as
          "contact" | "lead" | "deal" | "company",
        externalId: String(context.external_id),
        text: bitrixTimelineComment(context),
        idempotencyKey: job.idempotencyKey,
        ...(attachments.length ? { attachments } : {}),
      });
      await crmRepository.complete(job, { externalId: result.externalId });
    } else if (job.jobType === "responsible.sync") {
      const context = await crmRepository.responsibleContext(job);
      if (!context)
        throw new BitrixError(
          "NOT_FOUND",
          false,
          "CRM responsible mapping not found",
        );
      await provider.updateResponsible({
        entityType: String(context.entity_type) as
          "contact" | "lead" | "deal" | "company",
        externalId: String(context.external_id),
        externalUserId: String(context.external_user_id),
        idempotencyKey: job.idempotencyKey,
      });
      await crmRepository.complete(job);
    } else if (job.jobType === "full.sync") {
      let cursor: string | undefined;
      let users = 0;
      do {
        const page = await provider.listUsers(cursor);
        for (const user of page.data) {
          await crmRepository.upsertCrmUser(job, user);
          users++;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const pipelines = await provider.listPipelines();
      await crmRepository.replacePipelines(job, pipelines);
      await crmRepository.complete(job, {
        users,
        pipelines: pipelines.length,
        stages: pipelines.reduce(
          (total, pipeline) => total + pipeline.stages.length,
          0,
        ),
      });
    } else if (job.jobType === "automation.send_whatsapp") {
      const payload = job.payload as {
        entityType?: string;
        entityId?: string;
        phone?: string;
        templateName?: string;
        channelId?: string | null;
        contactName?: string | null;
        variables?: Record<string, string>;
      };
      const channelId = payload.channelId || job.automationDefaultChannelId;
      if (!channelId)
        throw new BitrixError(
          "VALIDATION",
          false,
          "No WhatsApp channel configured for this connection's automation webhook",
        );
      const channelRows = await sql<
        Array<Record<string, unknown>>
      >`SELECT id FROM channels WHERE id=${channelId}::uuid AND organization_id=${job.organizationId}::uuid AND status='connected'`;
      if (!channelRows[0])
        throw new BitrixError(
          "VALIDATION",
          false,
          "Automation webhook channel is missing or disconnected",
        );
      let normalizedPhone: string;
      try {
        normalizedPhone = normalizePhone(String(payload.phone ?? ""));
      } catch {
        throw new BitrixError(
          "VALIDATION",
          false,
          "Automation webhook phone number is invalid",
        );
      }
      const { conversationId } = await repository.resolveConversationForPhone({
        organizationId: job.organizationId,
        channelId,
        phone: normalizedPhone,
        ...(payload.contactName ? { name: payload.contactName } : {}),
      });
      const templateRows = await sql<
        Array<Record<string, unknown>>
      >`SELECT mt.id FROM message_templates mt JOIN message_template_channels mtc ON mtc.template_id=mt.id AND mtc.channel_id=${channelId}::uuid WHERE mt.organization_id=${job.organizationId}::uuid AND mt.name=${String(payload.templateName ?? "")} AND mt.status='approved' AND mt.deleted_at IS NULL LIMIT 1`;
      const templateRow = templateRows[0];
      if (!templateRow)
        throw new BitrixError(
          "VALIDATION",
          false,
          `Approved WhatsApp template "${payload.templateName}" not found for this channel`,
        );
      const result = await executeAutomationTemplateAction({
        organizationId: job.organizationId,
        conversationId,
        ruleId: `bitrix_automation:${job.connectionId}`,
        runId: job.id,
        config: {
          templateId: String(templateRow.id),
          channelId,
          variableValues: payload.variables ?? {},
          requireOptIn: true,
        },
      });
      if (result.status === "completed")
        await crmRepository.complete(job, result);
      else
        throw new BitrixError(
          "VALIDATION",
          false,
          `Automation WhatsApp send blocked: ${String((result as { reason?: string }).reason ?? result.status)}`,
        );
    } else {
      const health = await provider.health();
      await crmRepository.complete(job, { healthy: health.healthy });
    }
  } catch (error) {
    const normalized =
      error instanceof BitrixError
        ? error
        : new BitrixError("TEMPORARY", true, "Unexpected CRM worker error");
    await crmRepository.fail(job, {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      delay: crmRetryDelay(job.attemptCount),
    });
  }
}

async function processCrmWebhook() {
  const item = await crmRepository.claimWebhook(workerId);
  if (!item) return;
  try {
    if (item.eventType.toUpperCase() === "ONAPPUNINSTALL") {
      await crmRepository.disconnectOnAppUninstall(item);
      await crmRepository.completeWebhook(item.id);
      return;
    }
    if (item.eventType.toUpperCase().startsWith("ONIMCONNECTOR"))
      await crmRepository.touchOpenChannelEvent(item);
    if (item.eventType.toUpperCase() === "ONIMCONNECTORMESSAGEADD")
      await crmRepository.processOperatorMessage(item);
    if (
      item.eventType.toUpperCase() === "ONIMCONNECTORDIALOGSTART" ||
      item.eventType.toUpperCase() === "ONIMCONNECTORDIALOGFINISH"
    )
      await crmRepository.processOpenChannelSessionEvent(item);
    if (
      item.eventType.toLowerCase().includes("update") &&
      item.settings.syncResponsible !== false
    ) {
      const reference = bitrixEventEntityReference(
        item.eventType,
        item.payload,
      );
      if (reference) {
        const context = await crmProvider(
          item as ClaimedCrmWebhook & CrmConnection,
        ).getContext(reference);
        if (context.responsible)
          await crmRepository.processResponsibleWebhook(item, {
            entityType: reference.entityType,
            externalId: reference.externalId,
            externalUserId: context.responsible.externalId,
          });
      }
    }
    await crmRepository.completeWebhook(item.id);
  } catch (error) {
    await crmRepository.failWebhook(
      item.id,
      error instanceof Error ? error.message : "crm_webhook_error",
    );
  }
}

let nextCrmFullSyncScheduleAt = 0;
async function scheduleCrmFullSync() {
  const now = Date.now();
  if (now < nextCrmFullSyncScheduleAt) return;
  nextCrmFullSyncScheduleAt =
    now + Number(process.env.CRM_FULL_SYNC_SCAN_INTERVAL_MS ?? 300_000);
  const intervalHours = Math.max(
    1,
    Number(process.env.CRM_FULL_SYNC_INTERVAL_HOURS ?? 24),
  );
  await sql`
    INSERT INTO crm_sync_jobs(
      organization_id,
      connection_id,
      job_type,
      aggregate_type,
      aggregate_id,
      idempotency_key,
      payload
    )
    SELECT
      c.organization_id,
      c.id,
      'full.sync',
      'connection',
      c.id,
      'scheduled-full-sync:' ||
        floor(extract(epoch FROM now()) / (${intervalHours}::double precision * 3600))::text,
      '{}'::jsonb
    FROM integration_connections c
    WHERE c.provider='bitrix24'
      AND c.status='connected'
      AND (
        c.last_sync_at IS NULL
        OR c.last_sync_at < now() - (${intervalHours}::double precision * interval '1 hour')
      )
    ON CONFLICT(connection_id,idempotency_key) DO NOTHING`;
}

let nextPendingMessageStatusCleanupAt = 0;
async function prunePendingMessageStatuses() {
  const now = Date.now();
  if (now < nextPendingMessageStatusCleanupAt) return;
  const deleted = await repository.pruneOrphanedPendingStatuses(
    pendingMessageStatusRetentionHours,
  );
  nextPendingMessageStatusCleanupAt = now + 60 * 60_000;
  if (deleted > 0)
    process.stdout.write(
      JSON.stringify({
        level: "info",
        event: "message_status.pending_orphans_pruned",
        deleted,
        retentionHours: pendingMessageStatusRetentionHours,
      }) + "\n",
    );
}

async function ensureInboundFileAsset(attachment: Record<string, unknown>) {
  if (
    process.env.GOOGLE_DRIVE_ENABLED !== "true" ||
    !attachment.storage_key ||
    !attachment.message_id
  )
    return;
  const connection = (
    await sql<
      Array<Record<string, unknown>>
    >`SELECT id FROM storage_connections WHERE organization_id=${String(attachment.organization_id)}::uuid AND provider='google_drive' AND status='connected' ORDER BY created_at LIMIT 1`
  )[0];
  if (!connection) return;
  const asset = (
    await sql<Array<Record<string, unknown>>>`INSERT INTO file_assets(
      organization_id,provider,provider_connection_id,internal_storage_key,
      contact_id,conversation_id,message_id,channel_id,whatsapp_message_id,
      provider_media_id,original_name,sanitized_name,mime_type,extension,
      size_bytes,checksum_sha256,category,direction,source,status,metadata
    ) VALUES(
      ${String(attachment.organization_id)}::uuid,'google_drive',${String(connection.id)}::uuid,
      ${String(attachment.storage_key)},${attachment.contact_id ? String(attachment.contact_id) : null}::uuid,
      ${attachment.conversation_id ? String(attachment.conversation_id) : null}::uuid,
      ${String(attachment.message_id)}::uuid,${attachment.channel_id ? String(attachment.channel_id) : null}::uuid,
      ${attachment.whatsapp_message_id ? String(attachment.whatsapp_message_id) : null},
      ${attachment.provider_media_id ? String(attachment.provider_media_id) : null},
      ${String(attachment.provider_filename ?? "attachment")},${String(attachment.provider_filename ?? "attachment")},
      ${String(attachment.stored_mime_type ?? attachment.provider_mime_type ?? "application/octet-stream")},
      ${String(attachment.provider_filename ?? "").includes(".") ? String(attachment.provider_filename).split(".").pop()!.toLowerCase() : null},
      ${attachment.stored_size == null ? null : Number(attachment.stored_size)},
      ${attachment.stored_sha256 ? String(attachment.stored_sha256) : null},
      'incoming_media','inbound','whatsapp','PENDING',
      ${sql.json({ attachmentId: attachment.id, traceId: attachment.trace_id ?? null } as never)}
    ) ON CONFLICT(organization_id,whatsapp_message_id,provider_media_id)
      WHERE whatsapp_message_id IS NOT NULL AND provider_media_id IS NOT NULL AND deleted_at IS NULL
      DO UPDATE SET internal_storage_key=COALESCE(file_assets.internal_storage_key,excluded.internal_storage_key),updated_at=now()
    RETURNING id,(xmax=0) inserted`
  )[0];
  if (!asset) return;
  await sql.begin(async (tx) => {
    await tx`UPDATE message_attachments SET file_asset_id=${String(asset.id)}::uuid WHERE id=${String(attachment.id)}::uuid AND organization_id=${String(attachment.organization_id)}::uuid`;
    await tx`INSERT INTO file_versions(organization_id,file_asset_id,version_number,internal_storage_key,size_bytes,checksum_sha256,status,created_by) VALUES(${String(attachment.organization_id)}::uuid,${String(asset.id)}::uuid,1,${String(attachment.storage_key)},${attachment.stored_size == null ? null : Number(attachment.stored_size)},${attachment.stored_sha256 ? String(attachment.stored_sha256) : null},'PENDING',NULL) ON CONFLICT(file_asset_id,version_number) DO NOTHING`;
    await tx`INSERT INTO file_processing_jobs(organization_id,file_asset_id,connection_id,job_type,payload) VALUES(${String(attachment.organization_id)}::uuid,${String(asset.id)}::uuid,${String(connection.id)}::uuid,'storage.upload','{}') ON CONFLICT(file_asset_id,job_type) DO UPDATE SET connection_id=excluded.connection_id,status=CASE WHEN file_processing_jobs.status='completed' THEN file_processing_jobs.status ELSE 'pending' END,next_attempt_at=now(),updated_at=now()`;
  });
  if (asset.inserted)
    await emitFileAutomationEvent({
      organizationId: String(attachment.organization_id),
      eventType: "file.received",
      fileAssetId: String(asset.id),
      conversationId: attachment.conversation_id
        ? String(attachment.conversation_id)
        : null,
      payload: {
        messageId: attachment.message_id,
        contactId: attachment.contact_id,
        category: "incoming_media",
        source: "whatsapp",
      },
    });
}

async function processMediaJob() {
  const rows = await sql<
    Array<Record<string, unknown>>
  >`WITH candidate AS(SELECT id FROM media_processing_jobs WHERE ((status IN('pending','retry') AND next_attempt_at<=now()) OR (status='processing' AND locked_at<now()-interval '2 minutes')) AND (locked_at IS NULL OR locked_at<now()-interval '2 minutes') ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE media_processing_jobs j SET status='processing',locked_at=now(),locked_by=${workerId},attempt_count=j.attempt_count+1,updated_at=now() FROM candidate WHERE j.id=candidate.id RETURNING j.*`;
  const job = rows[0];
  if (!job) return;
  const attachments = await sql<
    Array<Record<string, unknown>>
  >`SELECT a.*,ch.credentials_encrypted,ch.phone_number_id,m.provider_message_id whatsapp_message_id,m.conversation_id,m.contact_id FROM message_attachments a LEFT JOIN channels ch ON ch.id=a.channel_id LEFT JOIN messages m ON m.id=a.message_id AND m.organization_id=a.organization_id WHERE a.id=${String(job.attachment_id)}::uuid AND a.organization_id=${String(job.organization_id)}::uuid`;
  const a = attachments[0];
  if (!a) {
    await sql`UPDATE media_processing_jobs SET status='dead_letter',last_error='ATTACHMENT_NOT_FOUND',completed_at=now(),locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid`;
    return;
  }
  const existingStorageKey = a.storage_key ? String(a.storage_key) : null;
  const attachmentMetadata =
    a.metadata && typeof a.metadata === "object"
      ? (a.metadata as Record<string, unknown>)
      : {};
  const persistedCleanupKeys = Array.isArray(attachmentMetadata.cleanupKeys)
    ? attachmentMetadata.cleanupKeys.filter(
        (key): key is string => typeof key === "string" && key.length > 0,
      )
    : [];
  let pendingPreviousCleanupKeys = mediaCleanupRequired({
    storageKey: existingStorageKey,
    lastErrorCode: a.last_error_code ? String(a.last_error_code) : null,
    cleanupKeys: persistedCleanupKeys,
  })
    ? [
        ...new Set(
          [existingStorageKey, ...persistedCleanupKeys].filter(
            Boolean,
          ) as string[],
        ),
      ]
    : [];
  let attemptStorageKey: string | null = null;
  let attemptThumbnailKey: string | null = null;
  let attachmentStored = mediaStoredClean({
    storageKey: existingStorageKey,
    processingStatus: a.processing_status,
    scanStatus: a.scan_status,
  });
  const publishAttachmentStored = async () =>
    publish(
      String(a.organization_id),
      "attachment.stored",
      String(a.id),
      String(
        (
          await sql<
            Array<Record<string, unknown>>
          >`SELECT conversation_id FROM messages WHERE id=${String(a.message_id)}::uuid`
        )[0]?.conversation_id ?? "",
      ),
      { attachmentId: a.id },
    );
  try {
    if (attachmentStored) {
      await ensureInboundFileAsset(a);
      await sql`UPDATE media_processing_jobs SET status='completed',completed_at=now(),last_error=NULL,locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid`;
      await publishAttachmentStored();
      return;
    }
    for (const cleanupKey of pendingPreviousCleanupKeys) {
      attemptStorageKey = cleanupKey;
      await storage.deleteObject({ key: cleanupKey });
      attemptStorageKey = null;
    }
    if (pendingPreviousCleanupKeys.length)
      await sql`UPDATE message_attachments SET storage_provider=NULL,storage_bucket=NULL,storage_key=NULL,metadata=metadata-'cleanupKeys',updated_at=now() WHERE id=${String(a.id)}::uuid`;
    pendingPreviousCleanupKeys = [];
    await sql`UPDATE message_attachments SET processing_status='downloading',download_attempt_count=download_attempt_count+1,updated_at=now() WHERE id=${String(a.id)}::uuid`;
    let mediaAccessToken: string | undefined;
    if (a.credentials_encrypted && encryptionKey) {
      const credentials = JSON.parse(
        decryptSecret(String(a.credentials_encrypted), encryptionKey),
      ) as { accessToken?: unknown };
      if (typeof credentials.accessToken === "string")
        mediaAccessToken = credentials.accessToken;
    }
    const result = await downloadInboundMedia({
      provider: String(a.provider),
      mediaId: String(a.provider_media_id),
      providerMimeType: String(
        a.provider_mime_type ?? "application/octet-stream",
      ),
      metadata: attachmentMetadata,
      ...(encryptionKey ? { encryptionKey } : {}),
      downloadWhatsAppWeb: downloadWhatsAppWebMedia,
      downloadMeta: () =>
        provider.downloadMedia({
          mediaId: String(a.provider_media_id),
          ...(a.phone_number_id
            ? { phoneNumberId: String(a.phone_number_id) }
            : {}),
          ...(mediaAccessToken ? { accessToken: mediaAccessToken } : {}),
        }),
    });
    if (!result.bytes) throw new Error("MEDIA_BODY_MISSING");
    const declared = String(a.provider_mime_type ?? result.contentType)
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    const max = mediaLimitBytes(declared, process.env);
    if (result.bytes.byteLength > max) throw new Error("MEDIA_TOO_LARGE");
    const detected = await detectMediaMime(result.bytes, declared);
    const key = storageKey(
      String(a.organization_id),
      String(a.provider_filename ?? "attachment"),
    );
    attemptStorageKey = key;
    const stored = await storage.putObject({
      key,
      // Keep the byte array as one binary chunk. Readable.from(Uint8Array)
      // otherwise emits individual numbers, which breaks hashing and writes.
      body: Readable.from([Buffer.from(result.bytes)]),
      contentType: detected,
    });
    await scanStoredObject({ storage, scanner, key });
    let thumbnailKey: string | null = null;
    if (detected.startsWith("image/")) {
      try {
        const thumbnail = await sharp(Buffer.from(result.bytes), {
          limitInputPixels: 40_000_000,
          failOn: "warning",
        })
          .rotate()
          .resize({
            width: 480,
            height: 480,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 78 })
          .toBuffer();
        thumbnailKey = `${key}.thumbnail.webp`;
        attemptThumbnailKey = thumbnailKey;
        await storage.putObject({
          key: thumbnailKey,
          body: Readable.from([thumbnail]),
          contentType: "image/webp",
        });
      } catch (thumbnailError) {
        if (attemptThumbnailKey) throw thumbnailError;
        thumbnailKey = null;
        process.stderr.write(
          JSON.stringify({
            level: "warn",
            event: "media.thumbnail_failed",
            attachmentId: a.id,
            error:
              thumbnailError instanceof Error
                ? thumbnailError.message
                : "thumbnail_error",
          }) + "\n",
        );
      }
    }
    await sql`UPDATE message_attachments SET storage_provider=${storageLocation.provider},storage_bucket=${storageLocation.bucket},storage_key=${key},stored_mime_type=${detected},stored_filename=${String(a.provider_filename ?? "attachment")},stored_size=${stored.size},stored_sha256=${stored.sha256},processing_status='stored',scan_status='clean',metadata=metadata||${sql.json({ thumbnailKey } as never)},stored_at=now(),last_error_code=NULL,last_error_message=NULL,updated_at=now() WHERE id=${String(a.id)}::uuid`;
    await ensureInboundFileAsset({
      ...a,
      storage_key: key,
      stored_mime_type: detected,
      stored_size: stored.size,
      stored_sha256: stored.sha256,
      trace_id: job.trace_id,
    });
    attachmentStored = true;
    attemptStorageKey = null;
    attemptThumbnailKey = null;
    await sql`UPDATE media_processing_jobs SET status='completed',completed_at=now(),last_error=NULL,locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid`;
    await publishAttachmentStored();
  } catch (error) {
    const attempt = Number(job.attempt_count);
    const maxAttempts = Number(job.max_attempts);
    let failure = mediaProcessingFailureDisposition(
      error,
      attempt,
      maxAttempts,
    );

    if (attachmentStored) {
      await sql`UPDATE media_processing_jobs SET status=${failure.dead ? "dead_letter" : "retry"},next_attempt_at=now()+(${mediaRetryDelay(attempt)}::int*interval '1 millisecond'),last_error=${failure.code},locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid`;
      return;
    }

    const cleanupCandidates = [
      failure.cleanupKey,
      attemptStorageKey,
      attemptThumbnailKey,
      ...pendingPreviousCleanupKeys,
    ].filter((key): key is string => Boolean(key));
    const uniqueCleanupCandidates = [...new Set(cleanupCandidates)];
    const failedCleanupKeys: string[] = [];
    for (const cleanupKey of uniqueCleanupCandidates) {
      try {
        await storage.deleteObject({ key: cleanupKey });
      } catch (cleanupError) {
        failedCleanupKeys.push(cleanupKey);
        process.stderr.write(
          JSON.stringify({
            level: "error",
            event: "media.cleanup_required",
            attachmentId: a.id,
            storageKey: cleanupKey,
            reason: failure.code,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : "storage_delete_failed",
          }) + "\n",
        );
      }
    }
    const cleanupSucceeded =
      uniqueCleanupCandidates.length > 0 && failedCleanupKeys.length === 0;
    if (failedCleanupKeys.length > 0) {
      failure = mediaObjectCleanupFailureDisposition(
        failure,
        failedCleanupKeys[0]!,
        attempt,
        maxAttempts,
      );
    }
    const hasFailedCleanup = failedCleanupKeys.length > 0;
    const cleanupMetadata = sql.json({
      cleanupKeys: failedCleanupKeys,
    } as never);
    await sql`UPDATE media_processing_jobs SET status=${failure.dead ? "dead_letter" : "retry"},next_attempt_at=now()+(${mediaRetryDelay(attempt)}::int*interval '1 millisecond'),last_error=${failure.code},locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid`;
    await sql`UPDATE message_attachments SET processing_status='failed',scan_status=CASE WHEN ${failure.scanStatus}::text IS NULL THEN scan_status ELSE ${failure.scanStatus}::text END,storage_provider=CASE WHEN ${cleanupSucceeded} THEN NULL WHEN ${hasFailedCleanup} THEN ${storageLocation.provider} ELSE storage_provider END,storage_bucket=CASE WHEN ${cleanupSucceeded} THEN NULL WHEN ${hasFailedCleanup} THEN ${storageLocation.bucket} ELSE storage_bucket END,storage_key=CASE WHEN ${cleanupSucceeded} THEN NULL WHEN ${hasFailedCleanup} THEN ${failedCleanupKeys[0] ?? null}::text ELSE storage_key END,metadata=CASE WHEN ${cleanupSucceeded} THEN metadata-'cleanupKeys' WHEN ${hasFailedCleanup} THEN metadata||${cleanupMetadata} ELSE metadata END,last_error_code=${failure.code},last_error_message='Media processing failed',updated_at=now() WHERE id=${String(a.id)}::uuid`;
  }
}

const folderPolicy = new FolderPolicyService();
const driveCategoryFolder: Record<string, string> = {
  incoming_media: "01_Incoming_Media",
  intraoral_photos: "02_Intraoral_Photos",
  xray_cbct: "03_Xray_CBCT",
  treatment_plans: "04_Treatment_Plans",
  offers: "05_Offers",
  consent_reports: "06_Consent_Reports",
  invoices_payments: "07_Invoices_Payments",
  other: "08_Other",
};

async function emitFileAutomationEvent(input: {
  organizationId: string;
  eventType: string;
  fileAssetId: string;
  conversationId?: string | null;
  payload?: Record<string, unknown>;
  origin?: string;
  // Automation-triggered re-emissions must inherit the parent chain so the
  // depth guard can terminate self-triggering rules (file.changed →
  // assign_file_category → file.changed would otherwise loop forever at
  // depth 0 with a fresh correlation id every round).
  correlationId?: string;
  depth?: number;
}) {
  await sql`INSERT INTO automation_events(
    organization_id,event_type,aggregate_type,aggregate_id,conversation_id,
    correlation_id,origin,depth,payload
  ) VALUES(
    ${input.organizationId}::uuid,${input.eventType},'file',${input.fileAssetId}::uuid,
    ${input.conversationId ?? null}::uuid,
    COALESCE(${input.correlationId ?? null}::uuid,gen_random_uuid()),
    ${input.origin ?? "files"},${input.depth ?? 0},
    ${sql.json({ fileAssetId: input.fileAssetId, ...(input.payload ?? {}) } as never)}
  )`;
}

async function googleDriveForConnection(connection: Record<string, unknown>) {
  if (
    !googleTokenEncryptionKey ||
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET
  )
    throw new StorageProviderError(
      "DRIVE_CONNECTION_DISABLED",
      "Google Drive worker configuration is missing.",
      false,
    );
  if (!connection.encrypted_credentials || connection.status === "disconnected")
    throw new StorageProviderError(
      "DRIVE_CONNECTION_DISABLED",
      "Google Drive connection is disabled.",
      false,
    );
  const credentials = JSON.parse(
    decryptSecret(
      String(connection.encrypted_credentials),
      googleTokenEncryptionKey,
    ),
  ) as { accessToken: string; refreshToken?: string; expiresAt?: string };
  const accessToken = async () => {
    if (
      !credentials.expiresAt ||
      new Date(credentials.expiresAt).getTime() > Date.now() + 60_000
    )
      return credentials.accessToken;
    if (!credentials.refreshToken)
      throw new StorageProviderError(
        "GOOGLE_TOKEN_REVOKED",
        "Google Drive must be reconnected.",
        false,
      );
    const refreshed = await refreshGoogleAccessToken({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      refreshToken: credentials.refreshToken,
    });
    credentials.accessToken = refreshed.accessToken;
    credentials.expiresAt = new Date(
      Date.now() + refreshed.expiresIn * 1000,
    ).toISOString();
    await sql`UPDATE storage_connections SET encrypted_credentials=${encryptSecret(JSON.stringify(credentials), googleTokenEncryptionKey)},token_expires_at=${credentials.expiresAt}::timestamptz,status='connected',last_error_code=NULL,updated_at=now() WHERE id=${String(connection.id)}::uuid`;
    return credentials.accessToken;
  };
  return new GoogleDriveAdapter({
    accessToken,
    ...(connection.shared_drive_id
      ? { sharedDriveId: String(connection.shared_drive_id) }
      : {}),
  });
}

async function findOrCreateFolder(
  adapter: GoogleDriveAdapter,
  name: string,
  parentId?: string,
) {
  const existing = await adapter.listFiles({
    ...(parentId ? { folderId: parentId } : {}),
    query: name,
    pageSize: 100,
  });
  const exact = existing.find(
    (file) =>
      file.name === name &&
      file.mimeType === "application/vnd.google-apps.folder",
  );
  return exact
    ? { id: exact.id, name: exact.name }
    : adapter.createFolder({ name, ...(parentId ? { parentId } : {}) });
}

async function assetDriveFolder(
  asset: Record<string, unknown>,
  connection: Record<string, unknown>,
  adapter: GoogleDriveAdapter,
) {
  if (!asset.contact_id)
    return connection.root_folder_id
      ? String(connection.root_folder_id)
      : undefined;
  const mapped = (
    await sql<
      Array<Record<string, unknown>>
    >`SELECT * FROM contact_storage_folders WHERE organization_id=${String(asset.organization_id)}::uuid AND contact_id=${String(asset.contact_id)}::uuid AND provider_connection_id=${String(connection.id)}::uuid`
  )[0];
  let contactFolderId: string;
  let categoryFolders: Record<string, string> = {};
  if (mapped) {
    contactFolderId = String(mapped.provider_folder_id);
    categoryFolders = (mapped.category_folders ?? {}) as Record<string, string>;
  } else {
    const contact = (
      await sql<
        Array<Record<string, unknown>>
      >`SELECT id,display_name,normalized_phone FROM contacts WHERE id=${String(asset.contact_id)}::uuid AND organization_id=${String(asset.organization_id)}::uuid`
    )[0];
    if (!contact)
      throw new StorageProviderError(
        "TENANT_ACCESS_DENIED",
        "Contact is outside tenant scope.",
        false,
      );
    const policy = folderPolicy.contactFolders({
      contactId: String(contact.id),
      displayName: String(contact.display_name ?? "Contact"),
      normalizedPhone: String(contact.normalized_phone ?? ""),
    });
    const year = await findOrCreateFolder(
      adapter,
      policy.rootName,
      connection.root_folder_id ? String(connection.root_folder_id) : undefined,
    );
    const contactFolder = await findOrCreateFolder(
      adapter,
      policy.contactName,
      year.id,
    );
    contactFolderId = contactFolder.id;
    for (const category of policy.categories)
      categoryFolders[category] = (
        await findOrCreateFolder(adapter, category, contactFolderId)
      ).id;
    await sql`INSERT INTO contact_storage_folders(organization_id,contact_id,provider_connection_id,provider_folder_id,folder_name,category_folders,sync_status) VALUES(${String(asset.organization_id)}::uuid,${String(asset.contact_id)}::uuid,${String(connection.id)}::uuid,${contactFolderId},${policy.contactName},${sql.json(categoryFolders as never)},'ready') ON CONFLICT(organization_id,contact_id,provider_connection_id) DO UPDATE SET provider_folder_id=excluded.provider_folder_id,folder_name=excluded.folder_name,category_folders=excluded.category_folders,sync_status='ready',updated_at=now()`;
    await emitFileAutomationEvent({
      organizationId: String(asset.organization_id),
      eventType: "file.folder_created",
      fileAssetId: String(asset.id),
      conversationId: asset.conversation_id
        ? String(asset.conversation_id)
        : null,
      payload: {
        contactId: asset.contact_id,
        providerFolderId: contactFolderId,
      },
    });
  }
  return (
    categoryFolders[
      driveCategoryFolder[String(asset.category)] ?? driveCategoryFolder.other!
    ] ?? contactFolderId
  );
}

async function processFileJob() {
  const job = (
    await sql<
      Array<Record<string, unknown>>
    >`WITH candidate AS(SELECT id FROM file_processing_jobs WHERE ((status IN('pending','retry') AND next_attempt_at<=now()) OR (status='processing' AND locked_at<now()-interval '5 minutes')) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE file_processing_jobs j SET status='processing',locked_at=now(),locked_by=${workerId},attempt_count=j.attempt_count+1,updated_at=now() FROM candidate WHERE j.id=candidate.id RETURNING j.*`
  )[0];
  if (!job) return;
  const context = (
    await sql<
      Array<Record<string, unknown>>
    >`SELECT f.*,c.encrypted_credentials,c.root_folder_id,c.shared_drive_id,c.status connection_status,c.id connection_row_id FROM file_assets f JOIN storage_connections c ON c.id=${String(job.connection_id)}::uuid AND c.organization_id=f.organization_id WHERE f.id=${String(job.file_asset_id)}::uuid AND f.organization_id=${String(job.organization_id)}::uuid`
  )[0];
  if (!context) {
    await sql`UPDATE file_processing_jobs SET status='dead_letter',last_error_code='DRIVE_CONNECTION_DISABLED',completed_at=now(),locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid`;
    return;
  }
  const connection = {
    ...context,
    id: context.connection_row_id,
    status: context.connection_status,
  };
  try {
    const adapter = await googleDriveForConnection(connection);
    const jobType = String(job.job_type);
    let eventType = "file.changed";
    if (jobType === "storage.upload") {
      if (!context.provider_file_id) {
        if (!context.internal_storage_key)
          throw new StorageProviderError(
            "DRIVE_FILE_NOT_FOUND",
            "Ingest object is missing.",
            false,
          );
        const folderId = await assetDriveFolder(context, connection, adapter);
        const uploaded = await adapter.upload({
          name: String(context.sanitized_name),
          mimeType: String(context.mime_type),
          ...(context.size_bytes == null
            ? {}
            : { sizeBytes: Number(context.size_bytes) }),
          ...(folderId ? { parentId: folderId } : {}),
          body: await storage.getObject({
            key: String(context.internal_storage_key),
          }),
          metadata: {
            brixchatAssetId: String(context.id),
            organizationId: String(context.organization_id),
          },
        });
        await sql`UPDATE file_assets SET provider_file_id=${uploaded.id},provider_folder_id=${uploaded.parentIds[0] ?? folderId ?? null},status='READY',error_code=NULL,error_message=NULL,metadata=metadata||${sql.json({ webViewLink: uploaded.webViewLink ?? null } as never)},updated_at=now() WHERE id=${String(context.id)}::uuid AND organization_id=${String(context.organization_id)}::uuid`;
        await sql`UPDATE file_versions SET provider_file_id=${uploaded.id},status='READY' WHERE file_asset_id=${String(context.id)}::uuid AND organization_id=${String(context.organization_id)}::uuid AND version_number=(SELECT max(version_number) FROM file_versions WHERE file_asset_id=${String(context.id)}::uuid)`;
      }
      eventType =
        String(context.category) === "xray_cbct"
          ? "file.xray_detected"
          : "file.uploaded";
    } else if (jobType === "storage.rename")
      await adapter.rename(
        String(context.provider_file_id),
        String(
          (job.payload as Record<string, unknown>)?.name ??
            context.sanitized_name,
        ),
      );
    else if (jobType === "storage.move")
      await adapter.move(
        String(context.provider_file_id),
        String((job.payload as Record<string, unknown>)?.folderId),
      );
    else if (jobType === "storage.archive")
      await adapter.archive(String(context.provider_file_id));
    else if (jobType === "storage.delete")
      await adapter.delete(String(context.provider_file_id));
    else if (jobType === "storage.restore")
      await adapter.restore(String(context.provider_file_id));
    else if (jobType === "storage.share") {
      const payload = (job.payload ?? {}) as Record<string, unknown>;
      const link = await adapter.createShareLink({
        fileId: String(context.provider_file_id),
        ...(payload.emailAddress
          ? { emailAddress: String(payload.emailAddress) }
          : {}),
        allowPublic: payload.allowPublic === true,
      });
      await sql`UPDATE file_assets SET metadata=metadata||${sql.json({ lastShare: link } as never)},updated_at=now() WHERE id=${String(context.id)}::uuid AND organization_id=${String(context.organization_id)}::uuid`;
      eventType = "file.permission_changed";
    } else if (jobType === "storage.revoke_share") {
      const payload = (job.payload ?? {}) as Record<string, unknown>;
      await adapter.revokeShareLink(
        String(payload.permissionId),
        String(context.provider_file_id),
      );
      eventType = "file.permission_changed";
    }
    await sql`UPDATE file_processing_jobs SET status='completed',completed_at=now(),locked_at=NULL,locked_by=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid`;
    await sql`UPDATE storage_connections SET last_synced_at=now(),status='connected',last_error_code=NULL,updated_at=now() WHERE id=${String(connection.id)}::uuid`;
    await emitFileAutomationEvent({
      organizationId: String(context.organization_id),
      eventType,
      fileAssetId: String(context.id),
      conversationId: context.conversation_id
        ? String(context.conversation_id)
        : null,
      payload: {
        jobType,
        category: context.category,
        provider: "google_drive",
      },
    });
    await publish(
      String(context.organization_id),
      "file.status_changed",
      String(context.id),
      String(context.conversation_id ?? context.id),
      {
        fileAssetId: context.id,
        status: context.status === "PENDING" ? "READY" : context.status,
      },
    );
  } catch (error) {
    const attempt = Number(job.attempt_count ?? 1),
      maxAttempts = Number(job.max_attempts ?? 5);
    const retryable =
      error instanceof StorageProviderError ? error.retryable : true;
    const dead = !retryable || attempt >= maxAttempts;
    const code =
      error instanceof StorageProviderError
        ? error.code
        : "FILE_PROCESSING_FAILED";
    const delay = Math.min(15 * 60_000, 1000 * 2 ** Math.max(0, attempt - 1));
    await sql`UPDATE file_processing_jobs SET status=${dead ? "dead_letter" : "retry"},next_attempt_at=now()+(${delay}::int*interval '1 millisecond'),locked_at=NULL,locked_by=NULL,last_error_code=${code},last_error_message=${error instanceof Error ? error.message : "File processing failed"},updated_at=now() WHERE id=${String(job.id)}::uuid`;
    await sql`UPDATE file_assets SET status=${dead ? "FAILED" : "RETRYING"},error_code=${code},error_message='Dosya işlemi tamamlanamadı.',updated_at=now() WHERE id=${String(context.id)}::uuid AND organization_id=${String(context.organization_id)}::uuid`;
    await sql`UPDATE storage_connections SET status=${dead ? "error" : "degraded"},last_error_code=${code},updated_at=now() WHERE id=${String(connection.id)}::uuid`;
    if (dead)
      await emitFileAutomationEvent({
        organizationId: String(context.organization_id),
        eventType: "file.upload_failed",
        fileAssetId: String(context.id),
        conversationId: context.conversation_id
          ? String(context.conversation_id)
          : null,
        payload: { jobType: job.job_type, errorCode: code },
      });
  }
}

let nextDriveWatchScanAt = 0;
async function scheduleDriveWatchRenewals() {
  if (
    process.env.GOOGLE_DRIVE_ENABLED !== "true" ||
    Date.now() < nextDriveWatchScanAt
  )
    return;
  nextDriveWatchScanAt = Date.now() + 5 * 60_000;
  const bucket = new Date().toISOString().slice(0, 13);
  await sql`INSERT INTO storage_sync_jobs(organization_id,connection_id,job_type,idempotency_key,payload) SELECT organization_id,id,'watch.renew',${`watch:${bucket}`}||':'||id::text,'{}'::jsonb FROM storage_connections c WHERE provider='google_drive' AND status IN('connected','degraded') AND NOT EXISTS(SELECT 1 FROM storage_sync_channels s WHERE s.connection_id=c.id AND s.status='active' AND s.expiration_at>now()+interval '2 hours') ON CONFLICT(connection_id,idempotency_key) DO NOTHING`;
}

async function processStorageSyncJob() {
  const job = (
    await sql<
      Array<Record<string, unknown>>
    >`WITH candidate AS(SELECT id FROM storage_sync_jobs WHERE ((status IN('pending','retry') AND next_attempt_at<=now()) OR (status='processing' AND locked_at<now()-interval '5 minutes')) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE storage_sync_jobs j SET status='processing',locked_at=now(),locked_by=${workerId},attempt_count=j.attempt_count+1,updated_at=now() FROM candidate WHERE j.id=candidate.id RETURNING j.*`
  )[0];
  if (!job) return;
  const connection = (
    await sql<
      Array<Record<string, unknown>>
    >`SELECT * FROM storage_connections WHERE id=${String(job.connection_id)}::uuid AND organization_id=${String(job.organization_id)}::uuid`
  )[0];
  if (!connection) {
    await sql`UPDATE storage_sync_jobs SET status='dead_letter',last_error_code='STORAGE_CONNECTION_NOT_FOUND',completed_at=now(),locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid`;
    return;
  }
  try {
    const adapter = await googleDriveForConnection(connection);
    if (job.job_type === "watch.renew") {
      const old = (
        await sql<
          Array<Record<string, unknown>>
        >`SELECT * FROM storage_sync_channels WHERE connection_id=${String(connection.id)}::uuid AND status='active' ORDER BY created_at DESC LIMIT 1`
      )[0];
      const pageToken = old?.page_token
        ? String(old.page_token)
        : await adapter.getStartPageToken();
      const channelId = crypto.randomUUID(),
        token = randomBytes(32).toString("base64url"),
        expiration = new Date(Date.now() + 23 * 60 * 60_000);
      const watched = await adapter.watchChanges({
        pageToken,
        channelId,
        channelToken: token,
        address: `${process.env.API_PUBLIC_URL ?? "http://localhost:4400"}/webhooks/google-drive/${channelId}`,
        expiration,
      });
      await sql.begin(async (tx) => {
        if (old)
          await tx`UPDATE storage_sync_channels SET status='stopped',updated_at=now() WHERE id=${String(old.id)}::uuid`;
        await tx`INSERT INTO storage_sync_channels(organization_id,connection_id,channel_id,channel_token_hash,resource_id,page_token,expiration_at,status) VALUES(${String(connection.organization_id)}::uuid,${String(connection.id)}::uuid,${channelId},${createHash("sha256").update(token).digest("hex")},${watched.resourceId},${pageToken},${watched.expiration ? new Date(Number(watched.expiration)).toISOString() : expiration.toISOString()}::timestamptz,'active')`;
      });
      if (old?.resource_id)
        await adapter
          .stopChannel({
            channelId: String(old.channel_id),
            resourceId: String(old.resource_id),
          })
          .catch(() => undefined);
    } else if (job.job_type === "changes.list") {
      const channel = (
        await sql<
          Array<Record<string, unknown>>
        >`SELECT * FROM storage_sync_channels WHERE id=${String(job.sync_channel_id)}::uuid AND connection_id=${String(connection.id)}::uuid`
      )[0];
      if (!channel?.page_token)
        throw new StorageProviderError(
          "FILE_PROCESSING_FAILED",
          "Drive page token is missing.",
          true,
        );
      let token = String(channel.page_token);
      for (let page = 0; page < 20; page++) {
        const result = await adapter.listChanges(token);
        for (const change of result.changes ?? []) {
          if (change.removed || change.file?.trashed)
            await sql`UPDATE file_assets SET status='DELETED',deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE organization_id=${String(connection.organization_id)}::uuid AND provider_connection_id=${String(connection.id)}::uuid AND provider_file_id=${change.fileId}`;
          else if (change.file)
            await sql`UPDATE file_assets SET sanitized_name=${change.file.name ?? "file"},provider_folder_id=${change.file.parents?.[0] ?? null},size_bytes=${change.file.size ? Number(change.file.size) : null},status=CASE WHEN status IN('FAILED','RETRYING') THEN 'READY' ELSE status END,metadata=metadata||${sql.json({ webViewLink: change.file.webViewLink ?? null, driveModifiedTime: change.file.modifiedTime ?? null } as never)},updated_at=now() WHERE organization_id=${String(connection.organization_id)}::uuid AND provider_connection_id=${String(connection.id)}::uuid AND provider_file_id=${change.fileId}`;
        }
        if (result.nextPageToken) token = result.nextPageToken;
        else {
          token = result.newStartPageToken ?? token;
          break;
        }
      }
      await sql`UPDATE storage_sync_channels SET page_token=${token},updated_at=now() WHERE id=${String(channel.id)}::uuid`;
    }
    await sql`UPDATE storage_sync_jobs SET status='completed',completed_at=now(),locked_at=NULL,locked_by=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid`;
    await sql`UPDATE storage_connections SET last_synced_at=now(),status='connected',last_error_code=NULL,updated_at=now() WHERE id=${String(connection.id)}::uuid`;
  } catch (error) {
    const attempt = Number(job.attempt_count ?? 1),
      maxAttempts = Number(job.max_attempts ?? 5);
    const retryable =
      error instanceof StorageProviderError ? error.retryable : true;
    const dead = !retryable || attempt >= maxAttempts;
    const code =
      error instanceof StorageProviderError
        ? error.code
        : "FILE_PROCESSING_FAILED";
    const delay = Math.min(15 * 60_000, 1000 * 2 ** Math.max(0, attempt - 1));
    await sql`UPDATE storage_sync_jobs SET status=${dead ? "dead_letter" : "retry"},next_attempt_at=now()+(${delay}::int*interval '1 millisecond'),locked_at=NULL,locked_by=NULL,last_error_code=${code},last_error_message=${error instanceof Error ? error.message : "Drive sync failed"},updated_at=now() WHERE id=${String(job.id)}::uuid`;
    await sql`UPDATE storage_connections SET status=${dead ? "error" : "degraded"},last_error_code=${code},updated_at=now() WHERE id=${String(connection.id)}::uuid`;
  }
}

function flattenAutomationContext(
  value: unknown,
  prefix = "",
  output: Record<string, unknown> = {},
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child))
      flattenAutomationContext(child, path, output);
    else output[path] = child;
  }
  return output;
}

async function executeAutomationTemplateAction(input: {
  organizationId: string;
  conversationId: string | null;
  ruleId: string;
  runId: string;
  config: Record<string, unknown>;
}) {
  if (!input.conversationId)
    return { status: "skipped", reason: "conversation_required" };
  const templateId =
    typeof input.config.templateId === "string"
      ? input.config.templateId
      : null;
  const configuredChannelId =
    typeof input.config.channelId === "string" ? input.config.channelId : null;
  if (!templateId || !configuredChannelId)
    return { status: "blocked", reason: "template_configuration_invalid" };

  const baseRows = await sql<Array<Record<string, unknown>>>`
    SELECT c.channel_id,c.contact_id,c.assignee_id,
           ct.first_name,ct.last_name,ct.normalized_phone,ct.language contact_language,ct.country,
           u.full_name assigned_user_name,o.name workspace_name,crm.context bitrix_context,
           base.family_id,base.category,f.default_language,f.fallback_language
    FROM conversations c
    JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id
    JOIN organizations o ON o.id=c.organization_id
    JOIN message_templates base ON base.id=${templateId}::uuid
      AND base.organization_id=c.organization_id AND base.deleted_at IS NULL
    JOIN message_template_channels base_channel ON base_channel.template_id=base.id
      AND base_channel.channel_id=c.channel_id
    LEFT JOIN message_template_families f ON f.id=base.family_id
    LEFT JOIN users u ON u.id=c.assignee_id
    LEFT JOIN conversation_crm_context_cache crm ON crm.organization_id=c.organization_id
      AND crm.conversation_id=c.id
    WHERE c.id=${input.conversationId}::uuid
      AND c.organization_id=${input.organizationId}::uuid
      AND c.channel_id=${configuredChannelId}::uuid`;
  const base = baseRows[0];
  if (!base) return { status: "blocked", reason: "template_channel_mismatch" };

  const languagePolicy = String(input.config.languagePolicy ?? "contact");
  const preferredLanguage =
    languagePolicy === "fixed"
      ? String(input.config.fixedLanguage ?? "")
      : String(base.contact_language ?? "");
  const variants = await sql<Array<Record<string, unknown>>>`
    SELECT mt.*
    FROM message_templates mt
    JOIN message_template_channels mtc ON mtc.template_id=mt.id
      AND mtc.channel_id=${configuredChannelId}::uuid
    WHERE mt.organization_id=${input.organizationId}::uuid
      AND mt.deleted_at IS NULL
      AND mt.status='approved'
      AND (
        (${base.family_id ? String(base.family_id) : null}::uuid IS NOT NULL AND mt.family_id=${base.family_id ? String(base.family_id) : null}::uuid)
        OR (${base.family_id ? String(base.family_id) : null}::uuid IS NULL AND mt.id=${templateId}::uuid)
      )`;
  const selected =
    variants.find((variant) => variant.language === preferredLanguage) ??
    variants.find(
      (variant) =>
        variant.language ===
        String(base.fallback_language ?? base.default_language ?? ""),
    );
  if (!selected)
    return { status: "blocked", reason: "approved_language_variant_missing" };

  if (input.config.requireOptIn !== false) {
    const consent = await sql`
      SELECT 1 FROM consent_records
      WHERE organization_id=${input.organizationId}::uuid
        AND subject_reference_hash=encode(digest(${String(base.normalized_phone)},'sha256'),'hex')
        AND purpose='whatsapp'
        AND status='granted'
      LIMIT 1`;
    if (!consent[0])
      return { status: "blocked", reason: "whatsapp_opt_in_missing" };
  }

  const repeatLimitMinutes = Math.max(
    1,
    Number(input.config.repeatLimitMinutes ?? 1440),
  );
  const recent = await sql`
    SELECT 1 FROM messages
    WHERE organization_id=${input.organizationId}::uuid
      AND conversation_id=${input.conversationId}::uuid
      AND metadata->>'automationRuleId'=${input.ruleId}
      AND metadata->>'templateId'=${String(selected.id)}
      AND status IN ('pending','sent','delivered','read')
      AND created_at>now()-(${repeatLimitMinutes}::int*interval '1 minute')
    LIMIT 1`;
  if (recent[0])
    return { status: "skipped", reason: "automation_repeat_limit" };

  const variableRows = await sql<
    Array<{
      component: string;
      position: number;
      internal_key: string | null;
      example_value: string | null;
      default_value: string | null;
      required: boolean;
      missing_policy: "block" | "default" | "manual";
      formatter: TemplateVariableMapping["formatter"] | null;
    }>
  >`SELECT component,position,internal_key,example_value,default_value,required,missing_policy,formatter FROM message_template_variables WHERE template_id=${String(selected.id)}::uuid ORDER BY component,position`;
  const mappings: TemplateVariableMapping[] = variableRows.map((variable) => ({
    component: variable.component,
    position: variable.position,
    internalKey:
      variable.internal_key ?? `${variable.component}.${variable.position}`,
    ...(variable.example_value ? { exampleValue: variable.example_value } : {}),
    ...(variable.default_value ? { defaultValue: variable.default_value } : {}),
    ...(variable.formatter ? { formatter: variable.formatter } : {}),
    required: variable.required,
    missingPolicy:
      input.config.missingPolicy === "default" ||
      input.config.missingPolicy === "manual"
        ? input.config.missingPolicy
        : variable.missing_policy,
  }));
  const context: Record<string, unknown> = {
    "contact.first_name": base.first_name,
    "contact.last_name": base.last_name,
    "contact.phone": base.normalized_phone,
    "contact.language": base.contact_language,
    "contact.country": base.country,
    "assigned_user.name": base.assigned_user_name,
    "workspace.name": base.workspace_name,
    ...flattenAutomationContext(base.bitrix_context, "bitrix"),
  };
  const manualDefaults =
    input.config.variableValues &&
    typeof input.config.variableValues === "object" &&
    !Array.isArray(input.config.variableValues)
      ? (input.config.variableValues as Record<string, string>)
      : {};
  const resolved = resolveTemplateVariables(mappings, context, manualDefaults);
  if (resolved.blocking.length)
    return {
      status: "blocked",
      reason: "template_variables_missing",
      missing: resolved.blocking,
    };
  const resolvedVariables = Object.fromEntries(
    resolved.values.map((value) => [value.key, value.value ?? ""]),
  );
  const orderedVariables = resolved.values.map((value) => value.value ?? "");
  const preview = resolved.values.reduce(
    (text, value) =>
      value.key.startsWith("body.")
        ? text.replace(
            new RegExp(`\\{\\{${value.key.split(".")[1]}\\}\\}`, "g"),
            value.value ?? "",
          )
        : text,
    String(selected.body_text),
  );
  const traceId = crypto.randomUUID();
  const created = await sql.begin(async (tx) => {
    const messages = await tx<Array<{ id: string }>>`
      INSERT INTO messages(
        organization_id,conversation_id,channel_id,contact_id,client_message_id,
        direction,type,status,body,metadata
      ) VALUES(
        ${input.organizationId}::uuid,${input.conversationId}::uuid,
        ${configuredChannelId}::uuid,${String(base.contact_id)}::uuid,
        gen_random_uuid(),'outbound','template','pending',${preview},
        ${tx.json({
          origin: "automation",
          automationRuleId: input.ruleId,
          automationRunId: input.runId,
          templateId: String(selected.id),
          templateName: String(selected.name),
          language: String(selected.language),
          variables: resolvedVariables,
          variableResolution: resolved.values,
          orderedVariables,
          templateComponents: selected.components,
        } as never)}
      ) RETURNING id`;
    const messageId = messages[0]!.id;
    await tx`INSERT INTO outbox_jobs(organization_id,aggregate_type,aggregate_id,job_type,payload) VALUES(${input.organizationId}::uuid,'message',${messageId}::uuid,'template.send',${tx.json({ messageId, traceId } as never)})`;
    await tx`INSERT INTO message_flow_events(organization_id,message_id,trace_id,event_type,source) VALUES(${input.organizationId}::uuid,${messageId}::uuid,${traceId}::uuid,'message.accepted','automation'),(${input.organizationId}::uuid,${messageId}::uuid,${traceId}::uuid,'outbox.created','automation')`;
    await tx`INSERT INTO template_send_events(organization_id,template_id,message_id,status) VALUES(${input.organizationId}::uuid,${String(selected.id)}::uuid,${messageId}::uuid,'pending')`;
    await tx`UPDATE message_templates SET usage_count=usage_count+1,last_used_at=now(),updated_at=now() WHERE id=${String(selected.id)}::uuid`;
    return messageId;
  });
  return {
    status: "completed",
    messageId: created,
    templateId: String(selected.id),
    language: String(selected.language),
  };
}

async function processAutomationEvent() {
  const staleLockSeconds = automationRuntimeConfig.staleLockSeconds;
  const events = await sql<Array<Record<string, unknown>>>`WITH candidate AS(
      SELECT id FROM automation_events
      WHERE (
        status IN ('pending','retry') AND next_attempt_at<=now()
        OR status='processing'
          AND locked_at<now()-(${staleLockSeconds}::int*interval '1 second')
      )
      AND (
        locked_at IS NULL
        OR locked_at<now()-(${staleLockSeconds}::int*interval '1 second')
      )
      ORDER BY next_attempt_at,created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE automation_events e SET
      status='processing',
      locked_at=now(),
      locked_by=${workerId},
      attempt_count=e.attempt_count+1
    FROM candidate
    WHERE e.id=candidate.id
    RETURNING e.*`;
  const e = events[0];
  if (!e) return;
  try {
    if (
      !loopAllowed({
        depth: Number(e.depth),
        maxDepth: automationRuntimeConfig.maxSubflowDepth,
        correlationId: String(e.correlation_id),
        seen: new Set(),
      })
    ) {
      await sql`UPDATE automation_events SET status='blocked',processed_at=now(),locked_at=NULL,locked_by=NULL,last_error_code='automation_loop_limit' WHERE id=${String(e.id)}::uuid`;
      return;
    }
    const rules = await sql<
      Array<Record<string, unknown>>
    >`SELECT ar.*,v.id version_id,v.version,v.compiled_definition FROM automation_rules ar JOIN automation_rule_versions v ON v.rule_id=ar.id AND v.version=ar.published_version JOIN automation_rule_triggers t ON t.version_id=v.id WHERE ar.organization_id=${String(e.organization_id)}::uuid AND ar.status='active' AND t.trigger_type=${String(e.event_type)} AND (t.config->>'channelId' IS NULL OR t.config->>'channelId'=${String(((e.payload ?? {}) as Record<string, unknown>).channelId ?? "")}) ORDER BY ar.priority`;
    for (const rule of rules) {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      let plannedActions: Map<number, PlannedAutomationAction> | null = null;
      let limitsSnapshot: Record<string, unknown> = {};
      if (rule.compiled_definition) {
        const plan = await planCompiledAutomation(
          rule.compiled_definition,
          payload,
        );
        if (plan.result.status === "skipped") continue;
        if (plan.result.status !== "completed")
          throw new Error(
            plan.result.errorCode ?? "automation_compiled_plan_failed",
          );
        plannedActions = new Map(
          plan.actions.map((action) => {
            const match = /^action-(\d+)$/.exec(action.nodeId);
            if (!match)
              throw new Error("automation_compiled_action_position_invalid");
            return [Number(match[1]) - 1, action];
          }),
        );
        limitsSnapshot = plan.definition.limits;
      } else {
        const conditions = await sql<
          Array<Record<string, unknown>>
        >`SELECT * FROM automation_rule_conditions WHERE version_id=${String(rule.version_id)}::uuid ORDER BY position`;
        if (
          !conditions.every((c) =>
            evaluateCondition(
              {
                field: String(c.field),
                operator: String(c.operator),
                value: c.value,
              },
              payload,
            ),
          )
        )
          continue;
      }
      const recent = (
        await sql<
          Array<Record<string, unknown>>
        >`SELECT count(*)::int organization_count,count(*) FILTER(WHERE conversation_id=${e.conversation_id ? String(e.conversation_id) : null}::uuid)::int conversation_count FROM automation_runs WHERE organization_id=${String(e.organization_id)}::uuid AND rule_id=${String(rule.id)}::uuid AND started_at>now()-interval '1 minute'`
      )[0];
      if (
        Number(recent?.organization_count ?? 0) >=
          Number(process.env.AUTOMATION_RULE_MAX_PER_MINUTE ?? 120) ||
        Number(recent?.conversation_count ?? 0) >=
          Number(process.env.AUTOMATION_CONVERSATION_MAX_PER_MINUTE ?? 10)
      ) {
        await sql`
        INSERT INTO automation_runs(
          organization_id,rule_id,version,event_id,conversation_id,
          correlation_id,status,action_count,error_code,completed_at
        ) VALUES(
          ${String(e.organization_id)}::uuid,${String(rule.id)}::uuid,
          ${Number(rule.version)},${String(e.id)}::uuid,
          ${e.conversation_id ? String(e.conversation_id) : null}::uuid,
          ${String(e.correlation_id)}::uuid,'skipped',0,
          'automation_rate_limit',now()
        )
        ON CONFLICT(rule_id,event_id) DO NOTHING`;
        continue;
      }
      const runs = await sql<
        Array<Record<string, unknown>>
      >`INSERT INTO automation_runs(organization_id,rule_id,version,version_id,event_id,conversation_id,correlation_id,limits_snapshot) VALUES(${String(e.organization_id)}::uuid,${String(rule.id)}::uuid,${Number(rule.version)},${String(rule.version_id)}::uuid,${String(e.id)}::uuid,${e.conversation_id ? String(e.conversation_id) : null}::uuid,${String(e.correlation_id)}::uuid,${sql.json(limitsSnapshot as never)}) ON CONFLICT(rule_id,event_id) DO NOTHING RETURNING id`;
      let completedPositions = new Set<number>();
      let run = runs[0];
      if (!run) {
        // A prior attempt owns this (rule, event). Failed runs are
        // retryable; a run stuck 'running' past the event stale-lock window
        // means its worker died mid-run. Both re-open and resume from the
        // step journal so completed actions are never re-executed while
        // the remaining ones finally run.
        const reopened = await sql<Array<Record<string, unknown>>>`
          UPDATE automation_runs
          SET status='running',error_code=NULL,completed_at=NULL
          WHERE rule_id=${String(rule.id)}::uuid
            AND event_id=${String(e.id)}::uuid
            AND (
              status='failed'
              OR (status='running' AND started_at<now()-interval '2 minutes')
            )
          RETURNING id`;
        if (!reopened[0]) continue;
        run = reopened[0];
        const doneSteps = await sql<Array<Record<string, unknown>>>`
          SELECT position FROM automation_run_steps
          WHERE run_id=${String(reopened[0].id)}::uuid
            AND status IN ('completed','skipped','blocked')`;
        completedPositions = new Set(
          doneSteps.map((row) => Number(row.position)),
        );
      }
      const storedActions = await sql<
        Array<Record<string, unknown>>
      >`SELECT * FROM automation_rule_actions WHERE version_id=${String(rule.version_id)}::uuid ORDER BY position`;
      const actions = plannedActions
        ? storedActions.filter((action) =>
            plannedActions!.has(Number(action.position)),
          )
        : storedActions;
      let count = 0;
      const stepStatuses: string[] = [];
      let firstStepError: string | null = null;
      for (const action of actions.slice(
        0,
        automationRuntimeConfig.maxActionsPerRun,
      )) {
        const actionPosition = Number(action.position);
        if (completedPositions.has(actionPosition)) continue;
        const config = (action.config ?? {}) as Record<string, unknown>;
        let stepResult: Record<string, unknown> = {
          status: "completed",
        };
        try {
          const configError = automationActionConfigError(
            String(action.action_type),
            config,
          );
          // Executor coverage guard: without this, an action whose branch
          // guards don't match (e.g. add_label on a conversation-less file
          // event, or an action type with no executor) fell through every
          // branch and was journaled as a successful no-op.
          const conversationRequiredActions = new Set([
            "add_label",
            "remove_label",
            "assign_user",
            "send_whatsapp_template",
            "send_group_message",
            "send_message",
            "create_bitrix_task",
            "update_bitrix_record",
          ]);
          const fileActionsSet = new Set([
            "create_patient_folder",
            "upload_drive",
            "move_file",
            "rename_file",
            "assign_file_category",
            "send_file_whatsapp",
            "create_file_share",
            "revoke_file_share",
            "archive_file",
            "assign_file_task",
            "notify_file",
          ]);
          const actionType = String(action.action_type);
          if (configError) {
            stepResult = { status: "blocked", reason: configError };
          } else if (
            !conversationRequiredActions.has(actionType) &&
            !fileActionsSet.has(actionType)
          ) {
            stepResult = {
              status: "blocked",
              reason: "automation_action_unsupported",
            };
          } else if (
            conversationRequiredActions.has(actionType) &&
            !e.conversation_id
          ) {
            stepResult = {
              status: "blocked",
              reason: "automation_action_requires_conversation",
            };
          } else if (
            action.action_type === "add_label" &&
            e.conversation_id &&
            config.labelId
          ) {
            const correlationId = crypto.randomUUID();
            const targetLabel = (
              await sql<Array<Record<string, unknown>>>`
            SELECT l.category_id,lc.selection_mode
            FROM conversation_labels l
            LEFT JOIN label_categories lc ON lc.id=l.category_id
            WHERE l.id=${String(config.labelId)}::uuid
              AND l.organization_id=${String(e.organization_id)}::uuid
              AND l.status='active' AND l.deleted_at IS NULL`
            )[0];
            if (!targetLabel) {
              stepResult = {
                status: "blocked",
                reason: "automation_label_unavailable",
              };
            } else {
              if (targetLabel.selection_mode === "single") {
                await sql`
            DELETE FROM conversation_label_assignments assignment
            USING conversation_labels sibling
            WHERE assignment.organization_id=${String(e.organization_id)}::uuid
              AND assignment.conversation_id=${String(e.conversation_id)}::uuid
              AND assignment.label_id=sibling.id
              AND sibling.category_id=${String(targetLabel.category_id)}::uuid
              AND sibling.id<>${String(config.labelId)}::uuid`;
              }
              const inserted = await sql<Array<Record<string, unknown>>>`
          INSERT INTO conversation_label_assignments(
            organization_id,conversation_id,label_id,source,automation_id,
            assigned_at,expires_at,correlation_id,metadata
          )
          SELECT ${String(e.organization_id)}::uuid,
            ${String(e.conversation_id)}::uuid,l.id,'automation',
            ${String(rule.id)}::uuid,now(),
            CASE WHEN ${config.expiresAt ? String(config.expiresAt) : null}::timestamptz IS NULL
              AND ${config.expiresInMinutes ? Number(config.expiresInMinutes) : null}::int IS NOT NULL
              THEN now()+make_interval(mins => ${config.expiresInMinutes ? Number(config.expiresInMinutes) : null}::int)
              ELSE ${config.expiresAt ? String(config.expiresAt) : null}::timestamptz END,
            ${correlationId}::uuid,
            ${sql.json({ automationRunId: String(run.id) } as never)}
          FROM conversation_labels l
          WHERE l.id=${String(config.labelId)}::uuid
            AND l.organization_id=${String(e.organization_id)}::uuid
            AND l.status='active' AND l.deleted_at IS NULL
          ON CONFLICT(conversation_id,label_id) DO NOTHING
          RETURNING *`;
              if (inserted[0]) {
                await sql`INSERT INTO label_usage_events(
            organization_id,label_id,conversation_id,event_type,source,
            automation_id,correlation_id,metadata
          ) VALUES(
            ${String(e.organization_id)}::uuid,${String(config.labelId)}::uuid,
            ${String(e.conversation_id)}::uuid,'assigned','automation',
            ${String(rule.id)}::uuid,${correlationId}::uuid,
            ${sql.json({ automationRunId: String(run.id) } as never)}
          )`;
                await sql`INSERT INTO automation_events(
            organization_id,event_type,aggregate_type,aggregate_id,
            conversation_id,correlation_id,origin,depth,payload
          ) VALUES(
            ${String(e.organization_id)}::uuid,'label_added','conversation',
            ${String(e.conversation_id)}::uuid,${String(e.conversation_id)}::uuid,
            ${correlationId}::uuid,${`automation:${String(rule.id)}`},
            ${Number(e.depth) + 1},
            ${sql.json({
              labelId: String(config.labelId),
              source: "automation",
              automationId: String(rule.id),
            } as never)}
          ) ON CONFLICT DO NOTHING`;
                await publish(
                  String(e.organization_id),
                  "conversation.label_added",
                  String(e.conversation_id),
                  String(e.conversation_id),
                  {
                    labelId: String(config.labelId),
                    source: "automation",
                    automationId: String(rule.id),
                  },
                );
              }
            }
          } else if (
            action.action_type === "remove_label" &&
            e.conversation_id &&
            config.labelId
          ) {
            const correlationId = crypto.randomUUID();
            const removed = await sql<Array<Record<string, unknown>>>`
          DELETE FROM conversation_label_assignments
          WHERE organization_id=${String(e.organization_id)}::uuid
            AND conversation_id=${String(e.conversation_id)}::uuid
            AND label_id=${String(config.labelId)}::uuid
          RETURNING *`;
            if (removed[0]) {
              await sql`INSERT INTO label_usage_events(
            organization_id,label_id,conversation_id,event_type,source,
            automation_id,correlation_id,metadata
          ) VALUES(
            ${String(e.organization_id)}::uuid,${String(config.labelId)}::uuid,
            ${String(e.conversation_id)}::uuid,'removed','automation',
            ${String(rule.id)}::uuid,${correlationId}::uuid,
            ${sql.json({ automationRunId: String(run.id) } as never)}
          )`;
              await publish(
                String(e.organization_id),
                "conversation.label_removed",
                String(e.conversation_id),
                String(e.conversation_id),
                {
                  labelId: String(config.labelId),
                  source: "automation",
                  automationId: String(rule.id),
                },
              );
            }
          } else if (
            action.action_type === "assign_user" &&
            e.conversation_id &&
            config.userId
          ) {
            const assignment = await sql.begin(async (tx) => {
              const current = (
                await tx<Array<Record<string, unknown>>>`
              SELECT assignee_id,team_id,operation_version
              FROM conversations
              WHERE id=${String(e.conversation_id)}::uuid
                AND organization_id=${String(e.organization_id)}::uuid
              FOR UPDATE`
              )[0];
              const member = (
                await tx<Array<Record<string, unknown>>>`
              SELECT u.id
              FROM users u
              JOIN organization_members member
                ON member.user_id=u.id
               AND member.organization_id=${String(e.organization_id)}::uuid
              WHERE u.id=${String(config.userId)}::uuid
                AND u.is_active=true
                AND u.suspended_at IS NULL`
              )[0];
              if (!current || !member) return null;
              const version = Number(current.operation_version ?? 0) + 1;
              await tx`
            UPDATE conversation_assignments SET
              active=false,
              unassigned_at=now()
            WHERE conversation_id=${String(e.conversation_id)}::uuid
              AND active`;
              if (
                current.assignee_id &&
                String(current.assignee_id) !== String(config.userId)
              )
                await tx`
              UPDATE agent_capacity_status SET
                active_count=GREATEST(active_count-1,0),
                updated_at=now()
              WHERE organization_id=${String(e.organization_id)}::uuid
                AND user_id=${String(current.assignee_id)}::uuid`;
              await tx`
            INSERT INTO conversation_assignments(
              organization_id,conversation_id,user_id,origin,version
            ) VALUES(
              ${String(e.organization_id)}::uuid,
              ${String(e.conversation_id)}::uuid,
              ${String(config.userId)}::uuid,'automation',${version}
            )`;
              if (String(current.assignee_id ?? "") !== String(config.userId))
                await tx`
              INSERT INTO agent_capacity_status(
                organization_id,user_id,active_count,last_assigned_at
              ) VALUES(
                ${String(e.organization_id)}::uuid,
                ${String(config.userId)}::uuid,1,now()
              )
              ON CONFLICT(organization_id,user_id) DO UPDATE SET
                active_count=agent_capacity_status.active_count+1,
                last_assigned_at=now(),
                updated_at=now()`;
              const updated = (
                await tx<Array<Record<string, unknown>>>`
              UPDATE conversations SET
                assignee_id=${String(config.userId)}::uuid,
                operation_version=${version},
                updated_at=now()
              WHERE id=${String(e.conversation_id)}::uuid
                AND organization_id=${String(e.organization_id)}::uuid
              RETURNING id,assignee_id,team_id,operation_version`
              )[0];
              await tx`
            INSERT INTO assignment_history(
              organization_id,conversation_id,from_user_id,to_user_id,
              from_team_id,reason,origin,version
            ) VALUES(
              ${String(e.organization_id)}::uuid,
              ${String(e.conversation_id)}::uuid,
              ${current.assignee_id ? String(current.assignee_id) : null}::uuid,
              ${String(config.userId)}::uuid,
              ${current.team_id ? String(current.team_id) : null}::uuid,
              ${`automation:${String(rule.id)}`},'automation',${version}
            )`;
              return updated;
            });
            if (!assignment) {
              stepResult = {
                status: "blocked",
                reason: "automation_assignee_unavailable",
              };
            } else {
              await publish(
                String(e.organization_id),
                "conversation.assigned",
                String(e.conversation_id),
                String(e.conversation_id),
                {
                  assignment,
                  source: "automation",
                  automationId: String(rule.id),
                  automationRunId: String(run.id),
                },
              );
            }
          } else if (
            action.action_type === "send_group_message" &&
            e.conversation_id
          ) {
            const mentionedJids = Array.isArray(config.mentionedJids)
              ? config.mentionedJids.filter(
                  (jid): jid is string => typeof jid === "string",
                )
              : [];
            const automationRunId = String(run.id);
            const queued = await sql.begin(async (tx) => {
              const context = (
                await tx<Array<Record<string, unknown>>>`
                SELECT conversation.channel_id,conversation.contact_id,
                  channel.provider,
                  contact.custom_fields->>'whatsappWebChatId' chat_id,
                  contact.custom_fields->>'whatsappWebConversationType' conversation_type
                FROM conversations conversation
                JOIN channels channel ON channel.id=conversation.channel_id
                JOIN contacts contact ON contact.id=conversation.contact_id
                WHERE conversation.id=${String(e.conversation_id)}::uuid
                  AND conversation.organization_id=${String(e.organization_id)}::uuid
                  AND channel.deleted_at IS NULL
                FOR UPDATE OF conversation
              `
              )[0];
              if (
                !context ||
                context.provider !== "whatsapp_web" ||
                context.conversation_type !== "group" ||
                !String(context.chat_id ?? "").endsWith("@g.us")
              )
                return { blocked: "automation_group_conversation_required" };
              const messages = await tx<Array<Record<string, unknown>>>`
              INSERT INTO messages(
                organization_id,conversation_id,channel_id,contact_id,
                client_message_id,direction,type,status,body,metadata
              )
              SELECT ${String(e.organization_id)}::uuid,
                ${String(e.conversation_id)}::uuid,
                ${String(context.channel_id)}::uuid,
                ${String(context.contact_id)}::uuid,
                gen_random_uuid(),'outbound','text','pending',
                ${String(config.text).trim()},
                ${tx.json({
                  origin: "automation",
                  automationId: String(rule.id),
                  automationRunId,
                  automationActionPosition: Number(action.position),
                  mentionedJids,
                  isGroup: true,
                  chatId: String(context.chat_id),
                } as never)}
              WHERE NOT EXISTS(
                SELECT 1 FROM messages
                WHERE organization_id=${String(e.organization_id)}::uuid
                  AND metadata->>'automationRunId'=${automationRunId}
                  AND metadata->>'automationActionPosition'=${String(action.position)}
              )
              RETURNING id
            `;
              const message = messages[0];
              if (!message) return { duplicate: true };
              await tx`
              INSERT INTO outbox_jobs(
                organization_id,aggregate_type,aggregate_id,job_type,payload
              ) VALUES(
                ${String(e.organization_id)}::uuid,'message',
                ${String(message.id)}::uuid,'message.send',
                ${tx.json({ traceId: crypto.randomUUID() } as never)}
              )
            `;
              return { messageId: String(message.id) };
            });
            if (queued.blocked) {
              stepResult = { status: "blocked", reason: queued.blocked };
            } else {
              stepResult = {
                status: "completed",
                queued: true,
                ...(queued.messageId ? { messageId: queued.messageId } : {}),
                ...(queued.duplicate ? { duplicate: true } : {}),
              };
              if (queued.messageId)
                await publish(
                  String(e.organization_id),
                  "message.created",
                  queued.messageId,
                  String(e.conversation_id),
                  { messageId: queued.messageId, origin: "automation" },
                );
            }
          } else if (
            action.action_type === "send_message" &&
            e.conversation_id
          ) {
            const automationRunId = String(run.id);
            const queued = await sql.begin(async (tx) => {
              const context = (
                await tx<Array<Record<string, unknown>>>`
                SELECT conversation.channel_id,conversation.contact_id,
                  conversation.customer_service_window_expires_at,
                  channel.status channel_status
                FROM conversations conversation
                JOIN channels channel ON channel.id=conversation.channel_id
                WHERE conversation.id=${String(e.conversation_id)}::uuid
                  AND conversation.organization_id=${String(e.organization_id)}::uuid
                  AND channel.deleted_at IS NULL
                FOR UPDATE OF conversation
              `
              )[0];
              if (!context || context.channel_status !== "connected")
                return { blocked: "automation_channel_not_connected" };
              // Meta only allows free-text (non-template) sends inside the
              // 24h customer service window opened by the customer's last
              // inbound message; outside it every send must be a template.
              const windowExpiresAt = context.customer_service_window_expires_at
                ? new Date(String(context.customer_service_window_expires_at))
                : null;
              if (!windowExpiresAt || windowExpiresAt <= new Date())
                return { blocked: "automation_message_window_closed" };
              const messages = await tx<Array<Record<string, unknown>>>`
              INSERT INTO messages(
                organization_id,conversation_id,channel_id,contact_id,
                client_message_id,direction,type,status,body,metadata
              )
              SELECT ${String(e.organization_id)}::uuid,
                ${String(e.conversation_id)}::uuid,
                ${String(context.channel_id)}::uuid,
                ${String(context.contact_id)}::uuid,
                gen_random_uuid(),'outbound','text','pending',
                ${String(config.text).trim()},
                ${tx.json({
                  origin: "automation",
                  automationId: String(rule.id),
                  automationRunId,
                  automationActionPosition: Number(action.position),
                } as never)}
              WHERE NOT EXISTS(
                SELECT 1 FROM messages
                WHERE organization_id=${String(e.organization_id)}::uuid
                  AND metadata->>'automationRunId'=${automationRunId}
                  AND metadata->>'automationActionPosition'=${String(action.position)}
              )
              RETURNING id
            `;
              const message = messages[0];
              if (!message) return { duplicate: true };
              await tx`
              INSERT INTO outbox_jobs(
                organization_id,aggregate_type,aggregate_id,job_type,payload
              ) VALUES(
                ${String(e.organization_id)}::uuid,'message',
                ${String(message.id)}::uuid,'message.send',
                ${tx.json({ traceId: crypto.randomUUID() } as never)}
              )
            `;
              return { messageId: String(message.id) };
            });
            if (queued.blocked) {
              stepResult = { status: "blocked", reason: queued.blocked };
            } else {
              stepResult = {
                status: "completed",
                queued: true,
                ...(queued.messageId ? { messageId: queued.messageId } : {}),
                ...(queued.duplicate ? { duplicate: true } : {}),
              };
              if (queued.messageId)
                await publish(
                  String(e.organization_id),
                  "message.created",
                  queued.messageId,
                  String(e.conversation_id),
                  { messageId: queued.messageId, origin: "automation" },
                );
            }
          } else if (
            action.action_type === "create_bitrix_task" &&
            e.conversation_id
          ) {
            const connection = (
              await sql<Array<Record<string, unknown>>>`
              SELECT integration.id integration_connection_id,
                integration.auth_mode,integration.portal_url,
                integration.credentials_encrypted,
                integration.settings integration_settings,
                contact.display_name contact_name,
                channel.name channel_name
              FROM conversations conversation
              JOIN channels channel ON channel.id=conversation.channel_id
              JOIN contacts contact ON contact.id=conversation.contact_id
              JOIN bitrix_open_channel_bindings binding
                ON binding.organization_id=conversation.organization_id
               AND binding.brixchat_channel_id=conversation.channel_id
               AND binding.status='active'
              JOIN integration_connections integration
                ON integration.id=binding.integration_connection_id
               AND integration.organization_id=binding.organization_id
               AND integration.provider='bitrix24'
               AND integration.status='connected'
              WHERE conversation.id=${String(e.conversation_id)}::uuid
                AND conversation.organization_id=${String(e.organization_id)}::uuid
              ORDER BY binding.updated_at DESC
              LIMIT 1
            `
            )[0];
            if (!connection) {
              stepResult = {
                status: "blocked",
                reason: "automation_bitrix_channel_binding_required",
              };
            } else if (connection.auth_mode === "fake") {
              stepResult = {
                status: "blocked",
                reason: "automation_bitrix_live_connection_required",
              };
            } else {
              const client = bitrixRestClient(
                openChannelsCrmConnection(connection),
              );
              const configuredDescription = String(
                config.description ?? "",
              ).trim();
              const conversationUrl = `${String(process.env.WEB_URL ?? "https://www.brixchat24.com").replace(/\/$/, "")}/app/inbox?conversation=${String(e.conversation_id)}`;
              const description = [
                configuredDescription,
                `BrixChat konuşması: ${conversationUrl}`,
                connection.contact_name
                  ? `Kişi/Grup: ${String(connection.contact_name)}`
                  : "",
                connection.channel_name
                  ? `Kanal: ${String(connection.channel_name)}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n\n")
                .slice(0, 5000);
              const result = await client.call<Record<string, unknown>>(
                "tasks.task.add",
                {
                  fields: {
                    TITLE: String(config.title).trim(),
                    DESCRIPTION: description,
                    RESPONSIBLE_ID: String(config.responsibleExternalUserId),
                  },
                },
              );
              const resultPayload = result.result ?? {};
              const task =
                resultPayload.task &&
                typeof resultPayload.task === "object" &&
                !Array.isArray(resultPayload.task)
                  ? (resultPayload.task as Record<string, unknown>)
                  : resultPayload;
              stepResult = {
                status: "completed",
                bitrixTaskId: String(task.id ?? task.ID ?? ""),
              };
            }
          } else if (
            action.action_type === "update_bitrix_record" &&
            e.conversation_id
          ) {
            const deliveryFailureBlock = bitrixDeliveryFailureBlockReason(
              e.event_type,
              e.payload,
            );
            if (deliveryFailureBlock) {
              stepResult = {
                status: "blocked",
                reason: deliveryFailureBlock,
              };
            } else {
              const connection = (
                await sql<Array<Record<string, unknown>>>`
              SELECT integration.id integration_connection_id,
                integration.auth_mode,integration.portal_url,
                integration.credentials_encrypted,
                integration.settings integration_settings
              FROM conversations conversation
              JOIN bitrix_open_channel_bindings binding
                ON binding.organization_id=conversation.organization_id
               AND binding.brixchat_channel_id=conversation.channel_id
               AND binding.status='active'
              JOIN integration_connections integration
                ON integration.id=binding.integration_connection_id
               AND integration.organization_id=binding.organization_id
               AND integration.provider='bitrix24'
               AND integration.status='connected'
              WHERE conversation.id=${String(e.conversation_id)}::uuid
                AND conversation.organization_id=${String(e.organization_id)}::uuid
              ORDER BY binding.updated_at DESC
              LIMIT 1
            `
              )[0];
              if (!connection) {
                stepResult = {
                  status: "blocked",
                  reason: "automation_bitrix_channel_binding_required",
                };
              } else if (connection.auth_mode === "fake") {
                stepResult = {
                  status: "blocked",
                  reason: "automation_bitrix_live_connection_required",
                };
              } else {
                const entityType = String(config.entityType);
                const link = (
                  await sql<Array<Record<string, unknown>>>`
                SELECT entity_type,external_id
                FROM crm_entity_links
                WHERE organization_id=${String(e.organization_id)}::uuid
                  AND connection_id=${String(connection.integration_connection_id)}::uuid
                  AND conversation_id=${String(e.conversation_id)}::uuid
                  AND entity_type=${entityType}
                  AND unavailable_at IS NULL
                ORDER BY updated_at DESC
                LIMIT 1
              `
                )[0];
                if (!link) {
                  stepResult = {
                    status: "blocked",
                    reason: "automation_bitrix_linked_record_required",
                  };
                } else {
                  const fields: Record<string, string> = {};
                  const stageId = String(config.stageId ?? "").trim();
                  const customFieldId = String(
                    config.customFieldId ?? "",
                  ).trim();
                  if (stageId)
                    fields[entityType === "lead" ? "STATUS_ID" : "STAGE_ID"] =
                      stageId;
                  if (customFieldId)
                    fields[customFieldId] = String(
                      config.customFieldValue ?? "",
                    );
                  const client = bitrixRestClient(
                    openChannelsCrmConnection(connection),
                  );
                  await client.call(`crm.${entityType}.update`, {
                    id: String(link.external_id),
                    fields,
                  });
                  stepResult = {
                    status: "completed",
                    bitrixEntityType: entityType,
                    stageUpdated: Boolean(stageId),
                    customFieldUpdated: Boolean(customFieldId),
                  };
                }
              }
            }
          } else if (
            [
              "create_patient_folder",
              "upload_drive",
              "move_file",
              "rename_file",
              "assign_file_category",
              "send_file_whatsapp",
              "create_file_share",
              "revoke_file_share",
              "archive_file",
              "assign_file_task",
              "notify_file",
            ].includes(String(action.action_type))
          ) {
            const eventPayload = (e.payload ?? {}) as Record<string, unknown>;
            const fileAssetId =
              typeof config.fileAssetId === "string"
                ? config.fileAssetId
                : typeof eventPayload.fileAssetId === "string"
                  ? eventPayload.fileAssetId
                  : e.aggregate_type === "file" && e.aggregate_id
                    ? String(e.aggregate_id)
                    : null;
            const asset = fileAssetId
              ? (
                  await sql<
                    Array<Record<string, unknown>>
                  >`SELECT * FROM file_assets WHERE id=${fileAssetId}::uuid AND organization_id=${String(e.organization_id)}::uuid AND deleted_at IS NULL`
                )[0]
              : null;
            if (!asset) {
              stepResult = {
                status: "blocked",
                reason: "automation_file_asset_required",
              };
            } else if (
              action.action_type === "assign_file_task" ||
              action.action_type === "notify_file"
            ) {
              const userId = String(config.userId);
              const member = (
                await sql<
                  Array<Record<string, unknown>>
                >`SELECT 1 FROM organization_members WHERE organization_id=${String(e.organization_id)}::uuid AND user_id=${userId}::uuid`
              )[0];
              if (!member)
                stepResult = {
                  status: "blocked",
                  reason: "automation_file_user_unavailable",
                };
              else {
                await sql`INSERT INTO notifications(organization_id,user_id,type,title,body,metadata) VALUES(${String(e.organization_id)}::uuid,${userId}::uuid,${String(action.action_type)},${action.action_type === "assign_file_task" ? String(config.title) : "Dosya bildirimi"},${action.action_type === "notify_file" ? String(config.message) : `Dosya görevi: ${String(asset.sanitized_name)}`},${sql.json({ fileAssetId, automationRunId: run.id } as never)})`;
                stepResult = { status: "completed", notifiedUserId: userId };
              }
            } else if (action.action_type === "send_file_whatsapp") {
              if (!e.conversation_id || !asset.internal_storage_key)
                stepResult = {
                  status: "blocked",
                  reason: "automation_file_conversation_or_content_required",
                };
              else {
                const conversation = (
                  await sql<
                    Array<Record<string, unknown>>
                  >`SELECT * FROM conversations WHERE id=${String(e.conversation_id)}::uuid AND organization_id=${String(e.organization_id)}::uuid`
                )[0];
                if (!conversation)
                  stepResult = {
                    status: "blocked",
                    reason: "automation_file_conversation_required",
                  };
                else {
                  const queued = await sql.begin(async (tx) => {
                    const message = (
                      await tx<
                        Array<Record<string, unknown>>
                      >`INSERT INTO messages(organization_id,conversation_id,channel_id,contact_id,client_message_id,direction,type,status,body,metadata) VALUES(${String(e.organization_id)}::uuid,${String(e.conversation_id)}::uuid,${String(conversation.channel_id)}::uuid,${String(conversation.contact_id)}::uuid,gen_random_uuid(),'outbound',${String(asset.mime_type).startsWith("image/") ? "image" : "document"},'pending',${String(asset.sanitized_name)},${tx.json({ origin: "automation", fileAssetId, automationRunId: run.id } as never)}) RETURNING id`
                    )[0]!;
                    const attachment = (
                      await tx<
                        Array<Record<string, unknown>>
                      >`INSERT INTO message_attachments(organization_id,message_id,channel_id,provider,provider_filename,attachment_type,storage_provider,storage_key,stored_mime_type,stored_filename,stored_size,stored_sha256,processing_status,scan_status,stored_at,file_asset_id) VALUES(${String(e.organization_id)}::uuid,${String(message.id)}::uuid,${String(conversation.channel_id)}::uuid,'files',${String(asset.sanitized_name)},${String(asset.mime_type).startsWith("image/") ? "image" : "document"},'files',${String(asset.internal_storage_key)},${String(asset.mime_type)},${String(asset.sanitized_name)},${asset.size_bytes == null ? null : Number(asset.size_bytes)},${asset.checksum_sha256 ? String(asset.checksum_sha256) : null},'stored','clean',now(),${fileAssetId}::uuid) RETURNING id`
                    )[0]!;
                    await tx`INSERT INTO outbox_jobs(organization_id,aggregate_type,aggregate_id,job_type,payload) VALUES(${String(e.organization_id)}::uuid,'message',${String(message.id)}::uuid,'message.send',${tx.json({ traceId: crypto.randomUUID(), attachmentId: attachment.id, fileAssetId } as never)})`;
                    return String(message.id);
                  });
                  stepResult = { status: "completed", messageId: queued };
                }
              }
            } else {
              if (action.action_type === "assign_file_category") {
                await sql`UPDATE file_assets SET category=${String(config.category)},updated_at=now() WHERE id=${fileAssetId}::uuid AND organization_id=${String(e.organization_id)}::uuid`;
                await emitFileAutomationEvent({
                  organizationId: String(e.organization_id),
                  eventType:
                    String(config.category) === "xray_cbct"
                      ? "file.xray_detected"
                      : "file.changed",
                  fileAssetId: String(fileAssetId),
                  conversationId: e.conversation_id
                    ? String(e.conversation_id)
                    : null,
                  payload: {
                    category: config.category,
                    automationRunId: run.id,
                  },
                  origin: "automation",
                  correlationId: String(e.correlation_id),
                  depth: Number(e.depth ?? 0) + 1,
                });
                stepResult = {
                  status: "completed",
                  fileAssetId,
                  category: config.category,
                };
              } else {
                if (action.action_type === "rename_file")
                  await sql`UPDATE file_assets SET sanitized_name=${folderPolicy.sanitize(String(config.name))},updated_at=now() WHERE id=${fileAssetId}::uuid AND organization_id=${String(e.organization_id)}::uuid`;
                if (action.action_type === "archive_file")
                  await sql`UPDATE file_assets SET status='ARCHIVED',archived_at=now(),updated_at=now() WHERE id=${fileAssetId}::uuid AND organization_id=${String(e.organization_id)}::uuid`;
                const jobType =
                  action.action_type === "move_file"
                    ? "storage.move"
                    : action.action_type === "rename_file"
                      ? "storage.rename"
                      : action.action_type === "create_file_share"
                        ? "storage.share"
                        : action.action_type === "revoke_file_share"
                          ? "storage.revoke_share"
                          : action.action_type === "archive_file"
                            ? "storage.archive"
                            : "storage.upload";
                if (!asset.provider_connection_id)
                  stepResult = {
                    status: "blocked",
                    reason: "automation_file_connection_required",
                  };
                else {
                  await sql`INSERT INTO file_processing_jobs(organization_id,file_asset_id,connection_id,job_type,payload) VALUES(${String(e.organization_id)}::uuid,${fileAssetId}::uuid,${String(asset.provider_connection_id)}::uuid,${jobType},${sql.json({ ...config, name: action.action_type === "rename_file" ? folderPolicy.sanitize(String(config.name)) : config.name } as never)}) ON CONFLICT(file_asset_id,job_type) DO UPDATE SET payload=excluded.payload,status='pending',next_attempt_at=now(),completed_at=NULL,updated_at=now()`;
                  stepResult = {
                    status: "completed",
                    queued: true,
                    fileAssetId,
                  };
                }
              }
            }
          } else if (action.action_type === "send_whatsapp_template")
            stepResult = await executeAutomationTemplateAction({
              organizationId: String(e.organization_id),
              conversationId: e.conversation_id
                ? String(e.conversation_id)
                : null,
              ruleId: String(rule.id),
              runId: String(run.id),
              config,
            });
        } catch (actionError) {
          // Per-action isolation: one throwing action must not abort the
          // rest of the rule; it is journaled as failed and retried alone
          // on the next event attempt via the resume path above.
          stepResult = {
            status: "failed",
            reason: redactedAutomationError(actionError),
          };
        }
        const plannedNode = plannedActions?.get(Number(action.position));
        await sql`INSERT INTO automation_run_steps(organization_id,run_id,position,step_type,node_id,node_version,selected_port,attempt,status,input,output,input_summary,output_summary,error_code,completed_at) VALUES(${String(e.organization_id)}::uuid,${String(run.id)}::uuid,${actionPosition},${String(action.action_type)},${plannedNode?.nodeId ?? null},${plannedNode?.nodeVersion ?? null},${String(stepResult.status ?? "completed") === "completed" ? "success" : "error"},${Number(e.attempt_count ?? 1)},${String(stepResult.status ?? "completed")},${sql.json(config as never)},${sql.json(stepResult as never)},${sql.json({ keys: Object.keys(config).sort() } as never)},${sql.json({ status: stepResult.status ?? "completed" } as never)},${stepResult.reason ? String(stepResult.reason) : null},now()) ON CONFLICT(run_id,position) DO UPDATE SET status=EXCLUDED.status,selected_port=EXCLUDED.selected_port,attempt=EXCLUDED.attempt,output=EXCLUDED.output,output_summary=EXCLUDED.output_summary,error_code=EXCLUDED.error_code,completed_at=EXCLUDED.completed_at`;
        stepStatuses.push(String(stepResult.status ?? "completed"));
        if (!firstStepError && stepResult.reason)
          firstStepError = String(stepResult.reason);
        count++;
      }
      // Final status comes from the journal, not this pass's memory, so a
      // resumed run also accounts for the steps completed in earlier passes.
      const journal = await sql<Array<Record<string, unknown>>>`
        SELECT status,error_code FROM automation_run_steps
        WHERE run_id=${String(run.id)}::uuid ORDER BY position`;
      const journalStatuses = journal.map((row) => String(row.status));
      const journalError =
        journal.find((row) => row.error_code)?.error_code ?? null;
      const runStatus = journalStatuses.includes("failed")
        ? "failed"
        : journalStatuses.includes("blocked")
          ? "blocked"
          : journalStatuses.length > 0 &&
              journalStatuses.every((status) => status === "skipped")
            ? "skipped"
            : "completed";
      await sql`UPDATE automation_runs SET status=${runStatus},action_count=${journalStatuses.length},error_code=${journalError ? String(journalError) : firstStepError},completed_at=now() WHERE id=${String(run.id)}::uuid`;
      await sql`UPDATE automation_rules SET last_run_at=now() WHERE id=${String(rule.id)}::uuid`;
      if (runStatus === "failed")
        // Drive the event into its retry schedule; the reopen/resume path
        // will re-execute only the failed positions next attempt.
        throw new Error(
          journalError ? String(journalError) : "automation_action_failed",
        );
      if (rule.stop_processing) break;
    }
    await sql`UPDATE automation_events SET status='completed',processed_at=now(),locked_at=NULL,locked_by=NULL,last_error_code=NULL WHERE id=${String(e.id)}::uuid`;
  } catch (error) {
    const errorCode = redactedAutomationError(error);
    const decision = automationFailureDecision(
      Number(e.attempt_count ?? 1),
      Number(e.max_attempts ?? 5),
    );
    await sql.begin(async (tx) => {
      await tx`
        UPDATE automation_runs SET
          status='failed',
          error_code=${errorCode},
          completed_at=now()
        WHERE event_id=${String(e.id)}::uuid
          AND status='running'`;
      await tx`
        UPDATE automation_events SET
          status=${decision.status},
          next_attempt_at=CASE
            WHEN ${decision.status}='retry'
              THEN now()+(${decision.delayMs}::int*interval '1 millisecond')
            ELSE next_attempt_at
          END,
          last_error_code=${errorCode},
          processed_at=CASE
            WHEN ${decision.status}='dead_letter' THEN now()
            ELSE NULL
          END,
          locked_at=NULL,
          locked_by=NULL
        WHERE id=${String(e.id)}::uuid`;
    });
  }
}

async function processLabelBulkJob() {
  const jobs = await sql<Array<Record<string, unknown>>>`
    WITH candidate AS(
      SELECT id FROM label_bulk_jobs
      WHERE status='pending'
        OR (status='processing' AND (locked_at IS NULL OR locked_at<now()-interval '5 minutes'))
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE label_bulk_jobs j SET
      status='processing',locked_at=now(),locked_by=${workerId},updated_at=now()
    FROM candidate
    WHERE j.id=candidate.id
    RETURNING j.*`;
  const job = jobs[0];
  if (!job) return;
  try {
    const member = (
      await sql<Array<Record<string, unknown>>>`
        SELECT role FROM organization_members
        WHERE organization_id=${String(job.organization_id)}::uuid
          AND user_id=${String(job.requested_by)}::uuid`
    )[0];
    if (!member) throw new Error("LABEL_BULK_REQUESTER_INACTIVE");
    const ids = (job.conversation_ids as string[]) ?? [];
    const accessible = await sql<Array<Record<string, unknown>>>`
      SELECT c.id
      FROM conversations c
      WHERE c.organization_id=${String(job.organization_id)}::uuid
        AND c.id=ANY(${ids}::uuid[])
        AND (
          ${["owner", "admin"].includes(String(member.role))}
          OR EXISTS(
            SELECT 1 FROM channel_user_ownership cuo
            WHERE cuo.organization_id=c.organization_id
              AND cuo.channel_id=c.channel_id
              AND cuo.user_id=${String(job.requested_by)}::uuid
          )
        )`;
    const accessibleIds = accessible.map((row) => String(row.id));
    const result = await sql.begin(async (tx) => {
      let changed: Array<Record<string, unknown>> = [];
      if (job.operation === "add") {
        const label = (
          await tx<Array<Record<string, unknown>>>`
            SELECT l.id,l.category_id,lc.selection_mode
            FROM conversation_labels l
            LEFT JOIN label_categories lc ON lc.id=l.category_id
            WHERE l.id=${String(job.label_id)}::uuid
              AND l.organization_id=${String(job.organization_id)}::uuid
              AND l.status='active' AND l.deleted_at IS NULL`
        )[0];
        if (!label) throw new Error("LABEL_BULK_LABEL_UNAVAILABLE");
        if (label.category_id && label.selection_mode === "single")
          await tx`
            DELETE FROM conversation_label_assignments a
            USING conversation_labels existing
            WHERE a.organization_id=${String(job.organization_id)}::uuid
              AND a.conversation_id=ANY(${accessibleIds}::uuid[])
              AND a.label_id=existing.id
              AND existing.category_id=${String(label.category_id)}::uuid
              AND existing.id<>${String(job.label_id)}::uuid`;
        changed = await tx<Array<Record<string, unknown>>>`
          INSERT INTO conversation_label_assignments(
            organization_id,conversation_id,label_id,assigned_by,source,assigned_at
          )
          SELECT ${String(job.organization_id)}::uuid,id,
            ${String(job.label_id)}::uuid,${String(job.requested_by)}::uuid,
            'manual',now()
          FROM unnest(${accessibleIds}::uuid[]) id
          ON CONFLICT(conversation_id,label_id) DO NOTHING
          RETURNING conversation_id`;
      } else if (job.operation === "remove") {
        changed = await tx<Array<Record<string, unknown>>>`
          DELETE FROM conversation_label_assignments
          WHERE organization_id=${String(job.organization_id)}::uuid
            AND conversation_id=ANY(${accessibleIds}::uuid[])
            AND label_id=${String(job.label_id)}::uuid
          RETURNING conversation_id`;
      } else {
        await tx`
          DELETE FROM conversation_label_assignments
          WHERE organization_id=${String(job.organization_id)}::uuid
            AND conversation_id=ANY(${accessibleIds}::uuid[])
            AND label_id=${String(job.label_id)}::uuid`;
        changed = await tx<Array<Record<string, unknown>>>`
          INSERT INTO conversation_label_assignments(
            organization_id,conversation_id,label_id,assigned_by,source,assigned_at
          )
          SELECT ${String(job.organization_id)}::uuid,id,
            ${String(job.replacement_label_id)}::uuid,
            ${String(job.requested_by)}::uuid,'manual',now()
          FROM unnest(${accessibleIds}::uuid[]) id
          ON CONFLICT(conversation_id,label_id) DO NOTHING
          RETURNING conversation_id`;
      }
      await tx`INSERT INTO audit_logs(
        organization_id,actor_id,action,entity_type,entity_id,metadata
      ) VALUES(
        ${String(job.organization_id)}::uuid,${String(job.requested_by)}::uuid,
        'label.bulk_completed','label_job',${String(job.id)}::uuid,
        ${tx.json({
          operation: String(job.operation),
          requested: ids.length,
          accessible: accessibleIds.length,
          changed: changed.length,
        } as never)}
      )`;
      return changed.length;
    });
    const skipped = ids.length - accessibleIds.length;
    await sql`UPDATE label_bulk_jobs SET
      status=${skipped ? "partial" : "completed"},
      processed_count=${result},skipped_count=${skipped},
      result=${sql.json({ changed: result, skipped } as never)},
      completed_at=now(),locked_at=NULL,locked_by=NULL,updated_at=now()
      WHERE id=${String(job.id)}::uuid`;
    await publish(
      String(job.organization_id),
      "labels.bulk_completed",
      String(job.id),
      String(job.id),
      { jobId: String(job.id), changed: result, skipped },
    );
  } catch (error) {
    await sql`UPDATE label_bulk_jobs SET
      status='failed',failed_count=total_count,
      error_code=${error instanceof Error ? error.message : "LABEL_BULK_FAILED"},
      completed_at=now(),locked_at=NULL,locked_by=NULL,updated_at=now()
      WHERE id=${String(job.id)}::uuid`;
  }
}

async function processExpiredLabels() {
  const expired = await sql<Array<Record<string, unknown>>>`
    WITH candidates AS(
      SELECT organization_id,conversation_id,label_id
      FROM conversation_label_assignments
      WHERE expires_at IS NOT NULL AND expires_at<=now()
      ORDER BY expires_at
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM conversation_label_assignments a
    USING candidates c
    WHERE a.organization_id=c.organization_id
      AND a.conversation_id=c.conversation_id
      AND a.label_id=c.label_id
    RETURNING a.organization_id,a.conversation_id,a.label_id`;
  for (const item of expired) {
    const correlationId = crypto.randomUUID();
    await sql`INSERT INTO label_usage_events(
      organization_id,label_id,conversation_id,event_type,source,correlation_id
    ) VALUES(
      ${String(item.organization_id)}::uuid,${String(item.label_id)}::uuid,
      ${String(item.conversation_id)}::uuid,'expired','system',
      ${correlationId}::uuid
    )`;
    await publish(
      String(item.organization_id),
      "conversation.label_removed",
      String(item.conversation_id),
      String(item.conversation_id),
      {
        labelId: String(item.label_id),
        source: "system",
        reason: "expired",
      },
    );
  }
}

function openChannelsCrmConnection(
  row: Record<string, unknown>,
): CrmConnection {
  return {
    connectionId: String(row.integration_connection_id),
    authMode: String(row.auth_mode),
    portalUrl: row.portal_url ? String(row.portal_url) : null,
    credentialsEncrypted: row.credentials_encrypted
      ? String(row.credentials_encrypted)
      : null,
    settings: (row.integration_settings ?? {}) as Record<string, unknown>,
  };
}

function workerOpenChannelsConnector(row: Record<string, unknown>) {
  return String(row.auth_mode) === "fake"
    ? new FakeBitrixOpenChannelsConnector()
    : new BitrixRestOpenChannelsConnector(
        bitrixRestClient(openChannelsCrmConnection(row)),
        {
          connectorId: String(row.connector_id),
          placementHandler: String(
            process.env.WEB_URL ?? "https://www.brixchat24.com",
          ),
        },
      );
}

async function completeOpenChannelsJob(id: string) {
  await sql.begin(async (tx) => {
    const completed = await tx<Array<Record<string, unknown>>>`
      UPDATE bitrix_open_channel_jobs
      SET status='completed',completed_at=now(),last_error=NULL,
        locked_at=NULL,locked_by=NULL,updated_at=now()
      WHERE id=${id}::uuid AND status='processing'
      RETURNING organization_id,integration_connection_id,conversation_id,job_type`;
    const job = completed[0];
    if (!job || String(job.job_type) !== "open_channels.crm") return;
    await tx`
      WITH next_job AS (
        SELECT id FROM bitrix_open_channel_jobs
        WHERE organization_id=${String(job.organization_id)}::uuid
          AND integration_connection_id=${String(job.integration_connection_id)}::uuid
          AND conversation_id=${String(job.conversation_id)}::uuid
          AND job_type='open_channels.crm'
          AND status='blocked'
        ORDER BY created_at,id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE bitrix_open_channel_jobs queued
      SET status='pending',last_error=NULL,next_attempt_at=now(),updated_at=now()
      FROM next_job
      WHERE queued.id=next_job.id`;
  });
}

async function archiveCrmJobsForExcludedContact(input: {
  job: Record<string, unknown>;
  normalizedPhone: string;
}) {
  const excluded = (
    await sql<Array<{ excluded: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM crm_contact_exclusions exclusion
        WHERE exclusion.organization_id=${String(input.job.organization_id)}::uuid
          AND exclusion.normalized_phone=${input.normalizedPhone}
          AND exclusion.archived_at IS NULL
      ) AS excluded`
  )[0]?.excluded;
  if (!excluded) return false;
  await sql`
    UPDATE bitrix_open_channel_jobs
    SET status='archived',completed_at=now(),last_error='CRM_CONTACT_EXCLUDED',
      locked_at=NULL,locked_by=NULL,updated_at=now()
    WHERE organization_id=${String(input.job.organization_id)}::uuid
      AND integration_connection_id=${String(input.job.integration_connection_id)}::uuid
      AND conversation_id=${String(input.job.conversation_id)}::uuid
      AND job_type='open_channels.crm'
      AND status IN(
        'pending','retry','processing','manual_review','dead_letter','blocked'
      )`;
  return true;
}

async function linkOpenChannelsCrmEntity(input: {
  job: Record<string, unknown>;
  message: Record<string, unknown>;
  entityType: string;
  externalId: string;
  source: "phone" | "created" | "inherited";
}) {
  await sql`INSERT INTO crm_entity_links(organization_id,connection_id,conversation_id,contact_id,entity_type,external_id,match_source,match_confidence) VALUES(${String(input.job.organization_id)}::uuid,${String(input.job.integration_connection_id)}::uuid,${String(input.job.conversation_id)}::uuid,${String(input.message.contact_id)}::uuid,${input.entityType},${input.externalId},${input.source},1) ON CONFLICT(connection_id,conversation_id,entity_type) DO UPDATE SET external_id=EXCLUDED.external_id,match_source=EXCLUDED.match_source,match_confidence=1,unavailable_at=NULL,updated_at=now()`;
}

async function processOpenChannelsCrmJob(
  job: Record<string, unknown>,
  connection: Record<string, unknown>,
  message: Record<string, unknown>,
) {
  const lockKey = openChannelsCustomerLockKey({
    organizationId: String(job.organization_id),
    connectionId: String(job.integration_connection_id),
    normalizedPhone: String(message.normalized_phone),
  });
  await sql.begin(async (lock) => {
    await lock`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey},0))`;
    await processOpenChannelsCrmJobLocked(job, connection, message);
  });
}

async function processOpenChannelsCrmJobLocked(
  job: Record<string, unknown>,
  connection: Record<string, unknown>,
  message: Record<string, unknown>,
) {
  if (
    await archiveCrmJobsForExcludedContact({
      job,
      normalizedPhone: String(message.normalized_phone),
    })
  )
    return;
  const channelSettings = (connection.binding_settings ?? {}) as Record<
    string,
    unknown
  >;
  const mappedPolicy =
    String(message.direction) === "outbound" && message.sender_id
      ? (
          await sql<
            Array<{
              crm_policy: Record<string, unknown>;
              external_user_id: string;
            }>
          >`SELECT crm_policy,external_user_id
            FROM crm_user_mappings
            WHERE organization_id=${String(job.organization_id)}::uuid
              AND connection_id=${String(job.integration_connection_id)}::uuid
              AND local_user_id=${String(message.sender_id)}::uuid
              AND active=true
            LIMIT 1`
        )[0]
      : undefined;
  const resolvedSettings = resolveOpenChannelsAutoCrmSettings({
    direction: String(message.direction),
    channel: {
      mode: String(channelSettings.autoCrmMode ?? "disabled") as
        "disabled" | "lead" | "contact_and_deal",
      sourceId: String(channelSettings.crmSourceId ?? "WEB"),
      responsibleExternalUserId:
        typeof channelSettings.responsibleExternalUserId === "string"
          ? channelSettings.responsibleExternalUserId
          : null,
      ...(typeof channelSettings.pipelineId === "string"
        ? { pipelineId: channelSettings.pipelineId }
        : {}),
      ...(typeof channelSettings.stageId === "string"
        ? { stageId: channelSettings.stageId }
        : {}),
    },
    ...(mappedPolicy
      ? {
          userPolicy: mappedPolicy.crm_policy as {
            mode?: "inherit" | "disabled" | "lead" | "contact_and_deal";
            sourceId?: string;
          },
          mappedExternalUserId: mappedPolicy.external_user_id,
        }
      : {}),
  });
  const settings = {
    ...channelSettings,
    autoCrmMode: resolvedSettings.mode,
    crmSourceId: resolvedSettings.sourceId,
    responsibleExternalUserId: resolvedSettings.responsibleExternalUserId,
    pipelineId: resolvedSettings.pipelineId,
    stageId: resolvedSettings.stageId,
  } as Record<string, unknown>;
  const mode = String(settings.autoCrmMode ?? "disabled");
  if (mode === "disabled") {
    await crmRepository.enqueueTimeline({
      organizationId: String(job.organization_id),
      messageId: String(job.local_message_id),
      conversationId: String(job.conversation_id),
    });
    await completeOpenChannelsJob(String(job.id));
    return;
  }
  const contactCustomFields = (message.custom_fields ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof contactCustomFields.telegramChatId === "string") {
    await crmRepository.enqueueTimeline({
      organizationId: String(job.organization_id),
      messageId: String(job.local_message_id),
      conversationId: String(job.conversation_id),
    });
    await completeOpenChannelsJob(String(job.id));
    return;
  }
  // Group chats must never produce Bitrix CRM records: their "phone" is a
  // group identity, not a customer, so no lead/contact/deal is ever right.
  if (contactCustomFields.whatsappWebConversationType === "group") {
    await completeOpenChannelsJob(String(job.id));
    return;
  }
  if (
    mode !== "lead" &&
    contactCustomFields.whatsappWebPhoneResolved === false
  ) {
    await completeOpenChannelsJob(String(job.id));
    return;
  }
  const localLinkRows = await sql<
    Array<Record<string, unknown>>
  >`SELECT link.conversation_id,link.entity_type,link.external_id,link.match_source
      FROM crm_entity_links link
      LEFT JOIN conversations linked_conversation
        ON linked_conversation.id=link.conversation_id
       AND linked_conversation.organization_id=link.organization_id
      WHERE link.organization_id=${String(job.organization_id)}::uuid
        AND link.connection_id=${String(job.integration_connection_id)}::uuid
        AND COALESCE(link.contact_id,linked_conversation.contact_id)=${String(message.contact_id)}::uuid
        AND link.unavailable_at IS NULL
      ORDER BY (link.conversation_id=${String(job.conversation_id)}::uuid) DESC,link.created_at`;
  const reusable = resolveReusableCustomerLinks(
    localLinkRows.map((link) => ({
      entityType: String(link.entity_type) as
        "contact" | "lead" | "deal" | "company",
      externalId: String(link.external_id),
      matchSource: String(link.match_source) as
        "phone" | "created" | "inherited",
    })),
  );
  if (reusable.status === "manual_review") {
    await sql`UPDATE bitrix_open_channel_jobs SET status='manual_review',last_error='CRM_LOCAL_IDENTITY_CONFLICT',locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid`;
    return;
  }
  for (const link of reusable.links) {
    const alreadyLinked = localLinkRows.some(
      (row) =>
        String(row.conversation_id) === String(job.conversation_id) &&
        String(row.entity_type) === link.entityType &&
        String(row.external_id) === link.externalId,
    );
    if (!alreadyLinked)
      await linkOpenChannelsCrmEntity({
        job,
        message,
        entityType: link.entityType,
        externalId: link.externalId,
        source: "inherited",
      });
  }
  const existingLinks = reusable.links;
  const provider = crmProvider(openChannelsCrmConnection(connection));
  if (mode === "lead" && settings.incomingEnabled !== false) {
    const session = (
      await sql<
        Array<Record<string, unknown>>
      >`SELECT external_chat_id,external_session_id
        FROM bitrix_open_channel_sessions
        WHERE organization_id=${String(job.organization_id)}::uuid
          AND integration_connection_id=${String(job.integration_connection_id)}::uuid
          AND conversation_id=${String(job.conversation_id)}::uuid`
    )[0];
    if (!session) {
      await sql`UPDATE bitrix_open_channel_jobs SET
        status='retry',next_attempt_at=now()+interval '1 second',
        attempt_count=GREATEST(attempt_count-1,0),
        locked_at=NULL,locked_by=NULL,updated_at=now()
        WHERE id=${String(job.id)}::uuid`;
      return;
    }
    const connector = workerOpenChannelsConnector(connection);
    const sessionLead = await connector.findLeadForChat({
      chatId: String(session.external_chat_id),
      sessionId: String(session.external_session_id),
    });
    if (sessionLead.status === "active") {
      await linkOpenChannelsCrmEntity({
        job,
        message,
        entityType: "lead",
        externalId: sessionLead.externalId,
        source: "created",
      });
      const responsibleExternalUserId =
        resolveOpenChannelsLeadResponsibleOverride({
          ownership: "bitrix_open_channel",
          configuredExternalUserId:
            typeof settings.responsibleExternalUserId === "string"
              ? settings.responsibleExternalUserId
              : null,
        });
      if (responsibleExternalUserId) {
        await provider.updateResponsible({
          entityType: "lead",
          externalId: sessionLead.externalId,
          externalUserId: responsibleExternalUserId,
          idempotencyKey: `open-channels:${String(job.conversation_id)}:lead:responsible`,
        });
      }
      await crmRepository.enqueueTimeline({
        organizationId: String(job.organization_id),
        messageId: String(job.local_message_id),
        conversationId: String(job.conversation_id),
      });
      await completeOpenChannelsJob(String(job.id));
      return;
    }

    let hasActiveLocalLink = false;
    for (const link of existingLinks) {
      const entity = {
        entityType: link.entityType,
        externalId: link.externalId,
      };
      try {
        await provider.getContext(entity);
        hasActiveLocalLink = true;
      } catch (error) {
        const code =
          typeof error === "object" && error !== null
            ? String((error as { code?: unknown }).code ?? "")
            : "";
        if (code !== "NOT_FOUND") throw error;
        await sql`UPDATE crm_entity_links link SET unavailable_at=now(),updated_at=now() WHERE link.organization_id=${String(job.organization_id)}::uuid AND link.connection_id=${String(job.integration_connection_id)}::uuid AND COALESCE(link.contact_id,(SELECT conversation.contact_id FROM conversations conversation WHERE conversation.id=link.conversation_id AND conversation.organization_id=link.organization_id))=${String(message.contact_id)}::uuid AND link.entity_type=${entity.entityType} AND link.external_id=${entity.externalId} AND link.unavailable_at IS NULL`;
      }
    }
    if (!hasActiveLocalLink) {
      const match = await matchOpenChannelsCustomerToExistingCrm({
        provider,
        customer: {
          conversationId: String(job.conversation_id),
          displayName: String(message.display_name ?? "WhatsApp"),
          normalizedPhone: String(message.normalized_phone),
          ...(message.email ? { email: String(message.email) } : {}),
        },
        linkEntity: async (entity, source) =>
          linkOpenChannelsCrmEntity({
            job,
            message,
            entityType: entity.entityType,
            externalId: entity.externalId,
            source,
          }),
      });
      if (match.status === "manual_review") {
        await sql`UPDATE bitrix_open_channel_jobs SET status='manual_review',last_error='CRM_MATCH_AMBIGUOUS',locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid AND status='processing'`;
        return;
      }
      if (match.status === "not_found") {
        if (sessionLead.status === "stale")
          throw new OpenChannelsError("BITRIX_CRM_LINK_STALE", false);
        try {
          const lead = await connector.ensureLeadForChat({
            chatId: String(session.external_chat_id),
            sessionId: String(session.external_session_id),
            phone: String(message.normalized_phone),
          });
          await linkOpenChannelsCrmEntity({
            job,
            message,
            entityType: "lead",
            externalId: lead.externalId,
            source: "created",
          });
          const responsibleExternalUserId =
            resolveOpenChannelsLeadResponsibleOverride({
              ownership: "bitrix_open_channel",
              configuredExternalUserId:
                typeof settings.responsibleExternalUserId === "string"
                  ? settings.responsibleExternalUserId
                  : null,
            });
          if (responsibleExternalUserId) {
            await provider.updateResponsible({
              entityType: "lead",
              externalId: lead.externalId,
              externalUserId: responsibleExternalUserId,
              idempotencyKey: `open-channels:${String(job.conversation_id)}:lead:responsible`,
            });
          }
        } catch (error) {
          if (!shouldFallbackToDirectCrmLead(error)) throw error;
          const fallback = await syncOpenChannelsCustomerToCrm({
            provider,
            settings: {
              mode: "lead",
              sourceId: String(settings.crmSourceId ?? "WEB"),
              responsibleExternalUserId:
                resolveOpenChannelsLeadResponsibleOverride({
                  ownership: "direct_crm",
                  configuredExternalUserId:
                    typeof settings.responsibleExternalUserId === "string"
                      ? settings.responsibleExternalUserId
                      : null,
                }),
            },
            customer: {
              conversationId: String(job.conversation_id),
              displayName: String(message.display_name ?? "WhatsApp"),
              normalizedPhone: String(message.normalized_phone),
              ...(message.email ? { email: String(message.email) } : {}),
            },
            existingLinks,
            linkEntity: async (entity, source) =>
              linkOpenChannelsCrmEntity({
                job,
                message,
                entityType: entity.entityType,
                externalId: entity.externalId,
                source,
              }),
            markEntityUnavailable: async (entity) => {
              await sql`UPDATE crm_entity_links link SET unavailable_at=now(),updated_at=now() WHERE link.organization_id=${String(job.organization_id)}::uuid AND link.connection_id=${String(job.integration_connection_id)}::uuid AND COALESCE(link.contact_id,(SELECT conversation.contact_id FROM conversations conversation WHERE conversation.id=link.conversation_id AND conversation.organization_id=link.organization_id))=${String(message.contact_id)}::uuid AND link.entity_type=${entity.entityType} AND link.external_id=${entity.externalId} AND link.unavailable_at IS NULL`;
            },
          });
          if (fallback.status === "manual_review") {
            await sql`UPDATE bitrix_open_channel_jobs SET status='manual_review',last_error='CRM_MATCH_AMBIGUOUS',locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid AND status='processing'`;
            return;
          }
        }
      }
    }
    await crmRepository.enqueueTimeline({
      organizationId: String(job.organization_id),
      messageId: String(job.local_message_id),
      conversationId: String(job.conversation_id),
    });
    await completeOpenChannelsJob(String(job.id));
    return;
  }
  const result = await syncOpenChannelsCustomerToCrm({
    provider,
    settings: {
      mode: mode === "lead" || mode === "contact_and_deal" ? mode : "disabled",
      sourceId: String(settings.crmSourceId ?? "WEB"),
      responsibleExternalUserId: resolveOpenChannelsLeadResponsibleOverride({
        ownership: "direct_crm",
        configuredExternalUserId:
          typeof settings.responsibleExternalUserId === "string"
            ? settings.responsibleExternalUserId
            : null,
      }),
      ...(typeof settings.pipelineId === "string"
        ? { pipelineId: settings.pipelineId }
        : {}),
      ...(typeof settings.stageId === "string"
        ? { stageId: settings.stageId }
        : {}),
    },
    customer: {
      conversationId: String(job.conversation_id),
      displayName: String(message.display_name ?? "WhatsApp"),
      normalizedPhone: String(message.normalized_phone),
      ...(message.email ? { email: String(message.email) } : {}),
    },
    existingLinks,
    linkEntity: async (entity, source) =>
      linkOpenChannelsCrmEntity({
        job,
        message,
        entityType: entity.entityType,
        externalId: entity.externalId,
        source,
      }),
    markEntityUnavailable: async (entity) => {
      await sql`UPDATE crm_entity_links link SET unavailable_at=now(),updated_at=now() WHERE link.organization_id=${String(job.organization_id)}::uuid AND link.connection_id=${String(job.integration_connection_id)}::uuid AND COALESCE(link.contact_id,(SELECT conversation.contact_id FROM conversations conversation WHERE conversation.id=link.conversation_id AND conversation.organization_id=link.organization_id))=${String(message.contact_id)}::uuid AND link.entity_type=${entity.entityType} AND link.external_id=${entity.externalId} AND link.unavailable_at IS NULL`;
    },
  });
  if (result.status === "manual_review") {
    await sql`UPDATE bitrix_open_channel_jobs SET status='manual_review',last_error='CRM_MATCH_AMBIGUOUS',locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(job.id)}::uuid AND status='processing'`;
    return;
  }
  await crmRepository.enqueueTimeline({
    organizationId: String(job.organization_id),
    messageId: String(job.local_message_id),
    conversationId: String(job.conversation_id),
  });
  await completeOpenChannelsJob(String(job.id));
}

async function processOpenChannelsJob() {
  const rows = await sql<Array<Record<string, unknown>>>`WITH candidate AS(
      SELECT j.id
      FROM bitrix_open_channel_jobs j
      JOIN integration_connections ic
        ON ic.id=j.integration_connection_id
       AND ic.status='connected'
       AND ic.open_channels_status='active'
      JOIN messages message
        ON message.id=j.local_message_id
       AND message.organization_id=j.organization_id
      JOIN bitrix_open_channel_bindings binding
        ON binding.integration_connection_id=j.integration_connection_id
       AND binding.organization_id=j.organization_id
       AND binding.brixchat_channel_id=message.channel_id
       AND binding.status='active'
      WHERE (j.status IN('pending','retry')
        OR (j.status='processing' AND (j.locked_at IS NULL OR j.locked_at<now()-interval '5 minutes')))
        AND j.next_attempt_at<=now()
      ORDER BY j.next_attempt_at,j.created_at
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1
    )
    UPDATE bitrix_open_channel_jobs j
    SET status='processing',locked_at=now(),locked_by=${workerId},
      attempt_count=j.attempt_count+1
    FROM candidate
    WHERE j.id=candidate.id
    RETURNING j.*`;
  const j = rows[0];
  if (!j) return;
  try {
    const c = (
      await sql<Array<Record<string, unknown>>>`SELECT
          connector.*,
          binding.id AS binding_id,
          binding.connector_id AS binding_connector_id,
          binding.line_id AS binding_line_id,
          binding.settings AS binding_settings,
          binding.brixchat_channel_id,
          ic.auth_mode,
          ic.status AS integration_status,
          ic.portal_url,
          ic.credentials_encrypted,
          ic.auth_external_user_id,
          ic.settings AS integration_settings
        FROM messages message
        JOIN bitrix_open_channel_bindings binding
          ON binding.organization_id=message.organization_id
         AND binding.integration_connection_id=${String(j.integration_connection_id)}::uuid
         AND binding.brixchat_channel_id=message.channel_id
         AND binding.status='active'
        JOIN bitrix_open_channel_connectors connector
          ON connector.integration_connection_id=binding.integration_connection_id
        JOIN integration_connections ic
          ON ic.id=binding.integration_connection_id
        WHERE message.id=${String(j.local_message_id)}::uuid`
    )[0];
    if (!c || !j.local_message_id)
      throw new Error("OPEN_CHANNEL_NOT_REGISTERED");
    if (String(c.integration_status) !== "connected")
      throw new Error("BITRIX_INTEGRATION_NOT_CONNECTED");
    const m = (
      await sql<
        Array<Record<string, unknown>>
      >`SELECT m.*,ct.id AS contact_id,ct.normalized_phone,ct.display_name,ct.email,ct.custom_fields FROM messages m JOIN contacts ct ON ct.id=m.contact_id WHERE m.id=${String(j.local_message_id)}::uuid`
    )[0];
    if (!m) throw new Error("MESSAGE_NOT_FOUND");
    if (String(j.job_type) === "open_channels.delivery") {
      const openChannelsSettings = (c.binding_settings ?? {}) as Record<
        string,
        unknown
      >;
      if (openChannelsSettings.deliveryStatusSync === false) {
        await completeOpenChannelsJob(String(j.id));
        return;
      }
      const metadata = (m.metadata ?? {}) as Record<string, unknown>;
      const providerMessageId = String(
        ((j.payload ?? {}) as Record<string, unknown>).providerMessageId ??
          m.provider_message_id ??
          "",
      );
      if (
        !providerMessageId ||
        typeof metadata.bitrixImChatId !== "string" ||
        typeof metadata.bitrixMessageId !== "string" ||
        typeof metadata.bitrixExternalChatId !== "string"
      )
        throw new Error("OPEN_CHANNELS_DELIVERY_CONTEXT_MISSING");
      await workerOpenChannelsConnector(c).acknowledgeDelivery({
        connectorId: String(c.binding_connector_id),
        lineId: String(c.binding_line_id),
        imChatId: metadata.bitrixImChatId,
        imMessageId: metadata.bitrixMessageId,
        externalChatId: metadata.bitrixExternalChatId,
        externalMessageId: providerMessageId,
      });
      await completeOpenChannelsJob(String(j.id));
      return;
    }
    if (String(j.job_type) === "open_channels.crm") {
      await processOpenChannelsCrmJob(j, c, m);
      return;
    }
    const connector = workerOpenChannelsConnector(c);
    const existingSession = (
      await sql<Array<Record<string, unknown>>>`SELECT external_user_code
        FROM bitrix_open_channel_sessions
        WHERE integration_connection_id=${String(j.integration_connection_id)}::uuid
          AND conversation_id=${String(j.conversation_id)}::uuid`
    )[0];
    const messageMetadata = (m.metadata ?? {}) as Record<string, unknown>;
    const contactCustomFields = (m.custom_fields ?? {}) as Record<
      string,
      unknown
    >;
    const isGroup =
      messageMetadata.isGroup === true ||
      contactCustomFields.whatsappWebConversationType === "group";
    const usesWhatsAppExternalIdentity =
      isGroup || contactCustomFields.whatsappWebPhoneResolved === false;
    const externalUserCode = String(
      existingSession?.external_user_code ??
        (usesWhatsAppExternalIdentity
          ? (contactCustomFields.whatsappWebChatId ??
            messageMetadata.chatId ??
            contactCustomFields.telegramChatId)
          : m.normalized_phone),
    );
    const payload = (j.payload ?? {}) as Record<string, unknown>,
      outgoingMirror = String(j.job_type) === "open_channels.outgoing";
    const mappedManager = outgoingMirror
      ? (
          await sql<Array<{ external_user_id: string }>>`
            SELECT external_user_id FROM (
              SELECT mapping.external_user_id,0 AS priority
              FROM crm_user_mappings mapping
              WHERE mapping.connection_id=${String(j.integration_connection_id)}::uuid
                AND mapping.local_user_id=${m.sender_id ? String(m.sender_id) : null}::uuid
                AND mapping.active
              UNION ALL
              SELECT mapping.external_operator_id AS external_user_id,1 AS priority
              FROM bitrix_open_channel_operator_mappings mapping
              WHERE mapping.integration_connection_id=${String(j.integration_connection_id)}::uuid
                AND mapping.local_user_id=${m.sender_id ? String(m.sender_id) : null}::uuid
                AND mapping.active
            ) candidates
            ORDER BY priority LIMIT 1`
        )[0]?.external_user_id
      : undefined;
    const managerUserId = outgoingMirror
      ? String(
          mappedManager ??
            (c.binding_settings as Record<string, unknown> | null)
              ?.responsibleExternalUserId ??
            c.auth_external_user_id ??
            "",
        )
      : undefined;
    if (outgoingMirror && !managerUserId)
      throw new Error("OPEN_CHANNEL_OUTGOING_USER_REQUIRED");
    const result = await connector.sendIncoming({
      connectorId: String(c.binding_connector_id),
      lineId: String(c.binding_line_id ?? "fake-line"),
      externalUserCode,
      ...(usesWhatsAppExternalIdentity
        ? {}
        : { phone: String(m.normalized_phone) }),
      displayName: String(m.display_name ?? m.normalized_phone),
      text:
        isGroup && typeof messageMetadata.senderName === "string"
          ? `${messageMetadata.senderName}: ${String(m.body)}`
          : String(m.body),
      sourceMarker: String(payload.sourceMarker ?? `local:${m.id}`),
      timestamp: Math.floor(
        new Date(String(m.provider_timestamp ?? new Date())).getTime() / 1000,
      ),
      ...(managerUserId ? { managerUserId } : {}),
    });
    await sql.begin(async (tx) => {
      await tx`INSERT INTO bitrix_open_channel_sessions(organization_id,integration_connection_id,conversation_id,connector_id,line_id,external_chat_id,external_session_id,external_user_code,last_synced_at) VALUES(${String(j.organization_id)}::uuid,${String(j.integration_connection_id)}::uuid,${String(j.conversation_id)}::uuid,${String(c.binding_connector_id)},${String(c.binding_line_id ?? "fake-line")},${result.chatId},${result.sessionId},${externalUserCode},now()) ON CONFLICT(integration_connection_id,conversation_id) DO UPDATE SET connector_id=excluded.connector_id,line_id=excluded.line_id,external_chat_id=excluded.external_chat_id,external_session_id=excluded.external_session_id,last_synced_at=now()`;
      await tx`INSERT INTO bitrix_open_channel_message_links(organization_id,conversation_id,local_message_id,external_chat_id,external_message_id,direction,source_marker) VALUES(${String(j.organization_id)}::uuid,${String(j.conversation_id)}::uuid,${String(j.local_message_id)}::uuid,${result.chatId},${result.messageId},${outgoingMirror ? "outbound" : "inbound"},${String(payload.sourceMarker ?? `local:${m.id}`)}) ON CONFLICT DO NOTHING`;
      if (outgoingMirror && !isGroup)
        // Mirrors the incoming-path enqueue: when the conversation already
        // has a CRM head job (crm_review_head_uq), the new job queues as
        // 'blocked' instead of raising 23505 and rolling back the mirror.
        // Group chats are excluded: they must never reach the CRM.
        await tx`INSERT INTO bitrix_open_channel_jobs(organization_id,integration_connection_id,conversation_id,local_message_id,job_type,idempotency_key,payload,status,last_error)
          SELECT ${String(j.organization_id)}::uuid,${String(j.integration_connection_id)}::uuid,${String(j.conversation_id)}::uuid,${String(j.local_message_id)}::uuid,
            'open_channels.crm',${`crm:${String(j.conversation_id)}:${String(j.local_message_id)}`},
            ${tx.json({ sourceMarker: String(payload.sourceMarker ?? `local:${m.id}`), provider: String(payload.provider ?? "whatsapp") } as never)},
            CASE WHEN EXISTS(
              SELECT 1 FROM bitrix_open_channel_jobs active_job
              WHERE active_job.organization_id=${String(j.organization_id)}::uuid
                AND active_job.integration_connection_id=${String(j.integration_connection_id)}::uuid
                AND active_job.conversation_id=${String(j.conversation_id)}::uuid
                AND active_job.job_type='open_channels.crm'
                AND active_job.status IN('pending','retry','processing','manual_review','dead_letter')
            ) THEN 'blocked' ELSE 'pending' END,
            CASE WHEN EXISTS(
              SELECT 1 FROM bitrix_open_channel_jobs active_job
              WHERE active_job.organization_id=${String(j.organization_id)}::uuid
                AND active_job.integration_connection_id=${String(j.integration_connection_id)}::uuid
                AND active_job.conversation_id=${String(j.conversation_id)}::uuid
                AND active_job.job_type='open_channels.crm'
                AND active_job.status IN('pending','retry','processing','manual_review','dead_letter')
            ) THEN 'CRM_REVIEW_PENDING' ELSE NULL END
          ON CONFLICT DO NOTHING`;
      await tx`UPDATE bitrix_open_channel_jobs SET status='completed',completed_at=now(),locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(j.id)}::uuid`;
      await tx`UPDATE bitrix_open_channel_bindings SET last_success_at=now(),last_error=NULL,updated_at=now() WHERE id=${String(c.binding_id)}::uuid`;
    });
  } catch (error) {
    if (
      error instanceof OpenChannelsError &&
      error.code === "BITRIX_CRM_LINK_STALE"
    ) {
      const rotatedUserCode = `brixchat_repair_${String(j.conversation_id).replaceAll("-", "")}`;
      await sql.begin(async (tx) => {
        await tx`UPDATE bitrix_open_channel_sessions SET external_user_code=${rotatedUserCode},updated_at=now() WHERE integration_connection_id=${String(j.integration_connection_id)}::uuid AND conversation_id=${String(j.conversation_id)}::uuid`;
        await tx`UPDATE bitrix_open_channel_jobs SET status='manual_review',last_error=${error.code},locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(j.id)}::uuid AND status='processing'`;
        await tx`UPDATE bitrix_open_channel_bindings binding SET last_error=${error.code},updated_at=now() FROM messages message WHERE message.id=${String(j.local_message_id)}::uuid AND binding.integration_connection_id=${String(j.integration_connection_id)}::uuid AND binding.brixchat_channel_id=message.channel_id`;
      });
      return;
    }
    const dead = Number(j.attempt_count) >= Number(j.max_attempts);
    await sql`UPDATE bitrix_open_channel_jobs SET status=${dead ? "dead_letter" : "retry"},next_attempt_at=now()+interval '5 seconds',last_error=${error instanceof Error ? error.message : "open_channel_error"},locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=${String(j.id)}::uuid AND status='processing'`;
    await sql`UPDATE bitrix_open_channel_bindings binding SET last_error=${error instanceof Error ? error.message : "open_channel_error"},updated_at=now() FROM messages message WHERE message.id=${String(j.local_message_id)}::uuid AND binding.integration_connection_id=${String(j.integration_connection_id)}::uuid AND binding.brixchat_channel_id=message.channel_id`;
  }
}

async function processOpenChannelsEvent() {
  const rows = await sql<
    Array<Record<string, unknown>>
  >`WITH candidate AS(SELECT id FROM bitrix_open_channel_events WHERE (status='pending' OR (status='processing' AND (locked_at IS NULL OR locked_at<now()-interval '5 minutes'))) ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE bitrix_open_channel_events e SET status='processing',locked_at=now(),locked_by=${workerId},attempt_count=e.attempt_count+1 FROM candidate WHERE e.id=candidate.id RETURNING e.*`;
  const e = rows[0];
  if (!e) return;
  try {
    const p = (e.payload ?? {}) as Record<string, unknown>,
      conversationId = String(p.conversationId),
      context = (
        await sql<
          Array<Record<string, unknown>>
        >`SELECT channel_id,contact_id FROM conversations WHERE id=${conversationId}::uuid AND organization_id=${String(e.organization_id)}::uuid`
      )[0];
    if (!context) throw new Error("CONVERSATION_NOT_FOUND");
    await sql.begin(async (tx) => {
      const m = await tx<
        Array<Record<string, unknown>>
      >`INSERT INTO messages(organization_id,conversation_id,channel_id,contact_id,client_message_id,direction,type,status,body,metadata) VALUES(${String(e.organization_id)}::uuid,${conversationId}::uuid,${String(context.channel_id)}::uuid,${String(context.contact_id)}::uuid,gen_random_uuid(),'outbound','text','pending',${String(p.text ?? "")},${tx.json({ origin: "bitrix_open_channels", eventKey: e.provider_event_key } as never)}) RETURNING id`;
      await tx`INSERT INTO outbox_jobs(organization_id,aggregate_type,aggregate_id,job_type,payload) VALUES(${String(e.organization_id)}::uuid,'message',${String(m[0]!.id)}::uuid,'message.send',${tx.json({ traceId: crypto.randomUUID() } as never)})`;
      await tx`UPDATE bitrix_open_channel_events SET status='processed',processed_at=now(),locked_at=NULL,locked_by=NULL WHERE id=${String(e.id)}::uuid`;
    });
  } catch (error) {
    await sql`UPDATE bitrix_open_channel_events SET status=CASE WHEN attempt_count>=5 THEN 'failed' ELSE 'pending' END,last_error=${error instanceof Error ? error.message : "open_event_error"},locked_at=NULL,locked_by=NULL WHERE id=${String(e.id)}::uuid`;
  }
}

async function processRetentionJob() {
  const rows = await sql<
    Array<Record<string, unknown>>
  >`WITH candidate AS(SELECT id FROM retention_jobs WHERE (status='pending' OR (status='processing' AND (locked_at IS NULL OR locked_at<now()-interval '15 minutes'))) AND dry_run=false ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE retention_jobs j SET status='processing',locked_at=now(),locked_by=${workerId},attempt_count=attempt_count+1 FROM candidate WHERE j.id=candidate.id RETURNING j.*`;
  const job = rows[0];
  if (!job) return;
  try {
    const settings = (
      await sql<
        Array<Record<string, unknown>>
      >`SELECT * FROM organization_retention_settings WHERE organization_id=${String(job.organization_id)}::uuid`
    )[0];
    if (!settings || settings.legal_hold) {
      await sql`UPDATE retention_jobs SET status='completed',eligible_count=0,deleted_count=0,completed_at=now(),locked_at=NULL,locked_by=NULL WHERE id=${String(job.id)}::uuid`;
      return;
    }
    const attachments = await sql<
      Array<Record<string, unknown>>
    >`SELECT id,storage_key,metadata->>'thumbnailKey' thumbnail_key FROM message_attachments WHERE organization_id=${String(job.organization_id)}::uuid AND deleted_at IS NULL AND created_at<now()-(${Number(settings.media_retention_days)}::int*interval '1 day') ORDER BY created_at LIMIT 100`;
    let deleted = 0;
    for (const attachment of attachments) {
      await sql`UPDATE retention_jobs SET locked_at=now() WHERE id=${String(job.id)}::uuid AND status='processing' AND locked_by=${workerId}`;
      if (attachment.storage_key)
        await storage.deleteObject({ key: String(attachment.storage_key) });
      if (attachment.thumbnail_key)
        await storage.deleteObject({ key: String(attachment.thumbnail_key) });
      await sql`UPDATE message_attachments SET processing_status='deleted',deleted_at=now(),updated_at=now() WHERE id=${String(attachment.id)}::uuid AND organization_id=${String(job.organization_id)}::uuid`;
      deleted++;
    }
    await sql`UPDATE retention_jobs SET status='completed',eligible_count=${attachments.length},deleted_count=${deleted},completed_at=now(),locked_at=NULL,locked_by=NULL WHERE id=${String(job.id)}::uuid`;
  } catch (error) {
    await sql`UPDATE retention_jobs SET status=CASE WHEN attempt_count>=5 THEN 'failed' ELSE 'pending' END,last_error=${error instanceof Error ? error.message : "retention_error"},locked_at=NULL,locked_by=NULL WHERE id=${String(job.id)}::uuid`;
  }
}

async function tick() {
  if (stopping) return;
  try {
    await whatsappWebRuntime?.tick();
    await processScheduledTemplateSync();
    await scheduleCrmFullSync();
    await prunePendingMessageStatuses();
    await new CampaignRepository(sql).reconcileStatuses();
    await new CampaignRepository(sql).processNextRecipient();
    await processOutbox();
    await processWebhook();
    await processCrmJob();
    await processCrmWebhook();
    await processMediaJob();
    await processFileJob();
    await scheduleDriveWatchRenewals();
    await processStorageSyncJob();
    await Promise.all(
      Array.from({ length: automationRuntimeConfig.workerConcurrency }, () =>
        processAutomationEvent(),
      ),
    );
    await processLabelBulkJob();
    await processExpiredLabels();
    await processOpenChannelsJob();
    await processOpenChannelsEvent();
    await processRetentionJob();
    healthy = true;
    processedTicks++;
  } catch (error) {
    healthy = false;
    failedTicks++;
    process.stderr.write(
      JSON.stringify({
        level: "error",
        event: "worker.tick_failed",
        error: error instanceof Error ? error.message : "unknown",
      }) + "\n",
    );
  } finally {
    lastTickAt = Date.now();
    if (!stopping) setTimeout(() => void tick(), 500);
  }
}

const health = createServer(async (_request, response) => {
  try {
    const result = await probeWorkerHealth({
      tickHealthy: healthy,
      lastTickAt,
      maxTickAgeMs: workerHealthMaxTickAgeMs,
      dependencyTimeoutMs: workerHealthDependencyTimeoutMs,
      databasePing: async () => sql`SELECT 1`,
      redisPing: async () => redis.ping(),
      storagePing: async () => storage.healthCheck(),
      scannerPing: async () => scanner.healthCheck(),
    });
    response.writeHead(result.healthy ? 200 : 503, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify({
        status: result.healthy ? "ok" : "degraded",
        service: "worker",
        dependencies: result.dependencies,
      }),
    );
  } catch {
    response.writeHead(503);
    response.end('{"status":"down"}');
  }
});

health.listen(
  resolveWorkerHealthPort(process.env),
  process.env.WORKER_HEALTH_HOST ?? "0.0.0.0",
);
async function heartbeat(status = healthy ? "healthy" : "degraded") {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO worker_instances(instance_id,service,version,last_heartbeat,current_jobs,processed_count,failed_count,status,safe_metadata)
      VALUES(${workerId},'worker',${process.env.APP_VERSION ?? "0.1.0"},now(),0,${processedTicks},${failedTicks},${status},${tx.json({ role: process.env.WORKER_ROLE ?? "all" } as never)})
      ON CONFLICT(instance_id) DO UPDATE SET last_heartbeat=now(),processed_count=excluded.processed_count,failed_count=excluded.failed_count,status=excluded.status`;
    await tx`INSERT INTO worker_heartbeats(instance_id,current_jobs,status) VALUES(${workerId},0,${status})`;
    await tx`DELETE FROM worker_heartbeats WHERE recorded_at<now()-interval '7 days'`;
  });
}
await heartbeat();
const heartbeatTimer = setInterval(
  () => void heartbeat().catch(() => (healthy = false)),
  Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? 10_000),
);
const alertScan = () =>
  void scanPlatformAlerts(sql).catch((error: unknown) =>
    process.stderr.write(
      `${JSON.stringify({ level: "error", event: "platform_alert.scan_failed", error: error instanceof Error ? error.message : "unknown" })}\n`,
    ),
  );
alertScan();
const alertScanTimer = setInterval(alertScan, 60_000);
void tick();

// --- AI orchestration loop -------------------------------------------------
// Runs independently from the main 500ms tick: LLM calls take seconds, and
// putting them in the serial tick would stall outbox/webhook processing for
// every tenant. Concurrency is bounded; per-conversation serialization is
// enforced by the claim query + partial unique index on ai_run_requests.
const aiEnv = {
  enabled: process.env.AI_ENABLED === "true",
  apiKey:
    process.env.OPENROUTER_API_KEY ??
    (process.env.OPENROUTER_API_KEY_FILE
      ? readFileSync(process.env.OPENROUTER_API_KEY_FILE, "utf8").trim()
      : null),
  defaultModel: process.env.AI_DEFAULT_MODEL ?? null,
  fallbackModel: process.env.AI_FALLBACK_MODEL ?? null,
  embeddingModel: process.env.AI_EMBEDDING_MODEL ?? null,
};
const aiConcurrency = Math.min(
  Math.max(Number(process.env.AI_WORKER_CONCURRENCY ?? 2), 1),
  8,
);
const billing = new BillingRepository(sql);
const aiDeps: AiOrchestratorDeps = {
  repository: new AiWorkerRepository(sql),
  publish: (organizationId, eventType, entityId, conversationId, payload) =>
    publish(organizationId, eventType, entityId, conversationId, payload),
  decryptSecret,
  encryptionKey: encryptionKey ?? "",
  storage,
  env: aiEnv,
  workerId,
  log: (level, event, detail) =>
    process.stderr.write(JSON.stringify({ level, event, ...detail }) + "\n"),
  reserveAiUsage: async (organizationId, eventKey) => {
    const included = await billing.reserveUsage({
      organizationId,
      eventKey,
      metric: "ai_runs",
    });
    if (included.allowed) return included;
    if (included.code !== "plan_limit_exceeded") return included;
    try {
      await billing.adjustCredits(organizationId, {
        entryKey: eventKey,
        entryType: "usage",
        amount: -1,
        referenceType: "ai_run",
        referenceId: eventKey.slice("ai.run:".length),
      });
      return { allowed: true, code: null };
    } catch (error) {
      if (error instanceof Error && error.message === "insufficient_credits")
        return { allowed: false, code: "ai_credits_required" };
      throw error;
    }
  },
};
async function aiTick() {
  let worked = false;
  try {
    const results = await Promise.all([
      ...Array.from({ length: aiConcurrency }, () =>
        processAiRunRequest(aiDeps),
      ),
      processAiKnowledgeDocument(aiDeps),
    ]);
    worked = results.some(Boolean);
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        event: "ai.tick_failed",
        error: error instanceof Error ? error.message : "unknown",
      }) + "\n",
    );
  } finally {
    if (!stopping) setTimeout(() => void aiTick(), worked ? 100 : 1000);
  }
}
if (aiEnv.enabled) void aiTick();

async function shutdown() {
  stopping = true;
  clearInterval(heartbeatTimer);
  clearInterval(alertScanTimer);
  health.close();
  await whatsappWebRuntime?.shutdown();
  await heartbeat("stopped").catch(() => undefined);
  await sql.end();
  redis.disconnect();
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

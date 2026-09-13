import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { can, type AuthClaims, type Permission } from "@brixchat/auth";
import {
  ChannelRepository,
  MessageRepository,
  ProductRepository,
  QuickReplyRepository,
  TemplateCenterRepository,
} from "@brixchat/database";
import {
  createMessagingProvider,
  configureTelegramWebhook,
  availableProviderDefinitions,
  BitrixRestClient,
  BitrixRestOpenChannelsConnector,
  decryptSecret,
  encryptSecret,
  FakeBitrixOpenChannelsConnector,
  hashSecret,
  messagingPlatforms,
  messagingProviderKeys,
  mergeChannelCredentials,
  normalizeTemplateName,
  providerDefinition,
  requireCreatableProviderDefinition,
  resolveTemplateVariables,
  renderQuickReply,
  removeTelegramWebhook,
  subscribeMetaAppToWaba,
  unsubscribeMetaAppFromWaba,
  validateInternalVariableKey,
  validateTemplateComponents,
  type ChannelCredentials,
  type TemplateComponentDraft,
  type TemplateVariableMapping,
} from "@brixchat/integrations";

type Sql = ReturnType<typeof postgres>;
type ProductOptions = {
  appEncryptionKey?: string;
  apiPublicUrl: string;
  webUrl: string;
  bitrixClientId?: string;
  bitrixClientSecret?: string;
  allowDevelopmentProviders?: boolean;
  whatsappWebEnabled?: boolean;
  publishEvent?: (
    organizationId: string,
    eventType: string,
    channelId: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  enforceBilling?: (
    organizationId: string,
    metric: string,
  ) => Promise<{ allowed: boolean; code: string | null }>;
  fakeMode?:
    | "success"
    | "temporary_error"
    | "permanent_error"
    | "auth_failure"
    | "token_expired"
    | "permission_denied";
  metaApiVersion: string;
};
const uuid = z.string().uuid();
const channelInput = z.object({
  name: z.string().trim().min(2).max(100),
  internalName: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  defaultLanguage: z.string().trim().min(2).max(20).default("tr"),
  timezone: z.string().trim().min(3).max(100).default("Europe/Istanbul"),
  provider: z.enum(messagingProviderKeys),
  platform: z.enum(messagingPlatforms).default("whatsapp"),
  phoneNumber: z.string().trim().min(8).max(30).optional(),
  phoneNumberId: z.string().trim().max(100).optional(),
  businessAccountId: z.string().trim().max(100).optional(),
  accessToken: z.string().trim().max(1000).optional(),
  appSecret: z.string().trim().max(1000).optional(),
});
const channelUpdateInput = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    internalName: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    defaultLanguage: z.string().trim().min(2).max(20).optional(),
    timezone: z.string().trim().min(3).max(100).optional(),
    phoneNumber: z.string().trim().min(8).max(30).optional(),
    phoneNumberId: z.string().trim().max(100).nullable().optional(),
    businessAccountId: z.string().trim().max(100).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "En az bir kanal alanı gönderilmelidir.",
  });
export function normalizeQuickReplyShortcut(value: string): string {
  return value
    .trim()
    .replace(/^\/+/, "")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
}
function quickReplyShortcutSuggestions(
  normalizedShortcut: string,
  language: string,
): string[] {
  return [
    `${normalizedShortcut}_2`,
    `${normalizedShortcut}_${language.toLowerCase()}`,
    `${normalizedShortcut}_team`,
  ].filter((value, index, values) => values.indexOf(value) === index);
}
const quickVariableInput = z.object({
  variableKey: z.string().trim().min(3).max(160),
  label: z.string().trim().min(1).max(120),
  source: z.string().trim().min(2).max(80),
  dataType: z.enum(["text", "date", "time", "phone", "number"]).default("text"),
  formatter: z.string().trim().max(40).nullish(),
  exampleValue: z.string().max(1000).nullish(),
  defaultValue: z.string().max(1000).nullish(),
  required: z.boolean().default(true),
  missingPolicy: z
    .enum(["block", "manual", "default", "remove"])
    .default("block"),
});
const quickBaseInput = z.object({
  title: z.string().trim().min(1).max(120),
  shortcut: z.string().trim().min(1).max(48),
  content: z.string().trim().min(1).max(4096),
  contentFormat: z.enum(["text", "structured"]).default("text"),
  language: z.string().trim().min(2).max(20).default("tr"),
  fallbackLanguage: z.string().trim().min(2).max(20).nullish(),
  scope: z.enum(["organization", "team", "personal"]),
  teamId: uuid.nullish(),
  folderId: uuid.nullish(),
  categoryId: uuid.nullish(),
  channelId: uuid.nullish(),
  tagIds: z.array(uuid).max(20).default([]),
  variables: z.array(quickVariableInput).max(50).default([]),
  isActive: z.boolean().default(true),
  version: z.number().int().positive().optional(),
});
const validateQuickScope = (
  body: {
    shortcut?: string | undefined;
    scope?: string | undefined;
    teamId?: string | null | undefined;
  },
  context: z.RefinementCtx,
) => {
  const shortcut = body.shortcut
    ? normalizeQuickReplyShortcut(body.shortcut)
    : undefined;
  if (body.shortcut && (!shortcut || shortcut.length > 40))
    context.addIssue({
      code: "custom",
      path: ["shortcut"],
      message:
        "Kısayol / ile başlayabilir ve 1-40 güvenli karakter içermelidir.",
    });
  if (body.scope === "team" && !body.teamId)
    context.addIssue({
      code: "custom",
      path: ["teamId"],
      message: "Ekip kapsamı için ekip gereklidir.",
    });
};
const quickInput = quickBaseInput.superRefine((body, context) => {
  validateQuickScope(body, context);
});
const quickUpdateInput = quickBaseInput
  .partial()
  .extend({ version: z.number().int().positive() })
  .superRefine((body, context) => {
    validateQuickScope(body, context);
  });
const quickImportInput = z.object({
  confirm: z.boolean().default(false),
  rows: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(120),
        shortcut: z.string().trim().min(1).max(48),
        content: z.string().trim().min(1).max(4096),
        scope: z.preprocess(
          (value) => (value === "" ? undefined : value),
          z.enum(["organization", "team", "personal"]).default("personal"),
        ),
        teamId: z.preprocess(
          (value) => (value === "" ? null : value),
          uuid.nullish(),
        ),
        language: z.preprocess(
          (value) => (value === "" ? undefined : value),
          z.string().trim().min(2).max(20).default("tr"),
        ),
        categoryId: z.preprocess(
          (value) => (value === "" ? null : value),
          uuid.nullish(),
        ),
      }),
    )
    .min(1)
    .max(500),
});
const templateComponentInput = z
  .object({
    type: z.enum(["HEADER", "BODY", "FOOTER", "BUTTONS"]),
    format: z
      .enum(["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "LOCATION"])
      .optional(),
    text: z.string().max(1024).optional(),
    example: z.record(z.string(), z.unknown()).optional(),
    buttons: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
  })
  .strict();
const templateVariableInput = z.object({
  component: z.string().trim().min(2).max(40),
  position: z.number().int().min(1).max(100),
  internalKey: z.string().trim().min(3).max(160),
  exampleValue: z.string().max(1000).optional(),
  defaultValue: z.string().max(1000).optional(),
  formatter: z.enum(["text", "date", "time", "phone", "currency"]).optional(),
  required: z.boolean().default(true),
  missingPolicy: z.enum(["block", "default", "manual"]).default("block"),
});
const templateDraftInput = z.object({
  channelId: uuid,
  name: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(20),
  category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]),
  components: z.array(templateComponentInput).min(1).max(4),
  variables: z.array(templateVariableInput).max(100).default([]),
  parameterFormat: z.enum(["positional", "named"]).default("positional"),
  defaultLanguage: z.string().trim().min(2).max(20).optional(),
  fallbackLanguage: z.string().trim().min(2).max(20).nullable().optional(),
  internalLabel: z.string().trim().max(100).nullable().optional(),
  folder: z.string().trim().max(100).nullable().optional(),
});
const templateUpdateInput = templateDraftInput
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: "En az bir şablon alanı gönderilmelidir.",
  });

function credentials(
  row: Record<string, unknown>,
  key?: string,
): ChannelCredentials {
  const encrypted =
    row.resolved_credentials_encrypted ?? row.credentials_encrypted;
  if (!encrypted || !key) return {};
  try {
    const value = JSON.parse(decryptSecret(String(encrypted), key)) as Record<
      string,
      unknown
    >;
    return {
      ...(typeof value.accessToken === "string"
        ? { accessToken: value.accessToken }
        : {}),
      ...(typeof value.appSecret === "string"
        ? { appSecret: value.appSecret }
        : {}),
    };
  } catch {
    return {};
  }
}
function safeChannel(row: Record<string, unknown>) {
  const definition = providerDefinition(
    String(row.provider),
    row.platform ? String(row.platform) : "whatsapp",
  );
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    name: String(row.name),
    internalName: row.internal_name
      ? String(row.internal_name)
      : String(row.name),
    description: row.description ? String(row.description) : null,
    defaultLanguage: String(row.default_language ?? "tr"),
    timezone: String(row.timezone ?? "Europe/Istanbul"),
    provider: String(row.provider),
    platform: row.platform ? String(row.platform) : "whatsapp",
    providerAccountId: row.provider_account_id
      ? String(row.provider_account_id)
      : null,
    externalChannelId: row.external_channel_id
      ? String(row.external_channel_id)
      : row.phone_number_id
        ? String(row.phone_number_id)
        : null,
    phoneNumber: row.phone_number ? String(row.phone_number) : null,
    phoneNumberId: row.phone_number_id ? String(row.phone_number_id) : null,
    businessAccountId: row.business_account_id
      ? String(row.business_account_id)
      : null,
    status: String(row.status),
    connectionStatus: String(
      row.connection_status ??
        (row.status === "connected" ? "ACTIVE" : "DISCONNECTED"),
    ),
    healthState: String(row.health_state ?? "UNKNOWN"),
    capabilities: Array.isArray(row.capabilities)
      ? row.capabilities
      : [...(definition?.capabilities ?? [])],
    providerDefinition: definition
      ? {
          key: definition.key,
          displayName: definition.displayName,
          availability: definition.availability,
          branding: definition.branding,
        }
      : null,
    healthStatus: String(row.health_status ?? "configuration_required"),
    healthCode: row.health_code ? String(row.health_code) : null,
    healthCheckedAt: row.health_checked_at
      ? new Date(String(row.health_checked_at)).toISOString()
      : null,
    lastWebhookAt: row.last_webhook_at
      ? new Date(String(row.last_webhook_at)).toISOString()
      : null,
    lastWebhookResult: row.last_webhook_result
      ? String(row.last_webhook_result)
      : null,
    lastInboundAt: row.last_inbound_at
      ? new Date(String(row.last_inbound_at)).toISOString()
      : null,
    lastOutboundAt: row.last_outbound_at
      ? new Date(String(row.last_outbound_at)).toISOString()
      : null,
    lastHealthCheckAt: row.last_health_check_at
      ? new Date(String(row.last_health_check_at)).toISOString()
      : row.health_checked_at
        ? new Date(String(row.health_checked_at)).toISOString()
        : null,
    lastHealthError: row.last_health_error
      ? String(row.last_health_error)
      : row.last_error_code
        ? String(row.last_error_code)
        : null,
    webhookHealth:
      row.last_webhook_result === "failed"
        ? "UNHEALTHY"
        : row.last_webhook_result === "retrying"
          ? "WARNING"
          : row.last_webhook_at
            ? "HEALTHY"
            : "UNKNOWN",
    credentialsConfigured: Boolean(
      row.resolved_credentials_encrypted ?? row.credentials_encrypted,
    ),
    verifyTokenConfigured: Boolean(row.verify_token_hash),
    metrics: {
      openConversations: Number(row.open_conversations ?? 0),
      inboundMessages: Number(row.inbound_messages ?? 0),
      outboundMessages: Number(row.outbound_messages ?? 0),
    },
    team: {
      name: row.primary_team_name ? String(row.primary_team_name) : null,
      members: Array.isArray(row.channel_members) ? row.channel_members : [],
    },
    session:
      String(row.provider) === "whatsapp_web"
        ? {
            status: String(row.whatsapp_web_session_status ?? "initializing"),
            qrExpiresAt: row.whatsapp_web_qr_expires_at
              ? new Date(String(row.whatsapp_web_qr_expires_at)).toISOString()
              : null,
            lastHeartbeatAt: row.whatsapp_web_last_heartbeat_at
              ? new Date(
                  String(row.whatsapp_web_last_heartbeat_at),
                ).toISOString()
              : null,
            lastErrorCode: row.whatsapp_web_last_error_code
              ? String(row.whatsapp_web_last_error_code)
              : null,
          }
        : null,
  };
}

function flattenTemplateContext(
  value: unknown,
  prefix = "",
  output: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child))
      flattenTemplateContext(child, path, output);
    else output[path] = child;
  }
  return output;
}

export function registerProductRoutes(
  app: FastifyInstance,
  sql: Sql,
  options: ProductOptions,
): void {
  const channelRepository = new ChannelRepository(sql);
  const messageRepository = new MessageRepository(sql);
  const templateRepository = new TemplateCenterRepository(sql);
  const quickReplyRepository = new QuickReplyRepository(sql);
  const productRepository = new ProductRepository(sql);
  const quickSql = quickReplyRepository.query.bind(quickReplyRepository);
  const auth = async (request: FastifyRequest) => {
    try {
      request.claims = await request.jwtVerify<AuthClaims>();
    } catch {
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    }
  };
  const permission = (name: Permission) => async (request: FastifyRequest) => {
    await auth(request);
    if (!request.claims || !can(request.claims.role, name))
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
  };
  const audit = async (
    request: FastifyRequest,
    action: string,
    entityType: string,
    entityId: string | null,
    metadata: Record<string, unknown> = {},
  ) => {
    await sql`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata,ip_address,user_agent) VALUES(${request.claims!.organizationId}::uuid,${request.claims!.sub}::uuid,${action},${entityType},${entityId}::uuid,${sql.json(metadata as never)},${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
  };
  const publishChannelEvent = (
    organizationId: string,
    eventType: string,
    channelId: string,
    payload: Record<string, unknown> = {},
  ) =>
    options.publishEvent?.(organizationId, eventType, channelId, payload) ??
    Promise.resolve();
  const byChannel = async (organizationId: string, id: string) => {
    const rows = await sql<
      Array<Record<string, unknown>>
    >`SELECT c.*,coalesce(pa.encrypted_credentials,c.credentials_encrypted) resolved_credentials_encrypted FROM channels c LEFT JOIN provider_accounts pa ON pa.id=c.provider_account_id AND pa.organization_id=c.organization_id AND pa.archived_at IS NULL WHERE c.id=${id}::uuid AND c.organization_id=${organizationId}::uuid AND c.deleted_at IS NULL`;
    return rows[0] ?? null;
  };
  const openChannelsConnector = (connection: Record<string, unknown>) => {
    if (String(connection.auth_mode) === "fake")
      return new FakeBitrixOpenChannelsConnector();
    if (!options.appEncryptionKey)
      throw new Error("OPEN_CHANNELS_ENCRYPTION_KEY_MISSING");
    const raw = connection.credentials_encrypted;
    if (!raw) throw new Error("OPEN_CHANNELS_CREDENTIALS_MISSING");
    const connectionCredentials = JSON.parse(
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
      ...(connectionCredentials.webhookUrl
        ? { webhookUrl: connectionCredentials.webhookUrl }
        : {}),
      ...(connectionCredentials.accessToken
        ? { accessToken: connectionCredentials.accessToken }
        : {}),
      ...(connectionCredentials.refreshToken
        ? { refreshToken: connectionCredentials.refreshToken }
        : {}),
      ...(connectionCredentials.accessTokenExpiresAt
        ? { accessTokenExpiresAt: connectionCredentials.accessTokenExpiresAt }
        : {}),
      portalUrl: String(connection.portal_url ?? ""),
      ...(options.bitrixClientId ? { clientId: options.bitrixClientId } : {}),
      ...(options.bitrixClientSecret
        ? { clientSecret: options.bitrixClientSecret }
        : {}),
      onTokenRefresh: async (update) => {
        const encrypted = encryptSecret(
          JSON.stringify({
            ...connectionCredentials,
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
        await productRepository.query`UPDATE integration_connections SET credentials_encrypted=${encrypted},updated_at=now() WHERE id=${String(connection.integration_connection_id)}::uuid AND organization_id=${String(connection.organization_id)}::uuid`;
      },
    });
    return new BitrixRestOpenChannelsConnector(client, {
      connectorId: String(connection.connector_id),
      placementHandler: `${options.webUrl}/app/integrations/bitrix24/open-channels`,
      eventHandler: `${options.apiPublicUrl}/webhooks/bitrix24/${String(connection.public_id)}`,
    });
  };
  const transitionBitrixBinding = async (
    organizationId: string,
    channelId: string,
    target: "disabled" | "archived",
  ) => {
    const binding = (
      await productRepository.query<Array<Record<string, unknown>>>`SELECT
          binding.*,
          connection.public_id,
          connection.auth_mode,
          connection.portal_url,
          connection.credentials_encrypted
        FROM bitrix_open_channel_bindings binding
        JOIN integration_connections connection
          ON connection.id=binding.integration_connection_id
         AND connection.organization_id=binding.organization_id
        WHERE binding.organization_id=${organizationId}::uuid
          AND binding.brixchat_channel_id=${channelId}::uuid
        LIMIT 1`
    )[0];
    if (!binding || String(binding.status) === target) return;
    await productRepository.query`UPDATE bitrix_open_channel_bindings SET status='deactivation_pending',last_error=NULL,updated_at=now() WHERE id=${String(binding.id)}::uuid AND organization_id=${organizationId}::uuid`;
    try {
      const connector = openChannelsConnector(binding);
      await connector.deactivate({
        connectorId: String(binding.connector_id),
        lineId: String(binding.line_id),
      });
      const settings = (binding.settings ?? {}) as Record<string, unknown>;
      if (
        target === "archived" &&
        settings.lineOwnership === "brixchat_created"
      )
        await connector.deleteLine({ lineId: String(binding.line_id) });
      await productRepository.begin(async (tx) => {
        await tx`UPDATE bitrix_open_channel_bindings SET status=${target},last_error=NULL,updated_at=now() WHERE id=${String(binding.id)}::uuid AND organization_id=${organizationId}::uuid`;
        await tx`UPDATE bitrix_open_channel_sessions session SET status='closed',closed_at=COALESCE(session.closed_at,now()),updated_at=now() FROM conversations conversation WHERE session.organization_id=${organizationId}::uuid AND session.conversation_id=conversation.id AND conversation.organization_id=session.organization_id AND conversation.channel_id=${channelId}::uuid AND session.status='open'`;
        const active = (
          await tx<
            Array<Record<string, unknown>>
          >`SELECT 1 FROM bitrix_open_channel_bindings WHERE integration_connection_id=${String(binding.integration_connection_id)}::uuid AND organization_id=${organizationId}::uuid AND status='active' LIMIT 1`
        )[0];
        if (!active) {
          await tx`UPDATE bitrix_open_channel_connectors SET status='disabled',updated_at=now() WHERE integration_connection_id=${String(binding.integration_connection_id)}::uuid AND organization_id=${organizationId}::uuid`;
          await tx`UPDATE integration_connections SET open_channels_status='disabled',updated_at=now() WHERE id=${String(binding.integration_connection_id)}::uuid AND organization_id=${organizationId}::uuid`;
        }
      });
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "BITRIX_DEACTIVATION_FAILED";
      await productRepository.query`UPDATE bitrix_open_channel_bindings SET status='warning',last_error=${message},updated_at=now() WHERE id=${String(binding.id)}::uuid AND organization_id=${organizationId}::uuid`;
      throw Object.assign(new Error(message), {
        statusCode: 502,
        code: "bitrix_open_channel_deactivation_failed",
      });
    }
  };

  app.get(
    "/api/v1/channel-providers",
    { preHandler: permission("inbox:read") },
    async () => ({
      data: availableProviderDefinitions({
        includeDevelopment: options.allowDevelopmentProviders === true,
        enableWhatsAppWeb: options.whatsappWebEnabled === true,
      }).map((definition) =>
        definition.provider === "whatsapp_web" &&
        options.whatsappWebEnabled !== true
          ? {
              ...definition,
              availability: "coming_soon" as const,
              isEnabled: false,
              description:
                "Bağlı cihaz tabanlı WhatsApp Web bağlantısı daha sonra geliştirilecek.",
            }
          : definition,
      ),
    }),
  );
  app.get(
    "/api/v1/channels/summary",
    { preHandler: permission("inbox:read") },
    async (request) => {
      const rows = await channelRepository.listAccessible({
        organizationId: request.claims!.organizationId,
        userId: request.claims!.sub,
        role: request.claims!.role,
      });
      const countBy = (key: string) =>
        rows.reduce<Record<string, number>>((output, row) => {
          const value = String(row[key] ?? "unknown");
          output[value] = (output[value] ?? 0) + 1;
          return output;
        }, {});
      return {
        data: {
          total: rows.length,
          byProvider: countBy("provider"),
          byPlatform: countBy("platform"),
          byConnectionStatus: countBy("connection_status"),
          byHealthState: countBy("health_state"),
        },
      };
    },
  );
  app.get(
    "/api/v1/channels",
    { preHandler: permission("inbox:read") },
    async (request) => ({
      data: (
        await channelRepository.listAccessible({
          organizationId: request.claims!.organizationId,
          userId: request.claims!.sub,
          role: request.claims!.role,
        })
      ).map(safeChannel),
    }),
  );
  app.post(
    "/api/v1/channels",
    { preHandler: permission("channels:manage") },
    async (request, reply) => {
      const body = channelInput.parse(request.body);
      const billing = await options.enforceBilling?.(
        request.claims!.organizationId,
        `channels:${body.platform}`,
      );
      if (billing && !billing.allowed)
        return reply.code(409).send({
          error: {
            code: billing.code,
            message: "Abonelik planınız yeni kanal eklemeye izin vermiyor.",
          },
        });
      if (
        body.provider === "whatsapp_web" &&
        options.whatsappWebEnabled !== true
      )
        return reply.code(503).send({
          error: {
            code: "whatsapp_web_runtime_disabled",
            message:
              "WhatsApp Web bağlı cihaz worker runtime henüz etkin değil.",
          },
        });
      const definition = requireCreatableProviderDefinition({
        provider: body.provider,
        platform: body.platform,
        includeDevelopment: options.allowDevelopmentProviders === true,
        enableWhatsAppWeb: options.whatsappWebEnabled === true,
      });
      if (
        body.provider === "meta" &&
        (!body.phoneNumber ||
          !body.phoneNumberId ||
          !body.businessAccountId ||
          !body.accessToken)
      )
        return reply.code(400).send({
          error: {
            code: "channel_configuration_invalid",
            message:
              "Meta Phone Number ID, Business Account ID ve access token gereklidir.",
          },
        });
      if (body.provider === "telegram" && !body.accessToken)
        return reply.code(400).send({
          error: {
            code: "channel_configuration_invalid",
            message: "Telegram bot token gereklidir.",
          },
        });
      let encrypted: string | null = null;
      if (body.accessToken || body.appSecret) {
        if (!options.appEncryptionKey)
          throw Object.assign(new Error("encryption_key_missing"), {
            statusCode: 503,
          });
        encrypted = encryptSecret(
          JSON.stringify({
            accessToken: body.accessToken,
            appSecret: body.appSecret,
          }),
          options.appEncryptionKey,
        );
      }
      const verifyToken = crypto.randomUUID() + crypto.randomUUID();
      let providerAccountCreated = false;
      const row = await sql.begin(async (tx) => {
        let providerAccountId: string | null = null;
        if (body.provider === "meta") {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${`${request.claims!.organizationId}:${body.businessAccountId}`}))`;
          const duplicate = await tx<Array<{ id: string }>>`
            SELECT id
            FROM channels
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND deleted_at IS NULL
              AND (
                phone_number_id=${body.phoneNumberId!}
                OR phone_number=${body.phoneNumber!}
              )
            LIMIT 1`;
          if (duplicate[0])
            throw Object.assign(new Error("channel_already_exists"), {
              statusCode: 409,
            });
          const activeWabaChannels = await tx<Array<{ id: string }>>`
            SELECT id
            FROM channels
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND provider='meta'
              AND business_account_id=${body.businessAccountId!}
              AND deleted_at IS NULL
            LIMIT 1`;
          const accounts = await tx<Array<{ id: string; inserted: boolean }>>`
            INSERT INTO provider_accounts(
              organization_id,
              provider,
              external_account_id,
              display_name,
              encrypted_credentials,
              status,
              last_authenticated_at,
              created_by,
              updated_by
            )
            VALUES(
              ${request.claims!.organizationId}::uuid,
              ${body.provider},
              ${body.businessAccountId!},
              ${`Meta WABA ${body.businessAccountId!}`},
              ${encrypted},
              'active',
              now(),
              ${request.claims!.sub}::uuid,
              ${request.claims!.sub}::uuid
            )
            ON CONFLICT(organization_id,provider,external_account_id)
            DO UPDATE SET
              encrypted_credentials=COALESCE(EXCLUDED.encrypted_credentials,provider_accounts.encrypted_credentials),
              status='active',
              last_authenticated_at=now(),
              updated_by=EXCLUDED.updated_by,
              updated_at=now(),
              archived_at=NULL
            RETURNING id,(xmax=0) inserted`;
          providerAccountId = accounts[0]!.id;
          providerAccountCreated =
            accounts[0]!.inserted || activeWabaChannels.length === 0;
        }
        const rows = await tx<
          Array<Record<string, unknown>>
        >`INSERT INTO channels(
          organization_id,
          provider_account_id,
          name,
          internal_name,
          description,
          default_language,
          timezone,
          provider,
          platform,
          external_channel_id,
          phone_number,
          phone_number_id,
          business_account_id,
          identity,
          capabilities,
          credentials_encrypted,
          verify_token_hash,
          status,
          connection_status,
          health_status,
          health_state,
          created_by,
          updated_by
        ) VALUES(
          ${request.claims!.organizationId}::uuid,
          ${providerAccountId}::uuid,
          ${body.name},
          ${body.internalName ?? body.name},
          ${body.description ?? null},
          ${body.defaultLanguage},
          ${body.timezone},
          ${body.provider},
          ${body.platform},
          ${body.phoneNumberId ?? body.phoneNumber ?? null},
          ${body.phoneNumber ?? null},
          ${body.phoneNumberId ?? null},
          ${body.businessAccountId ?? null},
          ${tx.json({
            type: body.platform === "whatsapp" ? "phone_number" : body.platform,
            value: body.phoneNumber ?? null,
            phoneNumberId: body.phoneNumberId ?? null,
            businessAccountId: body.businessAccountId ?? null,
          } as never)},
          ${tx.json([...definition.capabilities] as never)},
          ${encrypted},
          ${body.provider === "telegram" || providerAccountCreated ? hashSecret(verifyToken) : null},
          ${body.provider === "whatsapp_web" ? "disconnected" : "connected"},
          ${body.provider === "whatsapp_web" ? "DISCONNECTED" : "ACTIVE"},
          'configuration_required',
          'UNKNOWN',
          ${request.claims!.sub}::uuid,
          ${request.claims!.sub}::uuid
        ) RETURNING *`;
        const created = rows[0]!;
        if (body.provider === "whatsapp_web")
          await tx`
            INSERT INTO whatsapp_web_sessions(
              organization_id,
              channel_id,
              status
            )
            VALUES(
              ${request.claims!.organizationId}::uuid,
              ${String(created.id)}::uuid,
              'initializing'
            )`;
        await tx`INSERT INTO channel_user_ownership(organization_id,channel_id,user_id,relationship_type,is_primary) VALUES(${request.claims!.organizationId}::uuid,${String(created.id)}::uuid,${request.claims!.sub}::uuid,'owner',true) ON CONFLICT(organization_id,channel_id,user_id) DO UPDATE SET is_primary=true,updated_at=now()`;
        await tx`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata,ip_address,user_agent) VALUES(${request.claims!.organizationId}::uuid,${request.claims!.sub}::uuid,'channel.created','channel',${String(created.id)}::uuid,${tx.json({ provider: body.provider } as never)},${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
        return created;
      });
      if (body.provider === "meta" && providerAccountCreated) {
        try {
          await subscribeMetaAppToWaba({
            businessAccountId: body.businessAccountId!,
            accessToken: body.accessToken!,
            apiVersion: options.metaApiVersion,
            overrideCallbackUri: `${options.apiPublicUrl}/webhooks/meta/whatsapp/${row.public_id}`,
            verifyToken,
          });
        } catch (error) {
          const providerCode =
            typeof (error as { code?: unknown }).code === "string"
              ? String((error as { code: string }).code)
              : "PROVIDER_SUBSCRIPTION_FAILED";
          const retryable =
            (error as { retryable?: unknown }).retryable === true;
          await sql.begin(async (tx) => {
            await tx`UPDATE channels SET credentials_encrypted=CASE WHEN ${retryable} THEN credentials_encrypted ELSE NULL END,status='disconnected',health_status='unhealthy',health_code=${providerCode},deleted_at=CASE WHEN ${retryable} THEN deleted_at ELSE now() END,updated_at=now() WHERE organization_id=${request.claims!.organizationId}::uuid AND id=${String(row.id)}::uuid`;
            if (!retryable && row.provider_account_id)
              await tx`UPDATE provider_accounts SET status='archived',encrypted_credentials=NULL,archived_at=now(),updated_at=now() WHERE id=${String(row.provider_account_id)}::uuid AND organization_id=${request.claims!.organizationId}::uuid`;
            await tx`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata,ip_address,user_agent) VALUES(${request.claims!.organizationId}::uuid,${request.claims!.sub}::uuid,'channel.create_failed','channel',${String(row.id)}::uuid,${tx.json({ provider: body.provider, code: providerCode, retryable } as never)},${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
          });
          throw error;
        }
      }
      if (body.provider === "telegram") {
        try {
          const bot = await configureTelegramWebhook({
            accessToken: body.accessToken!,
            callbackUrl: `${options.apiPublicUrl}/webhooks/telegram/${row.public_id}`,
            secretToken: verifyToken,
          });
          row.phone_number_id = String(bot.id);
          row.external_channel_id = String(bot.id);
          row.phone_number = bot.username ? `@${bot.username}` : String(bot.id);
          await channelRepository.activateTelegramIdentity({
            organizationId: request.claims!.organizationId,
            channelId: String(row.id),
            botId: String(bot.id),
            ...(bot.username ? { username: bot.username } : {}),
          });
        } catch (error) {
          const providerCode =
            typeof (error as { code?: unknown }).code === "string"
              ? String((error as { code: string }).code)
              : "PROVIDER_SUBSCRIPTION_FAILED";
          await channelRepository.failTelegramProvisioning({
            organizationId: request.claims!.organizationId,
            channelId: String(row.id),
            code: providerCode,
          });
          throw error;
        }
      }
      await publishChannelEvent(
        request.claims!.organizationId,
        "channel.created",
        String(row.id),
        { provider: body.provider, platform: body.platform },
      );
      return reply
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .code(201)
        .send({
          data: {
            ...safeChannel(row),
            ...(body.provider === "meta" && providerAccountCreated
              ? {
                  webhookSetup: {
                    callbackUrl: `${options.apiPublicUrl}/webhooks/meta/whatsapp/${row.public_id}`,
                    verifyToken,
                    subscriptionConfigured: true,
                  },
                }
              : {}),
          },
        });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/channels/:id",
    { preHandler: permission("inbox:read") },
    async (request, reply) => {
      const row = await channelRepository.byIdAccessible({
        organizationId: request.claims!.organizationId,
        channelId: request.params.id,
        userId: request.claims!.sub,
        role: request.claims!.role,
      });
      return row
        ? { data: safeChannel(row) }
        : reply.code(404).send({
            error: {
              code: "channel_not_found",
              message: "Kanal bulunamadı.",
            },
          });
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/channels/:id",
    { preHandler: permission("channels:manage") },
    async (request, reply) => {
      const body = channelUpdateInput.parse(request.body);
      const current = await byChannel(
        request.claims!.organizationId,
        request.params.id,
      );
      if (!current)
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Kanal bulunamadı." },
        });
      const nextPhoneNumberId =
        body.phoneNumberId === undefined
          ? current.phone_number_id
          : body.phoneNumberId;
      const nextBusinessAccountId =
        body.businessAccountId === undefined
          ? current.business_account_id
          : body.businessAccountId;
      if (
        current.provider === "meta" &&
        (!nextPhoneNumberId || !nextBusinessAccountId)
      )
        return reply.code(400).send({
          error: {
            code: "channel_configuration_invalid",
            message: "Meta channel kimlikleri gereklidir.",
          },
        });
      if (
        current.provider === "meta" &&
        ((body.phoneNumberId !== undefined &&
          body.phoneNumberId !== current.phone_number_id) ||
          (body.businessAccountId !== undefined &&
            body.businessAccountId !== current.business_account_id))
      )
        return reply.code(409).send({
          error: {
            code: "meta_identity_change_requires_reconnect",
            message:
              "Meta Phone Number ID veya WABA değişikliği için kanalı yeniden bağlayın.",
          },
        });
      const rows = await sql<
        Array<Record<string, unknown>>
      >`UPDATE channels SET name=COALESCE(${body.name ?? null},name),internal_name=COALESCE(${body.internalName ?? null},internal_name,name),description=CASE WHEN ${body.description === undefined} THEN description ELSE ${body.description ?? null} END,default_language=COALESCE(${body.defaultLanguage ?? null},default_language),timezone=COALESCE(${body.timezone ?? null},timezone),phone_number=COALESCE(${body.phoneNumber ?? null},phone_number),phone_number_id=CASE WHEN ${body.phoneNumberId === undefined} THEN phone_number_id ELSE ${body.phoneNumberId ?? null} END,business_account_id=CASE WHEN ${body.businessAccountId === undefined} THEN business_account_id ELSE ${body.businessAccountId ?? null} END,updated_by=${request.claims!.sub}::uuid,version=version+1,updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid AND deleted_at IS NULL RETURNING *`;
      if (!rows[0])
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Kanal bulunamadı." },
        });
      await audit(request, "channel.updated", "channel", request.params.id);
      await publishChannelEvent(
        request.claims!.organizationId,
        "channel.updated",
        request.params.id,
      );
      return { data: safeChannel(rows[0]) };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/channels/:id",
    { preHandler: permission("channels:manage") },
    async (request, reply) => {
      const current = await byChannel(
        request.claims!.organizationId,
        request.params.id,
      );
      if (!current)
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Kanal bulunamadı." },
        });
      let archiveProviderAccount = false;
      if (current.provider === "meta") {
        const secrets = credentials(current, options.appEncryptionKey);
        if (!current.business_account_id || !secrets.accessToken)
          return reply.code(409).send({
            error: {
              code: "meta_unsubscribe_credentials_missing",
              message: "Meta aboneliği kaldırılmadan kanal güvenle silinemez.",
            },
          });
        const siblings = await sql<Array<{ count: number }>>`
          SELECT count(*)::int count
          FROM channels
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND provider='meta'
            AND business_account_id=${String(current.business_account_id)}
            AND id<>${request.params.id}::uuid
            AND deleted_at IS NULL`;
        archiveProviderAccount = (siblings[0]?.count ?? 0) === 0;
      }
      await transitionBitrixBinding(
        request.claims!.organizationId,
        request.params.id,
        "archived",
      );
      if (archiveProviderAccount) {
        const secrets = credentials(current, options.appEncryptionKey);
        await unsubscribeMetaAppFromWaba({
          businessAccountId: String(current.business_account_id),
          accessToken: secrets.accessToken!,
          apiVersion: options.metaApiVersion,
        });
      }
      if (current.provider === "telegram") {
        const secrets = credentials(current, options.appEncryptionKey);
        if (!secrets.accessToken)
          return reply.code(409).send({
            error: {
              code: "telegram_unsubscribe_credentials_missing",
              message:
                "Telegram webhook kaldırılmadan kanal güvenle silinemez.",
            },
          });
        await removeTelegramWebhook({ accessToken: secrets.accessToken });
      }
      if (current.provider === "whatsapp_web")
        await sql.begin(async (tx) => {
          await tx`
            DELETE FROM whatsapp_web_signal_keys
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND channel_id=${request.params.id}::uuid`;
          await tx`
            DELETE FROM whatsapp_web_sessions
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND channel_id=${request.params.id}::uuid`;
        });
      const rows = await sql<Array<{ id: string; name: string }>>`
        UPDATE channels
        SET status='disabled',
            connection_status='ARCHIVED',
            health_state='UNKNOWN',
            archived_at=now(),
            deleted_at=now(),
            credentials_encrypted=NULL,
            verify_token_hash=NULL,
            public_id=gen_random_uuid(),
            updated_at=now()
        WHERE id=${request.params.id}::uuid
          AND organization_id=${request.claims!.organizationId}::uuid
          AND deleted_at IS NULL
        RETURNING id,name`;
      const row = rows[0];
      if (!row)
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Kanal bulunamadı." },
        });
      if (archiveProviderAccount && current.provider_account_id)
        await channelRepository.archiveProviderAccount({
          organizationId: request.claims!.organizationId,
          providerAccountId: String(current.provider_account_id),
          actorId: request.claims!.sub,
        });
      await audit(request, "channel.deleted", "channel", request.params.id, {
        name: row.name,
      });
      await publishChannelEvent(
        request.claims!.organizationId,
        "channel.archived",
        request.params.id,
      );
      return { data: { deleted: true } };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/channels/:id/credentials",
    {
      preHandler: permission("channels:manage"),
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const body = z
        .object({
          accessToken: z.string().max(1000).optional(),
          appSecret: z.string().max(1000).optional(),
        })
        .refine(
          (value) =>
            Boolean(value.accessToken?.trim() || value.appSecret?.trim()),
          { message: "En az bir credential alanı gereklidir." },
        )
        .parse(request.body);
      const row = await byChannel(
        request.claims!.organizationId,
        request.params.id,
      );
      if (!row)
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Kanal bulunamadı." },
        });
      if (row.provider === "telegram")
        return reply.code(409).send({
          error: {
            code: "telegram_token_change_requires_reconnect",
            message:
              "Telegram bot token değişikliği için kanalı yeniden bağlayın.",
          },
        });
      if (!options.appEncryptionKey)
        throw Object.assign(new Error("encryption_key_missing"), {
          statusCode: 503,
        });
      const merged = mergeChannelCredentials(
        credentials(row, options.appEncryptionKey),
        {
          ...(body.accessToken !== undefined
            ? { accessToken: body.accessToken }
            : {}),
          ...(body.appSecret !== undefined
            ? { appSecret: body.appSecret }
            : {}),
        },
      );
      const encrypted = encryptSecret(
        JSON.stringify(merged),
        options.appEncryptionKey,
      );
      await sql.begin(async (tx) => {
        await tx`UPDATE channels SET credentials_encrypted=${encrypted},health_status='configuration_required',health_state='UNKNOWN',health_checked_at=NULL,last_health_check_at=NULL,updated_by=${request.claims!.sub}::uuid,version=version+1,updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid AND deleted_at IS NULL`;
        await tx`UPDATE provider_accounts pa SET encrypted_credentials=${encrypted},credential_version=credential_version+1,status='active',last_authenticated_at=now(),updated_by=${request.claims!.sub}::uuid,updated_at=now() FROM channels c WHERE c.id=${request.params.id}::uuid AND c.organization_id=${request.claims!.organizationId}::uuid AND c.provider_account_id=pa.id AND pa.organization_id=c.organization_id AND pa.archived_at IS NULL`;
      });
      await audit(
        request,
        "channel.credentials_updated",
        "channel",
        request.params.id,
      );
      return { data: { credentialsConfigured: true } };
    },
  );
  for (const action of ["enable", "disable"] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/v1/channels/:id/${action}`,
      { preHandler: permission("channels:manage") },
      async (request, reply) => {
        const status = action === "enable" ? "connected" : "disabled";
        const connectionStatus = action === "enable" ? "ACTIVE" : "DISABLED";
        if (action === "disable")
          await transitionBitrixBinding(
            request.claims!.organizationId,
            request.params.id,
            "disabled",
          );
        const rows =
          await sql`UPDATE channels SET status=${status},connection_status=${connectionStatus},version=version+1,updated_by=${request.claims!.sub}::uuid,updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid AND deleted_at IS NULL RETURNING id`;
        if (!rows[0])
          return reply.code(404).send({
            error: {
              code: "channel_not_found",
              message: "Kanal bulunamadı.",
            },
          });
        await audit(
          request,
          `channel.${action}d`,
          "channel",
          request.params.id,
        );
        await publishChannelEvent(
          request.claims!.organizationId,
          `channel.${action === "enable" ? "enabled" : "disabled"}`,
          request.params.id,
        );
        return { data: { status } };
      },
    );
  }
  app.post<{ Params: { id: string } }>(
    "/api/v1/channels/:id/rotate-public-id",
    { preHandler: permission("channels:manage") },
    async (request, reply) => {
      const channel = await byChannel(
        request.claims!.organizationId,
        request.params.id,
      );
      if (!channel)
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Kanal bulunamadı." },
        });
      if (channel.provider === "meta")
        return reply.code(409).send({
          error: {
            code: "meta_public_id_rotation_requires_webhook_rebind",
            message:
              "Meta kanal kimliği, webhook aboneliği yeniden bağlanmadan değiştirilemez.",
          },
        });
      const rows = await sql<
        Array<{ public_id: string }>
      >`UPDATE channels SET public_id=gen_random_uuid(),updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid AND deleted_at IS NULL RETURNING public_id`;
      if (!rows[0])
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Kanal bulunamadı." },
        });
      await audit(
        request,
        "channel.public_id_rotated",
        "channel",
        request.params.id,
      );
      return { data: { publicId: rows[0].public_id } };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/channels/:id/rotate-verify-token",
    { preHandler: permission("channels:manage") },
    async (request, reply) => {
      const token = createOpaqueVerifyToken();
      const tokenHash = hashSecret(token);
      const row = await sql.begin(async (tx) => {
        const rows = await tx<Array<Record<string, unknown>>>`
          SELECT *
          FROM channels
          WHERE id=${request.params.id}::uuid
            AND organization_id=${request.claims!.organizationId}::uuid
            AND deleted_at IS NULL
          FOR UPDATE`;
        if (!rows[0]) return null;
        const recentlyRotated = await tx<Array<{ exists: boolean }>>`
          SELECT EXISTS (
            SELECT 1
            FROM audit_logs
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND entity_id=${request.params.id}::uuid
              AND action='channel.verify_token_rotated'
              AND created_at > now() - interval '30 seconds'
          ) AS exists`;
        if (recentlyRotated[0]?.exists)
          throw Object.assign(new Error("verify_token_rotation_in_progress"), {
            statusCode: 409,
          });
        await tx`
          UPDATE channels
          SET verify_token_hash=${tokenHash},updated_at=now()
          WHERE id=${request.params.id}::uuid`;
        const audits = await tx<Array<{ id: string }>>`
          INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata,ip_address,user_agent)
          VALUES(${request.claims!.organizationId}::uuid,${request.claims!.sub}::uuid,'channel.verify_token_rotated','channel',${request.params.id}::uuid,${tx.json({} as never)},${request.clientIp}::inet,${request.headers["user-agent"] ?? null})
          RETURNING id`;
        return {
          channel: rows[0]!,
          previousVerifyTokenHash: rows[0]!.verify_token_hash
            ? String(rows[0]!.verify_token_hash)
            : null,
          auditId: audits[0]!.id,
        };
      });
      if (!row)
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Kanal bulunamadı." },
        });
      let subscriptionConfigured = false;
      if (row.channel.provider === "meta" && row.channel.business_account_id) {
        const secrets = credentials(row.channel, options.appEncryptionKey);
        if (secrets.accessToken) {
          try {
            await subscribeMetaAppToWaba({
              businessAccountId: String(row.channel.business_account_id),
              accessToken: secrets.accessToken,
              apiVersion: options.metaApiVersion,
              overrideCallbackUri: `${options.apiPublicUrl}/webhooks/meta/whatsapp/${row.channel.public_id}`,
              verifyToken: token,
            });
            subscriptionConfigured = true;
          } catch (error) {
            await sql.begin(async (tx) => {
              await tx`
                UPDATE channels
                SET verify_token_hash=${row.previousVerifyTokenHash},updated_at=now()
                WHERE id=${request.params.id}::uuid
                  AND organization_id=${request.claims!.organizationId}::uuid
                  AND verify_token_hash=${tokenHash}`;
              await tx`
                DELETE FROM audit_logs
                WHERE id=${row.auditId}::uuid
                  AND organization_id=${request.claims!.organizationId}::uuid`;
            });
            throw error;
          }
        }
      }
      return reply
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .send({
          data: {
            rotated: true,
            callbackUrl: `${options.apiPublicUrl}/webhooks/meta/whatsapp/${row.channel.public_id}`,
            verifyToken: token,
            subscriptionConfigured,
          },
        });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/channels/:id/webhook-info",
    { preHandler: permission("channels:manage") },
    async (request, reply) => {
      const row = await byChannel(
        request.claims!.organizationId,
        request.params.id,
      );
      return row
        ? {
            data: {
              callbackUrl: `${options.apiPublicUrl}/webhooks/meta/whatsapp/${row.public_id}`,
              publicId: String(row.public_id),
              verifyTokenConfigured: Boolean(row.verify_token_hash),
              signatureVerification: true,
              lastWebhookAt: row.last_webhook_at,
              lastWebhookResult: row.last_webhook_result,
              healthStatus: row.health_status,
            },
          }
        : reply.code(404).send({
            error: {
              code: "channel_not_found",
              message: "Kanal bulunamadı.",
            },
          });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/channels/:id/session",
    { preHandler: permission("inbox:read") },
    async (request, reply) => {
      const channel = await channelRepository.byIdAccessible({
        organizationId: request.claims!.organizationId,
        channelId: request.params.id,
        userId: request.claims!.sub,
        role: request.claims!.role,
      });
      if (!channel || channel.provider !== "whatsapp_web")
        return reply.code(404).send({
          error: {
            code: "whatsapp_web_session_not_found",
            message: "WhatsApp Web oturumu bulunamadı.",
          },
        });
      const rows = await sql<Array<Record<string, unknown>>>`
        SELECT status,encrypted_qr,qr_expires_at,phone_number,push_name,
          last_heartbeat_at,last_connected_at,last_disconnected_at,
          last_error_code,last_error
        FROM whatsapp_web_sessions
        WHERE organization_id=${request.claims!.organizationId}::uuid
          AND channel_id=${request.params.id}::uuid`;
      const session = rows[0];
      if (!session)
        return reply.code(404).send({
          error: {
            code: "whatsapp_web_session_not_found",
            message: "WhatsApp Web oturumu bulunamadı.",
          },
        });
      let qrCode: string | null = null;
      if (
        session.encrypted_qr &&
        session.qr_expires_at &&
        new Date(String(session.qr_expires_at)).getTime() > Date.now() &&
        options.appEncryptionKey
      ) {
        try {
          qrCode = decryptSecret(
            String(session.encrypted_qr),
            options.appEncryptionKey,
          );
        } catch {
          qrCode = null;
        }
      }
      const iso = (value: unknown) =>
        value ? new Date(String(value)).toISOString() : null;
      return reply
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .send({
          data: {
            status: String(session.status),
            qrCode,
            qrExpiresAt: iso(session.qr_expires_at),
            phoneNumber: session.phone_number
              ? String(session.phone_number)
              : null,
            pushName: session.push_name ? String(session.push_name) : null,
            lastHeartbeatAt: iso(session.last_heartbeat_at),
            lastConnectedAt: iso(session.last_connected_at),
            lastDisconnectedAt: iso(session.last_disconnected_at),
            lastErrorCode: session.last_error_code
              ? String(session.last_error_code)
              : null,
            lastError: session.last_error ? String(session.last_error) : null,
          },
        });
    },
  );
  for (const sessionAction of ["reconnect", "logout"] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/v1/channels/:id/session/${sessionAction}`,
      { preHandler: permission("channels:manage") },
      async (request, reply) => {
        const channel = await byChannel(
          request.claims!.organizationId,
          request.params.id,
        );
        if (!channel || channel.provider !== "whatsapp_web")
          return reply.code(404).send({
            error: {
              code: "whatsapp_web_session_not_found",
              message: "WhatsApp Web oturumu bulunamadı.",
            },
          });
        const nextStatus =
          sessionAction === "logout" ? "logged_out" : "initializing";
        const rows = await sql<Array<{ status: string }>>`
          UPDATE whatsapp_web_sessions
          SET status=${nextStatus},
            encrypted_qr=NULL,
            qr_expires_at=NULL,
            assigned_worker_id=NULL,
            lease_expires_at=NULL,
            restart_attempts=0,
            next_restart_at=CASE WHEN ${sessionAction}='reconnect'
              THEN now() ELSE NULL END,
            encrypted_credentials=CASE WHEN ${sessionAction}='logout'
              THEN NULL ELSE encrypted_credentials END,
            updated_at=now()
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND channel_id=${request.params.id}::uuid
          RETURNING status`;
        if (!rows[0])
          return reply.code(404).send({
            error: {
              code: "whatsapp_web_session_not_found",
              message: "WhatsApp Web oturumu bulunamadı.",
            },
          });
        if (sessionAction === "logout")
          await sql`
            DELETE FROM whatsapp_web_signal_keys
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND channel_id=${request.params.id}::uuid`;
        await sql`
          UPDATE channels
          SET status='disconnected',connection_status='DISCONNECTED',
            health_state='UNKNOWN',updated_at=now()
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND id=${request.params.id}::uuid`;
        await audit(
          request,
          `channel.session_${sessionAction}`,
          "channel",
          request.params.id,
        );
        await publishChannelEvent(
          request.claims!.organizationId,
          "channel.session_state_changed",
          request.params.id,
          { status: rows[0].status },
        );
        return { data: { status: rows[0].status } };
      },
    );
  }
  app.post<{ Params: { id: string } }>(
    "/api/v1/channels/:id/test",
    {
      preHandler: permission("channels:manage"),
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const row = await byChannel(
        request.claims!.organizationId,
        request.params.id,
      );
      if (!row)
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Kanal bulunamadı." },
        });
      if (row.provider === "whatsapp_web") {
        const sessions = await sql<Array<Record<string, unknown>>>`
          SELECT status,last_heartbeat_at,last_error_code
          FROM whatsapp_web_sessions
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND channel_id=${request.params.id}::uuid`;
        const session = sessions[0];
        const heartbeatAge = session?.last_heartbeat_at
          ? Date.now() - new Date(String(session.last_heartbeat_at)).getTime()
          : Number.POSITIVE_INFINITY;
        const healthy =
          session?.status === "connected" && heartbeatAge < 90_000;
        const status = healthy
          ? "healthy"
          : ["initializing", "qr_ready", "reconnecting"].includes(
                String(session?.status),
              )
            ? "warning"
            : "unhealthy";
        const code = healthy
          ? null
          : String(
              session?.last_error_code ?? "WHATSAPP_WEB_SESSION_NOT_CONNECTED",
            );
        await channelRepository.updateHealth({
          organizationId: request.claims!.organizationId,
          channelId: request.params.id,
          status,
          code,
          checkedAt: new Date(),
          profile: {
            sessionStatus: String(session?.status ?? "missing"),
          },
          healthy,
        });
        await audit(request, "channel.tested", "channel", request.params.id, {
          status,
          code,
        });
        return { data: { healthy, status, code } };
      }
      const provider = createMessagingProvider({
        mode: row.provider === "meta" ? "meta" : "fake",
        ...(options.fakeMode ? { fakeMode: options.fakeMode } : {}),
        apiVersion: options.metaApiVersion,
      });
      const secrets = credentials(row, options.appEncryptionKey);
      const result = await provider.healthCheck({
        ...(row.phone_number_id
          ? { phoneNumberId: String(row.phone_number_id) }
          : {}),
        ...(secrets.accessToken ? { accessToken: secrets.accessToken } : {}),
        ...(row.provider === "meta"
          ? {
              expectedWebhookCallbackUri: `${options.apiPublicUrl}/webhooks/meta/whatsapp/${row.public_id}`,
            }
          : {}),
      });
      await channelRepository.updateHealth({
        organizationId: request.claims!.organizationId,
        channelId: request.params.id,
        status: result.status ?? (result.healthy ? "healthy" : "unhealthy"),
        code: result.code ?? null,
        checkedAt: result.checkedAt,
        profile: result.profile ?? {},
        healthy: result.healthy,
      });
      await audit(request, "channel.tested", "channel", request.params.id, {
        status: result.status ?? (result.healthy ? "healthy" : "unhealthy"),
        code: result.code ?? null,
      });
      if (!result.healthy)
        await channelRepository.createHealthWarningNotification({
          organizationId: request.claims!.organizationId,
          channelId: request.params.id,
          channelName: String(row.name),
          code: result.code ?? null,
        });
      await publishChannelEvent(
        request.claims!.organizationId,
        "channel.health_changed",
        request.params.id,
        {
          healthy: result.healthy,
          status: result.status,
          code: result.code ?? null,
        },
      );
      return {
        data: {
          status: result.status ?? (result.healthy ? "healthy" : "unhealthy"),
          code: result.code ?? null,
          checkedAt: result.checkedAt.toISOString(),
          profile: result.profile ?? {},
        },
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/channels/:id/templates/sync",
    {
      preHandler: permission("templates:sync"),
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const channel = await byChannel(
        request.claims!.organizationId,
        request.params.id,
      );
      if (!channel)
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Kanal bulunamadı." },
        });
      const businessAccountId = channel.business_account_id
        ? String(channel.business_account_id)
        : `channel:${request.params.id}`;
      const headerKey = request.headers["x-idempotency-key"];
      const idempotencyKey =
        typeof headerKey === "string" && headerKey.trim()
          ? headerKey.trim().slice(0, 200)
          : `manual:${request.params.id}:${crypto.randomUUID()}`;
      const existingRun = await templateRepository.existingSyncRun(
        request.claims!.organizationId,
        idempotencyKey,
      );
      if (existingRun)
        return {
          data: {
            runId: String(existingRun.id),
            status: String(existingRun.status),
            idempotentReplay: true,
          },
        };
      const runId = await templateRepository.startSyncRun({
        organizationId: request.claims!.organizationId,
        channelId: request.params.id,
        businessAccountId,
        idempotencyKey,
      });
      await audit(
        request,
        "template.sync_started",
        "channel",
        request.params.id,
      );
      try {
        const provider = createMessagingProvider({
          mode: channel.provider === "meta" ? "meta" : "fake",
          ...(options.fakeMode ? { fakeMode: options.fakeMode } : {}),
          apiVersion: options.metaApiVersion,
        });
        const secrets = credentials(channel, options.appEncryptionKey);
        const templates = await provider.listTemplates({
          ...(channel.business_account_id
            ? { businessAccountId: String(channel.business_account_id) }
            : {}),
          ...(secrets.accessToken ? { accessToken: secrets.accessToken } : {}),
        });
        const seen: string[] = [];
        let created = 0,
          updated = 0;
        for (const item of templates) {
          const normalizedName = normalizeTemplateName(item.name);
          const family = await sql<
            Array<{ id: string }>
          >`INSERT INTO message_template_families(organization_id,business_account_id,normalized_name,default_language) VALUES(${request.claims!.organizationId}::uuid,${businessAccountId},${normalizedName},${item.language}) ON CONFLICT(organization_id,business_account_id,normalized_name) DO UPDATE SET updated_at=now() RETURNING id`;
          const rows = await sql<
            Array<{ id: string; inserted: boolean }>
          >`INSERT INTO message_templates(organization_id,channel_id,business_account_id,family_id,provider,provider_template_id,name,normalized_name,language,category,status,quality_score,rejection_reason,header_type,header_text,body_text,footer_text,buttons,components,parameter_format,provider_payload,last_synced_at) VALUES(${request.claims!.organizationId}::uuid,${request.params.id}::uuid,${businessAccountId},${family[0]!.id}::uuid,${String(channel.provider)},${item.providerTemplateId},${item.name},${normalizedName},${item.language},${item.category},${item.status},${item.qualityScore ?? null},${item.rejectionReason ?? null},${item.headerType ?? null},${item.headerText ?? null},${item.bodyText},${item.footerText ?? null},${sql.json((item.buttons ?? []) as never)},${sql.json((item.components ?? []) as never)},${item.parameterFormat ?? "positional"},${sql.json(item.providerPayload as never)},now()) ON CONFLICT(organization_id,business_account_id,normalized_name,language) WHERE business_account_id IS NOT NULL AND normalized_name IS NOT NULL AND deleted_at IS NULL DO UPDATE SET family_id=EXCLUDED.family_id,provider_template_id=EXCLUDED.provider_template_id,previous_category=CASE WHEN message_templates.category<>EXCLUDED.category THEN message_templates.category ELSE message_templates.previous_category END,category=EXCLUDED.category,status=EXCLUDED.status,quality_score=EXCLUDED.quality_score,rejection_reason=EXCLUDED.rejection_reason,header_type=EXCLUDED.header_type,header_text=EXCLUDED.header_text,body_text=EXCLUDED.body_text,footer_text=EXCLUDED.footer_text,buttons=EXCLUDED.buttons,components=EXCLUDED.components,parameter_format=EXCLUDED.parameter_format,provider_payload=EXCLUDED.provider_payload,last_synced_at=now(),updated_at=now(),version=message_templates.version+1 RETURNING id,(xmax=0) inserted`;
          const templateId = rows[0]!.id;
          seen.push(templateId);
          if (rows[0]!.inserted) created++;
          else updated++;
          await sql`INSERT INTO message_template_channels(organization_id,template_id,channel_id) VALUES(${request.claims!.organizationId}::uuid,${templateId}::uuid,${request.params.id}::uuid) ON CONFLICT DO NOTHING`;
          await sql`DELETE FROM message_template_components WHERE template_id=${templateId}::uuid`;
          for (const [position, component] of (item.components ?? []).entries())
            await productRepository.query`INSERT INTO message_template_components(template_id,component_type,position,payload) VALUES(${templateId}::uuid,${String(component.type ?? "UNKNOWN").toLowerCase()},${position},${sql.json(component as never)})`;
          await productRepository.query`DELETE FROM message_template_variables WHERE template_id=${templateId}::uuid`;
          for (const variable of item.variables)
            await productRepository.query`INSERT INTO message_template_variables(template_id,component,position,variable_name,internal_key,example_value,source,required,missing_policy) VALUES(${templateId}::uuid,${variable.component},${variable.position},${variable.variableName},${variable.variableName},${variable.exampleValue ?? null},'provider',true,'manual')`;
        }
        const archived =
          await productRepository.query`UPDATE message_templates SET status='archived',updated_at=now() WHERE organization_id=${request.claims!.organizationId}::uuid AND business_account_id=${businessAccountId} AND provider_template_id IS NOT NULL AND NOT(id=ANY(${seen}::uuid[])) AND status<>'archived' AND deleted_at IS NULL RETURNING id`;
        await templateRepository.completeSyncRun({
          runId,
          received: templates.length,
          created,
          updated,
          archived: archived.length,
        });
        await audit(
          request,
          "template.sync_completed",
          "channel",
          request.params.id,
          {
            received: templates.length,
            created,
            updated,
            archived: archived.length,
          },
        );
        return {
          data: {
            runId,
            status: "completed",
            received: templates.length,
            created,
            updated,
            archived: archived.length,
          },
        };
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "template_sync_failed";
        await templateRepository.failSyncRun(runId, code);
        await audit(
          request,
          "template.sync_failed",
          "channel",
          request.params.id,
          { code },
        );
        await templateRepository.notifySyncFailure({
          organizationId: request.claims!.organizationId,
          channelId: request.params.id,
          runId,
          code,
        });
        throw error;
      }
    },
  );
  const templateQuery = z.object({
    channelId: uuid.optional(),
    businessAccountId: z.string().max(100).optional(),
    language: z.string().max(20).optional(),
    category: z.string().max(40).optional(),
    status: z.string().max(40).optional(),
    quality: z.string().max(40).optional(),
    usage: z.enum(["used", "unused"]).optional(),
    search: z.string().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });
  app.get(
    "/api/v1/templates",
    { preHandler: permission("templates:read") },
    async (request) => {
      const query = templateQuery.parse(request.query);
      return templateRepository.list({
        organizationId: request.claims!.organizationId,
        userId: request.claims!.sub,
        role: request.claims!.role,
        ...query,
      });
    },
  );
  app.get(
    "/api/v1/templates/summary",
    { preHandler: permission("templates:read") },
    async (request) => {
      const query = z
        .object({
          channelId: uuid.optional(),
          businessAccountId: z.string().max(100).optional(),
        })
        .parse(request.query);
      return {
        data: await templateRepository.summary({
          organizationId: request.claims!.organizationId,
          userId: request.claims!.sub,
          role: request.claims!.role,
          ...query,
        }),
      };
    },
  );
  app.get(
    "/api/v1/template-families",
    { preHandler: permission("templates:read") },
    async (request) => ({
      data: await templateRepository.families(request.claims!.organizationId),
    }),
  );
  app.post(
    "/api/v1/templates",
    { preHandler: permission("templates:create") },
    async (request, reply) => {
      const body = templateDraftInput.parse(request.body);
      const componentErrors = validateTemplateComponents(
        body.components as TemplateComponentDraft[],
      );
      const invalidVariables = body.variables
        .filter(
          (variable) => !validateInternalVariableKey(variable.internalKey),
        )
        .map((variable) => variable.internalKey);
      if (componentErrors.length || invalidVariables.length)
        return reply.code(400).send({
          error: {
            code: "template_validation_failed",
            message: "Åablon Meta kurallarÄ±na uygun deÄŸil.",
            details: { componentErrors, invalidVariables },
          },
        });
      const channel = await byChannel(
        request.claims!.organizationId,
        body.channelId,
      );
      if (!channel)
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Kanal bulunamadÄ±." },
        });
      const businessAccountId = channel.business_account_id
        ? String(channel.business_account_id)
        : `channel:${body.channelId}`;
      const normalizedName = normalizeTemplateName(body.name);
      const result = await productRepository.begin(async (tx) => {
        const family = await tx<
          Array<{ id: string }>
        >`INSERT INTO message_template_families(organization_id,business_account_id,normalized_name,default_language,fallback_language,internal_label,folder,created_by,updated_by) VALUES(${request.claims!.organizationId}::uuid,${businessAccountId},${normalizedName},${body.defaultLanguage ?? body.language},${body.fallbackLanguage ?? null},${body.internalLabel ?? null},${body.folder ?? null},${request.claims!.sub}::uuid,${request.claims!.sub}::uuid) ON CONFLICT(organization_id,business_account_id,normalized_name) DO UPDATE SET fallback_language=COALESCE(EXCLUDED.fallback_language,message_template_families.fallback_language),internal_label=COALESCE(EXCLUDED.internal_label,message_template_families.internal_label),folder=COALESCE(EXCLUDED.folder,message_template_families.folder),updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING id`;
        const header = body.components.find(
          (component) => component.type === "HEADER",
        );
        const content = body.components.find(
          (component) => component.type === "BODY",
        )!;
        const footer = body.components.find(
          (component) => component.type === "FOOTER",
        );
        const buttons = body.components.find(
          (component) => component.type === "BUTTONS",
        );
        const inserted = await tx<
          Array<Record<string, unknown>>
        >`INSERT INTO message_templates(organization_id,channel_id,business_account_id,family_id,provider,provider_template_id,name,normalized_name,language,category,status,header_type,header_text,body_text,footer_text,buttons,components,parameter_format,provider_payload,internal_label,folder,created_by,updated_by) VALUES(${request.claims!.organizationId}::uuid,${body.channelId}::uuid,${businessAccountId},${family[0]!.id}::uuid,${String(channel.provider)},null,${normalizedName},${normalizedName},${body.language},${body.category},'draft',${header?.format?.toLowerCase() ?? null},${header?.text ?? null},${content.text ?? ""},${footer?.text ?? null},${tx.json((buttons?.buttons ?? []) as never)},${tx.json(body.components as never)},${body.parameterFormat},${tx.json({ draft: true } as never)},${body.internalLabel ?? null},${body.folder ?? null},${request.claims!.sub}::uuid,${request.claims!.sub}::uuid) RETURNING *`;
        const template = inserted[0]!;
        await tx`INSERT INTO message_template_channels(organization_id,template_id,channel_id) VALUES(${request.claims!.organizationId}::uuid,${String(template.id)}::uuid,${body.channelId}::uuid)`;
        for (const [position, component] of body.components.entries())
          await tx`INSERT INTO message_template_components(template_id,component_type,position,payload) VALUES(${String(template.id)}::uuid,${component.type.toLowerCase()},${position},${tx.json(component as never)})`;
        for (const variable of body.variables)
          await tx`INSERT INTO message_template_variables(template_id,component,position,variable_name,internal_key,example_value,default_value,source,required,missing_policy,formatter) VALUES(${String(template.id)}::uuid,${variable.component},${variable.position},${variable.internalKey},${variable.internalKey},${variable.exampleValue ?? null},${variable.defaultValue ?? null},'mapping',${variable.required},${variable.missingPolicy},${variable.formatter ?? null})`;
        await tx`INSERT INTO message_template_versions(organization_id,template_id,version,source,snapshot,actor_id) VALUES(${request.claims!.organizationId}::uuid,${String(template.id)}::uuid,1,'draft',${tx.json({ ...body, normalizedName } as never)},${request.claims!.sub}::uuid)`;
        return template;
      });
      await audit(request, "template.created", "template", String(result.id), {
        normalizedName,
        language: body.language,
        category: body.category,
      });
      return reply.code(201).send({
        data: {
          ...result,
          normalizedName,
          validation: { valid: true, componentErrors: [] },
        },
      });
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/templates/:id",
    { preHandler: permission("templates:update") },
    async (request, reply) => {
      const body = templateUpdateInput.parse(request.body);
      const current = await templateRepository.editableTemplate(
        request.claims!.organizationId,
        request.params.id,
      );
      if (!current)
        return reply.code(404).send({
          error: { code: "template_not_found", message: "Şablon bulunamadı." },
        });
      if (!["draft", "rejected"].includes(String(current.status)))
        return reply.code(409).send({
          error: {
            code: "template_edit_requires_draft",
            message:
              "Yalnızca taslak veya reddedilmiş şablonlar düzenlenebilir. Onaylı şablon için yeni bir sürüm oluşturun.",
          },
        });

      const components = (body.components ??
        current.components ??
        []) as TemplateComponentDraft[];
      const variables = body.variables;
      const componentErrors = validateTemplateComponents(components);
      const invalidVariables = (variables ?? [])
        .filter(
          (variable) => !validateInternalVariableKey(variable.internalKey),
        )
        .map((variable) => variable.internalKey);
      if (componentErrors.length || invalidVariables.length)
        return reply.code(400).send({
          error: {
            code: "template_validation_failed",
            message: "Şablon Meta kurallarına uygun değil.",
            details: { componentErrors, invalidVariables },
          },
        });

      const channelId = body.channelId ?? String(current.edit_channel_id);
      const channel = await byChannel(
        request.claims!.organizationId,
        channelId,
      );
      if (!channel)
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Kanal bulunamadı." },
        });
      const businessAccountId = channel.business_account_id
        ? String(channel.business_account_id)
        : `channel:${channelId}`;
      const normalizedName = normalizeTemplateName(
        body.name ?? String(current.name),
      );
      const language = body.language ?? String(current.language);
      const category = body.category ?? String(current.category);
      const header = components.find(
        (component) => component.type === "HEADER",
      );
      const content = components.find(
        (component) => component.type === "BODY",
      )!;
      const footer = components.find(
        (component) => component.type === "FOOTER",
      );
      const buttons = components.find(
        (component) => component.type === "BUTTONS",
      );

      const updated = await productRepository.begin(async (tx) => {
        const family = await tx<Array<{ id: string }>>`
          INSERT INTO message_template_families(
            organization_id,business_account_id,normalized_name,default_language,
            fallback_language,internal_label,folder,updated_by
          ) VALUES(
            ${request.claims!.organizationId}::uuid,${businessAccountId},
            ${normalizedName},${body.defaultLanguage ?? language},
            ${body.fallbackLanguage ?? null},
            ${body.internalLabel ?? (current.internal_label as string | null)},
            ${body.folder ?? (current.folder as string | null)},
            ${request.claims!.sub}::uuid
          )
          ON CONFLICT(organization_id,business_account_id,normalized_name)
          DO UPDATE SET
            fallback_language=COALESCE(EXCLUDED.fallback_language,message_template_families.fallback_language),
            internal_label=EXCLUDED.internal_label,folder=EXCLUDED.folder,
            updated_by=EXCLUDED.updated_by,updated_at=now()
          RETURNING id`;
        const rows = await tx<Array<Record<string, unknown>>>`
          UPDATE message_templates SET
            channel_id=${channelId}::uuid,
            business_account_id=${businessAccountId},
            family_id=${family[0]!.id}::uuid,
            provider=${String(channel.provider)},
            name=${normalizedName},
            normalized_name=${normalizedName},
            language=${language},
            category=${category},
            header_type=${header?.format?.toLowerCase() ?? null},
            header_text=${header?.text ?? null},
            body_text=${content.text ?? ""},
            footer_text=${footer?.text ?? null},
            buttons=${tx.json((buttons?.buttons ?? []) as never)},
            components=${tx.json(components as never)},
            parameter_format=${body.parameterFormat ?? String(current.parameter_format)},
            internal_label=${body.internalLabel ?? (current.internal_label as string | null)},
            folder=${body.folder ?? (current.folder as string | null)},
            version=version+1,updated_by=${request.claims!.sub}::uuid,updated_at=now()
          WHERE id=${request.params.id}::uuid
            AND organization_id=${request.claims!.organizationId}::uuid
          RETURNING *`;
        await tx`DELETE FROM message_template_channels WHERE organization_id=${request.claims!.organizationId}::uuid AND template_id=${request.params.id}::uuid`;
        await tx`INSERT INTO message_template_channels(organization_id,template_id,channel_id) VALUES(${request.claims!.organizationId}::uuid,${request.params.id}::uuid,${channelId}::uuid)`;
        await tx`DELETE FROM message_template_components WHERE template_id=${request.params.id}::uuid`;
        for (const [position, component] of components.entries())
          await tx`INSERT INTO message_template_components(template_id,component_type,position,payload) VALUES(${request.params.id}::uuid,${component.type.toLowerCase()},${position},${tx.json(component as never)})`;
        if (variables) {
          await tx`DELETE FROM message_template_variables WHERE template_id=${request.params.id}::uuid`;
          for (const variable of variables)
            await tx`INSERT INTO message_template_variables(template_id,component,position,variable_name,internal_key,example_value,default_value,source,required,missing_policy,formatter) VALUES(${request.params.id}::uuid,${variable.component},${variable.position},${variable.internalKey},${variable.internalKey},${variable.exampleValue ?? null},${variable.defaultValue ?? null},'mapping',${variable.required},${variable.missingPolicy},${variable.formatter ?? null})`;
        }
        await tx`INSERT INTO message_template_versions(organization_id,template_id,version,source,snapshot,actor_id) VALUES(${request.claims!.organizationId}::uuid,${request.params.id}::uuid,${Number(rows[0]!.version)},'draft_update',${tx.json(rows[0] as never)},${request.claims!.sub}::uuid)`;
        return rows[0]!;
      });
      await audit(request, "template.updated", "template", request.params.id, {
        normalizedName,
        language,
        category,
      });
      return { data: updated };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/templates/:id/submit",
    {
      preHandler: permission("templates:submit"),
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const template = await templateRepository.managementTemplate(
        request.claims!.organizationId,
        request.params.id,
      );
      if (!template)
        return reply.code(404).send({
          error: { code: "template_not_found", message: "Åablon bulunamadÄ±." },
        });
      const components = Array.isArray(template.components)
        ? (template.components as Array<Record<string, unknown>>)
        : [];
      const componentErrors = validateTemplateComponents(
        components as unknown as TemplateComponentDraft[],
      );
      if (componentErrors.length)
        return reply.code(400).send({
          error: {
            code: "template_validation_failed",
            message: "Åablon gÃ¶nderimden Ã¶nce dÃ¼zeltilmelidir.",
            details: componentErrors,
          },
        });
      const provider = createMessagingProvider({
        mode: template.provider === "meta" ? "meta" : "fake",
        ...(options.fakeMode ? { fakeMode: options.fakeMode } : {}),
        apiVersion: options.metaApiVersion,
      });
      const secrets = credentials(template, options.appEncryptionKey);
      const mutation = template.provider_template_id
        ? await provider.updateTemplate({
            providerTemplateId: String(template.provider_template_id),
            ...(secrets.accessToken
              ? { accessToken: secrets.accessToken }
              : {}),
            category: String(template.category),
            components,
          })
        : await provider.createTemplate({
            businessAccountId: String(
              template.business_account_id ?? template.channel_waba,
            ),
            ...(secrets.accessToken
              ? { accessToken: secrets.accessToken }
              : {}),
            name: String(template.normalized_name ?? template.name),
            language: String(template.language),
            category: String(template.category),
            components,
            parameterFormat:
              template.parameter_format === "named" ? "named" : "positional",
          });
      const updated = await templateRepository.saveProviderSubmission({
        organizationId: request.claims!.organizationId,
        templateId: request.params.id,
        actorId: request.claims!.sub,
        ...(mutation.providerTemplateId
          ? { providerTemplateId: mutation.providerTemplateId }
          : {}),
        status: mutation.status,
        ...(mutation.category ? { category: mutation.category } : {}),
        raw: mutation.raw,
      });
      await audit(
        request,
        "template.submitted",
        "template",
        request.params.id,
        {
          providerTemplateId: mutation.providerTemplateId ?? null,
          status: mutation.status,
        },
      );
      return reply.code(202).send({ data: updated });
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/templates/:id",
    { preHandler: permission("templates:delete") },
    async (request, reply) => {
      const template = await templateRepository.managementTemplate(
        request.claims!.organizationId,
        request.params.id,
      );
      if (!template)
        return reply.code(404).send({
          error: { code: "template_not_found", message: "Åablon bulunamadÄ±." },
        });
      const dependencies = await templateRepository.dependencies(
        request.claims!.organizationId,
        request.params.id,
      );
      if (dependencies.length)
        return reply.code(409).send({
          error: {
            code: "template_has_dependencies",
            message:
              "Åablon aktif otomasyon veya kampanyalarda kullanÄ±lÄ±yor.",
            details: dependencies,
          },
        });
      let providerResult: Record<string, unknown> = { localDraft: true };
      if (template.provider_template_id) {
        const provider = createMessagingProvider({
          mode: template.provider === "meta" ? "meta" : "fake",
          ...(options.fakeMode ? { fakeMode: options.fakeMode } : {}),
          apiVersion: options.metaApiVersion,
        });
        const secrets = credentials(template, options.appEncryptionKey);
        const mutation = await provider.deleteTemplate({
          businessAccountId: String(
            template.business_account_id ?? template.channel_waba,
          ),
          ...(secrets.accessToken ? { accessToken: secrets.accessToken } : {}),
          providerTemplateId: String(template.provider_template_id),
          name: String(template.normalized_name ?? template.name),
        });
        providerResult = mutation.raw;
      }
      await templateRepository.softDelete(
        request.claims!.organizationId,
        request.params.id,
        request.claims!.sub,
      );
      await audit(request, "template.deleted", "template", request.params.id, {
        providerResult,
      });
      return { data: { deleted: true, providerResult } };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/templates/:id/test-send",
    {
      preHandler: permission("templates:test"),
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const body = z
        .object({
          channelId: uuid,
          recipient: z
            .string()
            .trim()
            .regex(/^\+?\d{8,15}$/),
          variables: z.array(z.string().max(1000)).max(100).default([]),
        })
        .parse(request.body);
      const template = await templateRepository.managementTemplate(
        request.claims!.organizationId,
        request.params.id,
        body.channelId,
      );
      if (!template)
        return reply.code(404).send({
          error: { code: "template_not_found", message: "Åablon bulunamadÄ±." },
        });
      if (template.status !== "approved")
        return reply.code(409).send({
          error: {
            code: "template_not_approved",
            message:
              "YalnÄ±zca onaylÄ± ÅŸablonlar test gÃ¶nderiminde kullanÄ±labilir.",
          },
        });
      if (!template.phone_number_id)
        return reply.code(409).send({
          error: {
            code: "channel_phone_number_id_missing",
            message: "Kanal Phone Number ID yapÄ±landÄ±rÄ±lmamÄ±ÅŸ.",
          },
        });
      const provider = createMessagingProvider({
        mode: template.provider === "meta" ? "meta" : "fake",
        ...(options.fakeMode ? { fakeMode: options.fakeMode } : {}),
        apiVersion: options.metaApiVersion,
      });
      const secrets = credentials(template, options.appEncryptionKey);
      const result = await provider.sendTemplate({
        channelId: body.channelId,
        phoneNumberId: String(template.phone_number_id),
        recipient: body.recipient.replace(/^\+/, ""),
        templateName: String(template.normalized_name ?? template.name),
        language: String(template.language),
        variables: body.variables,
        idempotencyKey: `template-test:${request.params.id}:${crypto.randomUUID()}`,
        ...(secrets.accessToken ? { accessToken: secrets.accessToken } : {}),
      });
      await audit(
        request,
        "template.test_sent",
        "template",
        request.params.id,
        {
          channelId: body.channelId,
          providerMessageId: result.providerMessageId,
        },
      );
      return reply.code(202).send({
        data: {
          providerMessageId: result.providerMessageId,
          acceptedAt: result.acceptedAt.toISOString(),
        },
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/templates/:id/analytics",
    { preHandler: permission("templates:analytics") },
    async (request) => {
      const metrics = await templateRepository.analytics(
        request.claims!.organizationId,
        request.params.id,
      );
      return {
        data: {
          ...metrics,
          buttonClicks: null,
          estimatedCost: null,
          conversion: null,
          unavailable: ["buttonClicks", "estimatedCost", "conversion"],
        },
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/templates/:id",
    { preHandler: permission("templates:read") },
    async (request, reply) => {
      const detail = await templateRepository.detail({
        organizationId: request.claims!.organizationId,
        templateId: request.params.id,
        userId: request.claims!.sub,
        role: request.claims!.role,
      });
      if (!detail)
        return reply.code(404).send({
          error: {
            code: "template_not_found",
            message: "Şablon bulunamadı.",
          },
        });
      const { providerPayload, ...safe } = detail;
      return {
        data: {
          ...safe,
          ...(["owner", "admin"].includes(request.claims!.role)
            ? { providerPayload }
            : {}),
        },
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/channels/:id/templates",
    { preHandler: permission("templates:read") },
    async (request) => ({
      data: await templateRepository.channelTemplates({
        organizationId: request.claims!.organizationId,
        channelId: request.params.id,
        userId: request.claims!.sub,
        role: request.claims!.role,
      }),
    }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/template-messages",
    { preHandler: permission("message:send") },
    async (request, reply) => {
      const body = z
        .object({
          clientMessageId: uuid,
          channelId: uuid.optional(),
          templateId: uuid,
          language: z.string().min(2).max(20),
          variables: z.record(z.string(), z.string().max(1000)),
        })
        .parse(request.body);
      const existing =
        await sql`SELECT * FROM messages WHERE organization_id=${request.claims!.organizationId}::uuid AND client_message_id=${body.clientMessageId}::uuid`;
      if (existing[0]) {
        const message = await messageRepository.getById(
          request.claims!.organizationId,
          String(existing[0].id),
        );
        return reply.code(202).send({ data: message });
      }
      const messageId = await sql.begin(async (tx) => {
        const rows = await tx<
          Array<Record<string, unknown>>
        >`SELECT c.id conversation_id,c.channel_id,c.contact_id,mt.id template_id,mt.name,mt.language,mt.status,mt.body_text,mt.components,ct.first_name contact_first_name,ct.last_name contact_last_name,ct.normalized_phone contact_phone,ct.language contact_language,ct.country contact_country,u.full_name assigned_user_name,o.name workspace_name,crm.context bitrix_context FROM conversations c JOIN message_template_channels mtc ON mtc.channel_id=c.channel_id AND mtc.organization_id=c.organization_id JOIN message_templates mt ON mt.id=mtc.template_id AND mt.id=${body.templateId}::uuid AND mt.organization_id=c.organization_id AND mt.deleted_at IS NULL JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id JOIN organizations o ON o.id=c.organization_id LEFT JOIN users u ON u.id=c.assignee_id LEFT JOIN conversation_crm_context_cache crm ON crm.organization_id=c.organization_id AND crm.conversation_id=c.id WHERE c.id=${request.params.id}::uuid AND c.organization_id=${request.claims!.organizationId}::uuid AND (${!["agent", "team_lead"].includes(request.claims!.role)} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${request.claims!.sub}::uuid)) FOR UPDATE OF c,mt`;
        const row = rows[0];
        if (!row)
          throw Object.assign(new Error("template_conversation_mismatch"), {
            statusCode: 409,
          });
        if (body.channelId && String(row.channel_id) !== body.channelId)
          throw Object.assign(new Error("SELECTED_CHANNEL_MISMATCH"), {
            statusCode: 409,
          });
        if (row.status !== "approved")
          throw Object.assign(new Error("template_not_approved"), {
            statusCode: 409,
          });
        if (row.language !== body.language)
          throw Object.assign(new Error("template_language_mismatch"), {
            statusCode: 400,
          });
        const variableRows = await tx<
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
        >`SELECT component,position,internal_key,example_value,default_value,required,missing_policy,formatter FROM message_template_variables WHERE template_id=${body.templateId}::uuid ORDER BY component,position`;
        const expected = variableRows.map(
          (v) => `${v.component}.${v.position}`,
        );
        const unknown = Object.keys(body.variables).filter(
          (key) => !expected.includes(key),
        );
        const context: Record<string, unknown> = {
          "contact.first_name": row.contact_first_name,
          "contact.last_name": row.contact_last_name,
          "contact.phone": row.contact_phone,
          "contact.language": row.contact_language,
          "contact.country": row.contact_country,
          "assigned_user.name": row.assigned_user_name,
          "workspace.name": row.workspace_name,
          ...flattenTemplateContext(row.bitrix_context, "bitrix"),
        };
        const mappings: TemplateVariableMapping[] = variableRows.map(
          (variable) => ({
            component: variable.component,
            position: variable.position,
            internalKey:
              variable.internal_key ??
              `${variable.component}.${variable.position}`,
            ...(variable.example_value
              ? { exampleValue: variable.example_value }
              : {}),
            ...(variable.default_value
              ? { defaultValue: variable.default_value }
              : {}),
            ...(variable.formatter ? { formatter: variable.formatter } : {}),
            required: variable.required,
            missingPolicy: variable.missing_policy,
          }),
        );
        const manual = Object.fromEntries(
          mappings.flatMap((mapping) => {
            const provided =
              body.variables[`${mapping.component}.${mapping.position}`];
            return provided ? [[mapping.internalKey, provided]] : [];
          }),
        );
        const resolved = resolveTemplateVariables(mappings, context, manual);
        if (unknown.length || resolved.blocking.length)
          throw Object.assign(new Error("template_variables_invalid"), {
            statusCode: 400,
            details: [
              ...unknown.map((key) => `unknown:${key}`),
              ...resolved.blocking.map((key) => `missing:${key}`),
            ],
          });
        const resolvedVariables = Object.fromEntries(
          resolved.values.map((value) => [value.key, value.value ?? ""]),
        );
        const orderedVariables = expected.map(
          (key) => resolvedVariables[key] ?? "",
        );
        const preview = expected.reduce(
          (text, key, index) =>
            text.replace(
              new RegExp(`\\{\\{${index + 1}\\}\\}`, "g"),
              resolvedVariables[key] ?? "",
            ),
          String(row.body_text),
        );
        const traceId = crypto.randomUUID();
        const inserted = await tx<
          Array<Record<string, unknown>>
        >`INSERT INTO messages(organization_id,conversation_id,channel_id,contact_id,client_message_id,direction,type,status,body,sender_id,metadata) VALUES(${request.claims!.organizationId}::uuid,${request.params.id}::uuid,${String(row.channel_id)}::uuid,${String(row.contact_id)}::uuid,${body.clientMessageId}::uuid,'outbound','template','pending',${preview},${request.claims!.sub}::uuid,${tx.json({ templateId: body.templateId, templateName: String(row.name), language: body.language, variables: resolvedVariables, variableResolution: resolved.values, orderedVariables, templateComponents: row.components } as never)}) RETURNING *`;
        const message = inserted[0]!;
        await tx`INSERT INTO outbox_jobs(organization_id,aggregate_type,aggregate_id,job_type,payload) VALUES(${request.claims!.organizationId}::uuid,'message',${String(message.id)}::uuid,'template.send',${tx.json({ messageId: String(message.id), traceId } as never)})`;
        await tx`INSERT INTO message_flow_events(organization_id,message_id,trace_id,event_type,source) VALUES(${request.claims!.organizationId}::uuid,${String(message.id)}::uuid,${traceId}::uuid,'message.accepted','api'),(${request.claims!.organizationId}::uuid,${String(message.id)}::uuid,${traceId}::uuid,'outbox.created','api')`;
        await tx`INSERT INTO template_send_events(organization_id,template_id,message_id,status) VALUES(${request.claims!.organizationId}::uuid,${body.templateId}::uuid,${String(message.id)}::uuid,'pending')`;
        await tx`UPDATE message_templates SET usage_count=usage_count+1,last_used_at=now(),updated_at=now() WHERE id=${body.templateId}::uuid`;
        return String(message.id);
      });
      const result = await messageRepository.getById(
        request.claims!.organizationId,
        messageId,
      );
      if (!result)
        throw Object.assign(new Error("message_not_found_after_insert"), {
          statusCode: 500,
        });
      return reply.code(202).send({ data: result });
    },
  );

  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/api/v1/quick-replies",
    { preHandler: permission("quick_replies:read") },
    async (request) => {
      const query = z
        .object({
          search: z.string().trim().max(100).optional(),
          scope: z.enum(["organization", "team", "personal"]).optional(),
          status: z.enum(["active", "archived"]).default("active"),
          language: z.string().trim().max(20).optional(),
          teamId: uuid.optional(),
          channelId: uuid.optional(),
          categoryId: uuid.optional(),
          tagId: uuid.optional(),
          conversationId: uuid.optional(),
          favorite: z.enum(["true", "false"]).optional(),
          sort: z
            .enum(["relevance", "usage", "recent", "updated", "alphabetical"])
            .default("usage"),
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .parse(request.query);
      const offset = (query.page - 1) * query.limit;
      const conversationLanguage = query.conversationId
        ? await quickSql`
            SELECT ct.language
            FROM conversations c
            JOIN contacts ct
              ON ct.id=c.contact_id AND ct.organization_id=c.organization_id
            WHERE c.id=${query.conversationId}::uuid
              AND c.organization_id=${request.claims!.organizationId}::uuid
              AND (
                ${!["agent", "team_lead"].includes(request.claims!.role)}
                OR EXISTS(
                  SELECT 1 FROM channel_user_ownership cuo
                  WHERE cuo.organization_id=c.organization_id
                    AND cuo.channel_id=c.channel_id
                    AND cuo.user_id=${request.claims!.sub}::uuid
                )
              )`
        : [];
      if (query.conversationId && !conversationLanguage[0])
        return {
          data: [],
          meta: { page: query.page, limit: query.limit, total: 0 },
        };
      const preferredLanguage = conversationLanguage[0]?.language
        ? String(conversationLanguage[0].language)
        : null;
      const secondaryOrder =
        query.sort === "alphabetical"
          ? sql`qr.title ASC`
          : query.sort === "recent"
            ? sql`qr.last_used_at DESC NULLS LAST,qr.updated_at DESC`
            : query.sort === "updated"
              ? sql`qr.updated_at DESC`
              : sql`favorite DESC,qr.usage_count DESC,qr.updated_at DESC`;
      const order = sql`
        CASE
          WHEN ${preferredLanguage}::text IS NOT NULL
            AND qr.language=${preferredLanguage} THEN 0
          WHEN qr.language=coalesce(qr.fallback_language,'tr') THEN 1
          ELSE 2
        END,
        ${secondaryOrder}`;
      const rows = await quickSql<Array<Record<string, unknown>>>`
        SELECT qr.*,qrc.name category_name,qrc.color category_color,
          u.full_name owner_name,t.name team_name,updated.full_name updated_by_name,
          EXISTS(
            SELECT 1 FROM quick_reply_favorites qrf
            WHERE qrf.quick_reply_id=qr.id
              AND qrf.user_id=${request.claims!.sub}::uuid
          ) favorite,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object('id',qrt.id,'name',qrt.name,'color',qrt.color) ORDER BY qrt.name)
            FROM quick_reply_tag_assignments qrta
            JOIN quick_reply_tags qrt ON qrt.id=qrta.tag_id
            WHERE qrta.quick_reply_id=qr.id
          ),'[]'::jsonb) tags,
          COALESCE((
            SELECT count(*)::int FROM quick_reply_attachments qra
            WHERE qra.quick_reply_id=qr.id AND qra.scan_status='clean'
          ),0) attachment_count,
          (
            SELECT qra.id FROM quick_reply_attachments qra
            WHERE qra.quick_reply_id=qr.id AND qra.scan_status='clean'
            ORDER BY qra.created_at LIMIT 1
          ) attachment_id,
          (
            SELECT qra.filename FROM quick_reply_attachments qra
            WHERE qra.quick_reply_id=qr.id AND qra.scan_status='clean'
            ORDER BY qra.created_at LIMIT 1
          ) attachment_filename,
          count(*) OVER() total_count
        FROM quick_replies qr
        LEFT JOIN quick_reply_categories qrc ON qrc.id=qr.category_id
        LEFT JOIN users u ON u.id=qr.owner_user_id
        LEFT JOIN teams t ON t.id=qr.team_id
        LEFT JOIN users updated ON updated.id=qr.updated_by
        WHERE qr.organization_id=${request.claims!.organizationId}::uuid
          AND qr.status=${query.status}
          AND (
            qr.scope='organization'
            OR qr.scope='personal' AND qr.owner_user_id=${request.claims!.sub}::uuid
            OR qr.scope='team' AND EXISTS(
              SELECT 1 FROM team_members tm
              WHERE tm.organization_id=qr.organization_id
                AND tm.team_id=qr.team_id
                AND tm.user_id=${request.claims!.sub}::uuid
            )
          )
          AND (${query.scope ?? null}::text IS NULL OR qr.scope=${query.scope ?? null})
          AND (${query.language ?? null}::text IS NULL OR qr.language=${query.language ?? null})
          AND (${query.teamId ?? null}::uuid IS NULL OR qr.team_id=${query.teamId ?? null}::uuid)
          AND (${query.channelId ?? null}::uuid IS NULL OR qr.channel_id=${query.channelId ?? null}::uuid)
          AND (
            ${query.conversationId ?? null}::uuid IS NULL
            OR qr.channel_id IS NULL
            OR EXISTS(
              SELECT 1 FROM conversations quick_conversation
              WHERE quick_conversation.id=${query.conversationId ?? null}::uuid
                AND quick_conversation.organization_id=qr.organization_id
                AND quick_conversation.channel_id=qr.channel_id
            )
          )
          AND (${query.categoryId ?? null}::uuid IS NULL OR qr.category_id=${query.categoryId ?? null}::uuid)
          AND (
            ${query.tagId ?? null}::uuid IS NULL
            OR EXISTS(
              SELECT 1 FROM quick_reply_tag_assignments qrta
              WHERE qrta.quick_reply_id=qr.id
                AND qrta.tag_id=${query.tagId ?? null}::uuid
            )
          )
          AND (
            ${query.favorite ?? null}::text IS NULL
            OR EXISTS(
              SELECT 1 FROM quick_reply_favorites qrf
              WHERE qrf.quick_reply_id=qr.id
                AND qrf.user_id=${request.claims!.sub}::uuid
            )=${query.favorite === "true"}
          )
          AND (
            ${query.search ?? null}::text IS NULL
            OR qr.title ILIKE ${`%${query.search ?? ""}%`}
            OR qr.normalized_shortcut ILIKE ${`%${normalizeQuickReplyShortcut(query.search ?? "")}%`}
            OR qr.content ILIKE ${`%${query.search ?? ""}%`}
            OR qrc.name ILIKE ${`%${query.search ?? ""}%`}
            OR EXISTS(
              SELECT 1 FROM quick_reply_tag_assignments qrta
              JOIN quick_reply_tags qrt ON qrt.id=qrta.tag_id
              WHERE qrta.quick_reply_id=qr.id
                AND qrt.name ILIKE ${`%${query.search ?? ""}%`}
            )
          )
        ORDER BY ${order}
        LIMIT ${query.limit} OFFSET ${offset}`;
      return {
        data: rows,
        meta: {
          page: query.page,
          limit: query.limit,
          total: Number(rows[0]?.total_count ?? 0),
        },
      };
    },
  );
  app.get(
    "/api/v1/quick-replies/summary",
    { preHandler: permission("quick_replies:read") },
    async (request) => {
      const rows = await quickSql<Array<Record<string, unknown>>>`
        SELECT
          count(*) FILTER(WHERE qr.status='active')::int total,
          count(*) FILTER(WHERE qr.status='active' AND qr.scope='organization')::int organization,
          count(*) FILTER(WHERE qr.status='active' AND qr.scope='team')::int team,
          count(*) FILTER(WHERE qr.status='active' AND qr.scope='personal')::int personal,
          count(*) FILTER(WHERE qr.status='archived')::int archived,
          count(*) FILTER(WHERE qr.status='active' AND qr.last_used_at>now()-interval '7 days')::int recent,
          count(*) FILTER(WHERE qr.status='active' AND EXISTS(
            SELECT 1 FROM quick_reply_favorites qrf
            WHERE qrf.quick_reply_id=qr.id AND qrf.user_id=${request.claims!.sub}::uuid
          ))::int favorites
        FROM quick_replies qr
        WHERE qr.organization_id=${request.claims!.organizationId}::uuid
          AND qr.status<>'deleted'
          AND (
            qr.scope='organization'
            OR qr.scope='personal' AND qr.owner_user_id=${request.claims!.sub}::uuid
            OR qr.scope='team' AND EXISTS(
              SELECT 1 FROM team_members tm
              WHERE tm.organization_id=qr.organization_id
                AND tm.team_id=qr.team_id
                AND tm.user_id=${request.claims!.sub}::uuid
            )
          )`;
      return { data: rows[0] };
    },
  );
  app.get(
    "/api/v1/quick-reply-categories",
    { preHandler: permission("quick_replies:read") },
    async (request) => ({
      data: await quickSql`
        SELECT qrc.*,count(qr.id)::int usage_count
        FROM quick_reply_categories qrc
        LEFT JOIN quick_replies qr
          ON qr.category_id=qrc.id AND qr.status<>'deleted'
        WHERE qrc.organization_id=${request.claims!.organizationId}::uuid
          AND qrc.archived_at IS NULL
          AND (
            qrc.scope='organization'
            OR qrc.scope='team' AND EXISTS(
              SELECT 1 FROM team_members tm
              WHERE tm.organization_id=qrc.organization_id
                AND tm.team_id=qrc.team_id
                AND tm.user_id=${request.claims!.sub}::uuid
            )
          )
        GROUP BY qrc.id ORDER BY qrc.sort_order,qrc.name`,
    }),
  );
  app.post(
    "/api/v1/quick-reply-categories",
    { preHandler: permission("quick_replies:manage_team") },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1).max(80),
          scope: z.enum(["organization", "team"]),
          teamId: uuid.nullish(),
          color: z.string().trim().max(20).nullish(),
          icon: z.string().trim().max(40).nullish(),
        })
        .superRefine((value, context) => {
          if (value.scope === "team" && !value.teamId)
            context.addIssue({
              code: "custom",
              path: ["teamId"],
              message: "Ekip kategorisi için ekip gereklidir.",
            });
        })
        .parse(request.body);
      if (
        body.scope === "organization" &&
        !can(request.claims!.role, "quick_replies:manage_workspace")
      )
        return reply.code(403).send({
          error: { code: "forbidden", message: "Yetkiniz yok." },
        });
      const normalizedName = body.name.toLocaleLowerCase("tr-TR");
      const categoryTeamId =
        body.scope === "team" ? (body.teamId ?? null) : null;
      if (body.scope === "team") {
        const team = await quickSql`
          SELECT 1 FROM teams t
          WHERE t.id=${categoryTeamId}::uuid
            AND t.organization_id=${request.claims!.organizationId}::uuid
            AND (
              ${["owner", "admin"].includes(request.claims!.role)}
              OR EXISTS(
                SELECT 1 FROM team_members tm
                WHERE tm.organization_id=t.organization_id
                  AND tm.team_id=t.id
                  AND tm.user_id=${request.claims!.sub}::uuid
              )
            )`;
        if (!team[0])
          return reply.code(403).send({
            error: {
              code: "team_forbidden",
              message: "Bu ekibe erişiminiz yok.",
            },
          });
      }
      const rows = await quickSql<Array<Record<string, unknown>>>`
        INSERT INTO quick_reply_categories(
          organization_id,name,normalized_name,scope,team_id,color,icon,created_by,updated_by
        ) VALUES(
          ${request.claims!.organizationId}::uuid,${body.name},${normalizedName},
          ${body.scope},${categoryTeamId}::uuid,
          ${body.color ?? null},${body.icon ?? null},
          ${request.claims!.sub}::uuid,${request.claims!.sub}::uuid
        ) RETURNING *`;
      await audit(
        request,
        "quick_reply_category.created",
        "quick_reply_category",
        String(rows[0]!.id),
      );
      return reply.code(201).send({ data: rows[0] });
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/quick-reply-categories/:id",
    { preHandler: permission("quick_replies:manage_team") },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1).max(80).optional(),
          color: z.string().trim().max(20).nullish(),
          icon: z.string().trim().max(40).nullish(),
          sortOrder: z.number().int().min(0).max(10000).optional(),
        })
        .refine((value) => Object.keys(value).length > 0)
        .parse(request.body);
      const rows = await quickSql<Array<Record<string, unknown>>>`
        UPDATE quick_reply_categories qrc SET
          name=COALESCE(${body.name ?? null},name),
          normalized_name=COALESCE(${
            body.name?.toLocaleLowerCase("tr-TR") ?? null
          },normalized_name),
          color=CASE WHEN ${body.color !== undefined}
            THEN ${body.color ?? null} ELSE color END,
          icon=CASE WHEN ${body.icon !== undefined}
            THEN ${body.icon ?? null} ELSE icon END,
          sort_order=COALESCE(${body.sortOrder ?? null},sort_order),
          updated_by=${request.claims!.sub}::uuid,updated_at=now()
        WHERE qrc.id=${request.params.id}::uuid
          AND qrc.organization_id=${request.claims!.organizationId}::uuid
          AND qrc.archived_at IS NULL
          AND (
            qrc.scope='organization'
              AND ${can(request.claims!.role, "quick_replies:manage_workspace")}
            OR qrc.scope='team' AND (
              ${["owner", "admin"].includes(request.claims!.role)}
              OR EXISTS(
                SELECT 1 FROM team_members tm
                WHERE tm.organization_id=qrc.organization_id
                  AND tm.team_id=qrc.team_id
                  AND tm.user_id=${request.claims!.sub}::uuid
              )
            )
          )
        RETURNING *`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "category_not_found",
            message: "Kategori bulunamadı.",
          },
        });
      await audit(
        request,
        "quick_reply_category.updated",
        "quick_reply_category",
        request.params.id,
      );
      return { data: rows[0] };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/quick-reply-categories/:id",
    { preHandler: permission("quick_replies:manage_team") },
    async (request, reply) => {
      const rows = await quickSql`
        UPDATE quick_reply_categories qrc SET
          archived_at=now(),updated_by=${request.claims!.sub}::uuid,
          updated_at=now()
        WHERE qrc.id=${request.params.id}::uuid
          AND qrc.organization_id=${request.claims!.organizationId}::uuid
          AND (
            qrc.scope='organization'
              AND ${can(request.claims!.role, "quick_replies:manage_workspace")}
            OR qrc.scope='team' AND (
              ${["owner", "admin"].includes(request.claims!.role)}
              OR EXISTS(
                SELECT 1 FROM team_members tm
                WHERE tm.organization_id=qrc.organization_id
                  AND tm.team_id=qrc.team_id
                  AND tm.user_id=${request.claims!.sub}::uuid
              )
            )
          )
        RETURNING id`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "category_not_found",
            message: "Kategori bulunamadı.",
          },
        });
      await audit(
        request,
        "quick_reply_category.archived",
        "quick_reply_category",
        request.params.id,
      );
      return { data: { archived: true } };
    },
  );
  app.get(
    "/api/v1/quick-reply-tags",
    { preHandler: permission("quick_replies:read") },
    async (request) => ({
      data: await quickSql`
        SELECT qrt.*,count(qrta.quick_reply_id)::int usage_count
        FROM quick_reply_tags qrt
        LEFT JOIN quick_reply_tag_assignments qrta ON qrta.tag_id=qrt.id
        WHERE qrt.organization_id=${request.claims!.organizationId}::uuid
        GROUP BY qrt.id ORDER BY qrt.name`,
    }),
  );
  app.post(
    "/api/v1/quick-reply-tags",
    { preHandler: permission("quick_replies:manage_team") },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1).max(80),
          color: z.string().trim().max(20).nullish(),
        })
        .parse(request.body);
      const rows = await quickSql<Array<Record<string, unknown>>>`
        INSERT INTO quick_reply_tags(
          organization_id,name,normalized_name,color,created_by
        ) VALUES(
          ${request.claims!.organizationId}::uuid,${body.name},
          ${body.name.toLocaleLowerCase("tr-TR")},${body.color ?? null},
          ${request.claims!.sub}::uuid
        )
        ON CONFLICT(organization_id,normalized_name) DO UPDATE
          SET color=COALESCE(EXCLUDED.color,quick_reply_tags.color),
              updated_at=now()
        RETURNING *`;
      await audit(
        request,
        "quick_reply_tag.created",
        "quick_reply_tag",
        String(rows[0]!.id),
      );
      return reply.code(201).send({ data: rows[0] });
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/quick-reply-tags/:id",
    { preHandler: permission("quick_replies:manage_team") },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1).max(80).optional(),
          color: z.string().trim().max(20).nullish(),
        })
        .refine((value) => Object.keys(value).length > 0)
        .parse(request.body);
      const rows = await quickSql`
        UPDATE quick_reply_tags SET
          name=COALESCE(${body.name ?? null},name),
          normalized_name=COALESCE(${
            body.name?.toLocaleLowerCase("tr-TR") ?? null
          },normalized_name),
          color=CASE WHEN ${body.color !== undefined}
            THEN ${body.color ?? null} ELSE color END,
          updated_at=now()
        WHERE id=${request.params.id}::uuid
          AND organization_id=${request.claims!.organizationId}::uuid
        RETURNING *`;
      if (!rows[0])
        return reply.code(404).send({
          error: { code: "tag_not_found", message: "Etiket bulunamadı." },
        });
      return { data: rows[0] };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/quick-reply-tags/:id",
    { preHandler: permission("quick_replies:manage_workspace") },
    async (request, reply) => {
      const rows = await quickSql`
        DELETE FROM quick_reply_tags
        WHERE id=${request.params.id}::uuid
          AND organization_id=${request.claims!.organizationId}::uuid
        RETURNING id`;
      if (!rows[0])
        return reply.code(404).send({
          error: { code: "tag_not_found", message: "Etiket bulunamadı." },
        });
      await audit(
        request,
        "quick_reply_tag.deleted",
        "quick_reply_tag",
        request.params.id,
      );
      return reply.code(204).send();
    },
  );
  app.get(
    "/api/v1/quick-replies/export",
    { preHandler: permission("quick_replies:import_export") },
    async (request) => ({
      data: await quickSql`
        SELECT qr.title,qr.shortcut,qr.content,qr.scope,qr.team_id,
          t.name team_name,qr.language,qr.category_id,qrc.name category_name,
          qr.status,qr.updated_at
        FROM quick_replies qr
        LEFT JOIN teams t ON t.id=qr.team_id
        LEFT JOIN quick_reply_categories qrc ON qrc.id=qr.category_id
        WHERE qr.organization_id=${request.claims!.organizationId}::uuid
          AND qr.status<>'deleted'
          AND (
            qr.scope='organization'
            OR qr.scope='personal' AND qr.owner_user_id=${request.claims!.sub}::uuid
            OR qr.scope='team' AND EXISTS(
              SELECT 1 FROM team_members tm
              WHERE tm.organization_id=qr.organization_id
                AND tm.team_id=qr.team_id
                AND tm.user_id=${request.claims!.sub}::uuid
            )
          )
        ORDER BY qr.updated_at DESC`,
    }),
  );
  app.get<{ Querystring: { days?: string } }>(
    "/api/v1/quick-replies/analytics",
    { preHandler: permission("quick_replies:analytics") },
    async (request) => {
      const { days } = z
        .object({
          days: z.coerce.number().int().min(1).max(365).default(30),
        })
        .parse(request.query);
      const visibility = sql`
        (
          qr.scope='organization'
          OR qr.scope='personal' AND qr.owner_user_id=${request.claims!.sub}::uuid
          OR qr.scope='team' AND EXISTS(
            SELECT 1 FROM team_members tm
            WHERE tm.organization_id=qr.organization_id
              AND tm.team_id=qr.team_id
              AND tm.user_id=${request.claims!.sub}::uuid
          )
        )`;
      const [overview, topReplies, daily, agents] = await Promise.all([
        sql`
          SELECT
            count(*) FILTER(WHERE qrue.event_type='selected')::int selected,
            count(*) FILTER(WHERE qrue.event_type='sent')::int sent,
            count(*) FILTER(WHERE qrue.event_type='failed')::int failed,
            count(*) FILTER(WHERE qrue.event_type='variable_error')::int variable_errors,
            count(DISTINCT qrue.user_id) FILTER(WHERE qrue.event_type='sent')::int active_agents,
            count(DISTINCT qrue.quick_reply_id) FILTER(WHERE qrue.event_type='sent')::int used_replies
          FROM quick_reply_usage_events qrue
          JOIN quick_replies qr ON qr.id=qrue.quick_reply_id
          WHERE qrue.organization_id=${request.claims!.organizationId}::uuid
            AND qrue.created_at>=now()-make_interval(days => ${days}::int)
            AND ${visibility}`,
        sql`
          SELECT qr.id,qr.title,qr.normalized_shortcut,
            count(*) FILTER(WHERE qrue.event_type='sent')::int sent,
            count(*) FILTER(WHERE qrue.event_type='failed')::int failed,
            count(DISTINCT qrue.user_id) FILTER(WHERE qrue.event_type='sent')::int agents
          FROM quick_reply_usage_events qrue
          JOIN quick_replies qr ON qr.id=qrue.quick_reply_id
          WHERE qrue.organization_id=${request.claims!.organizationId}::uuid
            AND qrue.created_at>=now()-make_interval(days => ${days}::int)
            AND ${visibility}
          GROUP BY qr.id
          ORDER BY sent DESC,failed ASC,qr.title
          LIMIT 20`,
        sql`
          SELECT date_trunc(${"day"},qrue.created_at)::date AS "day",
            count(*) FILTER(WHERE qrue.event_type='selected')::int selected,
            count(*) FILTER(WHERE qrue.event_type='sent')::int sent,
            count(*) FILTER(WHERE qrue.event_type='failed')::int failed
          FROM quick_reply_usage_events qrue
          JOIN quick_replies qr ON qr.id=qrue.quick_reply_id
          WHERE qrue.organization_id=${request.claims!.organizationId}::uuid
            AND qrue.created_at>=now()-make_interval(days => ${days}::int)
            AND ${visibility}
          GROUP BY 1 ORDER BY 1`,
        sql`
          SELECT u.id,u.full_name,
            count(*) FILTER(WHERE qrue.event_type='sent')::int sent,
            count(*) FILTER(WHERE qrue.event_type='failed')::int failed
          FROM quick_reply_usage_events qrue
          JOIN quick_replies qr ON qr.id=qrue.quick_reply_id
          JOIN users u ON u.id=qrue.user_id
          WHERE qrue.organization_id=${request.claims!.organizationId}::uuid
            AND qrue.created_at>=now()-make_interval(days => ${days}::int)
            AND ${visibility}
          GROUP BY u.id ORDER BY sent DESC,u.full_name
          LIMIT 50`,
      ]);
      const totals = overview[0] ?? {};
      const selected = Number(totals.selected ?? 0);
      const sent = Number(totals.sent ?? 0);
      return {
        data: {
          overview: {
            ...totals,
            selectionToSendRate:
              selected > 0 ? Math.round((sent / selected) * 10000) / 100 : 0,
          },
          topReplies,
          daily,
          agents,
          days,
        },
      };
    },
  );
  app.post(
    "/api/v1/quick-replies/import",
    { preHandler: permission("quick_replies:import_export") },
    async (request, reply) => {
      const body = quickImportInput.parse(request.body);
      const normalizedRows = body.rows.map((row, index) => ({
        ...row,
        rowNumber: index + 2,
        normalizedShortcut: normalizeQuickReplyShortcut(row.shortcut),
        teamId: row.scope === "team" ? (row.teamId ?? null) : null,
      }));
      const duplicateKeys = new Set<string>();
      const seenKeys = new Set<string>();
      for (const row of normalizedRows) {
        const key = [
          row.scope,
          row.scope === "personal"
            ? request.claims!.sub
            : (row.teamId ?? "organization"),
          row.normalizedShortcut,
          row.language,
        ].join(":");
        if (seenKeys.has(key)) duplicateKeys.add(key);
        seenKeys.add(key);
      }
      const preview = [];
      for (const row of normalizedRows) {
        let message: string | null = null;
        const key = [
          row.scope,
          row.scope === "personal"
            ? request.claims!.sub
            : (row.teamId ?? "organization"),
          row.normalizedShortcut,
          row.language,
        ].join(":");
        if (!row.normalizedShortcut)
          message = "Kısayol güvenli bir karakter içermiyor.";
        else if (duplicateKeys.has(key))
          message =
            "Dosyada aynı kapsam, dil ve kısayol birden fazla kez bulunuyor.";
        else if (
          row.scope === "organization" &&
          !can(request.claims!.role, "quick_replies:manage_workspace")
        )
          message = "Organizasyon kapsamı için yetkiniz yok.";
        else if (
          row.scope === "team" &&
          !can(request.claims!.role, "quick_replies:manage_team")
        )
          message = "Ekip kapsamı için yetkiniz yok.";
        else if (row.scope === "team" && !row.teamId)
          message = "Ekip kapsamındaki satır için teamId gereklidir.";
        if (!message && row.scope === "team") {
          const team = await quickSql`
            SELECT 1 FROM teams t
            WHERE t.id=${row.teamId}::uuid
              AND t.organization_id=${request.claims!.organizationId}::uuid
              AND (
                ${["owner", "admin"].includes(request.claims!.role)}
                OR EXISTS(
                  SELECT 1 FROM team_members tm
                  WHERE tm.organization_id=t.organization_id
                    AND tm.team_id=t.id
                    AND tm.user_id=${request.claims!.sub}::uuid
                )
              )`;
          if (!team[0]) message = "Ekip bulunamadı veya erişiminiz yok.";
        }
        if (!message && row.categoryId) {
          const category = await quickSql`
            SELECT 1 FROM quick_reply_categories qrc
            WHERE qrc.id=${row.categoryId}::uuid
              AND qrc.organization_id=${request.claims!.organizationId}::uuid
              AND qrc.archived_at IS NULL
              AND (
                qrc.scope='organization'
                OR qrc.scope='team' AND qrc.team_id=${row.teamId}::uuid
              )`;
          if (!category[0])
            message = "Kategori bulunamadı veya bu kapsamla uyumlu değil.";
        }
        let conflict = false;
        if (!message) {
          const existing = await quickSql`
            SELECT 1 FROM quick_replies qr
            WHERE qr.organization_id=${request.claims!.organizationId}::uuid
              AND qr.status<>'deleted'
              AND qr.scope=${row.scope}
              AND qr.normalized_shortcut=${row.normalizedShortcut}
              AND qr.language=${row.language}
              AND (
                ${row.scope}='organization'
                OR ${row.scope}='personal' AND qr.owner_user_id=${request.claims!.sub}::uuid
                OR ${row.scope}='team' AND qr.team_id=${row.teamId}::uuid
              )`;
          conflict = Boolean(existing[0]);
          if (conflict)
            message = "Aynı kapsam ve dilde bu kısayol zaten kullanılıyor.";
        }
        preview.push({
          rowNumber: row.rowNumber,
          normalizedShortcut: row.normalizedShortcut,
          status: message ? (conflict ? "conflict" : "error") : "create",
          message,
        });
      }
      if (!body.confirm)
        return {
          data: {
            rows: preview,
            canCommit: preview.every((row) => row.status === "create"),
          },
        };
      const blocked = preview.filter((row) => row.status !== "create");
      if (blocked.length)
        return reply.code(409).send({
          error: {
            code: "quick_reply_import_blocked",
            message:
              "İçe aktarma uygulanmadı. Önizlemedeki hata ve çakışmaları düzeltin.",
            details: blocked,
          },
        });
      const createdIds = await quickReplyRepository.begin(async (tx) => {
        const ids: string[] = [];
        for (const row of normalizedRows) {
          const inserted = await tx<Array<Record<string, unknown>>>`
            INSERT INTO quick_replies(
              organization_id,title,shortcut,normalized_shortcut,content,
              content_format,language,scope,owner_user_id,team_id,category_id,
              is_active,status,family_key,created_by,updated_by
            ) VALUES(
              ${request.claims!.organizationId}::uuid,${row.title},
              ${row.normalizedShortcut},${row.normalizedShortcut},${row.content},
              'text',${row.language},${row.scope},
              ${row.scope === "personal" ? request.claims!.sub : null}::uuid,
              ${row.teamId}::uuid,${row.categoryId ?? null}::uuid,
              true,'active',${row.normalizedShortcut},
              ${request.claims!.sub}::uuid,${request.claims!.sub}::uuid
            ) RETURNING *`;
          const created = inserted[0]!;
          ids.push(String(created.id));
          await tx`
            INSERT INTO quick_reply_versions(
              organization_id,quick_reply_id,version,snapshot,changed_fields,actor_id
            ) VALUES(
              ${request.claims!.organizationId}::uuid,${String(created.id)}::uuid,
              1,${tx.json(created as never)},ARRAY['imported'],
              ${request.claims!.sub}::uuid
            )`;
        }
        return ids;
      });
      await audit(
        request,
        "quick_reply.imported",
        "quick_reply_batch",
        crypto.randomUUID(),
        { count: createdIds.length },
      );
      return reply.code(201).send({
        data: { created: createdIds.length, ids: createdIds },
      });
    },
  );
  app.post(
    "/api/v1/quick-replies",
    { preHandler: permission("quick_replies:create") },
    async (request, reply) => {
      const body = quickInput.parse(request.body);
      if (
        body.scope === "organization" &&
        !can(request.claims!.role, "quick_replies:manage_workspace")
      )
        return reply
          .code(403)
          .send({ error: { code: "forbidden", message: "Yetkiniz yok." } });
      if (
        body.scope === "team" &&
        !can(request.claims!.role, "quick_replies:manage_team")
      )
        return reply
          .code(403)
          .send({ error: { code: "forbidden", message: "Yetkiniz yok." } });
      if (body.scope === "team") {
        const team = await quickSql`
          SELECT id FROM teams
          WHERE id=${body.teamId!}::uuid
            AND organization_id=${request.claims!.organizationId}::uuid
            AND (
              ${["owner", "admin"].includes(request.claims!.role)}
              OR EXISTS(
                SELECT 1 FROM team_members tm
                WHERE tm.organization_id=teams.organization_id
                  AND tm.team_id=teams.id
                  AND tm.user_id=${request.claims!.sub}::uuid
              )
            )`;
        if (!team[0])
          return reply.code(403).send({
            error: {
              code: "team_forbidden",
              message: "Bu ekibe erişiminiz yok.",
            },
          });
      }
      const normalizedShortcut = normalizeQuickReplyShortcut(body.shortcut);
      const createTeamId = body.scope === "team" ? (body.teamId ?? null) : null;
      const existingShortcut = await quickSql`
        SELECT 1 FROM quick_replies qr
        WHERE qr.organization_id=${request.claims!.organizationId}::uuid
          AND qr.status<>'deleted'
          AND qr.scope=${body.scope}
          AND qr.normalized_shortcut=${normalizedShortcut}
          AND qr.language=${body.language}
          AND (
            ${body.scope}='organization'
            OR ${body.scope}='personal'
              AND qr.owner_user_id=${request.claims!.sub}::uuid
            OR ${body.scope}='team' AND qr.team_id=${createTeamId}::uuid
          )`;
      if (existingShortcut[0])
        return reply.code(409).send({
          error: {
            code: "quick_reply_shortcut_conflict",
            message:
              "Aynı kapsam ve dilde bu kısayol zaten kullanılıyor. Alternatiflerden birini deneyin.",
            details: {
              suggestions: quickReplyShortcutSuggestions(
                normalizedShortcut,
                body.language,
              ),
            },
          },
        });
      const rows = await quickReplyRepository.begin(async (tx) => {
        const inserted = await tx<Array<Record<string, unknown>>>`
          INSERT INTO quick_replies(
            organization_id,title,shortcut,normalized_shortcut,content,
            content_format,language,fallback_language,scope,owner_user_id,
            team_id,folder_id,category_id,channel_id,is_active,status,
            family_key,created_by,updated_by
          ) VALUES(
            ${request.claims!.organizationId}::uuid,${body.title},
            ${normalizedShortcut},${normalizedShortcut},${body.content},
            ${body.contentFormat},${body.language},${body.fallbackLanguage ?? null},
            ${body.scope},
            ${body.scope === "personal" ? request.claims!.sub : null}::uuid,
            ${createTeamId}::uuid,
            ${body.folderId ?? null}::uuid,${body.categoryId ?? null}::uuid,
            ${body.channelId ?? null}::uuid,${body.isActive},
            ${body.isActive ? "active" : "archived"},
            ${normalizedShortcut},${request.claims!.sub}::uuid,
            ${request.claims!.sub}::uuid
          ) RETURNING *`;
        const created = inserted[0]!;
        for (const variable of body.variables)
          await tx`
            INSERT INTO quick_reply_variables(
              organization_id,quick_reply_id,variable_key,label,source,
              data_type,formatter,example_value,default_value,required,missing_policy
            ) VALUES(
              ${request.claims!.organizationId}::uuid,${String(created.id)}::uuid,
              ${variable.variableKey},${variable.label},${variable.source},
              ${variable.dataType},${variable.formatter ?? null},
              ${variable.exampleValue ?? null},${variable.defaultValue ?? null},
              ${variable.required},${variable.missingPolicy}
            )`;
        if (body.tagIds.length)
          await tx`
            INSERT INTO quick_reply_tag_assignments(organization_id,quick_reply_id,tag_id)
            SELECT ${request.claims!.organizationId}::uuid,${String(created.id)}::uuid,id
            FROM quick_reply_tags
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND id=ANY(${body.tagIds}::uuid[])`;
        await tx`
          INSERT INTO quick_reply_versions(
            organization_id,quick_reply_id,version,snapshot,changed_fields,actor_id
          ) VALUES(
            ${request.claims!.organizationId}::uuid,${String(created.id)}::uuid,
            1,${tx.json(created as never)},ARRAY['created'],${request.claims!.sub}::uuid
          )`;
        return inserted;
      });
      await audit(
        request,
        "quick_reply.created",
        "quick_reply",
        String(rows[0]!.id),
        { scope: body.scope },
      );
      return reply.code(201).send({ data: rows[0] });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/quick-replies/:id",
    { preHandler: permission("quick_replies:read") },
    async (request, reply) => {
      const rows = await quickSql<Array<Record<string, unknown>>>`
        SELECT qr.*,qrc.name category_name,t.name team_name,u.full_name owner_name
        FROM quick_replies qr
        LEFT JOIN quick_reply_categories qrc ON qrc.id=qr.category_id
        LEFT JOIN teams t ON t.id=qr.team_id
        LEFT JOIN users u ON u.id=qr.owner_user_id
        WHERE qr.id=${request.params.id}::uuid
          AND qr.organization_id=${request.claims!.organizationId}::uuid
          AND qr.status<>'deleted'
          AND (
            qr.scope='organization'
            OR qr.scope='personal' AND qr.owner_user_id=${request.claims!.sub}::uuid
            OR qr.scope='team' AND EXISTS(
              SELECT 1 FROM team_members tm
              WHERE tm.organization_id=qr.organization_id
                AND tm.team_id=qr.team_id
                AND tm.user_id=${request.claims!.sub}::uuid
            )
          )`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "quick_reply_not_found",
            message: "Hazır cevap bulunamadı.",
          },
        });
      const [variables, tags, attachments] = await Promise.all([
        sql`
          SELECT * FROM quick_reply_variables
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND quick_reply_id=${request.params.id}::uuid
          ORDER BY variable_key`,
        sql`
          SELECT qrt.* FROM quick_reply_tags qrt
          JOIN quick_reply_tag_assignments qrta ON qrta.tag_id=qrt.id
          WHERE qrta.organization_id=${request.claims!.organizationId}::uuid
            AND qrta.quick_reply_id=${request.params.id}::uuid
          ORDER BY qrt.name`,
        sql`
          SELECT id,filename,mime_type,size_bytes,attachment_type,scan_status
          FROM quick_reply_attachments
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND quick_reply_id=${request.params.id}::uuid
          ORDER BY created_at`,
      ]);
      return { data: { ...rows[0], variables, tags, attachments } };
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/quick-replies/:id",
    { preHandler: permission("quick_replies:create") },
    async (request, reply) => {
      const body = quickUpdateInput.parse(request.body);
      const shortcut = body.shortcut
        ? normalizeQuickReplyShortcut(body.shortcut)
        : null;
      const rows = await quickReplyRepository.begin(async (tx) => {
        const current = await tx<Array<Record<string, unknown>>>`
          SELECT * FROM quick_replies
          WHERE id=${request.params.id}::uuid
            AND organization_id=${request.claims!.organizationId}::uuid
            AND status<>'deleted'
            AND (
              scope='personal' AND owner_user_id=${request.claims!.sub}::uuid
              OR scope='organization' AND ${can(request.claims!.role, "quick_replies:manage_workspace")}
              OR scope='team'
                AND ${can(request.claims!.role, "quick_replies:manage_team")}
                AND (
                  ${["owner", "admin"].includes(request.claims!.role)}
                  OR EXISTS(
                    SELECT 1 FROM team_members tm
                    WHERE tm.organization_id=quick_replies.organization_id
                      AND tm.team_id=quick_replies.team_id
                      AND tm.user_id=${request.claims!.sub}::uuid
                  )
                )
            )
          FOR UPDATE`;
        if (!current[0]) return [];
        if (Number(current[0].version) !== body.version)
          return [{ conflict_version: current[0].version }];
        const targetScope = body.scope ?? String(current[0].scope);
        if (
          targetScope === "organization" &&
          !can(request.claims!.role, "quick_replies:manage_workspace")
        )
          return [{ forbidden_scope: true }];
        if (
          targetScope === "team" &&
          !can(request.claims!.role, "quick_replies:manage_team")
        )
          return [{ forbidden_scope: true }];
        const targetTeamId =
          targetScope === "team"
            ? (body.teamId ??
              (current[0].team_id ? String(current[0].team_id) : null))
            : null;
        if (targetScope === "team") {
          const team = await tx`
            SELECT 1 FROM teams t
            WHERE t.id=${targetTeamId}::uuid
              AND t.organization_id=${request.claims!.organizationId}::uuid
              AND (
                ${["owner", "admin"].includes(request.claims!.role)}
                OR EXISTS(
                  SELECT 1 FROM team_members tm
                  WHERE tm.organization_id=t.organization_id
                    AND tm.team_id=t.id
                    AND tm.user_id=${request.claims!.sub}::uuid
                )
              )`;
          if (!team[0]) return [{ forbidden_scope: true }];
        }
        const targetShortcut =
          shortcut ?? String(current[0].normalized_shortcut);
        const targetLanguage = body.language ?? String(current[0].language);
        const duplicate = await tx`
          SELECT 1 FROM quick_replies qr
          WHERE qr.organization_id=${request.claims!.organizationId}::uuid
            AND qr.id<>${request.params.id}::uuid
            AND qr.status<>'deleted'
            AND qr.scope=${targetScope}
            AND qr.normalized_shortcut=${targetShortcut}
            AND qr.language=${targetLanguage}
            AND (
              ${targetScope}='organization'
              OR ${targetScope}='personal'
                AND qr.owner_user_id=${request.claims!.sub}::uuid
              OR ${targetScope}='team' AND qr.team_id=${targetTeamId}::uuid
            )`;
        if (duplicate[0])
          return [
            {
              shortcut_conflict: true,
              normalized_shortcut: targetShortcut,
              language: targetLanguage,
            },
          ];
        await tx`
          INSERT INTO quick_reply_versions(
            organization_id,quick_reply_id,version,snapshot,changed_fields,actor_id
          ) VALUES(
            ${request.claims!.organizationId}::uuid,${request.params.id}::uuid,
            ${body.version},${tx.json(current[0] as never)},
            ${Object.keys(body)},${request.claims!.sub}::uuid
          ) ON CONFLICT(quick_reply_id,version) DO NOTHING`;
        const updated = await tx<Array<Record<string, unknown>>>`
          UPDATE quick_replies SET
            title=COALESCE(${body.title ?? null},title),
            shortcut=COALESCE(${shortcut},shortcut),
            normalized_shortcut=COALESCE(${shortcut},normalized_shortcut),
            content=COALESCE(${body.content ?? null},content),
            content_format=COALESCE(${body.contentFormat ?? null},content_format),
            language=COALESCE(${body.language ?? null},language),
            fallback_language=CASE WHEN ${body.fallbackLanguage !== undefined}
              THEN ${body.fallbackLanguage ?? null} ELSE fallback_language END,
            scope=${targetScope},
            owner_user_id=${targetScope === "personal" ? request.claims!.sub : null}::uuid,
            team_id=${targetTeamId}::uuid,
            category_id=CASE WHEN ${body.categoryId !== undefined}
              THEN ${body.categoryId ?? null}::uuid ELSE category_id END,
            channel_id=CASE WHEN ${body.channelId !== undefined}
              THEN ${body.channelId ?? null}::uuid ELSE channel_id END,
            is_active=COALESCE(${body.isActive ?? null},is_active),
            status=CASE WHEN ${body.isActive === true} THEN 'active'
              WHEN ${body.isActive === false} THEN 'archived' ELSE status END,
            archived_at=CASE WHEN ${body.isActive === true} THEN NULL
              WHEN ${body.isActive === false} THEN now() ELSE archived_at END,
            updated_by=${request.claims!.sub}::uuid,
            version=version+1,updated_at=now()
          WHERE id=${request.params.id}::uuid
            AND organization_id=${request.claims!.organizationId}::uuid
            AND version=${body.version}
          RETURNING *`;
        if (body.variables) {
          await tx`
            DELETE FROM quick_reply_variables
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND quick_reply_id=${request.params.id}::uuid`;
          for (const variable of body.variables)
            await tx`
              INSERT INTO quick_reply_variables(
                organization_id,quick_reply_id,variable_key,label,source,
                data_type,formatter,example_value,default_value,required,missing_policy
              ) VALUES(
                ${request.claims!.organizationId}::uuid,${request.params.id}::uuid,
                ${variable.variableKey},${variable.label},${variable.source},
                ${variable.dataType},${variable.formatter ?? null},
                ${variable.exampleValue ?? null},${variable.defaultValue ?? null},
                ${variable.required},${variable.missingPolicy}
              )`;
        }
        if (body.tagIds) {
          await tx`
            DELETE FROM quick_reply_tag_assignments
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND quick_reply_id=${request.params.id}::uuid`;
          if (body.tagIds.length)
            await tx`
              INSERT INTO quick_reply_tag_assignments(organization_id,quick_reply_id,tag_id)
              SELECT ${request.claims!.organizationId}::uuid,${request.params.id}::uuid,id
              FROM quick_reply_tags
              WHERE organization_id=${request.claims!.organizationId}::uuid
                AND id=ANY(${body.tagIds}::uuid[])`;
        }
        return updated;
      });
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "quick_reply_not_found",
            message: "Hazır cevap bulunamadı.",
          },
        });
      const outcome = rows[0] as Record<string, unknown>;
      if (outcome.conflict_version)
        return reply.code(409).send({
          error: {
            code: "quick_reply_version_conflict",
            message: "Hazır cevap başka bir kullanıcı tarafından güncellendi.",
            details: { currentVersion: Number(outcome.conflict_version) },
          },
        });
      if (outcome.forbidden_scope)
        return reply.code(403).send({
          error: {
            code: "forbidden",
            message: "Bu kapsamı yönetme yetkiniz yok.",
          },
        });
      if (outcome.shortcut_conflict)
        return reply.code(409).send({
          error: {
            code: "quick_reply_shortcut_conflict",
            message:
              "Aynı kapsam ve dilde bu kısayol zaten kullanılıyor. Alternatiflerden birini deneyin.",
            details: {
              suggestions: quickReplyShortcutSuggestions(
                String(outcome.normalized_shortcut),
                String(outcome.language),
              ),
            },
          },
        });
      await audit(
        request,
        "quick_reply.updated",
        "quick_reply",
        request.params.id,
        {
          changedFields: Object.keys(body).filter((key) => key !== "version"),
          ...(body.scope ? { scope: body.scope } : {}),
          ...(body.teamId !== undefined ? { teamId: body.teamId } : {}),
        },
      );
      return { data: rows[0] };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/quick-replies/:id",
    { preHandler: permission("quick_replies:create") },
    async (request, reply) => {
      const rows =
        await quickSql`UPDATE quick_replies SET status='deleted',is_active=false,archived_at=COALESCE(archived_at,now()),updated_by=${request.claims!.sub}::uuid,version=version+1,updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid AND status<>'deleted' AND (scope='personal' AND owner_user_id=${request.claims!.sub}::uuid OR scope='organization' AND ${can(request.claims!.role, "quick_replies:manage_workspace")} OR scope='team' AND ${can(request.claims!.role, "quick_replies:manage_team")} AND (${["owner", "admin"].includes(request.claims!.role)} OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.organization_id=quick_replies.organization_id AND tm.team_id=quick_replies.team_id AND tm.user_id=${request.claims!.sub}::uuid))) RETURNING id`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "quick_reply_not_found",
            message: "Hazır cevap bulunamadı.",
          },
        });
      await audit(
        request,
        "quick_reply.deleted",
        "quick_reply",
        request.params.id,
      );
      return { data: { deleted: true } };
    },
  );
  for (const [action, status] of [
    ["archive", "archived"],
    ["restore", "active"],
  ] as const)
    app.post<{ Params: { id: string } }>(
      `/api/v1/quick-replies/:id/${action}`,
      { preHandler: permission("quick_replies:create") },
      async (request, reply) => {
        const rows = await quickSql<Array<Record<string, unknown>>>`
          UPDATE quick_replies SET
            status=${status},is_active=${status === "active"},
            archived_at=${status === "active" ? null : new Date()},
            updated_by=${request.claims!.sub}::uuid,
            version=version+1,updated_at=now()
          WHERE id=${request.params.id}::uuid
            AND organization_id=${request.claims!.organizationId}::uuid
            AND status<>'deleted'
            AND (
              scope='personal' AND owner_user_id=${request.claims!.sub}::uuid
              OR scope='organization' AND ${can(request.claims!.role, "quick_replies:manage_workspace")}
              OR scope='team'
                AND ${can(request.claims!.role, "quick_replies:manage_team")}
                AND (
                  ${["owner", "admin"].includes(request.claims!.role)}
                  OR EXISTS(
                    SELECT 1 FROM team_members tm
                    WHERE tm.organization_id=quick_replies.organization_id
                      AND tm.team_id=quick_replies.team_id
                      AND tm.user_id=${request.claims!.sub}::uuid
                  )
                )
            )
          RETURNING *`;
        if (!rows[0])
          return reply.code(404).send({
            error: {
              code: "quick_reply_not_found",
              message: "Hazır cevap bulunamadı.",
            },
          });
        await audit(
          request,
          `quick_reply.${action}`,
          "quick_reply",
          request.params.id,
        );
        return { data: rows[0] };
      },
    );
  app.put<{ Params: { id: string } }>(
    "/api/v1/quick-replies/:id/favorite",
    { preHandler: permission("quick_replies:read") },
    async (request, reply) => {
      const visible = await quickSql`
        SELECT id FROM quick_replies qr
        WHERE qr.id=${request.params.id}::uuid
          AND qr.organization_id=${request.claims!.organizationId}::uuid
          AND qr.status='active'
          AND (
            qr.scope='organization'
            OR qr.scope='personal' AND qr.owner_user_id=${request.claims!.sub}::uuid
            OR qr.scope='team' AND EXISTS(
              SELECT 1 FROM team_members tm
              WHERE tm.organization_id=qr.organization_id
                AND tm.team_id=qr.team_id
                AND tm.user_id=${request.claims!.sub}::uuid
            )
          )`;
      if (!visible[0])
        return reply.code(404).send({
          error: {
            code: "quick_reply_not_found",
            message: "Hazır cevap bulunamadı.",
          },
        });
      await quickSql`
        INSERT INTO quick_reply_favorites(organization_id,quick_reply_id,user_id)
        VALUES(
          ${request.claims!.organizationId}::uuid,${request.params.id}::uuid,
          ${request.claims!.sub}::uuid
        ) ON CONFLICT DO NOTHING`;
      return { data: { favorite: true } };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/quick-replies/:id/favorite",
    { preHandler: permission("quick_replies:read") },
    async (request) => {
      await quickSql`
        DELETE FROM quick_reply_favorites
        WHERE organization_id=${request.claims!.organizationId}::uuid
          AND quick_reply_id=${request.params.id}::uuid
          AND user_id=${request.claims!.sub}::uuid`;
      return { data: { favorite: false } };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/quick-replies/:id/duplicate",
    { preHandler: permission("quick_replies:create") },
    async (request, reply) => {
      const body = z
        .object({
          scope: z
            .enum(["organization", "team", "personal"])
            .default("personal"),
          teamId: uuid.nullish(),
        })
        .parse(request.body ?? {});
      if (
        body.scope === "organization" &&
        !can(request.claims!.role, "quick_replies:manage_workspace")
      )
        return reply.code(403).send({
          error: { code: "forbidden", message: "Yetkiniz yok." },
        });
      if (
        body.scope === "team" &&
        !can(request.claims!.role, "quick_replies:manage_team")
      )
        return reply.code(403).send({
          error: { code: "forbidden", message: "Yetkiniz yok." },
        });
      if (body.scope === "team") {
        const team = await quickSql`
          SELECT 1 FROM teams t
          WHERE t.id=${body.teamId ?? null}::uuid
            AND t.organization_id=${request.claims!.organizationId}::uuid
            AND (
              ${["owner", "admin"].includes(request.claims!.role)}
              OR EXISTS(
                SELECT 1 FROM team_members tm
                WHERE tm.organization_id=t.organization_id
                  AND tm.team_id=t.id
                  AND tm.user_id=${request.claims!.sub}::uuid
              )
            )`;
        if (!team[0])
          return reply.code(403).send({
            error: {
              code: "team_forbidden",
              message: "Bu ekibe erişiminiz yok.",
            },
          });
      }
      const duplicateTeamId =
        body.scope === "team" ? (body.teamId ?? null) : null;
      const rows = await quickSql<Array<Record<string, unknown>>>`
        INSERT INTO quick_replies(
          organization_id,title,shortcut,normalized_shortcut,content,content_format,
          content_json,language,fallback_language,scope,owner_user_id,team_id,
          category_id,channel_id,is_active,status,family_key,created_by,updated_by
        )
        SELECT qr.organization_id,qr.title || ' (Kopya)',
          qr.normalized_shortcut || '_' || generated.suffix,
          qr.normalized_shortcut || '_' || generated.suffix,
          qr.content,qr.content_format,qr.content_json,qr.language,qr.fallback_language,
          ${body.scope},
          ${body.scope === "personal" ? request.claims!.sub : null}::uuid,
          ${duplicateTeamId}::uuid,
          NULL,qr.channel_id,true,'active',qr.family_key,
          ${request.claims!.sub}::uuid,${request.claims!.sub}::uuid
        FROM quick_replies qr
        CROSS JOIN LATERAL (
          SELECT substr(replace(gen_random_uuid()::text,'-',''),1,6) suffix
        ) generated
        WHERE qr.id=${request.params.id}::uuid
          AND qr.organization_id=${request.claims!.organizationId}::uuid
          AND qr.status<>'deleted'
          AND (
            qr.scope='organization'
            OR qr.scope='personal' AND qr.owner_user_id=${request.claims!.sub}::uuid
            OR qr.scope='team' AND EXISTS(
              SELECT 1 FROM team_members tm
              WHERE tm.organization_id=qr.organization_id
                AND tm.team_id=qr.team_id
                AND tm.user_id=${request.claims!.sub}::uuid
            )
          )
        RETURNING *`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "quick_reply_not_found",
            message: "Hazır cevap bulunamadı.",
          },
        });
      await audit(
        request,
        "quick_reply.duplicated",
        "quick_reply",
        String(rows[0].id),
        { sourceId: request.params.id, scope: body.scope },
      );
      return reply.code(201).send({ data: rows[0] });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/quick-replies/:id/versions",
    { preHandler: permission("quick_replies:read") },
    async (request) => ({
      data: await quickSql`
        SELECT qrv.id,qrv.version,qrv.changed_fields,qrv.created_at,u.full_name actor_name
        FROM quick_reply_versions qrv
        LEFT JOIN users u ON u.id=qrv.actor_id
        JOIN quick_replies qr ON qr.id=qrv.quick_reply_id
        WHERE qrv.organization_id=${request.claims!.organizationId}::uuid
          AND qrv.quick_reply_id=${request.params.id}::uuid
          AND (
            qr.scope='organization'
            OR qr.scope='personal' AND qr.owner_user_id=${request.claims!.sub}::uuid
            OR qr.scope='team' AND EXISTS(
              SELECT 1 FROM team_members tm
              WHERE tm.organization_id=qr.organization_id
                AND tm.team_id=qr.team_id
                AND tm.user_id=${request.claims!.sub}::uuid
            )
          )
        ORDER BY qrv.version DESC`,
    }),
  );
  app.post<{ Params: { id: string; version: string } }>(
    "/api/v1/quick-replies/:id/versions/:version/restore",
    { preHandler: permission("quick_replies:create") },
    async (request, reply) => {
      const version = z.coerce
        .number()
        .int()
        .positive()
        .parse(request.params.version);
      const body = z
        .object({ currentVersion: z.number().int().positive() })
        .parse(request.body);
      const rows = await quickReplyRepository.begin(async (tx) => {
        const current = await tx<Array<Record<string, unknown>>>`
          SELECT * FROM quick_replies qr
          WHERE qr.id=${request.params.id}::uuid
            AND qr.organization_id=${request.claims!.organizationId}::uuid
            AND qr.status<>'deleted'
            AND (
              qr.scope='personal' AND qr.owner_user_id=${request.claims!.sub}::uuid
              OR qr.scope='organization'
                AND ${can(request.claims!.role, "quick_replies:manage_workspace")}
              OR qr.scope='team'
                AND ${can(request.claims!.role, "quick_replies:manage_team")}
                AND (
                  ${["owner", "admin"].includes(request.claims!.role)}
                  OR EXISTS(
                    SELECT 1 FROM team_members tm
                    WHERE tm.organization_id=qr.organization_id
                      AND tm.team_id=qr.team_id
                      AND tm.user_id=${request.claims!.sub}::uuid
                  )
                )
            )
          FOR UPDATE`;
        if (!current[0]) return [];
        if (Number(current[0].version) !== body.currentVersion)
          return [{ conflict_version: current[0].version }];
        const snapshots = await tx<Array<Record<string, unknown>>>`
          SELECT snapshot FROM quick_reply_versions
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND quick_reply_id=${request.params.id}::uuid
            AND version=${version}`;
        if (!snapshots[0]) return [{ version_not_found: true }];
        const snapshot = snapshots[0].snapshot as Record<string, unknown>;
        await tx`
          INSERT INTO quick_reply_versions(
            organization_id,quick_reply_id,version,snapshot,changed_fields,actor_id
          ) VALUES(
            ${request.claims!.organizationId}::uuid,${request.params.id}::uuid,
            ${body.currentVersion},${tx.json(current[0] as never)},
            ARRAY['restored_from_version'],${request.claims!.sub}::uuid
          ) ON CONFLICT(quick_reply_id,version) DO NOTHING`;
        return await tx<Array<Record<string, unknown>>>`
          UPDATE quick_replies SET
            title=${String(snapshot.title ?? current[0].title)},
            shortcut=${String(snapshot.shortcut ?? current[0].shortcut)},
            normalized_shortcut=${String(
              snapshot.normalized_shortcut ?? current[0].normalized_shortcut,
            )},
            content=${String(snapshot.content ?? current[0].content)},
            content_format=${String(
              snapshot.content_format ?? current[0].content_format,
            )},
            content_json=${tx.json(
              (snapshot.content_json ?? current[0].content_json ?? {}) as never,
            )},
            language=${String(snapshot.language ?? current[0].language)},
            fallback_language=${
              snapshot.fallback_language
                ? String(snapshot.fallback_language)
                : null
            },
            category_id=${
              snapshot.category_id ? String(snapshot.category_id) : null
            }::uuid,
            channel_id=${
              snapshot.channel_id ? String(snapshot.channel_id) : null
            }::uuid,
            version=version+1,updated_by=${request.claims!.sub}::uuid,
            updated_at=now()
          WHERE id=${request.params.id}::uuid
            AND version=${body.currentVersion}
          RETURNING *`;
      });
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "quick_reply_not_found",
            message: "Hazır cevap bulunamadı.",
          },
        });
      const outcome = rows[0] as Record<string, unknown>;
      if (outcome.conflict_version)
        return reply.code(409).send({
          error: {
            code: "quick_reply_version_conflict",
            message: "Hazır cevap başka bir kullanıcı tarafından güncellendi.",
            details: { currentVersion: Number(outcome.conflict_version) },
          },
        });
      if (outcome.version_not_found)
        return reply.code(404).send({
          error: {
            code: "quick_reply_version_not_found",
            message: "Geri alınacak sürüm bulunamadı.",
          },
        });
      await audit(
        request,
        "quick_reply.version_restored",
        "quick_reply",
        request.params.id,
        { restoredFrom: version },
      );
      return { data: rows[0] };
    },
  );
  app.post(
    "/api/v1/quick-replies/bulk",
    { preHandler: permission("quick_replies:manage_team") },
    async (request) => {
      const body = z
        .object({
          ids: z.array(uuid).min(1).max(100),
          action: z.enum(["archive", "restore"]),
        })
        .parse(request.body);
      const status = body.action === "archive" ? "archived" : "active";
      const rows = await quickSql`
        UPDATE quick_replies SET
          status=${status},is_active=${status === "active"},
          archived_at=${status === "active" ? null : new Date()},
          updated_by=${request.claims!.sub}::uuid,version=version+1,updated_at=now()
        WHERE organization_id=${request.claims!.organizationId}::uuid
          AND id=ANY(${body.ids}::uuid[])
          AND (
            scope='personal' AND owner_user_id=${request.claims!.sub}::uuid
            OR scope='organization' AND ${can(request.claims!.role, "quick_replies:manage_workspace")}
            OR scope='team'
              AND ${can(request.claims!.role, "quick_replies:manage_team")}
              AND (
                ${["owner", "admin"].includes(request.claims!.role)}
                OR EXISTS(
                  SELECT 1 FROM team_members tm
                  WHERE tm.organization_id=quick_replies.organization_id
                    AND tm.team_id=quick_replies.team_id
                    AND tm.user_id=${request.claims!.sub}::uuid
                )
              )
          )
        RETURNING id`;
      await audit(
        request,
        `quick_reply.bulk_${body.action}`,
        "quick_reply",
        null,
        {
          requested: body.ids.length,
          changed: rows.length,
        },
      );
      return { data: { changed: rows.length } };
    },
  );
  app.post(
    "/api/v1/quick-replies/bulk/category",
    { preHandler: permission("quick_replies:manage_team") },
    async (request) => {
      const body = z
        .object({
          ids: z.array(uuid).min(1).max(100),
          categoryId: uuid.nullish(),
        })
        .parse(request.body);
      const rows = await quickSql`
        UPDATE quick_replies SET
          category_id=${body.categoryId ?? null}::uuid,
          updated_by=${request.claims!.sub}::uuid,
          version=version+1,updated_at=now()
        WHERE organization_id=${request.claims!.organizationId}::uuid
          AND id=ANY(${body.ids}::uuid[])
          AND status<>'deleted'
          AND (
            scope='personal' AND owner_user_id=${request.claims!.sub}::uuid
            OR scope='organization'
              AND ${can(request.claims!.role, "quick_replies:manage_workspace")}
            OR scope='team' AND (
              ${["owner", "admin"].includes(request.claims!.role)}
              OR EXISTS(
                SELECT 1 FROM team_members tm
                WHERE tm.organization_id=quick_replies.organization_id
                  AND tm.team_id=quick_replies.team_id
                  AND tm.user_id=${request.claims!.sub}::uuid
              )
            )
          )
        RETURNING id`;
      await audit(
        request,
        "quick_reply.bulk_category_changed",
        "quick_reply",
        null,
        { requested: body.ids.length, changed: rows.length },
      );
      return { data: { changed: rows.length } };
    },
  );
  app.post(
    "/api/v1/quick-replies/bulk/tags",
    { preHandler: permission("quick_replies:manage_team") },
    async (request) => {
      const body = z
        .object({
          ids: z.array(uuid).min(1).max(100),
          tagIds: z.array(uuid).max(20),
        })
        .parse(request.body);
      const changed = await quickReplyRepository.begin(async (tx) => {
        const editable = await tx<Array<Record<string, unknown>>>`
          SELECT id FROM quick_replies
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND id=ANY(${body.ids}::uuid[])
            AND status<>'deleted'
            AND (
              scope='personal' AND owner_user_id=${request.claims!.sub}::uuid
              OR scope='organization'
                AND ${can(request.claims!.role, "quick_replies:manage_workspace")}
              OR scope='team' AND (
                ${["owner", "admin"].includes(request.claims!.role)}
                OR EXISTS(
                  SELECT 1 FROM team_members tm
                  WHERE tm.organization_id=quick_replies.organization_id
                    AND tm.team_id=quick_replies.team_id
                    AND tm.user_id=${request.claims!.sub}::uuid
                )
              )
            )
          FOR UPDATE`;
        const ids = editable.map((row) => String(row.id));
        if (!ids.length) return 0;
        await tx`
          DELETE FROM quick_reply_tag_assignments
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND quick_reply_id=ANY(${ids}::uuid[])`;
        if (body.tagIds.length)
          await tx`
            INSERT INTO quick_reply_tag_assignments(
              organization_id,quick_reply_id,tag_id
            )
            SELECT ${request.claims!.organizationId}::uuid,qr.id,qrt.id
            FROM quick_replies qr
            CROSS JOIN quick_reply_tags qrt
            WHERE qr.id=ANY(${ids}::uuid[])
              AND qrt.organization_id=${request.claims!.organizationId}::uuid
              AND qrt.id=ANY(${body.tagIds}::uuid[])`;
        await tx`
          UPDATE quick_replies SET
            updated_by=${request.claims!.sub}::uuid,
            version=version+1,updated_at=now()
          WHERE id=ANY(${ids}::uuid[])`;
        return ids.length;
      });
      await audit(
        request,
        "quick_reply.bulk_tags_changed",
        "quick_reply",
        null,
        { requested: body.ids.length, changed },
      );
      return { data: { changed } };
    },
  );
  app.post(
    "/api/v1/quick-replies/bulk/scope",
    { preHandler: permission("quick_replies:manage_team") },
    async (request, reply) => {
      const body = z
        .object({
          ids: z.array(uuid).min(1).max(100),
          scope: z.enum(["organization", "team", "personal"]),
          teamId: uuid.nullish(),
        })
        .superRefine((value, context) => {
          if (value.scope === "team" && !value.teamId)
            context.addIssue({
              code: "custom",
              path: ["teamId"],
              message: "Ekip kapsamı için ekip gereklidir.",
            });
        })
        .parse(request.body);
      if (
        body.scope === "organization" &&
        !can(request.claims!.role, "quick_replies:manage_workspace")
      )
        return reply.code(403).send({
          error: { code: "forbidden", message: "Yetkiniz yok." },
        });
      if (body.scope === "team") {
        const team = await quickSql`
          SELECT 1 FROM teams t
          WHERE t.id=${body.teamId ?? null}::uuid
            AND t.organization_id=${request.claims!.organizationId}::uuid
            AND (
              ${["owner", "admin"].includes(request.claims!.role)}
              OR EXISTS(
                SELECT 1 FROM team_members tm
                WHERE tm.organization_id=t.organization_id
                  AND tm.team_id=t.id
                  AND tm.user_id=${request.claims!.sub}::uuid
              )
            )`;
        if (!team[0])
          return reply.code(403).send({
            error: {
              code: "team_forbidden",
              message: "Bu ekibe erişiminiz yok.",
            },
          });
      }
      const rows = await quickSql`
        UPDATE quick_replies SET
          scope=${body.scope},
          owner_user_id=${
            body.scope === "personal" ? request.claims!.sub : null
          }::uuid,
          team_id=${body.scope === "team" ? (body.teamId ?? null) : null}::uuid,
          category_id=NULL,updated_by=${request.claims!.sub}::uuid,
          version=version+1,updated_at=now()
        WHERE organization_id=${request.claims!.organizationId}::uuid
          AND id=ANY(${body.ids}::uuid[])
          AND status<>'deleted'
          AND (
            scope='personal' AND owner_user_id=${request.claims!.sub}::uuid
            OR scope='organization'
              AND ${can(request.claims!.role, "quick_replies:manage_workspace")}
            OR scope='team' AND (
              ${["owner", "admin"].includes(request.claims!.role)}
              OR EXISTS(
                SELECT 1 FROM team_members tm
                WHERE tm.organization_id=quick_replies.organization_id
                  AND tm.team_id=quick_replies.team_id
                  AND tm.user_id=${request.claims!.sub}::uuid
              )
            )
          )
        RETURNING id`;
      await audit(
        request,
        "quick_reply.bulk_scope_changed",
        "quick_reply",
        null,
        { requested: body.ids.length, changed: rows.length, scope: body.scope },
      );
      return { data: { changed: rows.length } };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/quick-replies/:id/render",
    { preHandler: permission("quick_replies:read") },
    async (request, reply) => {
      const body = z
        .object({
          conversationId: uuid,
          manualValues: z
            .record(z.string().trim().min(3).max(160), z.string().max(1000))
            .default({}),
        })
        .parse(request.body);
      const rows = await quickSql<
        Array<Record<string, unknown>>
      >`SELECT qr.content,c.id conversation_id,ct.first_name,ct.last_name,ct.display_name,ct.normalized_phone,ct.country,ct.language contact_language,ct.custom_fields,u.full_name agent_name,o.name organization_name,o.timezone organization_timezone,o.default_locale organization_locale,t.name team_name,ch.name channel_name,ch.phone_number channel_phone,c.last_message_at,crm.context bitrix_context FROM quick_replies qr JOIN organizations o ON o.id=qr.organization_id JOIN users u ON u.id=${request.claims!.sub}::uuid JOIN conversations c ON c.id=${body.conversationId}::uuid AND c.organization_id=qr.organization_id JOIN contacts ct ON ct.id=c.contact_id JOIN channels ch ON ch.id=c.channel_id AND (qr.channel_id IS NULL OR qr.channel_id=ch.id) LEFT JOIN teams t ON t.id=qr.team_id LEFT JOIN conversation_crm_context_cache crm ON crm.organization_id=c.organization_id AND crm.conversation_id=c.id WHERE qr.id=${request.params.id}::uuid AND qr.organization_id=${request.claims!.organizationId}::uuid AND qr.status='active' AND (${!["agent", "team_lead"].includes(request.claims!.role)} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${request.claims!.sub}::uuid)) AND (qr.scope='organization' OR qr.scope='personal' AND qr.owner_user_id=${request.claims!.sub}::uuid OR qr.scope='team' AND EXISTS(SELECT 1 FROM team_members tm WHERE tm.organization_id=qr.organization_id AND tm.team_id=qr.team_id AND tm.user_id=${request.claims!.sub}::uuid))`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "quick_reply_not_found",
            message: "Hazır cevap bulunamadı.",
          },
        });
      const row = rows[0];
      const variableDefinitions = await quickSql<
        Array<{
          variable_key: string;
          label: string;
          default_value: string | null;
          required: boolean;
          missing_policy: "block" | "manual" | "default" | "remove";
        }>
      >`
        SELECT variable_key,label,default_value,required,missing_policy
        FROM quick_reply_variables
        WHERE organization_id=${request.claims!.organizationId}::uuid
          AND quick_reply_id=${request.params.id}::uuid
        ORDER BY variable_key`;
      const allowedManualKeys = new Set(
        variableDefinitions.map((definition) => definition.variable_key),
      );
      const unknownManualKeys = Object.keys(body.manualValues).filter(
        (key) => !allowedManualKeys.has(key),
      );
      if (unknownManualKeys.length)
        return reply.code(400).send({
          error: {
            code: "quick_reply_manual_variable_unknown",
            message: "Bilinmeyen manuel değişken gönderildi.",
            details: unknownManualKeys,
          },
        });
      const contactFields =
        row.custom_fields &&
        typeof row.custom_fields === "object" &&
        !Array.isArray(row.custom_fields)
          ? (row.custom_fields as Record<string, unknown>)
          : {};
      const bitrixValues = Object.fromEntries(
        Object.entries(
          flattenTemplateContext(row.bitrix_context, "bitrix"),
        ).map(([key, value]) => [key, String(value ?? "")]),
      );
      const timeZone = String(row.organization_timezone ?? "Europe/Istanbul");
      const locale = String(
        row.contact_language ?? row.organization_locale ?? "tr",
      );
      const now = new Date();
      const result = renderQuickReply(String(row.content), {
        "contact.first_name": String(row.first_name ?? ""),
        "contact.last_name": String(row.last_name ?? ""),
        "contact.full_name": String(
          row.display_name ??
            `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim(),
        ),
        "contact.phone": String(row.normalized_phone),
        "contact.country": String(row.country ?? ""),
        "contact.city": String(contactFields.city ?? ""),
        "contact.language": String(row.contact_language ?? ""),
        "agent.first_name": String(row.agent_name).split(" ")[0]!,
        "agent.full_name": String(row.agent_name),
        "assigned_user.name": String(row.agent_name),
        "assigned_user.first_name": String(row.agent_name).split(" ")[0]!,
        "organization.name": String(row.organization_name),
        "workspace.name": String(row.organization_name),
        "team.name": String(row.team_name ?? ""),
        "channel.name": String(row.channel_name ?? ""),
        "channel.phone_number": String(row.channel_phone ?? ""),
        "conversation.id": String(row.conversation_id),
        "conversation.last_message_at": row.last_message_at
          ? new Intl.DateTimeFormat(locale, {
              dateStyle: "short",
              timeStyle: "short",
              timeZone,
            }).format(new Date(String(row.last_message_at)))
          : "",
        "appointment.date": String(
          contactFields.appointment_date ?? contactFields.appointmentDate ?? "",
        ),
        "appointment.time": String(
          contactFields.appointment_time ?? contactFields.appointmentTime ?? "",
        ),
        current_date: new Intl.DateTimeFormat(locale, {
          dateStyle: "short",
          timeZone,
        }).format(now),
        current_time: new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
          timeZone,
        }).format(now),
        ...bitrixValues,
        ...body.manualValues,
      });
      const definitionByKey = new Map(
        variableDefinitions.map((definition) => [
          definition.variable_key,
          definition,
        ]),
      );
      let resolvedContent = result.content;
      const remainingMissing: string[] = [];
      for (const key of result.missingVariables) {
        const definition = definitionByKey.get(key);
        const policy =
          definition?.missing_policy ??
          (definition?.required === false ? "remove" : "block");
        const token = new RegExp(
          `\\{\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`,
          "g",
        );
        if (policy === "default" && definition?.default_value)
          resolvedContent = resolvedContent.replace(
            token,
            definition.default_value,
          );
        else if (policy === "remove" || definition?.required === false)
          resolvedContent = resolvedContent.replace(token, "");
        else remainingMissing.push(key);
      }
      const attachments = await quickSql`
        SELECT id,filename,mime_type,size_bytes,attachment_type
        FROM quick_reply_attachments
        WHERE organization_id=${request.claims!.organizationId}::uuid
          AND quick_reply_id=${request.params.id}::uuid
          AND scan_status='clean'
        ORDER BY created_at
        LIMIT 1`;
      return {
        data: {
          ...result,
          content: resolvedContent,
          missingVariables: remainingMissing,
          variableDefinitions,
          attachments,
          locale,
          timeZone,
        },
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/quick-replies/:id/track-usage",
    { preHandler: permission("quick_replies:read") },
    async (request, reply) => {
      const body = z
        .object({
          conversationId: uuid.optional(),
          renderedContent: z.string().max(4096).optional(),
          eventType: z
            .enum(["selected", "sent", "failed", "variable_error"])
            .default("sent"),
          errorCode: z.string().trim().max(100).optional(),
        })
        .parse(request.body);
      const rows =
        await quickSql`UPDATE quick_replies qr SET usage_count=usage_count+CASE WHEN ${body.eventType}='sent' THEN 1 ELSE 0 END,last_used_at=CASE WHEN ${body.eventType}='sent' THEN now() ELSE last_used_at END,updated_at=CASE WHEN ${body.eventType}='sent' THEN now() ELSE updated_at END WHERE qr.id=${request.params.id}::uuid AND qr.organization_id=${request.claims!.organizationId}::uuid AND qr.status='active' AND (qr.scope='organization' OR qr.scope='personal' AND qr.owner_user_id=${request.claims!.sub}::uuid OR qr.scope='team' AND EXISTS(SELECT 1 FROM team_members tm WHERE tm.organization_id=qr.organization_id AND tm.team_id=qr.team_id AND tm.user_id=${request.claims!.sub}::uuid)) AND (${body.conversationId ?? null}::uuid IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=${body.conversationId ?? null}::uuid AND c.organization_id=qr.organization_id)) RETURNING id,team_id`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "quick_reply_not_found",
            message: "Hazır cevap bulunamadı.",
          },
        });
      await quickSql`INSERT INTO quick_reply_usage_events(organization_id,quick_reply_id,user_id,conversation_id,rendered_content_hash,event_type,team_id,error_code) VALUES(${request.claims!.organizationId}::uuid,${request.params.id}::uuid,${request.claims!.sub}::uuid,${body.conversationId ?? null}::uuid,${body.renderedContent ? hashSecret(body.renderedContent) : null},${body.eventType},${rows[0]!.team_id ?? null}::uuid,${body.errorCode ?? null})`;
      return reply.code(204).send();
    },
  );
}

function createOpaqueVerifyToken() {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`;
}

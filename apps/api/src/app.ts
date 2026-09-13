import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import { fastifyRateLimit } from "@fastify/rate-limit";
import { fastifySwagger } from "@fastify/swagger";
import { resolveClientIp } from "./client-ip";
import { registerDatabaseScopes } from "./database-scope";
import { registerCampaignRoutes } from "./campaign-routes";
import { z } from "zod";
import postgres from "postgres";
import IORedis from "ioredis";
import { HttpRequestMetrics } from "@brixchat/observability";
import { can, type AuthClaims, type Permission } from "@brixchat/auth";
import type { TrustProxyConfig } from "@brixchat/config";
import {
  ChannelRepository,
  CrmWorkerRepository,
  ConversationRepository,
  AiRepository,
  AiWorkerRepository,
  BillingRepository,
  CampaignRepository,
  LabelOperationsRepository,
  MediaAuditRepository,
  MessageRepository,
  PlatformAdminRepository,
  WebhookEventRepository,
  withTenantScope,
  createScopedDatabaseRouter,
} from "@brixchat/database";
import {
  createMessagingProvider,
  decryptSecret,
  deterministicEventKey,
  hashSecret,
  safeEqual,
  verifyMetaSignature,
  createMalwareScanner,
  createObjectStorageProvider,
  objectStorageLocation,
  extractMetaWebhookChanges,
  metaWebhookEventType,
  metaWebhookTargetsPhone,
  normalizePhone,
  PaddleBillingClient,
  normalizeTelegramWebhookUpdate,
} from "@brixchat/integrations";
import {
  conversationQuerySchema,
  inboxCountQuerySchema,
  messageQuerySchema,
  sendMessageSchema,
  sendInteractiveMessageSchema,
  startConversationSchema,
} from "@brixchat/validation";
import { registerAuthRoutes } from "./auth-routes";
import { registerProductRoutes } from "./product-routes";
import { registerAdminRoutes } from "./admin-routes";
import { registerPlatformAdminRoutes } from "./platform-admin-routes";
import {
  createEmailProviderFromEnv,
  DisabledEmailProvider,
  type EmailProvider,
} from "./email";
import { registerCrmRoutes } from "./crm-routes";
import { registerConversationOpsRoutes } from "./conversation-ops-routes";
import { registerLabelRoutes } from "./label-routes";
import { registerMilestone5Routes } from "./milestone5-routes";
import { registerMilestone6Routes } from "./milestone6-routes";
import { registerStorageRoutes } from "./storage-routes";
import { registerAiRoutes } from "./ai-routes";
import { registerBillingRoutes } from "./billing-routes";
declare module "fastify" {
  interface FastifyRequest {
    claims?: AuthClaims;
    rawBody?: string;
    clientIp: string;
  }
}
const demoOrganizationId = "00000000-0000-4000-8000-000000000001";
const maskPhone = (value: string) =>
  value.length < 7 ? "***" : `${value.slice(0, 4)} *** **${value.slice(-2)}`;
export interface AppOptions {
  jwtSecret: string;
  webUrl: string;
  corsAllowedOrigins?: string[] | undefined;
  databaseUrl?: string | undefined;
  scopedDatabaseUrl?: string | undefined;
  redisUrl?: string | undefined;
  redisPing?: (() => Promise<string>) | undefined;
  metaAppSecret?: string | undefined;
  metaVerifyToken?: string | undefined;
  appEncryptionKey?: string | undefined;
  accessTokenTtlMinutes?: number | undefined;
  refreshTokenTtlDays?: number | undefined;
  cookieSecure?: boolean | undefined;
  cookieSameSite?: "lax" | "strict" | "none" | undefined;
  cookieDomain?: string | undefined;
  apiPublicUrl?: string | undefined;
  fakeProviderMode?:
    | "success"
    | "temporary_error"
    | "permanent_error"
    | "auth_failure"
    | "token_expired"
    | "permission_denied"
    | undefined;
  metaApiVersion?: string | undefined;
  emailProvider?: EmailProvider | undefined;
  bitrixClientId?: string | undefined;
  bitrixClientSecret?: string | undefined;
  objectStorageLocalPath?: string | undefined;
  metricsApiKey?: string | undefined;
  environment?: string | undefined;
  configEnv?: NodeJS.ProcessEnv | undefined;
  internalOperationsToken?: string | undefined;
  databasePoolMax?: number | undefined;
  trustProxy?: TrustProxyConfig | undefined;
  redisHealthTimeoutMs?: number | undefined;
  distributedRateLimitEnabled?: boolean | undefined;
  rateLimitMax?: number | undefined;
  openApiEnabled?: boolean | undefined;
  paddleApiKey?: string | undefined;
  paddleClientToken?: string | undefined;
  paddleWebhookSecret?: string | undefined;
  paddleEnvironment?: "sandbox" | "production" | undefined;
  paddleCheckoutUrl?: string | undefined;
  billingGraceDays?: number | undefined;
}
const eventPayload = (
  type: string,
  organizationId: string,
  entityId: string,
  conversationId?: string,
  payload: Record<string, unknown> = {},
) => ({
  eventId: crypto.randomUUID(),
  eventType: type,
  organizationId,
  entityType: type.startsWith("message")
    ? "message"
    : type.startsWith("channel")
      ? "channel"
      : "conversation",
  entityId,
  ...(conversationId ? { conversationId } : {}),
  occurredAt: new Date().toISOString(),
  payloadVersion: 1 as const,
  payload,
});
function channelSecrets(
  channel: Record<string, unknown>,
  options: AppOptions,
): { accessToken?: string; appSecret?: string } {
  const encrypted =
    channel.resolved_credentials_encrypted ?? channel.credentials_encrypted;
  if (encrypted && options.appEncryptionKey) {
    try {
      const parsed = JSON.parse(
        decryptSecret(String(encrypted), options.appEncryptionKey),
      ) as { accessToken?: unknown; appSecret?: unknown };
      return {
        ...(typeof parsed.accessToken === "string"
          ? { accessToken: parsed.accessToken }
          : {}),
        ...(typeof parsed.appSecret === "string"
          ? { appSecret: parsed.appSecret }
          : {}),
      };
    } catch {
      return {};
    }
  }
  return {};
}
export function buildApp(options: AppOptions) {
  const controlPool = postgres(
    options.databaseUrl ??
      "postgresql://brixchat:brixchat@localhost:5434/brixchat",
    { max: options.databasePoolMax ?? 10 },
  );
  const tenantPool = options.scopedDatabaseUrl
    ? postgres(options.scopedDatabaseUrl, {
        max: options.databasePoolMax ?? 10,
      })
    : undefined;
  const lockPool = options.scopedDatabaseUrl
    ? postgres(options.scopedDatabaseUrl, {
        max: options.databasePoolMax ?? 10,
      })
    : undefined;
  const databaseRouter = tenantPool
    ? createScopedDatabaseRouter(tenantPool, lockPool)
    : undefined;
  const sql = databaseRouter?.sql ?? controlPool;
  const conversations = new ConversationRepository(sql),
    messages = new MessageRepository(sql),
    channels = new ChannelRepository(sql),
    webhooks = new WebhookEventRepository(sql),
    crmJobs = new CrmWorkerRepository(sql),
    mediaAudit = new MediaAuditRepository(sql),
    billing = new BillingRepository(sql);
  const enforceStorage = async (organizationId: string, bytes: number) => {
    const policy = await billing.policy(organizationId, "storage_bytes");
    if (!policy.allowed) return policy;
    if (policy.limit !== null && policy.usage + bytes > policy.limit)
      return { ...policy, allowed: false, code: "plan_limit_exceeded" };
    return policy;
  };
  const redisUrl = options.redisUrl ?? "redis://localhost:6381";
  const publisher = new IORedis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const proxyTrusted = Boolean(options.trustProxy ?? false);
  const app = Fastify({
    trustProxy: options.trustProxy ?? false,
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "body.password",
        "body.currentPassword",
        "body.newPassword",
        "body.token",
        "body.accessToken",
        "body.appSecret",
        "body.webhookUrl",
        "body.text",
        "body.messages",
        "access_token",
        "app_secret",
        "credentials",
      ],
      serializers: {
        req: (request) => {
          const remotePort = request.raw.socket.remotePort;
          return {
            method: request.method,
            url: request.url.replace(/\?.*$/, ""),
            host: request.hostname,
            remoteAddress: resolveClientIp(request, proxyTrusted),
            ...(remotePort === undefined ? {} : { remotePort }),
          };
        },
      },
    },
    genReqId: () => crypto.randomUUID(),
  });
  if (databaseRouter) registerDatabaseScopes(app, databaseRouter, controlPool);
  if (tenantPool)
    app.addHook("onReady", async () => {
      const [role] = await tenantPool<{ unsafe: boolean }[]>`
      SELECT (r.rolsuper OR r.rolbypassrls OR EXISTS(
        SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace
          AND c.relrowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')
      )) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`;
      if (!role || role.unsafe)
        throw new Error("API_SCOPED_DATABASE_ROLE_MUST_ENFORCE_RLS");
    });
  fastifySwagger(
    app,
    {
      openapi: {
        info: {
          title: "Brixchat24 API",
          version: "1.0.0",
          description: "Tenant-scoped messaging and operations API.",
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          },
        },
      },
    },
    (error) => {
      if (error) throw error;
    },
  );
  const httpMetrics = new HttpRequestMetrics();
  app.decorateRequest("clientIp", "");
  app.addHook("onRequest", async (request) => {
    request.clientIp = resolveClientIp(request, proxyTrusted);
  });
  app.addHook("onResponse", async (request, reply) => {
    httpMetrics.record({
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
    });
  });
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const raw = (body as Buffer).toString("utf8");
      request.rawBody = raw;
      try {
        done(null, JSON.parse(raw));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
  app.addContentTypeParser(
    "application/octet-stream",
    (_request, payload, done) => done(null, payload),
  );
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
  const allowedOrigins = options.corsAllowedOrigins?.length
    ? options.corsAllowedOrigins
    : [options.webUrl];
  app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin))
        return callback(null, true);
      return callback(
        Object.assign(new Error("cors_origin_not_allowed"), {
          statusCode: 403,
        }),
        false,
      );
    },
    credentials: true,
  });
  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Request-ID", request.id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; frame-ancestors 'none'",
    );
    if (options.webUrl.startsWith("https://"))
      reply.header(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
  });
  app.register(cookie);
  fastifyRateLimit(
    app,
    {
      max: options.rateLimitMax ?? 120,
      timeWindow: "1 minute",
      keyGenerator: (request) => resolveClientIp(request, proxyTrusted),
      ...(options.distributedRateLimitEnabled
        ? { redis: publisher, nameSpace: "brixchat:rate-limit:" }
        : {}),
    },
    (error) => {
      if (error) throw error;
    },
  );
  app.register(jwt, { secret: options.jwtSecret });
  const publish = async (
    organizationId: string,
    event: Record<string, unknown>,
  ) => {
    try {
      if (publisher.status === "wait") await publisher.connect();
      await publisher.publish(
        `brixchat:${organizationId}`,
        JSON.stringify(event),
      );
    } catch (error) {
      app.log.warn(
        { error: error instanceof Error ? error.message : "redis_error" },
        "realtime publish deferred",
      );
    }
  };
  const emailProvider = options.emailProvider ?? createEmailProviderFromEnv();
  if (emailProvider instanceof DisabledEmailProvider) {
    app.addHook("onRequest", async (request, reply) => {
      const path = request.url.split("?")[0];
      if (
        request.method === "POST" &&
        ([
          "/api/v1/auth/register",
          "/api/v1/auth/forgot-password",
          "/api/v1/auth/resend-verification",
          "/api/v1/invitations",
        ].includes(path ?? "") ||
          /^\/api\/v1\/invitations\/[^/]+\/resend$/.test(path ?? ""))
      )
        return reply.code(503).send({
          error: {
            code: "EMAIL_NOT_CONFIGURED",
            message:
              "E-posta servisi henüz yapılandırılmadı. Hesap erişimi için yöneticinizle iletişime geçin.",
          },
        });
    });
  }
  registerAuthRoutes(app, sql, {
    accessTokenTtlMinutes: options.accessTokenTtlMinutes ?? 15,
    refreshTokenTtlDays: options.refreshTokenTtlDays ?? 30,
    cookieSecure: options.cookieSecure ?? false,
    cookieSameSite: options.cookieSameSite ?? "lax",
    ...(options.cookieDomain ? { cookieDomain: options.cookieDomain } : {}),
    email: emailProvider,
    appPublicUrl: options.webUrl,
  });
  registerProductRoutes(app, sql, {
    ...(options.appEncryptionKey
      ? { appEncryptionKey: options.appEncryptionKey }
      : {}),
    apiPublicUrl: options.apiPublicUrl ?? "http://localhost:4400",
    webUrl: options.webUrl,
    ...(options.bitrixClientId
      ? { bitrixClientId: options.bitrixClientId }
      : {}),
    ...(options.bitrixClientSecret
      ? { bitrixClientSecret: options.bitrixClientSecret }
      : {}),
    allowDevelopmentProviders: options.environment !== "production",
    whatsappWebEnabled: process.env.WHATSAPP_WEB_ENABLED === "true",
    enforceBilling: (organizationId, metric) =>
      billing.policy(organizationId, metric),
    publishEvent: (organizationId, eventType, channelId, payload) =>
      publish(
        organizationId,
        eventPayload(eventType, organizationId, channelId, undefined, payload),
      ),
    ...(options.fakeProviderMode ? { fakeMode: options.fakeProviderMode } : {}),
    metaApiVersion: options.metaApiVersion ?? "v25.0",
  });
  registerAdminRoutes(app, sql, {
    email: emailProvider,
    appPublicUrl: options.webUrl,
    accessTokenTtlMinutes: options.accessTokenTtlMinutes ?? 15,
    enforceBilling: (organizationId, metric) =>
      billing.policy(organizationId, metric),
    enforceInvitation: (tokenHash, metric) =>
      billing.policyForInvitation(tokenHash, metric),
  });
  registerPlatformAdminRoutes(app, new PlatformAdminRepository(sql), billing, {
    email: emailProvider,
    appPublicUrl: options.webUrl,
  });
  const authenticate = async (request: FastifyRequest) => {
    let claims: AuthClaims & { aud?: string };
    try {
      claims = await request.jwtVerify<AuthClaims & { aud?: string }>();
    } catch {
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    }
    // Realtime tokens travel in URLs and may leak via logs/history; they are
    // only valid for the realtime endpoint, never as a bearer credential.
    if (claims.aud === "realtime")
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    request.claims = claims;
  };
  const authorize =
    (permission: Permission) => async (request: FastifyRequest) => {
      await authenticate(request);
      if (!request.claims || !can(request.claims.role, permission))
        throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    };
  const paddle =
    options.paddleApiKey &&
    options.paddleClientToken &&
    options.paddleWebhookSecret &&
    options.paddleCheckoutUrl
      ? new PaddleBillingClient({
          apiKey: options.paddleApiKey,
          clientToken: options.paddleClientToken,
          webhookSecret: options.paddleWebhookSecret,
          environment: options.paddleEnvironment ?? "sandbox",
          checkoutUrl: options.paddleCheckoutUrl,
        })
      : undefined;
  registerCampaignRoutes(app, new CampaignRepository(sql), authorize);
  registerBillingRoutes(app, billing, {
    authorize,
    ...(paddle ? { paddle } : {}),
    graceDays: options.billingGraceDays ?? 7,
  });
  registerCrmRoutes(app, sql, {
    authorize,
    publish,
    apiPublicUrl: options.apiPublicUrl ?? "http://localhost:4400",
    webUrl: options.webUrl,
    ...(options.appEncryptionKey
      ? { appEncryptionKey: options.appEncryptionKey }
      : {}),
    ...(options.bitrixClientId
      ? { bitrixClientId: options.bitrixClientId }
      : {}),
    ...(options.bitrixClientSecret
      ? { bitrixClientSecret: options.bitrixClientSecret }
      : {}),
  });
  registerConversationOpsRoutes(app, sql, {
    authorize,
    publish,
    ...(databaseRouter ? { runWithTenant: databaseRouter.tenant } : {}),
  });
  registerLabelRoutes(app, new LabelOperationsRepository(sql), {
    authorize,
    publish,
  });
  const mediaEnvironment = options.configEnv ?? process.env;
  const storage = createObjectStorageProvider(
    mediaEnvironment,
    options.apiPublicUrl ?? "http://localhost:4400",
    options.appEncryptionKey ?? options.jwtSecret,
  );
  registerAiRoutes(app, new AiRepository(sql), {
    authorize,
    publish,
    workerStore: new AiWorkerRepository(sql),
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
    aiEnv: {
      enabled: process.env.AI_ENABLED === "true",
      apiKey: process.env.OPENROUTER_API_KEY ?? null,
      defaultModel: process.env.AI_DEFAULT_MODEL ?? null,
      fallbackModel: process.env.AI_FALLBACK_MODEL ?? null,
      embeddingModel: process.env.AI_EMBEDDING_MODEL ?? null,
    },
    imageStorage: storage,
    ...(options.appEncryptionKey
      ? { appEncryptionKey: options.appEncryptionKey }
      : {}),
  });
  const malwareScanner = createMalwareScanner(mediaEnvironment);
  const storageLocation = objectStorageLocation(mediaEnvironment);
  registerMilestone5Routes(app, sql, {
    authorize,
    enforceBilling: (organizationId, metric) =>
      billing.policy(organizationId, metric),
    enforceStorage,
    acquireStorageLock: (organizationId) =>
      billing.acquireStorageLock(organizationId),
    publish,
    storage,
    malwareScanner,
    recordMediaCleanupRequired: (input) =>
      mediaAudit.recordCleanupRequired(input),
    storageProvider: storageLocation.provider,
    ...(storageLocation.bucket
      ? { storageBucket: storageLocation.bucket }
      : {}),
    redisPing: options.redisPing ?? (() => publisher.ping()),
    redisHealthTimeoutMs: options.redisHealthTimeoutMs ?? 5_000,
    apiPublicUrl: options.apiPublicUrl ?? "http://localhost:4400",
    webUrl: options.webUrl,
    ...(options.appEncryptionKey
      ? { appEncryptionKey: options.appEncryptionKey }
      : {}),
    ...(options.bitrixClientId
      ? { bitrixClientId: options.bitrixClientId }
      : {}),
    ...(options.bitrixClientSecret
      ? { bitrixClientSecret: options.bitrixClientSecret }
      : {}),
    ...(options.metricsApiKey ? { metricsApiKey: options.metricsApiKey } : {}),
    runtimeMetrics: () => httpMetrics.renderPrometheus(),
  });
  const googleTokenEncryptionKey =
    mediaEnvironment.GOOGLE_TOKEN_ENCRYPTION_KEY ?? options.appEncryptionKey;
  registerStorageRoutes(app, sql, {
    authorize,
    enforceStorage,
    acquireStorageLock: (organizationId) =>
      billing.acquireStorageLock(organizationId),
    ...(googleTokenEncryptionKey
      ? { encryptionKey: googleTokenEncryptionKey }
      : {}),
    webUrl: options.webUrl,
    googleDriveEnabled: mediaEnvironment.GOOGLE_DRIVE_ENABLED === "true",
    ...(mediaEnvironment.GOOGLE_CLIENT_ID
      ? { googleClientId: mediaEnvironment.GOOGLE_CLIENT_ID }
      : {}),
    ...(mediaEnvironment.GOOGLE_CLIENT_SECRET
      ? { googleClientSecret: mediaEnvironment.GOOGLE_CLIENT_SECRET }
      : {}),
    ...(mediaEnvironment.GOOGLE_OAUTH_REDIRECT_URI
      ? { googleRedirectUri: mediaEnvironment.GOOGLE_OAUTH_REDIRECT_URI }
      : {}),
    storage,
    scanner: malwareScanner,
    publish,
  });
  registerMilestone6Routes(app, sql, {
    authorize,
    environment: options.environment ?? "development",
    configEnv: options.configEnv ?? process.env,
    ...(options.internalOperationsToken
      ? { internalOperationsToken: options.internalOperationsToken }
      : {}),
  });
  app.addHook("onClose", async () => {
    await controlPool.end();
    await tenantPool?.end();
    await lockPool?.end();
    if (publisher.status !== "end") publisher.disconnect();
  });
  app.get("/health", async () => {
    await sql`SELECT 1`;
    return { status: "ok", service: "api" };
  });
  app.get(
    "/api/v1/conversations",
    { preHandler: authorize("inbox:read") },
    async (request) => {
      const query = conversationQuerySchema.parse(request.query);
      if (
        query.whatsappOwnerUserId &&
        request.claims!.role === "agent" &&
        query.whatsappOwnerUserId !== request.claims!.sub
      )
        throw Object.assign(new Error("whatsapp_account_forbidden"), {
          statusCode: 403,
        });
      const result = await withTenantScope(
        sql,
        request.claims!.organizationId,
        (tx) =>
          new ConversationRepository(tx).list({
            organizationId: request.claims!.organizationId,
            userId: request.claims!.sub,
            role: request.claims!.role,
            ...query,
          }),
      );
      return { data: result.data, page: { nextCursor: result.nextCursor } };
    },
  );
  app.post(
    "/api/v1/conversations",
    { preHandler: authorize("message:send") },
    async (request, reply) => {
      const entitlement = await billing.policy(
        request.claims!.organizationId,
        "outgoing_messages",
      );
      if (!entitlement.allowed)
        return reply.code(409).send({
          error: {
            code: entitlement.code,
            message: "Organization plan does not allow this operation.",
          },
        });
      const body = startConversationSchema.parse(request.body);
      let normalizedPhone: string;
      try {
        normalizedPhone = normalizePhone(body.phone);
      } catch {
        return reply.code(400).send({
          error: {
            code: "invalid_phone",
            message: "Telefon numarasını ülke koduyla girin.",
          },
        });
      }
      const started = await conversations.startOutbound({
        organizationId: request.claims!.organizationId,
        userId: request.claims!.sub,
        role: request.claims!.role,
        channelId: body.channelId,
        normalizedPhone,
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ipAddress: request.clientIp,
        userAgent: request.headers["user-agent"],
      });
      if (started.kind === "channel_unavailable")
        return reply.code(404).send({
          error: {
            code: "channel_unavailable",
            message: "Kanal kullanılamıyor veya bu kanala erişiminiz yok.",
          },
        });
      const conversation = await conversations.get(
        request.claims!.organizationId,
        started.conversationId,
        request.claims!.sub,
        request.claims!.role,
      );
      if (!conversation)
        throw Object.assign(new Error("conversation_start_failed"), {
          statusCode: 500,
        });
      if (started.created) {
        await publish(
          request.claims!.organizationId,
          eventPayload(
            "conversation.created",
            request.claims!.organizationId,
            conversation.id,
            conversation.id,
            { conversation },
          ),
        );
      }
      return reply
        .code(started.created ? 201 : 200)
        .send({ data: { conversation, created: started.created } });
    },
  );
  app.get(
    "/api/v1/inbox/counts",
    { preHandler: authorize("inbox:read") },
    async (request) => {
      const query = inboxCountQuerySchema.parse(request.query);
      return {
        data: await conversations.counts({
          organizationId: request.claims!.organizationId,
          userId: request.claims!.sub,
          role: request.claims!.role,
          ...query,
        }),
      };
    },
  );
  app.get(
    "/api/v1/inbox/whatsapp-accounts",
    { preHandler: authorize("inbox:read") },
    async (request) => {
      const org = request.claims!.organizationId;
      const ownOnly = ["agent", "team_lead"].includes(request.claims!.role);
      const rows = await sql<Array<Record<string, unknown>>>`
        SELECT u.id user_id,u.full_name user_name,c.id channel_id,c.public_id channel_public_id,c.name channel_name,c.phone_number,c.status,
          (SELECT count(*)::int FROM conversations cv WHERE cv.organization_id=c.organization_id AND cv.channel_id=c.id AND cv.unread_count>0) unread_count,
          (SELECT count(*)::int FROM conversations cv WHERE cv.organization_id=c.organization_id AND cv.channel_id=c.id AND cv.status IN ('open','waiting','snoozed')) open_count
        FROM channel_user_ownership o JOIN users u ON u.id=o.user_id JOIN channels c ON c.id=o.channel_id
        WHERE o.organization_id=${org}::uuid AND c.deleted_at IS NULL AND u.is_active AND (${ownOnly}=false OR u.id=${request.claims!.sub}::uuid)
        ORDER BY u.full_name,c.name`;
      const grouped = new Map<
        string,
        {
          userId: string;
          userName: string;
          channels: unknown[];
          unreadConversationCount: number;
          openConversationCount: number;
        }
      >();
      for (const row of rows) {
        const key = String(row.user_id);
        const item = grouped.get(key) ?? {
          userId: key,
          userName: String(row.user_name),
          channels: [],
          unreadConversationCount: 0,
          openConversationCount: 0,
        };
        const unread = Number(row.unread_count ?? 0),
          open = Number(row.open_count ?? 0);
        item.channels.push({
          channelId: String(row.channel_id),
          channelName: String(row.channel_name),
          maskedPhoneNumber: maskPhone(String(row.phone_number)),
          status: String(row.status),
          health: String(row.status) === "connected" ? "healthy" : "unhealthy",
        });
        item.unreadConversationCount += unread;
        item.openConversationCount += open;
        grouped.set(key, item);
      }
      const accounts = [...grouped.values()];
      return {
        data: {
          accounts,
          totals: {
            unreadConversationCount: accounts.reduce(
              (n, a) => n + a.unreadConversationCount,
              0,
            ),
            openConversationCount: accounts.reduce(
              (n, a) => n + a.openConversationCount,
              0,
            ),
          },
        },
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/channels/:id/users",
    { preHandler: authorize("channels:manage") },
    async (request) => ({
      data: await channels.listUsers({
        organizationId: request.claims!.organizationId,
        channelId: request.params.id,
      }),
    }),
  );
  app.post<{
    Params: { id: string };
    Body: { userId: string; relationshipType?: string; isPrimary?: boolean };
  }>(
    "/api/v1/channels/:id/users",
    { preHandler: authorize("channels:manage") },
    async (request, reply) => {
      const body = z
        .object({
          userId: z.string().uuid(),
          relationshipType: z
            .enum(["owner", "shared", "manager"])
            .default("shared"),
          isPrimary: z.boolean().default(false),
        })
        .parse(request.body);
      const org = request.claims!.organizationId;
      const rows = await sql.begin(async (tx) => {
        if (body.isPrimary)
          await tx`UPDATE channel_user_ownership SET is_primary=false,updated_at=now() WHERE organization_id=${org}::uuid AND channel_id=${request.params.id}::uuid AND is_primary`;
        const inserted = await tx<Array<Record<string, unknown>>>`
          INSERT INTO channel_user_ownership(organization_id,channel_id,user_id,relationship_type,is_primary)
          SELECT ${org}::uuid,c.id,${body.userId}::uuid,${body.relationshipType},${body.isPrimary}
          FROM channels c JOIN organization_members om ON om.organization_id=c.organization_id AND om.user_id=${body.userId}::uuid
          WHERE c.id=${request.params.id}::uuid AND c.organization_id=${org}::uuid AND c.deleted_at IS NULL
          ON CONFLICT(organization_id,channel_id,user_id) DO UPDATE SET relationship_type=EXCLUDED.relationship_type,is_primary=EXCLUDED.is_primary,updated_at=now()
          RETURNING id,channel_id,user_id,relationship_type,is_primary`;
        if (inserted[0])
          await tx`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata,ip_address,user_agent) VALUES(${org}::uuid,${request.claims!.sub}::uuid,'channel.access_granted','channel',${request.params.id}::uuid,${tx.json({ userId: body.userId, relationshipType: body.relationshipType, isPrimary: body.isPrimary } as never)},${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
        return inserted;
      });
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "channel_or_user_not_found",
            message: "Channel or user not found",
          },
        });
      return reply.code(201).send({ data: rows[0] });
    },
  );
  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/v1/channels/:id/users/:userId",
    { preHandler: authorize("channels:manage") },
    async (request, reply) => {
      const rows = await sql.begin(async (tx) => {
        const existing = await tx<Array<{ id: string }>>`
          SELECT id
          FROM channel_user_ownership
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND channel_id=${request.params.id}::uuid
            AND user_id=${request.params.userId}::uuid
          FOR UPDATE`;
        if (!existing[0]) return [];
        const others = await tx<Array<{ count: number }>>`
          SELECT count(*)::int count
          FROM channel_user_ownership
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND channel_id=${request.params.id}::uuid
            AND user_id<>${request.params.userId}::uuid`;
        if ((others[0]?.count ?? 0) === 0)
          throw Object.assign(new Error("channel_last_owner_required"), {
            statusCode: 409,
          });
        const deleted = await tx<Array<{ id: string }>>`
          DELETE FROM channel_user_ownership
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND channel_id=${request.params.id}::uuid
            AND user_id=${request.params.userId}::uuid
          RETURNING id`;
        await tx`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata,ip_address,user_agent) VALUES(${request.claims!.organizationId}::uuid,${request.claims!.sub}::uuid,'channel.access_revoked','channel',${request.params.id}::uuid,${tx.json({ userId: request.params.userId } as never)},${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
        return deleted;
      });
      return rows[0]
        ? { data: { deleted: true } }
        : reply.code(404).send({
            error: {
              code: "ownership_not_found",
              message: "Ownership not found",
            },
          });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/conversations/:id",
    { preHandler: authorize("inbox:read") },
    async (request, reply) => {
      const item = await conversations.get(
        request.claims!.organizationId,
        request.params.id,
        request.claims!.sub,
        request.claims!.role,
      );
      return item
        ? { data: item }
        : reply.code(404).send({
            error: {
              code: "conversation_not_found",
              message: "Conversation not found",
            },
          });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/messages",
    { preHandler: authorize("inbox:read") },
    async (request, reply) => {
      const query = messageQuerySchema.parse(request.query);
      const scoped = await withTenantScope(
        sql,
        request.claims!.organizationId,
        async (tx) => {
          const conversation = await new ConversationRepository(tx).get(
            request.claims!.organizationId,
            request.params.id,
            request.claims!.sub,
            request.claims!.role,
          );
          if (!conversation) return { found: false as const };
          const result = await new MessageRepository(tx).list(
            request.claims!.organizationId,
            request.params.id,
            query.cursor,
            query.limit,
          );
          return { found: true as const, result };
        },
      );
      if (!scoped.found)
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      return {
        data: scoped.result.data,
        page: { nextCursor: scoped.result.nextCursor },
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/messages",
    { preHandler: authorize("message:send") },
    async (request, reply) => {
      const body = sendMessageSchema.parse(request.body);
      const usageEventKey = `message.outgoing:${body.clientMessageId}`;
      const entitlement = await billing.reserveUsage({
        organizationId: request.claims!.organizationId,
        eventKey: usageEventKey,
        metric: "outgoing_messages",
      });
      if (!entitlement.allowed)
        return reply.code(409).send({
          error: {
            code: entitlement.code,
            message: "Organization plan does not allow this operation.",
          },
        });
      let result;
      try {
        result = await messages.createOutbound({
          organizationId: request.claims!.organizationId,
          conversationId: request.params.id,
          senderId: request.claims!.sub,
          role: request.claims!.role,
          clientMessageId: body.clientMessageId,
          expectedChannelId: body.channelId,
          text: body.text,
          ...(body.replyToMessageId === undefined
            ? {}
            : { metadata: { replyToMessageId: body.replyToMessageId } }),
          traceId: crypto.randomUUID(),
        });
      } catch (error) {
        if (!("duplicate" in entitlement && entitlement.duplicate))
          await billing.releaseUsage({
            organizationId: request.claims!.organizationId,
            eventKey: usageEventKey,
          });
        throw error;
      }
      if (result.created)
        await crmJobs.enqueueTimeline({
          organizationId: request.claims!.organizationId,
          messageId: result.message.id,
          conversationId: request.params.id,
        });
      if (result.created)
        await publish(
          request.claims!.organizationId,
          eventPayload(
            "message.created",
            request.claims!.organizationId,
            result.message.id,
            request.params.id,
            { message: result.message },
          ),
        );
      return reply.code(202).send({ data: result.message });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/interactive",
    { preHandler: authorize("message:send") },
    async (request, reply) => {
      const body = sendInteractiveMessageSchema.parse(request.body);
      const usageEventKey = `message.outgoing:${body.clientMessageId}`;
      const entitlement = await billing.reserveUsage({
        organizationId: request.claims!.organizationId,
        eventKey: usageEventKey,
        metric: "outgoing_messages",
      });
      if (!entitlement.allowed)
        return reply.code(409).send({
          error: {
            code: entitlement.code,
            message: "Organization plan does not allow this operation.",
          },
        });
      let result;
      try {
        result = await messages.createOutbound({
          organizationId: request.claims!.organizationId,
          conversationId: request.params.id,
          senderId: request.claims!.sub,
          role: request.claims!.role,
          clientMessageId: body.clientMessageId,
          expectedChannelId: body.channelId,
          text: body.text,
          type: "interactive",
          metadata: { interactive: body.interactive },
          traceId: crypto.randomUUID(),
        });
      } catch (error) {
        if (!("duplicate" in entitlement && entitlement.duplicate))
          await billing.releaseUsage({
            organizationId: request.claims!.organizationId,
            eventKey: usageEventKey,
          });
        throw error;
      }
      if (result.created)
        await crmJobs.enqueueTimeline({
          organizationId: request.claims!.organizationId,
          messageId: result.message.id,
          conversationId: request.params.id,
        });
      if (result.created)
        await publish(
          request.claims!.organizationId,
          eventPayload(
            "message.created",
            request.claims!.organizationId,
            result.message.id,
            request.params.id,
            { message: result.message },
          ),
        );
      return reply
        .code(result.created ? 201 : 200)
        .send({ data: result.message });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/reactions",
    { preHandler: authorize("message:send") },
    async (request, reply) => {
      const body = z
        .object({
          clientMessageId: z.string().uuid(),
          messageId: z.string().min(1),
          emoji: z.string().max(8),
        })
        .parse(request.body);
      const usageEventKey = `message.outgoing:${body.clientMessageId}`;
      const entitlement = await billing.reserveUsage({
        organizationId: request.claims!.organizationId,
        eventKey: usageEventKey,
        metric: "outgoing_messages",
      });
      if (!entitlement.allowed)
        return reply.code(409).send({
          error: {
            code: entitlement.code,
            message: "Organization plan does not allow this operation.",
          },
        });
      let result;
      try {
        result = await messages.createOutbound({
          organizationId: request.claims!.organizationId,
          conversationId: request.params.id,
          senderId: request.claims!.sub,
          role: request.claims!.role,
          clientMessageId: body.clientMessageId,
          text: body.emoji,
          type: "reaction",
          metadata: { messageId: body.messageId },
          traceId: crypto.randomUUID(),
        });
      } catch (error) {
        if (!("duplicate" in entitlement && entitlement.duplicate))
          await billing.releaseUsage({
            organizationId: request.claims!.organizationId,
            eventKey: usageEventKey,
          });
        throw error;
      }
      return reply
        .code(result.created ? 201 : 200)
        .send({ data: result.message });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/read",
    { preHandler: authorize("inbox:read") },
    async (request, reply) => {
      const conversation = await conversations.get(
        request.claims!.organizationId,
        request.params.id,
        request.claims!.sub,
        request.claims!.role,
      );
      if (!conversation)
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      const latest = await conversations.latestInboundProviderMessage(
        request.claims!.organizationId,
        request.params.id,
      );
      if (
        latest?.provider === "meta" &&
        latest.phone_number_id &&
        latest.provider_message_id
      ) {
        const secrets = channelSecrets(latest, options);
        const provider = createMessagingProvider({
          mode: "meta",
          ...(options.metaApiVersion
            ? { apiVersion: options.metaApiVersion }
            : {}),
        });
        await provider.markAsRead({
          phoneNumberId: latest.phone_number_id,
          providerMessageId: latest.provider_message_id,
          ...(secrets.accessToken ? { accessToken: secrets.accessToken } : {}),
        });
      }
      if (
        !(await conversations.markRead(
          request.claims!.organizationId,
          request.params.id,
        ))
      )
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      await publish(
        request.claims!.organizationId,
        eventPayload(
          "conversation.read",
          request.claims!.organizationId,
          request.params.id,
          request.params.id,
        ),
      );
      return { data: { conversationId: request.params.id, unreadCount: 0 } };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/unread",
    { preHandler: authorize("conversation:operate") },
    async (request, reply) => {
      const conversation = await conversations.get(
        request.claims!.organizationId,
        request.params.id,
        request.claims!.sub,
        request.claims!.role,
      );
      if (!conversation)
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      if (
        !(await conversations.markUnread(
          request.claims!.organizationId,
          request.params.id,
        ))
      )
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      await publish(
        request.claims!.organizationId,
        eventPayload(
          "conversation.unread",
          request.claims!.organizationId,
          request.params.id,
          request.params.id,
        ),
      );
      return { data: { conversationId: request.params.id, unreadCount: 1 } };
    },
  );
  app.get(
    "/api/v1/realtime/token",
    { preHandler: authorize("inbox:read") },
    async (request) => {
      // EventSource cannot send Authorization headers. Issue a short-lived,
      // realtime-scoped token so the long-lived access token never appears in
      // a URL (and any leaked URL has a very small blast radius).
      const token = app.jwt.sign(
        { ...request.claims!, aud: "realtime" },
        {
          expiresIn: "60s",
        },
      );
      return { data: { token, expiresIn: 60 } };
    },
  );
  app.get(
    "/api/v1/realtime",
    { logLevel: "silent" },
    async (request, reply) => {
      const token = (request.query as { access_token?: string }).access_token;
      if (!token)
        return reply
          .code(401)
          .send({ error: { code: "unauthorized", message: "Missing token" } });
      try {
        const verified = app.jwt.verify<AuthClaims & { aud?: string }>(token);
        if (verified.aud !== "realtime") throw new Error("invalid_audience");
        request.claims = verified;
      } catch {
        return reply
          .code(401)
          .send({ error: { code: "unauthorized", message: "Invalid token" } });
      }
      const claims = request.claims,
        subscriber = new IORedis(redisUrl);
      const requestOrigin = request.headers.origin;
      const responseOrigin =
        requestOrigin && allowedOrigins.includes(requestOrigin)
          ? requestOrigin
          : options.webUrl;
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "access-control-allow-origin": responseOrigin,
        "access-control-allow-credentials": "true",
        vary: "Origin",
      });
      reply.raw.write("retry: 3000\n\n");
      await subscriber.subscribe(`brixchat:${claims.organizationId}`);
      subscriber.on("message", async (_channel, message) => {
        try {
          const event = JSON.parse(message) as { conversationId?: unknown };
          if (
            typeof event.conversationId === "string" &&
            ["agent", "team_lead"].includes(claims.role) &&
            !(await (databaseRouter
              ? databaseRouter.tenant(claims.organizationId, async () =>
                  conversations.get(
                    claims.organizationId,
                    event.conversationId as string,
                    claims.sub,
                    claims.role,
                  ),
                )
              : conversations.get(
                  claims.organizationId,
                  event.conversationId,
                  claims.sub,
                  claims.role,
                )))
          )
            return;
          reply.raw.write(`data: ${message}\n\n`);
        } catch {
          app.log.warn(
            { organizationId: claims.organizationId },
            "invalid realtime event ignored",
          );
        }
      });
      const timer = setInterval(
        () => reply.raw.write(": heartbeat\n\n"),
        15000,
      );
      request.raw.on("close", () => {
        clearInterval(timer);
        subscriber.disconnect();
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/channels/:id/health",
    { preHandler: authorize("channels:manage") },
    async (request, reply) => {
      const channel = await channels.byId(
        request.claims!.organizationId,
        request.params.id,
      );
      return channel
        ? {
            data: {
              id: channel.id,
              healthy: channel.status === "connected",
              credentialsConfigured: Boolean(channel.credentials_encrypted),
              phoneNumberConfigured: Boolean(channel.phone_number_id),
              lastWebhookAt: channel.last_webhook_at ?? null,
              lastErrorCode: channel.last_error_code ?? null,
            },
          }
        : reply.code(404).send({
            error: {
              code: "channel_not_found",
              message: "Channel not found",
            },
          });
    },
  );
  app.get("/api/v1/webhooks/meta", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const token = query["hub.verify_token"] ?? "";
    const verifyToken =
      options.metaVerifyToken ??
      (options.environment === "production" ? null : "local-verify-token");
    if (
      query["hub.mode"] !== "subscribe" ||
      !token ||
      !verifyToken ||
      !safeEqual(token, verifyToken)
    )
      return reply.code(403).send("Forbidden");
    return reply.type("text/plain").send(query["hub.challenge"] ?? "");
  });
  app.get<{ Params: { channelPublicId: string } }>(
    "/webhooks/meta/whatsapp/:channelPublicId",
    async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const channel = await channels.byPublicId(request.params.channelPublicId);
      const token = query["hub.verify_token"] ?? "";
      const storedHash = channel?.verify_token_hash
        ? String(channel.verify_token_hash)
        : null;
      const fallbackVerifyToken =
        options.metaVerifyToken ??
        (options.environment === "production" ? null : "local-verify-token");
      const validToken = storedHash
        ? safeEqual(hashSecret(token), storedHash)
        : fallbackVerifyToken
          ? safeEqual(token, fallbackVerifyToken)
          : false;
      if (
        !channel ||
        query["hub.mode"] !== "subscribe" ||
        !token ||
        !validToken
      )
        return reply.code(403).send("Forbidden");
      return reply.type("text/plain").send(query["hub.challenge"] ?? "");
    },
  );
  app.post<{ Params: { channelPublicId: string } }>(
    "/webhooks/meta/whatsapp/:channelPublicId",
    async (request, reply) => {
      const channel = await channels.byPublicId(request.params.channelPublicId);
      if (!channel)
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Channel not found" },
        });
      const signature = request.headers["x-hub-signature-256"],
        secrets = channelSecrets(channel, options),
        appSecret =
          secrets.appSecret ??
          options.metaAppSecret ??
          (options.environment === "production" ? null : "local-app-secret");
      if (!appSecret)
        return reply.code(503).send({
          error: {
            code: "webhook_signature_configuration_missing",
            message: "Webhook signature configuration is missing",
          },
        });
      if (
        typeof signature !== "string" ||
        !verifyMetaSignature(request.rawBody ?? "", signature, appSecret)
      )
        return reply.code(401).send({
          error: { code: "invalid_signature", message: "Invalid signature" },
        });
      const payload = request.body as Record<string, unknown>;
      if (
        payload.object !== "whatsapp_business_account" ||
        !Array.isArray(payload.entry)
      )
        return reply.code(400).send({
          error: {
            code: "invalid_webhook_payload",
            message: "Invalid webhook payload",
          },
        });
      const changes = extractMetaWebhookChanges(payload);
      if (changes.length === 0)
        return reply.code(400).send({
          error: {
            code: "invalid_webhook_payload",
            message: "Webhook payload has no changes",
          },
        });
      let accepted = 0,
        duplicates = 0;
      for (const change of changes) {
        const targetChannel =
          change.phoneNumberIds.length === 1
            ? await channels.byMetaPhoneNumberId({
                organizationId: String(channel.organization_id),
                phoneNumberId: change.phoneNumberIds[0]!,
                providerAccountId: channel.provider_account_id
                  ? String(channel.provider_account_id)
                  : null,
                businessAccountId: channel.business_account_id
                  ? String(channel.business_account_id)
                  : null,
              })
            : channel;
        // WABA-level fields have no endpoint metadata and remain attached to
        // the callback anchor. Phone-scoped fields are routed to the matching
        // sibling channel under the same provider account.
        const channelMatches =
          Boolean(targetChannel) &&
          metaWebhookTargetsPhone(
            change,
            String(targetChannel?.phone_number_id),
          );
        const key = deterministicEventKey({
          channel: targetChannel?.id ?? channel.id,
          entryIndex: change.entryIndex,
          changeIndex: change.changeIndex,
          entryId: change.entryId,
          change: change.change,
        });
        if (
          await webhooks.insert({
            organizationId: String(channel.organization_id),
            channelId: String(targetChannel?.id ?? channel.id),
            eventKey: key,
            eventType: metaWebhookEventType(change.field),
            payload: change.payload,
            status: channelMatches ? "pending" : "unmatched_channel",
          })
        ) {
          accepted++;
        } else duplicates++;
      }
      return { accepted, duplicates };
    },
  );
  app.post<{ Params: { channelPublicId: string } }>(
    "/webhooks/telegram/:channelPublicId",
    async (request, reply) => {
      const channel = await channels.byPublicId(request.params.channelPublicId);
      if (!channel || channel.provider !== "telegram")
        return reply.code(404).send({
          error: { code: "channel_not_found", message: "Channel not found" },
        });
      const secret = request.headers["x-telegram-bot-api-secret-token"];
      if (
        typeof secret !== "string" ||
        !channel.verify_token_hash ||
        !safeEqual(hashSecret(secret), String(channel.verify_token_hash))
      )
        return reply.code(401).send({
          error: { code: "invalid_signature", message: "Invalid signature" },
        });
      const normalized = normalizeTelegramWebhookUpdate(request.body);
      if (!normalized) return reply.code(202).send({ accepted: 0, ignored: 1 });
      const inserted = await webhooks.insert({
        organizationId: String(channel.organization_id),
        channelId: String(channel.id),
        provider: "telegram",
        eventKey: `${normalized.eventKey}:${String(channel.id)}`,
        eventType: "messages",
        payload: normalized.payload,
      });
      return { accepted: inserted ? 1 : 0, duplicates: inserted ? 0 : 1 };
    },
  );
  if (options.openApiEnabled)
    app.get(
      "/openapi.json",
      { config: { rateLimit: false }, schema: { hide: true } },
      async () => app.swagger(),
    );
  app.setErrorHandler((error, request, reply) => {
    const normalized =
      error instanceof Error ? error : new Error("unknown_error");
    const statusCode =
      (normalized as Error & { statusCode?: number }).statusCode ??
      (normalized.name === "ZodError" ? 400 : 500);
    request.log.error(
      { err: statusCode >= 500 ? normalized.message : undefined, statusCode },
      "request failed",
    );
    reply.code(statusCode).send({
      error: {
        code: statusCode === 500 ? "internal_error" : normalized.message,
        message: statusCode === 500 ? "İstek işlenemedi." : normalized.message,
        requestId: request.id,
      },
    });
  });
  return app;
}

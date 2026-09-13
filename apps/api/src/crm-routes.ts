import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  type Permission,
} from "@brixchat/auth";
import { CrmRepository, type DatabaseClient } from "@brixchat/database";
import {
  Bitrix24Provider,
  BitrixRestClient,
  type StoredBitrixTokens,
  FakeBitrix24Provider,
  bitrixAuthPayload,
  decryptSecret,
  deterministicEventKey,
  encryptSecret,
  hashSecret,
  pickUnambiguousMatch,
  safeEqual,
  type BitrixOAuthTokenUpdate,
  type CrmProvider,
  type FakeBitrixScenario,
} from "@brixchat/integrations";
import { z } from "zod";

type Authorize = (
  permission: Permission,
) => (request: FastifyRequest) => Promise<void>;
type Publish = (
  organizationId: string,
  event: Record<string, unknown>,
) => Promise<void>;
interface CrmRouteOptions {
  appEncryptionKey?: string;
  bitrixClientId?: string;
  bitrixClientSecret?: string;
  apiPublicUrl: string;
  webUrl: string;
  authorize: Authorize;
  publish: Publish;
}
type Row = Record<string, unknown>;
type BitrixStoredCredentials = {
  webhookUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  clientEndpoint?: string;
  serverEndpoint?: string;
};
const BITRIX_CRM_EVENTS = [
  "ONAPPINSTALL",
  "ONCRMCONTACTUPDATE",
  "ONCRMLEADUPDATE",
  "ONCRMDEALUPDATE",
  "ONCRMCOMPANYUPDATE",
  "ONAPPUNINSTALL",
] as const;
const BITRIX_CLOUD_SUFFIXES = [
  "bitrix24.com",
  "bitrix24.com.tr",
  "bitrix24.de",
  "bitrix24.eu",
  "bitrix24.fr",
  "bitrix24.it",
  "bitrix24.es",
  "bitrix24.pl",
  "bitrix24.ru",
  "bitrix24.kz",
  "bitrix24.in",
  "bitrix24.com.br",
  "bitrix24.com.au",
  "bitrix24.co.uk",
  "bitrix24.ca",
  "bitrix24.com.mx",
] as const;

const webhookConnectSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    portalUrl: z.string().url().max(300),
    webhookUrl: z.string().url().max(500).optional(),
    webhookToken: z.string().min(16).max(200).optional(),
    fakeScenario: z
      .enum([
        "success",
        "empty",
        "pagination",
        "ambiguous_contact",
        "timeout",
        "auth_failure",
        "rate_limit",
        "permission_denied",
        "invalid_payload",
        "temporary_error",
        "permanent_error",
      ])
      .optional(),
  })
  .refine(
    (value) => Boolean(value.fakeScenario || value.webhookUrl),
    "webhookUrl is required",
  );
const entitySchema = z.object({
  entityType: z.enum(["contact", "lead", "deal"]),
  fields: z.record(z.string(), z.unknown()).default({}),
  pipelineId: z.string().max(80).optional(),
  stageId: z.string().max(80).optional(),
});
const automationWebhookSchema = z.object({
  entity_type: z.enum(["lead", "deal", "contact"]),
  entity_id: z.union([z.string(), z.number()]).transform(String),
  phone: z.string().trim().min(3).max(40),
  template_name: z.string().trim().min(1).max(200),
  channel_id: z.string().uuid().optional(),
  contact_name: z.string().trim().max(200).optional(),
  variables: z.record(z.string(), z.string()).optional(),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
});
const mappingSchema = z.object({
  mappings: z
    .array(
      z.object({
        externalUserId: z.string().min(1).max(80),
        localUserId: z.string().uuid().nullable(),
        externalSnapshot: z.record(z.string(), z.unknown()).default({}),
        active: z.boolean().default(true),
        crmPolicy: z
          .object({
            mode: z
              .enum(["inherit", "disabled", "lead", "contact_and_deal"])
              .default("inherit"),
            sourceId: z.string().trim().max(80).optional(),
          })
          .default({ mode: "inherit" }),
      }),
    )
    .max(500)
    .superRefine((mappings, context) => {
      const assigned = new Set<string>();
      mappings.forEach((mapping, index) => {
        if (!mapping.localUserId) return;
        if (assigned.has(mapping.localUserId)) {
          context.addIssue({
            code: "custom",
            message: "A panel user can map to only one Bitrix24 user",
            path: [index, "localUserId"],
          });
          return;
        }
        assigned.add(mapping.localUserId);
      });
    }),
});

function safeConnection(row: Row) {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    provider: String(row.provider),
    name: String(row.name),
    authMode: String(row.auth_mode),
    portalUrl: row.portal_url ? String(row.portal_url) : null,
    authExternalUserId: row.auth_external_user_id
      ? String(row.auth_external_user_id)
      : null,
    authExternalUserName:
      typeof (row.settings as Record<string, unknown> | null)
        ?.authExternalUserName === "string"
        ? String((row.settings as Record<string, unknown>).authExternalUserName)
        : null,
    status: String(row.status),
    settings: row.settings ?? {},
    credentialsConfigured: Boolean(row.credentials_encrypted),
    lastHealthAt: row.last_health_at ?? null,
    lastSyncAt: row.last_sync_at ?? null,
    lastErrorCode: row.last_error_code ?? null,
    createdAt: row.created_at,
  };
}

function normalizeBitrixPortalUrl(value: string) {
  const url = new URL(value);
  const cloudPortal = BITRIX_CLOUD_SUFFIXES.some((suffix) => {
    const marker = `.${suffix}`;
    if (!url.hostname.endsWith(marker)) return false;
    const portalName = url.hostname.slice(0, -marker.length);
    return /^[a-z0-9-]+$/i.test(portalName);
  });
  const localFake = url.hostname.endsWith(".bitrix24.local");
  if ((url.protocol !== "https:" || !cloudPortal) && !localFake)
    throw Object.assign(new Error("bitrix_portal_url_invalid"), {
      statusCode: 400,
    });
  return `${url.protocol}//${url.host}`;
}

function validateBitrixWebhookUrl(webhookUrl: string, portalUrl: string) {
  const webhook = new URL(webhookUrl);
  const portal = new URL(portalUrl);
  if (
    webhook.protocol !== "https:" ||
    webhook.hostname !== portal.hostname ||
    !/^\/rest\/\d+\/[a-z0-9_-]+\/?$/i.test(webhook.pathname)
  )
    throw Object.assign(new Error("bitrix_webhook_url_invalid"), {
      statusCode: 400,
    });
  return webhook.toString().replace(/\/$/, "");
}

function sanitizedBitrixEventPayload(body: Record<string, unknown>) {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (
      /^auth\[(access_token|refresh_token|application_token)\]$/i.test(key) ||
      /^(access_token|refresh_token|application_token)$/i.test(key)
    )
      continue;
    if (key === "auth" && typeof value === "object" && value !== null) {
      const auth = value as Record<string, unknown>;
      sanitized.auth = {
        domain: auth.domain ?? null,
        member_id: auth.member_id ?? null,
      };
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

// Bitrix24 loads the local application's install URL inside an iframe in the
// portal admin's own browser (this is not a pure server-to-server callback),
// so a plain HTML response is what Bitrix24 -- and the admin -- actually see.
// BX24.installFinish() tells Bitrix24 the install succeeded; the link below
// breaks out of the iframe to let the admin claim the new Brixchat24 account.
function installSuccessHtml(setupUrl: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Brixchat24 kuruldu</title>
<script src="https://api.bitrix24.com/api/v1/"></script></head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#172033">
<h1>Brixchat24 kuruldu 🎉</h1>
<p>Hesabınızı tamamlamak için aşağıdaki bağlantıya tıklayın.</p>
<p><a href="${setupUrl}" target="_top" style="display:inline-block;padding:12px 24px;background:#625bf6;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Kurulumu tamamla</a></p>
<script>try{BX24.init(function(){BX24.installFinish();});}catch(e){}</script>
</body></html>`;
}

function alreadyInstalledHtml(webUrl: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Brixchat24</title>
<script src="https://api.bitrix24.com/api/v1/"></script></head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#172033">
<h1>Bu portal zaten bağlı</h1>
<p>Bu Bitrix24 hesabı için Brixchat24'te zaten bir bağlantı var. Giriş yapmak için <a href="${webUrl}/login" target="_top">buraya tıklayın</a> veya yardım için destek ekibiyle iletişime geçin.</p>
<script>try{BX24.init(function(){BX24.installFinish();});}catch(e){}</script>
</body></html>`;
}

function mergeOAuthCredentials(
  credentials: BitrixStoredCredentials,
  update: BitrixOAuthTokenUpdate,
): BitrixStoredCredentials {
  return {
    ...credentials,
    accessToken: update.accessToken,
    ...(update.refreshToken ? { refreshToken: update.refreshToken } : {}),
    accessTokenExpiresAt: update.accessTokenExpiresAt,
    ...(update.clientEndpoint ? { clientEndpoint: update.clientEndpoint } : {}),
    ...(update.serverEndpoint ? { serverEndpoint: update.serverEndpoint } : {}),
  };
}

function providerFor(
  row: Row,
  encryptionKey?: string,
  oauth?: {
    clientId?: string;
    clientSecret?: string;
    persistCredentials?: (
      credentials: BitrixStoredCredentials,
    ) => Promise<void>;
    withRefreshLock?: <T>(
      fn: (freshest: StoredBitrixTokens | null) => Promise<T>,
    ) => Promise<T>;
  },
): CrmProvider {
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  if (row.auth_mode === "fake")
    return new FakeBitrix24Provider(
      String(settings.fakeScenario ?? "success") as FakeBitrixScenario,
    );
  if (!row.credentials_encrypted || !encryptionKey)
    throw Object.assign(new Error("integration_credentials_missing"), {
      statusCode: 409,
    });
  const credentials = JSON.parse(
    decryptSecret(String(row.credentials_encrypted), encryptionKey),
  ) as BitrixStoredCredentials;
  return new Bitrix24Provider(
    new BitrixRestClient({
      // API handlers must not sit in the default 5-attempt/372s backoff; a
      // single quick retry keeps request latency bounded.
      maxAttempts: 2,
      ...(credentials.webhookUrl ? { webhookUrl: credentials.webhookUrl } : {}),
      ...(row.portal_url ? { portalUrl: String(row.portal_url) } : {}),
      ...(credentials.accessToken
        ? { accessToken: credentials.accessToken }
        : {}),
      ...(credentials.refreshToken
        ? { refreshToken: credentials.refreshToken }
        : {}),
      ...(credentials.accessTokenExpiresAt
        ? { accessTokenExpiresAt: credentials.accessTokenExpiresAt }
        : {}),
      ...(oauth?.clientId ? { clientId: oauth.clientId } : {}),
      ...(oauth?.clientSecret ? { clientSecret: oauth.clientSecret } : {}),
      ...(oauth?.persistCredentials
        ? {
            onTokenRefresh: async (update) =>
              oauth.persistCredentials!(
                mergeOAuthCredentials(credentials, update),
              ),
          }
        : {}),
      ...(oauth?.withRefreshLock
        ? { withRefreshLock: oauth.withRefreshLock }
        : {}),
    }),
    String(row.portal_url ?? ""),
  );
}

async function connection(
  repository: CrmRepository,
  organizationId: string,
  id?: string,
): Promise<Row | null> {
  return repository.connection(organizationId, id);
}

export function registerCrmRoutes(
  app: FastifyInstance,
  sql: DatabaseClient,
  options: CrmRouteOptions,
) {
  const crmRepository = new CrmRepository(sql);
  const provider = (row: Row) =>
    providerFor(row, options.appEncryptionKey, {
      ...(options.bitrixClientId ? { clientId: options.bitrixClientId } : {}),
      ...(options.bitrixClientSecret
        ? { clientSecret: options.bitrixClientSecret }
        : {}),
      ...(options.appEncryptionKey && row.id
        ? {
            persistCredentials: async (
              credentials: BitrixStoredCredentials,
            ) => {
              const encrypted = encryptSecret(
                JSON.stringify(credentials),
                options.appEncryptionKey!,
              );
              await sql`UPDATE integration_connections SET credentials_encrypted=${encrypted},updated_at=now() WHERE id=${String(row.id)}::uuid`;
            },
            withRefreshLock: async <T>(
              fn: (freshest: StoredBitrixTokens | null) => Promise<T>,
            ): Promise<T> =>
              sql.begin(async (tx) => {
                await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`bitrix_token_refresh:${String(row.id)}`},0))`;
                const stored = await tx<
                  Row[]
                >`SELECT credentials_encrypted FROM integration_connections WHERE id=${String(row.id)}::uuid`;
                let freshest: StoredBitrixTokens | null = null;
                const encryptedCredentials = stored[0]?.credentials_encrypted;
                if (encryptedCredentials) {
                  try {
                    const parsed = JSON.parse(
                      decryptSecret(
                        String(encryptedCredentials),
                        options.appEncryptionKey!,
                      ),
                    ) as BitrixStoredCredentials;
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
          }
        : {}),
    });
  app.get(
    "/api/v1/integrations",
    { preHandler: options.authorize("inbox:read") },
    async (request) => ({
      data: (
        await sql<
          Row[]
        >`SELECT * FROM integration_connections WHERE organization_id=${request.claims!.organizationId}::uuid ORDER BY created_at`
      ).map(safeConnection),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/integrations/:id",
    { preHandler: options.authorize("inbox:read") },
    async (request, reply) => {
      const row = await connection(
        crmRepository,
        request.claims!.organizationId,
        request.params.id,
      );
      return row
        ? { data: safeConnection(row) }
        : reply.code(404).send({
            error: {
              code: "integration_not_found",
              message: "Integration not found",
            },
          });
    },
  );

  app.post(
    "/api/v1/integrations/bitrix24/webhook-connect",
    { preHandler: options.authorize("integrations:manage") },
    async (request, reply) => {
      const body = webhookConnectSchema.parse(request.body),
        fake = Boolean(body.fakeScenario);
      if (!fake && !options.appEncryptionKey)
        return reply.code(503).send({
          error: {
            code: "encryption_not_configured",
            message: "Encryption is not configured",
          },
        });
      const publicToken =
        body.webhookToken ?? randomBytes(24).toString("base64url");
      const portalUrl = fake
        ? body.portalUrl
        : normalizeBitrixPortalUrl(body.portalUrl);
      const webhookUrl =
        !fake && body.webhookUrl
          ? validateBitrixWebhookUrl(body.webhookUrl, portalUrl)
          : body.webhookUrl;
      const encrypted =
        !fake && webhookUrl
          ? encryptSecret(
              JSON.stringify({ webhookUrl }),
              options.appEncryptionKey!,
            )
          : null;
      const rows = await crmRepository.query<
        Row[]
      >`INSERT INTO integration_connections(organization_id,provider,name,auth_mode,portal_url,credentials_encrypted,webhook_token_hash,status,settings,created_by) VALUES(${request.claims!.organizationId}::uuid,'bitrix24',${body.name},${fake ? "fake" : "webhook"},${portalUrl},${encrypted},${hashSecret(publicToken)},'connected',${sql.json({ fakeScenario: body.fakeScenario ?? null, syncResponsible: true, timelineEnabled: true } as never)},${request.claims!.sub}::uuid) ON CONFLICT(organization_id,provider,portal_url) DO UPDATE SET name=EXCLUDED.name,auth_mode=EXCLUDED.auth_mode,credentials_encrypted=COALESCE(EXCLUDED.credentials_encrypted,integration_connections.credentials_encrypted),webhook_token_hash=EXCLUDED.webhook_token_hash,status='connected',settings=EXCLUDED.settings,updated_at=now() RETURNING *`;
      return reply.code(201).send({
        data: {
          ...safeConnection(rows[0]!),
          webhookCallbackUrl: `${options.apiPublicUrl}/webhooks/bitrix24/${rows[0]!.public_id}`,
          webhookToken: publicToken,
        },
      });
    },
  );

  app.post(
    "/api/v1/integrations/bitrix24/local-app/start",
    { preHandler: options.authorize("integrations:manage") },
    async (request, reply) => {
      const body = z
        .object({
          portalUrl: z.string().url(),
          name: z.string().trim().min(1).max(80).default("Bitrix24"),
        })
        .parse(request.body);
      if (
        !options.bitrixClientId ||
        !options.bitrixClientSecret ||
        !options.appEncryptionKey
      )
        return reply.code(503).send({
          error: {
            code: "bitrix_local_app_not_configured",
            message:
              "Bitrix24 local application credentials are not configured",
          },
        });
      const portalUrl = normalizeBitrixPortalUrl(body.portalUrl);
      const nonce = randomBytes(32).toString("base64url");
      const existing = (
        await sql<
          Row[]
        >`SELECT * FROM integration_connections WHERE organization_id=${request.claims!.organizationId}::uuid AND provider='bitrix24' AND portal_url=${portalUrl} ORDER BY created_at LIMIT 1`
      )[0];
      if (existing && String(existing.status) === "connected")
        return reply.code(409).send({
          error: {
            code: "bitrix_connection_exists",
            message: "A connected Bitrix24 integration already exists",
          },
        });
      const rows = existing
        ? await sql<
            Row[]
          >`UPDATE integration_connections SET name=${body.name},auth_mode='oauth',credentials_encrypted=NULL,webhook_token_hash=${hashSecret(nonce)},status='oauth_pending',settings=${sql.json({ syncResponsible: true, timelineEnabled: true } as never)},updated_at=now() WHERE id=${String(existing.id)}::uuid RETURNING *`
        : await sql<
            Row[]
          >`INSERT INTO integration_connections(organization_id,provider,name,auth_mode,portal_url,webhook_token_hash,status,settings,created_by) VALUES(${request.claims!.organizationId}::uuid,'bitrix24',${body.name},'oauth',${portalUrl},${hashSecret(nonce)},'oauth_pending',${sql.json({ syncResponsible: true, timelineEnabled: true } as never)},${request.claims!.sub}::uuid) RETURNING *`;
      const row = rows[0]!;
      const callback = new URL(
        `${options.apiPublicUrl}/webhooks/bitrix24/install/${String(row.public_id)}`,
      );
      callback.searchParams.set("setup_token", nonce);
      return reply.code(201).send({
        data: {
          ...safeConnection(row),
          applicationHandlerUrl: `${options.webUrl}/app/integrations/bitrix24`,
          installationCallbackUrl: callback.toString(),
          eventHandlerUrl: `${options.apiPublicUrl}/webhooks/bitrix24/${String(row.public_id)}`,
          requiredScopes: ["crm", "user"],
          optionalScopes: ["imopenlines", "im", "imconnector", "placement"],
        },
      });
    },
  );

  app.post<{ Params: { connectionPublicId: string } }>(
    "/webhooks/bitrix24/install/:connectionPublicId",
    async (request, reply) => {
      if (
        !options.bitrixClientId ||
        !options.bitrixClientSecret ||
        !options.appEncryptionKey
      )
        return reply.code(503).send({
          error: {
            code: "bitrix_local_app_not_configured",
            message:
              "Bitrix24 local application credentials are not configured",
          },
        });
      const query = z
        .object({ setup_token: z.string().min(32).max(200) })
        .parse(request.query);
      const row = (
        await sql<
          Row[]
        >`SELECT * FROM integration_connections WHERE public_id=${request.params.connectionPublicId}::uuid AND provider='bitrix24' AND status='oauth_pending' FOR UPDATE`
      )[0];
      if (
        !row ||
        !row.webhook_token_hash ||
        !safeEqual(
          String(row.webhook_token_hash),
          hashSecret(query.setup_token),
        )
      )
        return reply.code(401).send({
          error: {
            code: "bitrix_install_invalid",
            message: "Bitrix24 installation callback is invalid or expired",
          },
        });
      const auth = bitrixAuthPayload(
        (request.body ?? {}) as Record<string, unknown>,
      );
      if (
        !auth.accessToken ||
        !auth.refreshToken ||
        !auth.applicationToken ||
        !auth.domain ||
        !auth.memberId
      )
        return reply.code(400).send({
          error: {
            code: "bitrix_install_auth_missing",
            message: "Bitrix24 installation authorization is incomplete",
          },
        });
      const portalUrl = normalizeBitrixPortalUrl(`https://${auth.domain}`);
      if (portalUrl !== String(row.portal_url))
        return reply.code(400).send({
          error: {
            code: "bitrix_install_domain_mismatch",
            message: "Bitrix24 installation domain does not match",
          },
        });
      const accessTokenExpiresAt = new Date(
        Date.now() +
          (Number.isFinite(auth.expiresIn) && auth.expiresIn > 0
            ? auth.expiresIn
            : 3600) *
            1000,
      ).toISOString();
      const credentials: BitrixStoredCredentials = {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        accessTokenExpiresAt,
        ...(auth.clientEndpoint ? { clientEndpoint: auth.clientEndpoint } : {}),
        ...(auth.serverEndpoint ? { serverEndpoint: auth.serverEndpoint } : {}),
      };
      const client = new BitrixRestClient({
        portalUrl,
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        accessTokenExpiresAt,
        clientId: options.bitrixClientId,
        clientSecret: options.bitrixClientSecret,
      });
      await client.call("app.info");
      const profileResponse =
        await client.call<Record<string, unknown>>("profile");
      const profile = profileResponse.result ?? {};
      const authExternalUserId = String(profile.ID ?? "").trim();
      if (!authExternalUserId)
        return reply.code(502).send({
          error: {
            code: "bitrix_oauth_profile_missing",
            message: "Bitrix OAuth user profile could not be resolved",
          },
        });
      const authExternalUserName = [profile.NAME, profile.LAST_NAME]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .join(" ");
      const ownerConflict = (
        await crmRepository.query<
          Row[]
        >`SELECT id FROM integration_connections WHERE organization_id=${String(row.organization_id)}::uuid AND provider='bitrix24' AND portal_url=${portalUrl} AND auth_external_user_id=${authExternalUserId} AND status='connected' AND id<>${String(row.id)}::uuid LIMIT 1`
      )[0];
      if (ownerConflict) {
        await crmRepository.query`UPDATE integration_connections SET status='disconnected',credentials_encrypted=NULL,webhook_token_hash=NULL,last_error_code='BITRIX_OAUTH_USER_ALREADY_CONNECTED',updated_at=now() WHERE id=${String(row.id)}::uuid`;
        return reply.code(409).send({
          error: {
            code: "bitrix_oauth_user_already_connected",
            message:
              "This Bitrix user already owns an active connection for the portal",
          },
        });
      }
      const eventHandler = `${options.apiPublicUrl}/webhooks/bitrix24/${String(row.public_id)}`;
      for (const event of BITRIX_CRM_EVENTS)
        await client.call("event.bind", { event, handler: eventHandler });
      const encrypted = encryptSecret(
        JSON.stringify(credentials),
        options.appEncryptionKey,
      );
      await sql`UPDATE integration_connections SET portal_url=${portalUrl},member_id=${auth.memberId},auth_external_user_id=${authExternalUserId},credentials_encrypted=${encrypted},webhook_token_hash=${hashSecret(auth.applicationToken)},status='connected',settings=settings||${sql.json({ installedAt: new Date().toISOString(), subscribedEvents: BITRIX_CRM_EVENTS, authExternalUserName } as never)},last_error_code=NULL,updated_at=now() WHERE id=${String(row.id)}::uuid`;
      return {
        status: "connected",
        connectionPublicId: String(row.public_id),
        subscribedEvents: BITRIX_CRM_EVENTS,
      };
    },
  );

  /**
   * Bitrix24.Market's real "Install" button flow: the customer has never
   * touched Brixchat24 before, so unlike every other route in this file this
   * one intentionally has no auth -- it's the one, fixed "Initial
   * installation path" registered once in the Bitrix24 Partner panel.
   * Bitrix24 POSTs the OAuth grant straight to it, and this handler
   * provisions a brand-new organization + owner user + connection from that
   * payload alone. The request is verified by calling back into the reported
   * Bitrix portal with the received access token (app.info/profile) -- a
   * forged domain can't produce a token that authenticates against a real
   * portal, so this is the actual trust boundary, not the request body.
   */
  // The Market vendor console GETs this URL to confirm it's reachable
  // before it'll accept it as the "Application installer URL" -- the real
  // install flow below only ever receives POSTs from Bitrix24.
  app.get("/webhooks/bitrix24/market-install", async (_request, reply) => {
    return reply.code(200).send({ status: "ok" });
  });

  app.post(
    "/webhooks/bitrix24/market-install",
    // Bitrix24 POSTs install callbacks from its own infrastructure, not the
    // customer's IP, so unrelated customers can share a source IP here. Keep
    // this generous -- the app.info/profile round-trip against the reported
    // portal is the real abuse control, not this limit.
    { config: { rateLimit: { max: 60, timeWindow: "1 hour" } } },
    async (request, reply) => {
      if (
        !options.bitrixClientId ||
        !options.bitrixClientSecret ||
        !options.appEncryptionKey
      )
        return reply.code(503).send({
          error: {
            code: "bitrix_local_app_not_configured",
            message:
              "Bitrix24 local application credentials are not configured",
          },
        });
      const auth = bitrixAuthPayload(
        (request.body ?? {}) as Record<string, unknown>,
      );
      if (
        !auth.accessToken ||
        !auth.refreshToken ||
        !auth.applicationToken ||
        !auth.domain ||
        !auth.memberId
      )
        return reply.code(400).send({
          error: {
            code: "bitrix_install_auth_missing",
            message: "Bitrix24 installation authorization is incomplete",
          },
        });
      let portalUrl: string;
      try {
        portalUrl = normalizeBitrixPortalUrl(`https://${auth.domain}`);
      } catch {
        return reply.code(400).send({
          error: {
            code: "bitrix_install_domain_invalid",
            message: "Bitrix24 installation domain is not a recognized portal",
          },
        });
      }
      const accessTokenExpiresAt = new Date(
        Date.now() +
          (Number.isFinite(auth.expiresIn) && auth.expiresIn > 0
            ? auth.expiresIn
            : 3600) *
            1000,
      ).toISOString();
      const client = new BitrixRestClient({
        portalUrl,
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        accessTokenExpiresAt,
        clientId: options.bitrixClientId,
        clientSecret: options.bitrixClientSecret,
      });
      let authExternalUserId: string;
      let authExternalUserName: string;
      try {
        await client.call("app.info");
        const profileResponse =
          await client.call<Record<string, unknown>>("profile");
        const profile = profileResponse.result ?? {};
        authExternalUserId = String(profile.ID ?? "").trim();
        authExternalUserName = [profile.NAME, profile.LAST_NAME]
          .map((value) => String(value ?? "").trim())
          .filter(Boolean)
          .join(" ");
      } catch {
        return reply.code(502).send({
          error: {
            code: "bitrix_install_token_invalid",
            message:
              "Could not verify the Bitrix24 authorization against the reported portal",
          },
        });
      }
      if (!authExternalUserId)
        return reply.code(502).send({
          error: {
            code: "bitrix_oauth_profile_missing",
            message: "Bitrix OAuth user profile could not be resolved",
          },
        });

      const memberId = auth.memberId.toLowerCase().replace(/[^a-z0-9]/g, "");
      const domainSlug =
        auth.domain
          .split(".")[0]!
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "bitrix24";
      const syntheticEmail = `bitrix-${memberId}@setup.brixchat24.internal`;
      const placeholderPasswordHash = await hashPassword(
        randomBytes(24).toString("base64url"),
      );
      const credentials: BitrixStoredCredentials = {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        accessTokenExpiresAt,
        ...(auth.clientEndpoint ? { clientEndpoint: auth.clientEndpoint } : {}),
        ...(auth.serverEndpoint ? { serverEndpoint: auth.serverEndpoint } : {}),
      };
      const encrypted = encryptSecret(
        JSON.stringify(credentials),
        options.appEncryptionKey,
      );

      const trialPlan = (
        await sql<
          Row[]
        >`SELECT id FROM plans WHERE code='trial' AND active=true LIMIT 1`
      )[0];
      if (!trialPlan)
        return reply.code(503).send({
          error: {
            code: "bitrix_install_plan_missing",
            message: "No active trial plan is configured for new organizations",
          },
        });

      let provisioned: {
        organizationId: string;
        userId: string;
        connectionId: string;
        connectionPublicId: string;
      } | null;
      try {
        provisioned = await sql.begin(async (tx) => {
          if (
            await crmRepository.hasActiveBitrixMarketInstallation(
              tx,
              auth.memberId,
            )
          )
            return null;
          const org = (
            await tx<
              Row[]
            >`INSERT INTO organizations(name,slug) VALUES(${`${auth.domain} (Bitrix24)`},${`${domainSlug}-${randomBytes(3).toString("hex")}`}) RETURNING id`
          )[0]!;
          await tx`INSERT INTO organization_entitlements(organization_id,plan_id,trial_started_at,trial_ends_at,trial_status) VALUES(${String(org.id)}::uuid,${String(trialPlan.id)}::uuid,now(),now()+interval '14 days','active')`;
          const user = (
            await tx<
              Row[]
            >`INSERT INTO users(email,password_hash,full_name) VALUES(${syntheticEmail},${placeholderPasswordHash},${authExternalUserName || "Bitrix24 Yöneticisi"}) RETURNING id`
          )[0]!;
          await tx`INSERT INTO user_credentials(user_id,password_hash) VALUES(${String(user.id)}::uuid,${placeholderPasswordHash})`;
          await tx`INSERT INTO organization_members(organization_id,user_id,role) VALUES(${String(org.id)}::uuid,${String(user.id)}::uuid,'owner')`;
          await tx`INSERT INTO onboarding_progress(user_id,organization_id) VALUES(${String(user.id)}::uuid,${String(org.id)}::uuid)`;
          const conn = (
            await tx<
              Row[]
            >`INSERT INTO integration_connections(organization_id,provider,name,auth_mode,portal_url,member_id,auth_external_user_id,credentials_encrypted,webhook_token_hash,status,settings,created_by)
              VALUES(${String(org.id)}::uuid,'bitrix24',${`Bitrix24 (${auth.domain})`},'oauth',${portalUrl},${auth.memberId},${authExternalUserId},${encrypted},${hashSecret(auth.applicationToken)},'connected',${tx.json({ installedAt: new Date().toISOString(), subscribedEvents: BITRIX_CRM_EVENTS, authExternalUserName, source: "market_cold_install" } as never)},${String(user.id)}::uuid)
              RETURNING id,public_id`
          )[0]!;
          await tx`INSERT INTO tenant_provisioning_audit(organization_id,action,actor,details) VALUES(${String(org.id)}::uuid,'create','bitrix24_market_install',${tx.json({ portalUrl, memberId: auth.memberId } as never)})`;
          return {
            organizationId: String(org.id),
            userId: String(user.id),
            connectionId: String(conn.id),
            connectionPublicId: String(conn.public_id),
          };
        });
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23505"
        )
          return reply
            .code(409)
            .type("text/html")
            .send(alreadyInstalledHtml(options.webUrl));
        throw error;
      }

      if (!provisioned)
        return reply
          .code(409)
          .type("text/html")
          .send(alreadyInstalledHtml(options.webUrl));

      const eventHandler = `${options.apiPublicUrl}/webhooks/bitrix24/${provisioned.connectionPublicId}`;
      for (const event of BITRIX_CRM_EVENTS) {
        try {
          await client.call("event.bind", { event, handler: eventHandler });
        } catch (error) {
          app.log.warn(
            {
              error: error instanceof Error ? error.message : String(error),
              event,
            },
            "bitrix market install: event.bind failed",
          );
        }
      }

      const setupToken = createOpaqueToken();
      await sql`INSERT INTO bitrix_setup_tokens(organization_id,user_id,connection_id,token_hash,expires_at) VALUES(${provisioned.organizationId}::uuid,${provisioned.userId}::uuid,${provisioned.connectionId}::uuid,${hashOpaqueToken(setupToken)},now()+interval '24 hours')`;

      const setupUrl = new URL("/bitrix24-setup", options.webUrl);
      setupUrl.searchParams.set("token", setupToken);
      return reply
        .type("text/html")
        .send(installSuccessHtml(setupUrl.toString()));
    },
  );

  app.get<{ Params: { connectionPublicId: string } }>(
    "/webhooks/bitrix24/install/:connectionPublicId",
    async (request, reply) => {
      const query = z
        .object({
          code: z.string().min(1),
          state: z.string().min(1),
          domain: z.string().min(1),
          member_id: z.string().optional(),
        })
        .parse(request.query);
      const callback = new URL(
        `${options.apiPublicUrl}/api/v1/integrations/bitrix24/oauth/callback`,
      );
      callback.searchParams.set("code", query.code);
      callback.searchParams.set("state", query.state);
      callback.searchParams.set("domain", query.domain);
      if (query.member_id)
        callback.searchParams.set("member_id", query.member_id);
      return reply.redirect(callback.toString());
    },
  );

  app.post(
    "/api/v1/integrations/bitrix24/oauth/start",
    { preHandler: options.authorize("integrations:manage") },
    async (request, reply) => {
      const body = z
        .object({
          portalUrl: z.string().url(),
          name: z.string().min(1).max(80).default("Bitrix24"),
        })
        .parse(request.body);
      if (
        !options.bitrixClientId ||
        !options.bitrixClientSecret ||
        !options.appEncryptionKey
      )
        return reply.code(503).send({
          error: {
            code: "bitrix_oauth_not_configured",
            message: "Bitrix OAuth is not configured",
          },
        });
      const portalUrl = normalizeBitrixPortalUrl(body.portalUrl);
      const nonce = randomBytes(24).toString("base64url");
      const existing = (
        await sql<
          Row[]
        >`SELECT * FROM integration_connections WHERE organization_id=${request.claims!.organizationId}::uuid AND provider='bitrix24' AND portal_url=${portalUrl} AND status='oauth_pending' ORDER BY updated_at DESC LIMIT 1`
      )[0];
      const rows = existing
        ? await sql<
            Row[]
          >`UPDATE integration_connections SET name=${body.name},auth_mode='oauth',credentials_encrypted=NULL,webhook_token_hash=${hashSecret(nonce)},status='oauth_pending',settings=settings||${sql.json({ oauthFallbackStartedAt: new Date().toISOString() } as never)},updated_at=now() WHERE id=${String(existing.id)}::uuid RETURNING id`
        : await sql<
            Row[]
          >`INSERT INTO integration_connections(organization_id,provider,name,auth_mode,portal_url,webhook_token_hash,status,settings,created_by) VALUES(${request.claims!.organizationId}::uuid,'bitrix24',${body.name},'oauth',${portalUrl},${hashSecret(nonce)},'oauth_pending','{}',${request.claims!.sub}::uuid) RETURNING id`;
      const state = app.jwt.sign(
        {
          purpose: "bitrix_oauth",
          connectionId: String(rows[0]!.id),
          organizationId: request.claims!.organizationId,
          nonce,
        },
        { expiresIn: "10m" },
      );
      const redirectUri = `${options.apiPublicUrl}/api/v1/integrations/bitrix24/oauth/callback`;
      const authorization = new URL(`${portalUrl}/oauth/authorize/`);
      authorization.searchParams.set("client_id", options.bitrixClientId);
      authorization.searchParams.set("response_type", "code");
      authorization.searchParams.set("state", state);
      authorization.searchParams.set("redirect_uri", redirectUri);
      return {
        data: {
          authorizationUrl: authorization.toString(),
        },
      };
    },
  );

  app.get(
    "/api/v1/integrations/bitrix24/oauth/callback",
    async (request, reply) => {
      const query = z
        .object({
          code: z.string().min(1),
          state: z.string().min(1),
          domain: z.string().min(1),
          member_id: z.string().optional(),
        })
        .parse(request.query);
      let state: {
        purpose: string;
        connectionId: string;
        organizationId: string;
        nonce: string;
      };
      try {
        state = app.jwt.verify(query.state) as typeof state;
      } catch {
        return reply.code(400).send({
          error: {
            code: "oauth_state_invalid",
            message: "OAuth state is invalid",
          },
        });
      }
      const rows = await sql<
        Row[]
      >`SELECT * FROM integration_connections WHERE id=${state.connectionId}::uuid AND organization_id=${state.organizationId}::uuid AND status='oauth_pending' FOR UPDATE`;
      const row = rows[0];
      const callbackPortalUrl = normalizeBitrixPortalUrl(
        `https://${query.domain}`,
      );
      if (
        !row ||
        state.purpose !== "bitrix_oauth" ||
        callbackPortalUrl !== String(row.portal_url) ||
        !safeEqual(String(row.webhook_token_hash), hashSecret(state.nonce))
      )
        return reply.code(400).send({
          error: {
            code: "oauth_state_invalid",
            message: "OAuth state is invalid or already used",
          },
        });
      const tokenResponse = await fetch(
        "https://oauth.bitrix.info/oauth/token/",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: options.bitrixClientId!,
            client_secret: options.bitrixClientSecret!,
            code: query.code,
            redirect_uri: `${options.apiPublicUrl}/api/v1/integrations/bitrix24/oauth/callback`,
          }),
        },
      );
      const token = (await tokenResponse.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!tokenResponse.ok || typeof token.access_token !== "string")
        return reply.code(502).send({
          error: {
            code: "bitrix_oauth_exchange_failed",
            message: "Bitrix OAuth exchange failed",
          },
        });
      const accessTokenExpiresAt = new Date(
        Date.now() +
          (Number(token.expires_in ?? token.expires ?? 3600) || 3600) * 1000,
      ).toISOString();
      const client = new BitrixRestClient({
        portalUrl: callbackPortalUrl,
        accessToken: token.access_token,
        ...(typeof token.refresh_token === "string"
          ? { refreshToken: token.refresh_token }
          : {}),
        accessTokenExpiresAt,
        clientId: options.bitrixClientId!,
        clientSecret: options.bitrixClientSecret!,
      });
      await client.call("app.info");
      const profileResponse =
        await client.call<Record<string, unknown>>("profile");
      const profile = profileResponse.result ?? {};
      const authExternalUserId = String(profile.ID ?? "").trim();
      if (!authExternalUserId)
        return reply.code(502).send({
          error: {
            code: "bitrix_oauth_profile_missing",
            message: "Bitrix OAuth user profile could not be resolved",
          },
        });
      const authExternalUserName = [profile.NAME, profile.LAST_NAME]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .join(" ");
      const ownerConflict = (
        await crmRepository.query<
          Row[]
        >`SELECT id FROM integration_connections WHERE organization_id=${state.organizationId}::uuid AND provider='bitrix24' AND portal_url=${callbackPortalUrl} AND auth_external_user_id=${authExternalUserId} AND status='connected' AND id<>${state.connectionId}::uuid LIMIT 1`
      )[0];
      if (ownerConflict) {
        await crmRepository.query`UPDATE integration_connections SET status='disconnected',credentials_encrypted=NULL,webhook_token_hash=NULL,last_error_code='BITRIX_OAUTH_USER_ALREADY_CONNECTED',updated_at=now() WHERE id=${state.connectionId}::uuid`;
        return reply.code(409).send({
          error: {
            code: "bitrix_oauth_user_already_connected",
            message:
              "This Bitrix user already owns an active connection for the portal",
          },
        });
      }
      const eventHandler = `${options.apiPublicUrl}/webhooks/bitrix24/${String(row.public_id)}`;
      for (const event of BITRIX_CRM_EVENTS)
        await client.call("event.bind", { event, handler: eventHandler });
      const encrypted = encryptSecret(
        JSON.stringify({
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          accessTokenExpiresAt,
          ...(typeof token.client_endpoint === "string"
            ? { clientEndpoint: token.client_endpoint }
            : {}),
          ...(typeof token.server_endpoint === "string"
            ? { serverEndpoint: token.server_endpoint }
            : {}),
        }),
        options.appEncryptionKey!,
      );
      const memberId =
        query.member_id ??
        (typeof token.member_id === "string" ? token.member_id : null);
      await sql`UPDATE integration_connections SET portal_url=${callbackPortalUrl},member_id=${memberId},auth_external_user_id=${authExternalUserId},credentials_encrypted=${encrypted},webhook_token_hash=NULL,status='connected',settings=settings||${sql.json({ awaitingApplicationToken: true, oauthConnectedAt: new Date().toISOString(), subscribedEvents: BITRIX_CRM_EVENTS, authExternalUserName } as never)},last_error_code=NULL,updated_at=now() WHERE id=${state.connectionId}::uuid`;
      return reply.redirect(
        `${options.webUrl}/app/integrations/bitrix24?connected=1`,
      );
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/integrations/:id",
    { preHandler: options.authorize("integrations:manage") },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().min(1).max(80).optional(),
          status: z.enum(["connected", "disabled"]).optional(),
          settings: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(request.body);
      const rows = await sql<
        Row[]
      >`UPDATE integration_connections SET name=COALESCE(${body.name ?? null},name),status=COALESCE(${body.status ?? null},status),settings=COALESCE(${body.settings ? JSON.stringify(body.settings) : null}::jsonb,settings),updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid RETURNING *`;
      return rows[0]
        ? { data: safeConnection(rows[0]) }
        : reply.code(404).send({
            error: {
              code: "integration_not_found",
              message: "Integration not found",
            },
          });
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/integrations/:id",
    { preHandler: options.authorize("integrations:manage") },
    async (request, reply) => {
      const rows =
        await sql`UPDATE integration_connections SET status='disconnected',credentials_encrypted=NULL,webhook_token_hash=NULL,updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid RETURNING id`;
      return rows.length
        ? reply.code(204).send()
        : reply.code(404).send({
            error: {
              code: "integration_not_found",
              message: "Integration not found",
            },
          });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/test",
    { preHandler: options.authorize("integrations:manage") },
    async (request, reply) => {
      const row = await connection(
        crmRepository,
        request.claims!.organizationId,
        request.params.id,
      );
      if (!row)
        return reply.code(404).send({
          error: {
            code: "integration_not_found",
            message: "Integration not found",
          },
        });
      const health = await provider(row).health();
      await sql`UPDATE integration_connections SET last_health_at=now(),last_error_code=NULL,updated_at=now() WHERE id=${request.params.id}::uuid`;
      return { data: health };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/users",
    { preHandler: options.authorize("inbox:read") },
    async (request) => ({
      data: await crmRepository.listUserMappings(
        request.claims!.organizationId,
        request.params.id,
      ),
    }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/users/sync",
    { preHandler: options.authorize("integrations:manage") },
    async (request, reply) => {
      const row = await connection(
        crmRepository,
        request.claims!.organizationId,
        request.params.id,
      );
      if (!row)
        return reply.code(404).send({
          error: {
            code: "integration_not_found",
            message: "Integration not found",
          },
        });
      const crmProvider = provider(row);
      let cursor: string | undefined;
      let count = 0;
      do {
        const page = await crmProvider.listUsers(cursor);
        for (const user of page.data) {
          await sql`INSERT INTO crm_user_mappings(organization_id,connection_id,external_user_id,external_snapshot,active) VALUES(${request.claims!.organizationId}::uuid,${request.params.id}::uuid,${user.externalId},${sql.json(user as never)},${user.active}) ON CONFLICT(connection_id,external_user_id) DO UPDATE SET external_snapshot=EXCLUDED.external_snapshot,active=EXCLUDED.active,last_synced_at=now(),updated_at=now()`;
          count++;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return { data: { synced: count } };
    },
  );
  app.put<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/user-mappings",
    { preHandler: options.authorize("integrations:manage") },
    async (request, reply) => {
      const owned = await connection(
        crmRepository,
        request.claims!.organizationId,
        request.params.id,
      );
      if (!owned)
        return reply.code(404).send({
          error: {
            code: "integration_not_found",
            message: "Integration not found",
          },
        });
      const body = mappingSchema.parse(request.body);
      const updated = await crmRepository.replaceUserMappings(
        request.claims!.organizationId,
        request.params.id,
        body.mappings,
      );
      return { data: { updated } };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/bitrix24/:id/automation-webhook/rotate",
    { preHandler: options.authorize("integrations:manage") },
    async (request, reply) => {
      const row = await connection(
        crmRepository,
        request.claims!.organizationId,
        request.params.id,
      );
      if (!row || row.provider !== "bitrix24")
        return reply.code(404).send({
          error: {
            code: "integration_not_found",
            message: "Integration not found",
          },
        });
      const secret = randomBytes(32).toString("base64url");
      await crmRepository.query`UPDATE integration_connections SET automation_webhook_token_hash=${hashSecret(secret)},updated_at=now() WHERE id=${String(row.id)}::uuid`;
      return {
        data: {
          webhookUrl: `${options.apiPublicUrl}/webhooks/bitrix24/${String(row.public_id)}/automation/${secret}`,
        },
      };
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/integrations/bitrix24/:id/automation-webhook",
    { preHandler: options.authorize("integrations:manage") },
    async (request, reply) => {
      const row = await connection(
        crmRepository,
        request.claims!.organizationId,
        request.params.id,
      );
      if (!row || row.provider !== "bitrix24")
        return reply.code(404).send({
          error: {
            code: "integration_not_found",
            message: "Integration not found",
          },
        });
      const body = z
        .object({ channelId: z.string().uuid().nullable() })
        .parse(request.body);
      if (body.channelId) {
        const channelRows = await crmRepository.query<
          Row[]
        >`SELECT id FROM channels WHERE id=${body.channelId}::uuid AND organization_id=${request.claims!.organizationId}::uuid`;
        if (!channelRows[0])
          return reply.code(422).send({
            error: { code: "channel_not_found", message: "Channel not found" },
          });
      }
      await crmRepository.query`UPDATE integration_connections SET automation_default_channel_id=${body.channelId}::uuid,updated_at=now() WHERE id=${String(row.id)}::uuid`;
      return { data: { automationDefaultChannelId: body.channelId } };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/pipelines",
    { preHandler: options.authorize("inbox:read") },
    async (request) => ({
      data: await crmRepository.listPipelines(
        request.claims!.organizationId,
        request.params.id,
      ),
    }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/pipelines/sync",
    { preHandler: options.authorize("integrations:manage") },
    async (request, reply) => {
      const row = await connection(
        crmRepository,
        request.claims!.organizationId,
        request.params.id,
      );
      if (!row)
        return reply.code(404).send({
          error: {
            code: "integration_not_found",
            message: "Integration not found",
          },
        });
      const pipelines = await provider(row).listPipelines();
      await sql.begin(async (tx) => {
        await tx`DELETE FROM crm_pipeline_cache WHERE organization_id=${request.claims!.organizationId}::uuid AND connection_id=${request.params.id}::uuid`;
        for (const pipeline of pipelines)
          for (const stage of pipeline.stages)
            await tx`INSERT INTO crm_pipeline_cache(organization_id,connection_id,entity_type,pipeline_external_id,pipeline_name,stage_external_id,stage_name,stage_order,fetched_at,stale_at) VALUES(${request.claims!.organizationId}::uuid,${request.params.id}::uuid,${pipeline.entityType},${pipeline.externalId},${pipeline.name},${stage.externalId},${stage.name},${stage.order},now(),now()+interval '1 hour')`;
      });
      return {
        data: {
          pipelines: pipelines.length,
          stages: pipelines.reduce((sum, item) => sum + item.stages.length, 0),
        },
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/sync",
    { preHandler: options.authorize("integrations:manage") },
    async (request, reply) => {
      const row = await connection(
        crmRepository,
        request.claims!.organizationId,
        request.params.id,
      );
      if (!row)
        return reply.code(404).send({
          error: {
            code: "integration_not_found",
            message: "Integration not found",
          },
        });
      const key = `manual-sync:${Date.now()}`;
      const jobs = await sql<
        Row[]
      >`INSERT INTO crm_sync_jobs(organization_id,connection_id,job_type,aggregate_type,aggregate_id,idempotency_key,payload) VALUES(${request.claims!.organizationId}::uuid,${request.params.id}::uuid,'full.sync','connection',${request.params.id},${key},'{}') RETURNING id,status`;
      return reply.code(202).send({ data: jobs[0] });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/jobs",
    { preHandler: options.authorize("inbox:read") },
    async (request) => ({
      data: await crmRepository.listSyncJobs(
        request.claims!.organizationId,
        request.params.id,
      ),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/integrations/:id/logs",
    { preHandler: options.authorize("inbox:read") },
    async (request) => ({
      data: await crmRepository.listSyncLogs(
        request.claims!.organizationId,
        request.params.id,
      ),
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/crm-context",
    { preHandler: options.authorize("inbox:read") },
    async (request, reply) => {
      const rows = await sql<
        Row[]
      >`SELECT cache.*,link.entity_type,link.external_id,ic.status connection_status FROM conversations c LEFT JOIN LATERAL (SELECT l.id,l.connection_id,l.entity_type,l.external_id FROM crm_entity_links l WHERE l.organization_id=c.organization_id AND l.conversation_id=c.id AND l.unavailable_at IS NULL ORDER BY l.created_at LIMIT 1) link ON true LEFT JOIN conversation_crm_context_cache cache ON cache.conversation_id=c.id AND cache.organization_id=c.organization_id AND cache.link_id=link.id LEFT JOIN integration_connections ic ON ic.id=link.connection_id AND ic.organization_id=c.organization_id WHERE c.id=${request.params.id}::uuid AND c.organization_id=${request.claims!.organizationId}::uuid`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      return {
        data:
          rows[0].context || rows[0].external_id
            ? {
                context: rows[0].context ?? null,
                fetchedAt: rows[0].fetched_at ?? null,
                staleAt: rows[0].stale_at ?? null,
                stale:
                  !rows[0].context ||
                  new Date(String(rows[0].stale_at)) < new Date(),
                lastErrorCode: rows[0].last_error_code ?? null,
                link: rows[0].external_id
                  ? {
                      entityType: rows[0].entity_type,
                      externalId: rows[0].external_id,
                    }
                  : null,
              }
            : null,
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/crm-match",
    { preHandler: options.authorize("crm:write") },
    async (request, reply) => {
      const rows = await sql<
        Row[]
      >`SELECT c.id,c.contact_id,ct.normalized_phone,ct.email,ic.* FROM conversations c JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id JOIN integration_connections ic ON ic.organization_id=c.organization_id AND ic.status='connected' WHERE c.id=${request.params.id}::uuid AND c.organization_id=${request.claims!.organizationId}::uuid ORDER BY ic.created_at LIMIT 1`;
      const row = rows[0];
      if (!row)
        return reply.code(404).send({
          error: {
            code: "conversation_or_integration_not_found",
            message: "Conversation or integration not found",
          },
        });
      const matches = await provider(row).findEntities({
        phone: String(row.normalized_phone),
        ...(row.email ? { email: String(row.email) } : {}),
      });
      const selected = pickUnambiguousMatch(matches);
      if (selected)
        await crmRepository.query`INSERT INTO crm_entity_links(organization_id,connection_id,conversation_id,contact_id,entity_type,external_id,match_source,match_confidence,created_by) VALUES(${request.claims!.organizationId}::uuid,${String(row.id)}::uuid,${request.params.id}::uuid,${String(row.contact_id)}::uuid,${selected.entityType},${selected.externalId},${selected.source},${selected.confidence},${request.claims!.sub}::uuid) ON CONFLICT(connection_id,conversation_id,entity_type) DO NOTHING`;
      return { data: { matches, selected } };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/crm-entities",
    { preHandler: options.authorize("crm:write") },
    async (request, reply) => {
      const body = entitySchema.parse(request.body);
      const rows = await crmRepository.query<
        Row[]
      >`SELECT c.contact_id,ct.display_name,ct.normalized_phone,ct.email,ic.* FROM conversations c JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id JOIN integration_connections ic ON ic.organization_id=c.organization_id AND ic.status='connected' WHERE c.id=${request.params.id}::uuid AND c.organization_id=${request.claims!.organizationId}::uuid ORDER BY ic.created_at LIMIT 1`;
      const row = rows[0];
      if (!row)
        return reply.code(404).send({
          error: {
            code: "conversation_or_integration_not_found",
            message: "Conversation or integration not found",
          },
        });
      const entity = await provider(row).createEntity({
        entityType: body.entityType,
        idempotencyKey: `${request.params.id}:${body.entityType}`,
        fields: {
          TITLE: String(row.display_name ?? "WhatsApp"),
          NAME: String(row.display_name ?? "WhatsApp"),
          PHONE: [
            { VALUE: String(row.normalized_phone), VALUE_TYPE: "MOBILE" },
          ],
          ...(row.email
            ? { EMAIL: [{ VALUE: String(row.email), VALUE_TYPE: "WORK" }] }
            : {}),
          ...body.fields,
        },
        ...(body.pipelineId ? { pipelineId: body.pipelineId } : {}),
        ...(body.stageId ? { stageId: body.stageId } : {}),
      });
      const links = await crmRepository.query<
        Row[]
      >`INSERT INTO crm_entity_links(organization_id,connection_id,conversation_id,contact_id,entity_type,external_id,match_source,match_confidence,created_by) VALUES(${request.claims!.organizationId}::uuid,${String(row.id)}::uuid,${request.params.id}::uuid,${String(row.contact_id)}::uuid,${entity.entityType},${entity.externalId},'created',1,${request.claims!.sub}::uuid) ON CONFLICT(connection_id,conversation_id,entity_type) DO UPDATE SET external_id=EXCLUDED.external_id,match_source='created',match_confidence=1,updated_at=now() RETURNING *`;
      return reply.code(201).send({ data: links[0] });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/crm-context/refresh",
    { preHandler: options.authorize("crm:write") },
    async (request, reply) => {
      const rows = await crmRepository.query<
        Row[]
      >`SELECT l.id link_id,l.connection_id,l.entity_type,l.external_id,ic.* FROM crm_entity_links l JOIN integration_connections ic ON ic.id=l.connection_id AND ic.organization_id=l.organization_id WHERE l.organization_id=${request.claims!.organizationId}::uuid AND l.conversation_id=${request.params.id}::uuid AND l.unavailable_at IS NULL ORDER BY l.created_at LIMIT 1`;
      const row = rows[0];
      if (!row)
        return reply.code(404).send({
          error: {
            code: "crm_link_not_found",
            message: "CRM link not found",
          },
        });
      const context = await provider(row).getContext({
        entityType: String(row.entity_type) as
          "contact" | "lead" | "deal" | "company",
        externalId: String(row.external_id),
      });
      await crmRepository.query`INSERT INTO conversation_crm_context_cache(organization_id,conversation_id,connection_id,link_id,context,fetched_at,stale_at,last_error_code,last_error_at) VALUES(${request.claims!.organizationId}::uuid,${request.params.id}::uuid,${String(row.connection_id)}::uuid,${String(row.link_id)}::uuid,${sql.json(context as never)},now(),now()+interval '15 minutes',NULL,NULL) ON CONFLICT(organization_id,conversation_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,link_id=EXCLUDED.link_id,context=EXCLUDED.context,fetched_at=now(),stale_at=EXCLUDED.stale_at,last_error_code=NULL,last_error_at=NULL`;
      return { data: { context, fetchedAt: new Date().toISOString() } };
    },
  );

  app.post<{ Params: { connectionPublicId: string } }>(
    "/webhooks/bitrix24/:connectionPublicId",
    async (request, reply) => {
      const rows = await crmRepository.query<
        Row[]
      >`SELECT * FROM integration_connections WHERE public_id=${request.params.connectionPublicId}::uuid AND provider='bitrix24' AND status='connected'`;
      const row = rows[0];
      if (!row)
        return reply.code(404).send({
          error: {
            code: "integration_not_found",
            message: "Integration not found",
          },
        });
      const body = (request.body ?? {}) as Record<string, unknown>;
      const auth = bitrixAuthPayload(body);
      const eventType = String(body.event ?? "unknown");
      const token = String(
        request.headers["x-bitrix-token"] ??
          body.application_token ??
          body["auth[application_token]"] ??
          auth.applicationToken ??
          "",
      );
      let bootstrappedApplicationToken = false;
      if (!row.webhook_token_hash) {
        let domainMatches = false;
        try {
          domainMatches =
            Boolean(auth.domain) &&
            normalizeBitrixPortalUrl(`https://${auth.domain}`) ===
              String(row.portal_url);
        } catch {
          domainMatches = false;
        }
        const canBootstrap =
          eventType.toUpperCase() === "ONAPPINSTALL" &&
          Boolean(token) &&
          Boolean(auth.memberId) &&
          String(row.member_id ?? "") === auth.memberId &&
          domainMatches;
        if (canBootstrap) {
          const adopted =
            await crmRepository.query`UPDATE integration_connections SET webhook_token_hash=${hashSecret(token)},settings=settings||${sql.json({ awaitingApplicationToken: false, applicationTokenVerifiedAt: new Date().toISOString() } as never)},updated_at=now() WHERE id=${String(row.id)}::uuid AND webhook_token_hash IS NULL RETURNING id`;
          if (adopted.length) bootstrappedApplicationToken = true;
          else {
            // A concurrent request adopted a token first; validate this
            // request against the freshly stored hash instead of skipping
            // the check entirely.
            const fresh =
              await crmRepository.query`SELECT webhook_token_hash FROM integration_connections WHERE id=${String(row.id)}::uuid`;
            row.webhook_token_hash = fresh[0]?.webhook_token_hash ?? null;
          }
        }
      }
      if (
        !bootstrappedApplicationToken &&
        (!row.webhook_token_hash ||
          !safeEqual(String(row.webhook_token_hash), hashSecret(token)))
      )
        return reply.code(401).send({
          error: {
            code: "invalid_webhook_token",
            message: "Invalid webhook token",
          },
        });
      const payload = sanitizedBitrixEventPayload(body);
      const key = deterministicEventKey({
        connection: String(row.id),
        event: eventType,
        ts: body.ts ?? null,
        data: payload.data ?? payload,
      });
      const inserted =
        await crmRepository.query`INSERT INTO crm_webhook_events(organization_id,connection_id,provider_event_key,event_type,auth,payload) VALUES(${String(row.organization_id)}::uuid,${String(row.id)}::uuid,${key},${eventType},${sql.json({ member_id: auth.memberId || null } as never)},${sql.json(payload as never)}) ON CONFLICT(connection_id,provider_event_key) DO NOTHING RETURNING id`;
      return { accepted: true, duplicate: inserted.length === 0 };
    },
  );

  app.post<{ Params: { connectionPublicId: string; token: string } }>(
    "/webhooks/bitrix24/:connectionPublicId/automation/:token",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const rows = await crmRepository.query<
        Row[]
      >`SELECT * FROM integration_connections WHERE public_id=${request.params.connectionPublicId}::uuid AND provider='bitrix24' AND status='connected'`;
      const row = rows[0];
      if (!row || !row.automation_webhook_token_hash)
        return reply.code(404).send({
          error: {
            code: "integration_not_found",
            message: "Integration not found",
          },
        });
      if (
        !safeEqual(
          String(row.automation_webhook_token_hash),
          hashSecret(request.params.token),
        )
      )
        return reply.code(401).send({
          error: {
            code: "invalid_webhook_token",
            message: "Invalid webhook token",
          },
        });
      const parsed = automationWebhookSchema.safeParse(request.body ?? {});
      if (!parsed.success)
        return reply.code(422).send({
          error: {
            code: "invalid_payload",
            message: "Invalid automation webhook payload",
            details: parsed.error.flatten(),
          },
        });
      const data = parsed.data;
      if (data.channel_id) {
        const channelRows = await crmRepository.query<
          Row[]
        >`SELECT id FROM channels WHERE id=${data.channel_id}::uuid AND organization_id=${String(row.organization_id)}::uuid`;
        if (!channelRows[0])
          return reply.code(422).send({
            error: { code: "channel_not_found", message: "Channel not found" },
          });
      }
      const idempotencyKey =
        data.idempotency_key ??
        deterministicEventKey({
          connection: String(row.id),
          event: "automation.send_whatsapp",
          minuteBucket: Math.floor(Date.now() / 60000),
          entityType: data.entity_type,
          entityId: data.entity_id,
          templateName: data.template_name,
          phone: data.phone,
        });
      const inserted = await crmRepository.query<
        Row[]
      >`INSERT INTO crm_sync_jobs(organization_id,connection_id,job_type,aggregate_type,aggregate_id,idempotency_key,payload) VALUES(${String(row.organization_id)}::uuid,${String(row.id)}::uuid,'automation.send_whatsapp','crm_entity',${data.entity_id},${idempotencyKey},${sql.json(
        {
          entityType: data.entity_type,
          entityId: data.entity_id,
          phone: data.phone,
          templateName: data.template_name,
          channelId: data.channel_id ?? null,
          contactName: data.contact_name ?? null,
          variables: data.variables ?? {},
        } as never,
      )}) ON CONFLICT(connection_id,idempotency_key) DO NOTHING RETURNING id`;
      return reply
        .code(202)
        .send({ accepted: true, duplicate: inserted.length === 0 });
    },
  );
}

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import type { Permission } from "@brixchat/auth";
import { FilesRepository } from "@brixchat/database";
import {
  GoogleDriveAdapter,
  MediaScanError,
  StorageProviderError,
  createGoogleOAuthState,
  decryptSecret,
  encryptSecret,
  exchangeGoogleAuthorizationCode,
  googleAuthorizationUrl,
  hasGoogleDriveWriteScope,
  hashGoogleOAuthState,
  mimeAllowed,
  refreshGoogleAccessToken,
  sanitizeFilename,
  scanStoredObject,
  storageKey,
  type MalwareScanner,
  type ObjectStorageProvider,
} from "@brixchat/integrations";

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;
type Authorize = (
  permission: Permission,
) => (request: FastifyRequest) => Promise<void>;
const uuid = z.string().uuid();
const categories = [
  "incoming_media",
  "intraoral_photos",
  "xray_cbct",
  "treatment_plans",
  "offers",
  "consent_reports",
  "invoices_payments",
  "other",
] as const;
const connectionUpdate = z
  .object({
    displayName: z.string().trim().min(2).max(120).optional(),
    rootFolderId: z.string().trim().max(200).nullable().optional(),
    sharedDriveId: z.string().trim().max(200).nullable().optional(),
    configuration: z.record(z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
const fileUpdate = z
  .object({
    name: z.string().trim().min(1).max(180).optional(),
    category: z.enum(categories).optional(),
    folderId: z.string().max(300).optional(),
    note: z.string().trim().max(2000).optional(),
    treatmentRecordId: uuid.nullable().optional(),
    favorite: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

function ip(request: FastifyRequest) {
  return request.clientIp || null;
}
function errorResponse(error: unknown) {
  if (error instanceof StorageProviderError)
    return {
      status: error.retryable
        ? 503
        : error.code.includes("NOT_FOUND")
          ? 404
          : 409,
      code: error.code,
      message: error.message,
    };
  return {
    status: 500,
    code: "FILE_PROCESSING_FAILED",
    message: "Dosya işlemi tamamlanamadı.",
  };
}

export function registerStorageRoutes(
  app: FastifyInstance,
  sql: Sql,
  options: {
    authorize: Authorize;
    encryptionKey?: string;
    webUrl: string;
    googleDriveEnabled: boolean;
    googleClientId?: string;
    googleClientSecret?: string;
    googleRedirectUri?: string;
    storage: ObjectStorageProvider;
    scanner: MalwareScanner;
    publish: (organizationId: string, event: Row) => Promise<void>;
    uploadLimitBytes?: number;
    enforceStorage?: (
      organizationId: string,
      bytes: number,
    ) => Promise<{ allowed: boolean; code: string | null }>;
    /**
     * Serializes concurrent enforceStorage checks + file_assets writes for
     * the same organization, so two uploads racing the same plan limit can't
     * both read the pre-upload usage total and both pass. Must be released
     * (in a finally block) after the check-then-write critical section ends,
     * on every exit path including rejects and thrown errors.
     */
    acquireStorageLock?: (
      organizationId: string,
    ) => Promise<{ release: () => Promise<void> }>;
  },
) {
  const filesRepository = new FilesRepository(sql);
  const enabled = () => {
    if (!options.googleDriveEnabled)
      throw Object.assign(new Error("DRIVE_CONNECTION_DISABLED"), {
        statusCode: 404,
      });
  };
  const oauthConfig = () => {
    enabled();
    if (
      !options.googleClientId ||
      !options.googleClientSecret ||
      !options.googleRedirectUri ||
      !options.encryptionKey
    )
      throw Object.assign(new Error("GOOGLE_DRIVE_CONFIGURATION_MISSING"), {
        statusCode: 503,
      });
    return {
      clientId: options.googleClientId,
      clientSecret: options.googleClientSecret,
      redirectUri: options.googleRedirectUri,
      encryptionKey: options.encryptionKey,
    };
  };
  const audit = async (
    request: FastifyRequest,
    action: string,
    assetId?: string | null,
    metadata: Row = {},
  ) => {
    await filesRepository.audit({
      organizationId: request.claims!.organizationId,
      userId: request.claims!.sub,
      action,
      ...(assetId === undefined ? {} : { assetId }),
      metadata,
      ip: ip(request),
      userAgent: String(request.headers["user-agent"] ?? ""),
    });
  };
  const emitFileEvent = async (
    request: FastifyRequest,
    eventType: string,
    asset: Row,
    payload: Row = {},
  ) => {
    await filesRepository.emitEvent({
      organizationId: request.claims!.organizationId,
      userId: request.claims!.sub,
      eventType,
      asset,
      payload,
    });
  };
  const connection = async (organizationId: string, id: string) => {
    const row = await filesRepository.connection(organizationId, id);
    if (!row)
      throw Object.assign(new Error("storage_connection_not_found"), {
        statusCode: 404,
      });
    return row;
  };
  const adapterFor = async (organizationId: string, connectionId: string) => {
    const config = oauthConfig();
    const row = await connection(organizationId, connectionId);
    if (row.status === "disconnected" || !row.encrypted_credentials)
      throw new StorageProviderError(
        "DRIVE_CONNECTION_DISABLED",
        "Google Drive bağlantısı etkin değil.",
        false,
      );
    const credentials = JSON.parse(
      decryptSecret(String(row.encrypted_credentials), config.encryptionKey),
    ) as { accessToken: string; refreshToken?: string; expiresAt?: string };
    const refreshAccessToken = async () => {
      try {
        if (!credentials.refreshToken)
          throw new StorageProviderError(
            "GOOGLE_TOKEN_REVOKED",
            "Google Drive yeniden bağlanmalıdır.",
            false,
          );
        const refreshed = await refreshGoogleAccessToken({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: credentials.refreshToken,
        });
        credentials.accessToken = refreshed.accessToken;
        credentials.expiresAt = new Date(
          Date.now() + refreshed.expiresIn * 1000,
        ).toISOString();
        await filesRepository.saveRefreshedCredentials({
          organizationId,
          connectionId,
          encrypted: encryptSecret(
            JSON.stringify(credentials),
            config.encryptionKey,
          ),
          expiresAt: credentials.expiresAt,
        });
        return credentials.accessToken;
      } catch (error) {
        const code =
          error instanceof StorageProviderError
            ? error.code
            : "GOOGLE_TOKEN_REFRESH_FAILED";
        await filesRepository.markConnectionError(
          organizationId,
          connectionId,
          code,
        );
        throw error;
      }
    };
    const accessToken = async () => {
      if (
        !credentials.expiresAt ||
        new Date(credentials.expiresAt).getTime() > Date.now() + 60_000
      )
        return credentials.accessToken;
      return refreshAccessToken();
    };
    return {
      row,
      adapter: new GoogleDriveAdapter({
        accessToken,
        refreshAccessToken,
        ...(row.shared_drive_id
          ? { sharedDriveId: String(row.shared_drive_id) }
          : {}),
      }),
    };
  };

  async function issueAuthUrl(request: FastifyRequest, connectionId?: string) {
    const config = oauthConfig();
    const state = createGoogleOAuthState();
    if (connectionId)
      await connection(request.claims!.organizationId, connectionId);
    await filesRepository.createOAuthState({
      organizationId: request.claims!.organizationId,
      userId: request.claims!.sub,
      stateHash: state.hash,
      ...(connectionId ? { connectionId } : {}),
    });
    return googleAuthorizationUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state: state.value,
      promptConsent: true,
    });
  }

  app.get(
    "/api/v1/integrations/google-drive/auth-url",
    { preHandler: options.authorize("files:manage_connections") },
    async (request) => ({ data: { url: await issueAuthUrl(request) } }),
  );
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/v1/integrations/google-drive/callback",
    async (request, reply) => {
      const config = oauthConfig();
      if (request.query.error || !request.query.code || !request.query.state)
        return reply.redirect(`${options.webUrl}/app/files?google=denied`);
      const stateHash = hashGoogleOAuthState(request.query.state);
      const state = await filesRepository.consumeOAuthState(stateHash);
      if (!state)
        return reply.code(400).send({
          error: {
            code: "OAUTH_STATE_INVALID",
            message: "OAuth oturumu geçersiz veya süresi dolmuş.",
          },
        });
      const tokens = await exchangeGoogleAuthorizationCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.redirectUri,
        code: request.query.code,
      });
      const userInfoResponse = await fetch(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        { headers: { authorization: `Bearer ${tokens.access_token}` } },
      );
      const userInfo = userInfoResponse.ok
        ? ((await userInfoResponse.json()) as { email?: string })
        : {};
      const previous = state.connection_id
        ? await connection(
            String(state.organization_id),
            String(state.connection_id),
          )
        : null;
      const previousCredentials = previous?.encrypted_credentials
        ? (JSON.parse(
            decryptSecret(
              String(previous.encrypted_credentials),
              config.encryptionKey,
            ),
          ) as { refreshToken?: string })
        : {};
      const expiresAt = new Date(
        Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
      ).toISOString();
      const encrypted = encryptSecret(
        JSON.stringify({
          accessToken: tokens.access_token,
          refreshToken:
            tokens.refresh_token ?? previousCredentials.refreshToken,
          expiresAt,
        }),
        config.encryptionKey,
      );
      const accountEmail =
        userInfo.email ??
        (previous?.account_email ? String(previous.account_email) : null);
      const scopes = String(tokens.scope ?? "")
        .split(" ")
        .filter(Boolean);
      if (!hasGoogleDriveWriteScope(scopes)) {
        if (state.connection_id)
          await filesRepository.markConnectionError(
            String(state.organization_id),
            String(state.connection_id),
            "DRIVE_SCOPE_MISSING",
            true,
          );
        return reply.redirect(
          `${options.webUrl}/app/files?google=scope_missing`,
        );
      }
      await filesRepository.saveOAuthConnection({
        state,
        accountEmail,
        encrypted,
        scopes,
        expiresAt,
        displayName: userInfo.email
          ? `Google Drive - ${userInfo.email}`
          : "Google Drive",
      });
      return reply.redirect(`${options.webUrl}/app/files?google=connected`);
    },
  );

  app.get(
    "/api/v1/integrations/google-drive/connections",
    { preHandler: options.authorize("files:view") },
    async (request) => ({
      data: await filesRepository.listConnections(
        request.claims!.organizationId,
      ),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/integrations/google-drive/connections/:id/health",
    { preHandler: options.authorize("files:manage_connections") },
    async (request, reply) => {
      try {
        const { row, adapter } = await adapterFor(
          request.claims!.organizationId,
          request.params.id,
        );
        if (row.root_folder_id)
          await adapter.getMetadata(String(row.root_folder_id));
        else await adapter.listFiles({ pageSize: 1 });
        await filesRepository.markConnectionHealthy(
          request.claims!.organizationId,
          request.params.id,
        );
        return { data: { healthy: true, checkedAt: new Date().toISOString() } };
      } catch (error) {
        const mapped = errorResponse(error);
        await filesRepository.markConnectionError(
          request.claims!.organizationId,
          request.params.id,
          mapped.code,
          true,
        );
        return reply
          .code(mapped.status)
          .send({ error: { code: mapped.code, message: mapped.message } });
      }
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/integrations/google-drive/connections/:id",
    { preHandler: options.authorize("files:manage_connections") },
    async (request) => {
      const body = connectionUpdate.parse(request.body);
      const current = await connection(
        request.claims!.organizationId,
        request.params.id,
      );
      const displayName = body.displayName ?? String(current.display_name);
      const rootFolderId =
        body.rootFolderId === undefined
          ? current.root_folder_id
            ? String(current.root_folder_id)
            : null
          : body.rootFolderId;
      const sharedDriveId =
        body.sharedDriveId === undefined
          ? current.shared_drive_id
            ? String(current.shared_drive_id)
            : null
          : body.sharedDriveId;
      const configuration =
        body.configuration ??
        ((current.configuration ?? {}) as Record<string, unknown>);
      return {
        data: await filesRepository.updateConnection({
          organizationId: request.claims!.organizationId,
          id: request.params.id,
          displayName,
          rootFolderId,
          sharedDriveId,
          configuration,
        }),
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/integrations/google-drive/connections/:id/reconnect",
    { preHandler: options.authorize("files:manage_connections") },
    async (request) => ({
      data: { url: await issueAuthUrl(request, request.params.id) },
    }),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/integrations/google-drive/connections/:id",
    { preHandler: options.authorize("files:manage_connections") },
    async (request) => {
      const current = await connection(
        request.claims!.organizationId,
        request.params.id,
      );
      let providerRevoked = false;
      if (current.encrypted_credentials && options.encryptionKey) {
        try {
          const credentials = JSON.parse(
            decryptSecret(
              String(current.encrypted_credentials),
              options.encryptionKey,
            ),
          ) as { accessToken?: string; refreshToken?: string };
          const token = credentials.refreshToken ?? credentials.accessToken;
          if (token) {
            const response = await fetch(
              "https://oauth2.googleapis.com/revoke",
              {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({ token }),
              },
            );
            providerRevoked = response.ok;
          }
        } catch {
          providerRevoked = false;
        }
      }
      await filesRepository.disconnect(
        request.claims!.organizationId,
        request.params.id,
      );
      await audit(request, "DISCONNECT_PROVIDER", null, {
        connectionId: request.params.id,
        provider: "google_drive",
        providerRevoked,
      });
      return { data: { disconnected: true } };
    },
  );

  app.post(
    "/api/v1/files/folders",
    { preHandler: options.authorize("files:move") },
    async (request, reply) => {
      const body = z
        .object({
          connectionId: uuid,
          name: z.string().trim().min(1).max(120),
          parentId: z.string().trim().max(300).optional(),
        })
        .parse(request.body);
      try {
        const folder = await (
          await adapterFor(request.claims!.organizationId, body.connectionId)
        ).adapter.createFolder({
          name: sanitizeFilename(body.name),
          ...(body.parentId ? { parentId: body.parentId } : {}),
        });
        await audit(request, "CREATE_FOLDER", null, {
          connectionId: body.connectionId,
          folderId: folder.id,
        });
        return reply.code(201).send({ data: folder });
      } catch (error) {
        const mapped = errorResponse(error);
        return reply
          .code(mapped.status)
          .send({ error: { code: mapped.code, message: mapped.message } });
      }
    },
  );

  app.get(
    "/api/v1/files",
    { preHandler: options.authorize("files:view") },
    async (request) => {
      const query = z
        .object({
          q: z.string().trim().max(200).optional(),
          category: z.enum(categories).optional(),
          status: z.string().max(40).optional(),
          contactId: uuid.optional(),
          conversationId: uuid.optional(),
          channelId: uuid.optional(),
          connectionId: uuid.optional(),
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(30),
          trash: z.coerce.boolean().default(false),
        })
        .parse(request.query);
      const org = request.claims!.organizationId;
      const offset = (query.page - 1) * query.limit;
      const rows = await filesRepository.listFiles({
        organizationId: org,
        ...(query.q ? { q: query.q } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.contactId ? { contactId: query.contactId } : {}),
        ...(query.conversationId
          ? { conversationId: query.conversationId }
          : {}),
        ...(query.channelId ? { channelId: query.channelId } : {}),
        ...(query.connectionId ? { connectionId: query.connectionId } : {}),
        trash: query.trash,
        limit: query.limit,
        offset,
      });
      return {
        data: rows,
        page: {
          page: query.page,
          limit: query.limit,
          total: Number(rows[0]?.total_count ?? 0),
        },
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/files/:id",
    { preHandler: options.authorize("files:view") },
    async (request, reply) => {
      const row = await filesRepository.file(
        request.claims!.organizationId,
        request.params.id,
      );
      return row
        ? { data: row }
        : reply.code(404).send({
            error: {
              code: "DRIVE_FILE_NOT_FOUND",
              message: "Dosya bulunamadı.",
            },
          });
    },
  );

  app.post(
    "/api/v1/files/uploads",
    {
      preHandler: options.authorize("files:upload"),
      bodyLimit: options.uploadLimitBytes ?? 25 * 1024 * 1024,
    },
    async (request, reply) => {
      const query = z
        .object({
          connectionId: uuid.optional(),
          contactId: uuid.optional(),
          conversationId: uuid.optional(),
          channelId: uuid.optional(),
          category: z.enum(categories).default("other"),
          saveOnly: z.coerce.boolean().default(true),
        })
        .parse(request.query);
      const filename = sanitizeFilename(
        String(request.headers["x-filename"] ?? "document"),
      );
      const mimeType = String(
        request.headers["x-mime-type"] ?? "application/octet-stream",
      );
      if (!mimeAllowed(mimeType))
        return reply.code(415).send({
          error: {
            code: "UNSUPPORTED_MIME_TYPE",
            message: "Bu dosya türüne izin verilmiyor.",
          },
        });
      if (query.connectionId)
        await connection(request.claims!.organizationId, query.connectionId);
      for (const [table, id] of [
        ["contacts", query.contactId],
        ["conversations", query.conversationId],
        ["channels", query.channelId],
      ] as const) {
        if (
          id &&
          !(await filesRepository.relatedExists(
            request.claims!.organizationId,
            table,
            id,
          ))
        )
          return reply.code(404).send({
            error: {
              code: "TENANT_ACCESS_DENIED",
              message: "İlişkili kayıt bulunamadı.",
            },
          });
      }
      const key = storageKey(request.claims!.organizationId, filename);
      const stored = await options.storage.putObject({
        key,
        body: request.body as Readable,
        contentType: mimeType,
      });
      const storageLock = await options.acquireStorageLock?.(
        request.claims!.organizationId,
      );
      let asset!: Awaited<
        ReturnType<typeof filesRepository.createUploadedFile>
      >;
      const status = query.connectionId ? "PENDING" : "READY";
      try {
        const storageBilling = await options.enforceStorage?.(
          request.claims!.organizationId,
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
            scanner: options.scanner,
            key: stored.key,
          });
        } catch (error) {
          if (error instanceof MediaScanError)
            return reply.code(error.retryable ? 503 : 422).send({
              error: {
                code:
                  error.scanStatus === "infected"
                    ? "MALWARE_DETECTED"
                    : "FILE_PROCESSING_FAILED",
                message: "Dosya güvenlik kontrolünden geçemedi.",
              },
            });
          throw error;
        }
        const extension = filename.includes(".")
          ? filename.split(".").pop()!.toLowerCase()
          : null;
        asset = await filesRepository.createUploadedFile({
          organizationId: request.claims!.organizationId,
          userId: request.claims!.sub,
          ...(query.connectionId ? { connectionId: query.connectionId } : {}),
          storageKey: stored.key,
          ...(query.contactId ? { contactId: query.contactId } : {}),
          ...(query.conversationId
            ? { conversationId: query.conversationId }
            : {}),
          ...(query.channelId ? { channelId: query.channelId } : {}),
          filename,
          mimeType,
          extension,
          size: stored.size,
          sha256: stored.sha256,
          category: query.category,
          status,
        });
      } finally {
        await storageLock?.release();
      }
      await audit(request, "UPLOAD", String(asset.id), {
        source: "user_upload",
        connectionId: query.connectionId ?? null,
      });
      await emitFileEvent(request, "file.document_created", asset, {
        category: query.category,
        status,
        source: "user_upload",
      });
      await options.publish(request.claims!.organizationId, {
        eventType: "file.created",
        organizationId: request.claims!.organizationId,
        entityType: "file",
        entityId: asset.id,
        occurredAt: new Date().toISOString(),
        payloadVersion: 1,
        payload: { status },
      });
      return reply.code(201).send({ data: asset });
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/files/:id",
    { preHandler: options.authorize("files:view") },
    async (request, reply) => {
      const body = fileUpdate.parse(request.body);
      await options.authorize(body.folderId ? "files:move" : "files:rename")(
        request,
      );
      const row = await filesRepository.file(
        request.claims!.organizationId,
        request.params.id,
        "active",
      );
      if (!row)
        return reply.code(404).send({
          error: {
            code: "DRIVE_FILE_NOT_FOUND",
            message: "Dosya bulunamadı.",
          },
        });
      const name = body.name ? sanitizeFilename(body.name) : row.sanitized_name;
      const metadata = {
        ...((row.metadata ?? {}) as Row),
        ...(body.note ? { internalNote: body.note } : {}),
        ...(body.treatmentRecordId === undefined
          ? {}
          : { treatmentRecordId: body.treatmentRecordId }),
        ...(body.favorite === undefined ? {} : { favorite: body.favorite }),
      };
      const category = body.category ?? String(row.category);
      const providerFolderId =
        body.folderId ??
        (row.provider_folder_id ? String(row.provider_folder_id) : null);
      const jobType = body.folderId
        ? "storage.move"
        : body.name
          ? "storage.rename"
          : body.category
            ? "storage.classify"
            : "storage.metadata";
      const updated = await filesRepository.updateFile({
        organizationId: request.claims!.organizationId,
        id: request.params.id,
        name: String(name),
        category,
        providerFolderId,
        metadata,
        jobType,
        jobPayload: { name, folderId: body.folderId },
      });
      await audit(
        request,
        body.folderId ? "MOVE" : body.name ? "RENAME" : "UPDATE",
        request.params.id,
        body as Row,
      );
      await emitFileEvent(request, "file.changed", updated!, {
        changes: Object.keys(body).sort(),
      });
      return { data: updated };
    },
  );
  for (const operation of ["archive", "delete", "restore"] as const) {
    const permission: Permission =
      operation === "archive"
        ? "files:archive"
        : operation === "delete"
          ? "files:delete"
          : "files:restore";
    app.post<{ Params: { id: string } }>(
      `/api/v1/files/:id/${operation}`,
      { preHandler: options.authorize(permission) },
      async (request, reply) => {
        const row = await filesRepository.operateFile(
          request.claims!.organizationId,
          request.params.id,
          operation,
        );
        if (!row)
          return reply.code(404).send({
            error: {
              code: "DRIVE_FILE_NOT_FOUND",
              message: "Dosya bulunamadı.",
            },
          });
        await audit(request, operation.toUpperCase(), request.params.id);
        await emitFileEvent(
          request,
          operation === "delete" ? "file.deleted" : "file.changed",
          row,
          { operation },
        );
        return { data: row };
      },
    );
  }
  app.post<{ Params: { id: string } }>(
    "/api/v1/files/:id/download-url",
    { preHandler: options.authorize("files:download") },
    async (request, reply) => {
      const row = await filesRepository.file(
        request.claims!.organizationId,
        request.params.id,
        "active",
      );
      if (!row)
        return reply.code(404).send({
          error: {
            code: "DRIVE_FILE_NOT_FOUND",
            message: "Dosya bulunamadı.",
          },
        });
      if (row.internal_storage_key) {
        const signed = await options.storage.createSignedDownloadUrl({
          key: String(row.internal_storage_key),
          expiresInSeconds: 300,
          downloadFilename: String(row.sanitized_name),
        });
        await audit(request, "DOWNLOAD", request.params.id);
        return { data: signed };
      }
      return {
        data: {
          url: `/api/v1/files/${request.params.id}/content`,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/files/:id/content",
    { preHandler: options.authorize("files:download") },
    async (request, reply) => {
      const row = await filesRepository.file(
        request.claims!.organizationId,
        request.params.id,
        "active",
      );
      if (!row)
        return reply.code(404).send({
          error: {
            code: "DRIVE_FILE_NOT_FOUND",
            message: "Dosya bulunamadı.",
          },
        });
      const stream = row.internal_storage_key
        ? await options.storage.getObject({
            key: String(row.internal_storage_key),
          })
        : (
            await adapterFor(
              request.claims!.organizationId,
              String(row.provider_connection_id),
            )
          ).adapter.download(String(row.provider_file_id));
      await audit(request, "DOWNLOAD", request.params.id);
      reply
        .header("content-type", String(row.mime_type))
        .header(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(String(row.sanitized_name))}`,
        );
      return reply.send(Readable.fromWeb(stream as never));
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/files/:id/share",
    { preHandler: options.authorize("files:share") },
    async (request, reply) => {
      const body = z
        .object({
          emailAddress: z.string().email().optional(),
          allowPublic: z.boolean().default(false),
          role: z.enum(["reader", "commenter", "writer"]).default("reader"),
        })
        .parse(request.body);
      const row = await filesRepository.file(
        request.claims!.organizationId,
        request.params.id,
        "provider",
      );
      if (!row)
        return reply.code(409).send({
          error: {
            code: "DRIVE_FILE_NOT_FOUND",
            message: "Drive dosyası hazır değil.",
          },
        });
      try {
        const link = await (
          await adapterFor(
            request.claims!.organizationId,
            String(row.provider_connection_id),
          )
        ).adapter.createShareLink({
          fileId: String(row.provider_file_id),
          role: body.role,
          ...(body.emailAddress ? { emailAddress: body.emailAddress } : {}),
          allowPublic: body.allowPublic,
        });
        await audit(request, "SHARE", request.params.id, {
          permissionId: link.permissionId,
          public: body.allowPublic,
        });
        await emitFileEvent(request, "file.permission_changed", row, {
          operation: "share",
          permissionId: link.permissionId,
          public: body.allowPublic,
        });
        return { data: link };
      } catch (error) {
        const mapped = errorResponse(error);
        return reply
          .code(mapped.status)
          .send({ error: { code: mapped.code, message: mapped.message } });
      }
    },
  );
  app.delete<{ Params: { id: string; permissionId: string } }>(
    "/api/v1/files/:id/share/:permissionId",
    { preHandler: options.authorize("files:share") },
    async (request, reply) => {
      const row = await filesRepository.file(
        request.claims!.organizationId,
        request.params.id,
        "provider",
      );
      if (!row)
        return reply.code(404).send({
          error: {
            code: "DRIVE_FILE_NOT_FOUND",
            message: "Dosya bulunamadı.",
          },
        });
      await (
        await adapterFor(
          request.claims!.organizationId,
          String(row.provider_connection_id),
        )
      ).adapter.revokeShareLink(
        request.params.permissionId,
        String(row.provider_file_id),
      );
      await audit(request, "REVOKE_SHARE", request.params.id, {
        permissionId: request.params.permissionId,
      });
      await emitFileEvent(request, "file.permission_changed", row, {
        operation: "revoke",
        permissionId: request.params.permissionId,
      });
      return { data: { revoked: true } };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/files/:id/send-whatsapp",
    { preHandler: options.authorize("files:send") },
    async (request, reply) => {
      const body = z
        .object({ conversationId: uuid, clientMessageId: uuid.optional() })
        .parse(request.body);
      const org = request.claims!.organizationId;
      const [asset, conversation] = await Promise.all([
        filesRepository.file(org, request.params.id, "ready"),
        filesRepository.conversationForSend({
          organizationId: org,
          conversationId: body.conversationId,
          userId: request.claims!.sub,
          enforceOwnership: ["agent", "team_lead"].includes(
            request.claims!.role,
          ),
        }),
      ]);
      if (!asset || !conversation)
        return reply.code(404).send({
          error: {
            code: "TENANT_ACCESS_DENIED",
            message: "Dosya veya konuşma bulunamadı.",
          },
        });
      if (conversation.channel_status !== "connected")
        return reply.code(409).send({
          error: {
            code: "DRIVE_CONNECTION_DISABLED",
            message: "WhatsApp kanalı bağlı değil.",
          },
        });
      let internalKey = asset.internal_storage_key
        ? String(asset.internal_storage_key)
        : "";
      if (!internalKey) {
        const providerStream = await (
          await adapterFor(org, String(asset.provider_connection_id))
        ).adapter.download(String(asset.provider_file_id));
        const copied = await options.storage.putObject({
          key: storageKey(org, String(asset.sanitized_name)),
          body: providerStream,
          contentType: String(asset.mime_type),
        });
        await scanStoredObject({
          storage: options.storage,
          scanner: options.scanner,
          key: copied.key,
        });
        internalKey = copied.key;
        await filesRepository.cacheInternalObject({
          organizationId: org,
          id: request.params.id,
          key: internalKey,
          sha256: copied.sha256,
          size: copied.size,
        });
      }
      const result = await filesRepository.queueWhatsAppSend({
        organizationId: org,
        userId: request.claims!.sub,
        asset,
        conversation,
        conversationId: body.conversationId,
        ...(body.clientMessageId
          ? { clientMessageId: body.clientMessageId }
          : {}),
        internalKey,
      });
      await audit(request, "SEND_WHATSAPP", request.params.id, {
        conversationId: body.conversationId,
        messageId: result.messageId,
      });
      return reply.code(202).send({ data: result });
    },
  );

  app.post<{ Params: { channelId: string } }>(
    "/webhooks/google-drive/:channelId",
    async (request, reply) => {
      const token = String(request.headers["x-goog-channel-token"] ?? "");
      const resourceId = String(request.headers["x-goog-resource-id"] ?? "");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const channel = await filesRepository.acceptDriveNotification({
        channelId: request.params.channelId,
        tokenHash,
        resourceId,
        messageNumber: String(
          request.headers["x-goog-message-number"] ?? "unknown",
        ),
        resourceState: request.headers["x-goog-resource-state"] ?? null,
      });
      if (!channel)
        return reply.code(403).send({
          error: {
            code: "DRIVE_PERMISSION_DENIED",
            message: "Geçersiz Drive kanalı.",
          },
        });
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/v1/files/operations/health",
    { preHandler: options.authorize("files:view_audit") },
    async (request) => {
      return {
        data: await filesRepository.operationsHealth(
          request.claims!.organizationId,
        ),
      };
    },
  );
}

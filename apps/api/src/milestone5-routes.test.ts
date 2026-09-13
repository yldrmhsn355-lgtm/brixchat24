import Fastify from "fastify";
import { Readable } from "node:stream";
import type { DatabaseClient } from "@brixchat/database";
import type {
  MalwareScanner,
  ObjectStorageProvider,
} from "@brixchat/integrations";
import { describe, expect, it, vi } from "vitest";
import { registerMilestone5Routes } from "./milestone5-routes";

const database = (async () => [{ one: 1 }]) as unknown as DatabaseClient;
const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const conversationId = "00000000-0000-4000-8000-000000000003";
const channelId = "00000000-0000-4000-8000-000000000004";
const contactId = "00000000-0000-4000-8000-000000000005";
const messageId = "00000000-0000-4000-8000-000000000006";
const attachmentId = "00000000-0000-4000-8000-000000000007";

function objectStorage(healthy = true): ObjectStorageProvider {
  return {
    putObject: vi.fn(),
    getObject: vi.fn(),
    deleteObject: vi.fn(),
    createSignedDownloadUrl: vi.fn(),
    healthCheck: vi.fn(async () => ({ healthy, provider: "test" })),
  };
}

function malwareScanner(healthy: boolean): MalwareScanner {
  return {
    scan: vi.fn(async () => ({ status: "clean" as const })),
    healthCheck: vi.fn(async () => ({ healthy })),
  };
}

function healthApp(
  scannerHealthy: boolean,
  redisPing: () => Promise<string> = vi.fn(async () => "PONG"),
  redisHealthTimeoutMs = 50,
) {
  const app = Fastify();
  registerMilestone5Routes(app, database, {
    authorize: () => async () => undefined,
    publish: async () => undefined,
    storage: objectStorage(),
    malwareScanner: malwareScanner(scannerHealthy),
    recordMediaCleanupRequired: vi.fn(async () => undefined),
    redisPing,
    redisHealthTimeoutMs,
    apiPublicUrl: "http://localhost:4400",
  });
  return app;
}

function mediaApp(input: {
  scanStatus?: "clean" | "infected" | "failed";
  attachment?: Record<string, unknown>;
  retryableAttachment?: boolean;
  uploadLimitBytes?: number;
  deleteFails?: boolean;
  transactionFails?: boolean;
}) {
  const tx = vi.fn(async (strings: TemplateStringsArray) => {
    const statement = strings.join(" ");
    if (statement.includes("INSERT INTO messages"))
      return [{ id: messageId, client_message_id: crypto.randomUUID() }];
    if (statement.includes("INSERT INTO message_attachments"))
      return [{ id: attachmentId }];
    return [];
  });
  Object.assign(tx, { json: (value: unknown) => value });
  const begin = vi.fn(
    async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      if (input.transactionFails) throw new Error("transaction failed");
      return callback(tx);
    },
  );
  const query = vi.fn(
    async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = strings.join(" ");
      if (statement.includes("WITH retryable_attachment AS"))
        return input.retryableAttachment ? [{ id: attachmentId }] : [];
      if (statement.includes("SELECT a.storage_key"))
        return input.attachment ? [input.attachment] : [];
      if (statement.includes("SELECT c.channel_id"))
        return [
          {
            channel_id: channelId,
            contact_id: contactId,
            customer_service_window_expires_at: new Date(
              Date.now() + 60_000,
            ).toISOString(),
            status: "connected",
          },
        ];
      if (statement.includes("SELECT qr.id FROM quick_replies"))
        return [{ id: crypto.randomUUID() }];
      if (statement.includes("INSERT INTO quick_reply_attachments"))
        return [
          {
            id: attachmentId,
            filename: "guide.pdf",
            mime_type: "application/pdf",
            size_bytes: 4,
            attachment_type: "document",
            scan_status: "clean",
          },
        ];
      return [];
    },
  );
  Object.assign(query, { begin, json: (value: unknown) => value });
  const storage = {
    putObject: vi.fn(async (putInput) => {
      const source =
        putInput.body instanceof Readable
          ? putInput.body
          : Readable.fromWeb(putInput.body);
      let size = 0;
      for await (const chunk of source) size += Buffer.byteLength(chunk);
      return {
        key: "org/upload.pdf",
        size,
        contentType: "application/pdf",
        sha256: "hash",
      };
    }),
    getObject: vi.fn(async () => new ReadableStream<Uint8Array>()),
    deleteObject: vi.fn(async () => {
      if (input.deleteFails) throw new Error("delete unavailable");
    }),
    createSignedDownloadUrl: vi.fn(async () => ({
      url: "https://storage.example.test/file",
      expiresAt: new Date(Date.now() + 60_000),
    })),
    healthCheck: vi.fn(async () => ({ healthy: true, provider: "test" })),
  } satisfies ObjectStorageProvider;
  const scanner = {
    scan: vi.fn(async () => ({ status: input.scanStatus ?? "clean" })),
    healthCheck: vi.fn(async () => ({ healthy: true })),
  } satisfies MalwareScanner;
  const recordMediaCleanupRequired = vi.fn(async () => undefined);
  const app = Fastify();
  app.addContentTypeParser(
    "application/octet-stream",
    (_request, payload, done) => done(null, payload),
  );
  registerMilestone5Routes(app, query as unknown as DatabaseClient, {
    authorize: () => async (request) => {
      request.claims = {
        sub: userId,
        organizationId,
        role: "owner",
        email: "owner@example.test",
      };
    },
    publish: async () => undefined,
    storage,
    malwareScanner: scanner,
    recordMediaCleanupRequired,
    storageProvider: "s3",
    storageBucket: "private-bucket",
    ...(input.uploadLimitBytes
      ? { mediaUploadLimitBytes: input.uploadLimitBytes }
      : {}),
    redisPing: async () => "PONG",
    apiPublicUrl: "http://localhost:4400",
  });
  return {
    app,
    begin,
    query,
    recordMediaCleanupRequired,
    scanner,
    storage,
    tx,
  };
}

function automationManagementApp(input?: { deleteFound?: boolean }) {
  const query = vi.fn(
    async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = strings.join(" ");
      if (statement.includes("SELECT * FROM automation_rules")) {
        const active = {
          id: crypto.randomUUID(),
          name: "Aktif akış",
          status: "active",
        };
        return statement.includes("status<>'archived'")
          ? [active]
          : [active, { id: crypto.randomUUID(), name: "Eski", status: "archived" }];
      }
      if (statement.includes("UPDATE automation_rules SET")) {
        return input?.deleteFound === false
          ? []
          : [{ id: crypto.randomUUID(), status: "archived" }];
      }
      return [];
    },
  );
  Object.assign(query, { json: (value: unknown) => value });
  const app = Fastify();
  registerMilestone5Routes(app, query as unknown as DatabaseClient, {
    authorize: () => async (request) => {
      request.claims = {
        sub: userId,
        organizationId,
        role: "owner",
        email: "owner@example.test",
      };
    },
    publish: async () => undefined,
    storage: objectStorage(),
    malwareScanner: malwareScanner(true),
    recordMediaCleanupRequired: vi.fn(async () => undefined),
    redisPing: async () => "PONG",
    apiPublicUrl: "http://localhost:4400",
  });
  return { app, query };
}

describe("milestone 5 readiness", () => {
  it("is ready when PostgreSQL, Redis, object storage, and malware scanning are healthy", async () => {
    const redisPing = vi.fn(async () => "PONG");
    const app = healthApp(true, redisPing);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ready",
      dependencies: {
        postgresql: "ok",
        redis: { healthy: true },
        objectStorage: { healthy: true },
        malwareScanner: { healthy: true },
      },
    });
    expect(redisPing).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("stays ready (200, degraded) when only the malware scanner is unhealthy", async () => {
    const app = healthApp(false);

    const response = await app.inject({ method: "GET", url: "/health/ready" });
    const dependencies = await app.inject({
      method: "GET",
      url: "/health/dependencies",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "degraded",
      dependencies: {
        postgresql: "ok",
        objectStorage: { healthy: true },
        malwareScanner: { healthy: false },
      },
    });
    expect(dependencies.statusCode).toBe(200);
    expect(dependencies.json()).toMatchObject({
      dependencies: {
        redis: { healthy: true },
        malwareScanner: { healthy: false },
      },
    });
    await app.close();
  });

  it("stays ready (200, degraded) but reports /health/dependencies as 503 when Redis is unavailable", async () => {
    const redisPing = vi.fn(async () => {
      throw new Error("redis unavailable");
    });
    const app = healthApp(true, redisPing);

    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    const dependencies = await app.inject({
      method: "GET",
      url: "/health/dependencies",
    });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "degraded",
      dependencies: { redis: { healthy: false } },
    });
    expect(dependencies.statusCode).toBe(503);
    expect(dependencies.json()).toMatchObject({
      status: "degraded",
      dependencies: { redis: { healthy: false } },
    });
    expect(redisPing).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("bounds a stalled Redis PING", async () => {
    const redisPing = vi.fn(() => new Promise<string>(() => undefined));
    const app = healthApp(true, redisPing, 10);

    const startedAt = Date.now();
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(response.json()).toMatchObject({
      dependencies: { redis: { healthy: false } },
    });
    await app.close();
  });

  it("returns 503 from readiness only when PostgreSQL itself is unreachable", async () => {
    const brokenSql = (async () => {
      throw new Error("connection refused");
    }) as unknown as DatabaseClient;
    const app = Fastify();
    registerMilestone5Routes(app, brokenSql, {
      authorize: () => async () => undefined,
      publish: async () => undefined,
      storage: objectStorage(),
      malwareScanner: malwareScanner(true),
      recordMediaCleanupRequired: vi.fn(async () => undefined),
      redisPing: async () => "PONG",
      apiPublicUrl: "http://localhost:4400",
    });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "down" });
    await app.close();
  });
});

describe("automation management lifecycle", () => {
  it("excludes archived automations from the default list", async () => {
    const { app, query } = automationManagementApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/automations",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].status).toBe("active");
    expect(query.mock.calls[0]![0].join(" ")).toContain("status<>'archived'");
    await app.close();
  });

  it("archives an automation through the delete contract", async () => {
    const { app, query } = automationManagementApp();
    const id = crypto.randomUUID();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/automations/${id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { status: "archived" },
    });
    const statement = query.mock.calls.find(([strings]) =>
      strings.join(" ").includes("UPDATE automation_rules SET"),
    )![0].join(" ");
    expect(statement).toContain("organization_id=");
    expect(statement).toContain("status<>'archived'");
    await app.close();
  });

  it("returns 404 when the automation cannot be archived", async () => {
    const { app } = automationManagementApp({ deleteFound: false });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/automations/${crypto.randomUUID()}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "automation_not_found" },
    });
    await app.close();
  });
});

describe("milestone 5 media safety", () => {
  it.each(["pending", "infected", "failed"])(
    "does not sign a %s attachment for download",
    async (scanStatus) => {
      const { app, storage } = mediaApp({
        attachment: {
          storage_key: "org/file",
          processing_status: "stored",
          scan_status: scanStatus,
        },
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/attachments/${attachmentId}/download-url`,
      });

      expect(response.statusCode).toBe(409);
      expect(storage.createSignedDownloadUrl).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("does not sign a clean attachment until storage is complete", async () => {
    const { app, storage } = mediaApp({
      attachment: {
        storage_key: "org/file",
        processing_status: "downloading",
        scan_status: "clean",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/${attachmentId}/download-url`,
    });

    expect(response.statusCode).toBe(409);
    expect(storage.createSignedDownloadUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it("signs a stored and clean attachment", async () => {
    const { app, storage } = mediaApp({
      attachment: {
        storage_key: "org/file",
        processing_status: "stored",
        scan_status: "clean",
        download_filename: "müşteri-fotoğrafı.jpg",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/${attachmentId}/download-url`,
    });

    expect(response.statusCode).toBe(200);
    expect(storage.createSignedDownloadUrl).toHaveBeenCalledWith({
      key: "org/file",
      expiresInSeconds: 300,
      downloadFilename: "müşteri-fotoğrafı.jpg",
    });
    await app.close();
  });

  it("requeues a failed tenant attachment with a fresh retry budget", async () => {
    const { app, query } = mediaApp({ retryableAttachment: true });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/${attachmentId}/retry`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { queued: true } });
    const retryCall = query.mock.calls.find(([strings]) =>
      strings.join(" ").includes("WITH retryable_attachment AS"),
    );
    expect(retryCall).toBeDefined();
    const statement = retryCall![0].join(" ");
    expect(retryCall).toContain(attachmentId);
    expect(retryCall).toContain(organizationId);
    expect(statement).toContain("a.processing_status='failed'");
    expect(statement).toContain(
      "media_processing_jobs.organization_id=EXCLUDED.organization_id",
    );
    expect(statement).toMatch(/attempt_count\s*=\s*0/);
    expect(statement).toMatch(/locked_at\s*=\s*NULL/);
    expect(statement).toMatch(/locked_by\s*=\s*NULL/);
    expect(statement).toMatch(/last_error\s*=\s*NULL/);
    expect(statement).toMatch(/completed_at\s*=\s*NULL/);
    await app.close();
  });

  it("does not queue an attachment outside the failed tenant scope", async () => {
    const { app, query } = mediaApp({});

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/${attachmentId}/retry`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "attachment_not_found" },
    });
    expect(query).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it.each([
    ["infected", 422, "MEDIA_INFECTED"],
    ["failed", 503, "MEDIA_SCAN_FAILED"],
  ] as const)(
    "deletes a %s upload before any message or outbox transaction",
    async (scanStatus, statusCode, code) => {
      const { app, begin, storage } = mediaApp({ scanStatus });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/media/uploads?conversationId=${conversationId}`,
        headers: {
          "content-type": "application/octet-stream",
          "x-filename": "invoice.pdf",
          "x-mime-type": "application/pdf",
        },
        payload: Buffer.from("file"),
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ error: { code } });
      expect(storage.deleteObject).toHaveBeenCalledWith({
        key: "org/upload.pdf",
      });
      expect(begin).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("stores a scanned quick-reply attachment without creating a message", async () => {
    const { app, begin, scanner } = mediaApp({});
    const quickReplyId = crypto.randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/quick-replies/${quickReplyId}/attachments`,
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": "guide.pdf",
        "x-mime-type": "application/pdf",
      },
      payload: Buffer.from("file"),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: {
        id: attachmentId,
        scan_status: "clean",
        attachment_type: "document",
      },
    });
    expect(scanner.scan).toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    await app.close();
  });

  it("persists a cleanup record when a rejected upload cannot be deleted", async () => {
    const { app, begin, recordMediaCleanupRequired } = mediaApp({
      scanStatus: "infected",
      deleteFails: true,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/media/uploads?conversationId=${conversationId}`,
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": "infected.pdf",
        "x-mime-type": "application/pdf",
      },
      payload: Buffer.from("file"),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "MEDIA_SCAN_CLEANUP_FAILED" },
    });
    expect(begin).not.toHaveBeenCalled();
    expect(recordMediaCleanupRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: "org/upload.pdf",
        reason: "MEDIA_SCAN_CLEANUP_FAILED",
      }),
    );
    await app.close();
  });

  it("rejects and cleans up an oversized streaming upload before DB work", async () => {
    const { app, begin, scanner, storage } = mediaApp({
      uploadLimitBytes: 4,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/media/uploads?conversationId=${conversationId}`,
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": "large.pdf",
        "x-mime-type": "application/pdf",
      },
      payload: Buffer.from("too-large"),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: "MEDIA_TOO_LARGE" },
    });
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(scanner.scan).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates an outbound message only after a clean scan", async () => {
    const { app, begin, scanner, storage, tx } = mediaApp({
      scanStatus: "clean",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/media/uploads?conversationId=${conversationId}`,
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": "invoice.pdf",
        "x-mime-type": "application/pdf",
      },
      payload: Buffer.from("file"),
    });

    expect(response.statusCode).toBe(201);
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(begin).toHaveBeenCalledTimes(1);
    const attachmentInsert = tx.mock.calls.find(([strings]) =>
      strings.join(" ").includes("INSERT INTO message_attachments"),
    );
    expect(attachmentInsert).toContain("s3");
    expect(attachmentInsert).toContain("private-bucket");
    await app.close();
  });

  it("cleans up or records a clean object when the DB transaction fails", async () => {
    const { app, begin, recordMediaCleanupRequired, scanner, storage } =
      mediaApp({
        scanStatus: "clean",
        transactionFails: true,
        deleteFails: true,
      });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/media/uploads?conversationId=${conversationId}`,
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": "invoice.pdf",
        "x-mime-type": "application/pdf",
      },
      payload: Buffer.from("file"),
    });

    expect(response.statusCode).toBe(500);
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledWith({
      key: "org/upload.pdf",
    });
    expect(recordMediaCleanupRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: "org/upload.pdf",
        reason: "MEDIA_DATABASE_TRANSACTION_FAILED",
      }),
    );
    await app.close();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateCondition,
  loopAllowed,
  safeWebhookTarget,
  withinWorkingHours,
} from "./automation/index";
import {
  LocalObjectStorageProvider,
  attachmentContentDisposition,
  mediaRetryDelay,
  mimeAllowed,
  sanitizeFilename,
  sniffMime,
  storageKey,
  assertProductionMediaAdapters,
  createObjectStorageProvider,
  createMalwareScanner,
  objectStorageLocation,
  scanStoredObject,
  type MalwareScanner,
  type ObjectStorageProvider,
} from "./media/index";
import {
  FakeBitrixOpenChannelsConnector,
  bothModeTimelinePolicy,
} from "./open-channels/index";
import { validateProductionConfig } from "./secrets/index";
import { FakeMessagingProvider } from "./fake/provider";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((x) => rm(x, { recursive: true, force: true })),
  );
});
describe("milestone 5 safety contracts", () => {
  it("keeps official Meta-compatible groups disabled", () =>
    expect(new FakeMessagingProvider().capabilities().groupConversations).toBe(
      false,
    ));
  it("sanitizes filenames and creates tenant scoped unpredictable keys", () => {
    expect(sanitizeFilename("../../a<script>.pdf")).not.toContain("/");
    const key = storageKey("org-1", "report.pdf");
    expect(key).toMatch(/^org-1\/.+\/[0-9a-f-]+\.pdf$/);
  });
  it("builds a safe UTF-8 attachment content disposition", () => {
    expect(attachmentContentDisposition('müşteri "fotoğrafı".jpg')).toBe(
      "attachment; filename=\"m__teri _foto_raf__.jpg\"; filename*=UTF-8''m%C3%BC%C5%9Fteri%20_foto%C4%9Fraf%C4%B1_.jpg",
    );
  });
  it("validates MIME and magic bytes", () => {
    expect(mimeAllowed("image/png")).toBe(true);
    expect(mimeAllowed("image/svg+xml")).toBe(false);
    expect(sniffMime(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(
      "image/png",
    );
  });
  it("creates and verifies expiring private local URLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brix-media-"));
    dirs.push(dir);
    const s = new LocalObjectStorageProvider(dir, "http://api", "secret");
    await s.putObject({
      key: "org/x.bin",
      body: Readable.from(Buffer.from("safe")),
      contentType: "text/plain",
    });
    const signed = await s.createSignedDownloadUrl({
      key: "org/x.bin",
      expiresInSeconds: 60,
      downloadFilename: "müşteri-belgesi.pdf",
    });
    expect(
      s.verify(new URL(signed.url).searchParams.get("token")!),
    ).toMatchObject({
      key: "org/x.bin",
      downloadFilename: "müşteri-belgesi.pdf",
    });
    expect(s.verify("invalid")).toBeNull();
  });
  it("caps exponential media retry", () =>
    expect(mediaRetryDelay(20)).toBe(300000));
  it.each([
    ["infected", "MEDIA_INFECTED", false],
    ["failed", "MEDIA_SCAN_FAILED", true],
  ] as const)(
    "deletes a stored object and rejects a %s scan",
    async (status, code, retryable) => {
      const storage = {
        getObject: vi.fn(async () => new ReadableStream<Uint8Array>()),
        deleteObject: vi.fn(async () => undefined),
      } as unknown as ObjectStorageProvider;
      const scanner = {
        scan: vi.fn(async () => ({ status })),
      } as unknown as MalwareScanner;

      const failure = scanStoredObject({ storage, scanner, key: "org/file" });

      await expect(failure).rejects.toMatchObject({
        code,
        retryable,
        scanStatus: status,
      });
      expect(storage.deleteObject).toHaveBeenCalledWith({ key: "org/file" });
    },
  );
  it("keeps a clean stored object", async () => {
    const storage = {
      getObject: vi.fn(async () => new ReadableStream<Uint8Array>()),
      deleteObject: vi.fn(async () => undefined),
    } as unknown as ObjectStorageProvider;
    const scanner = {
      scan: vi.fn(async () => ({ status: "clean" as const })),
    } as unknown as MalwareScanner;

    await expect(
      scanStoredObject({ storage, scanner, key: "org/file" }),
    ).resolves.toEqual({ status: "clean" });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
  it("keeps failed cleanup traceable and retryable", async () => {
    const storage = {
      getObject: vi.fn(async () => new ReadableStream<Uint8Array>()),
      deleteObject: vi.fn(async () => {
        throw new Error("delete unavailable");
      }),
    } as unknown as ObjectStorageProvider;
    const scanner = {
      scan: vi.fn(async () => ({ status: "infected" as const })),
    } as unknown as MalwareScanner;

    await expect(
      scanStoredObject({ storage, scanner, key: "org/orphan" }),
    ).rejects.toMatchObject({
      code: "MEDIA_SCAN_CLEANUP_FAILED",
      retryable: true,
      cleanupFailed: true,
      scanStatus: "infected",
      storageKey: "org/orphan",
    });
  });
  it("records the configured storage provider and bucket", () => {
    expect(
      objectStorageLocation({
        OBJECT_STORAGE_PROVIDER: "s3",
        S3_BUCKET: "private-bucket",
      }),
    ).toEqual({ provider: "s3", bucket: "private-bucket" });
    expect(objectStorageLocation({})).toEqual({
      provider: "local",
      bucket: null,
    });
  });
  it("fails fast instead of allowing insecure production media fallbacks", () => {
    expect(() =>
      assertProductionMediaAdapters({
        APP_ENV: "production",
        OBJECT_STORAGE_PROVIDER: "local",
        MALWARE_SCANNER_PROVIDER: "noop",
      }),
    ).toThrow("PRODUCTION_OBJECT_STORAGE_PROVIDER_REQUIRED");
    expect(() =>
      assertProductionMediaAdapters({
        APP_ENV: "production",
        OBJECT_STORAGE_PROVIDER: "s3",
        MALWARE_SCANNER_PROVIDER: "noop",
      }),
    ).toThrow("PRODUCTION_MALWARE_SCANNER_PROVIDER_REQUIRED");
    expect(() =>
      assertProductionMediaAdapters({
        APP_ENV: "production",
        OBJECT_STORAGE_PROVIDER: "s3",
        MALWARE_SCANNER_PROVIDER: "clamav",
      }),
    ).not.toThrow();
  });
  it("builds configured remote storage and ClamAV adapters", () => {
    expect(
      createObjectStorageProvider({
        APP_ENV: "production",
        OBJECT_STORAGE_PROVIDER: "s3",
        S3_BUCKET: "private-bucket",
        S3_REGION: "us-east-1",
        S3_ACCESS_KEY_ID: "access",
        S3_SECRET_ACCESS_KEY: "secret",
      }),
    ).toBeTruthy();
    expect(
      createMalwareScanner({
        APP_ENV: "production",
        MALWARE_SCANNER_PROVIDER: "clamav",
        CLAMAV_HOST: "127.0.0.1",
        CLAMAV_PORT: "3310",
      }),
    ).toBeTruthy();
  });
  it("evaluates bounded automation conditions", () => {
    expect(
      evaluateCondition(
        { field: "text", operator: "contains", value: "hello" },
        { text: "Hello World" },
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "status", operator: "equals", value: "open" },
        { status: "closed" },
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { field: "text", operator: "not_contains", value: "spam" },
        { text: "Hello" },
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "text", operator: "starts_with", value: "he" },
        { text: "Hello" },
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "tag", operator: "is_empty", value: null },
        {},
      ),
    ).toBe(true);
  });
  it("blocks recursive correlations", () =>
    expect(
      loopAllowed({
        depth: 5,
        maxDepth: 5,
        correlationId: "x",
        seen: new Set(),
      }),
    ).toBe(false));
  it("rejects SSRF targets", () => {
    expect(safeWebhookTarget("https://127.0.0.1/hook", ["127.0.0.1"])).toBe(
      false,
    );
    expect(
      safeWebhookTarget("https://hooks.example.com/a", ["hooks.example.com"]),
    ).toBe(true);
  });
  it("evaluates timezone working hours", () =>
    expect(
      withinWorkingHours(new Date("2026-07-16T09:00:00Z"), "UTC", 8, 18),
    ).toBe(true));
  it("maps fake Open Channels messages deterministically", async () => {
    const c = new FakeBitrixOpenChannelsConnector();
    const input = {
      connectorId: "c",
      lineId: "l",
      externalUserCode: "u",
      text: "hi",
      sourceMarker: "source-1",
    };
    expect(await c.sendIncoming(input)).toEqual(await c.sendIncoming(input));
  });
  it("creates a stable separate Open Channel line for each channel name", async () => {
    const connector = new FakeBitrixOpenChannelsConnector();
    const first = await connector.createLine({
      name: "BrixChat24 - WhatsApp 0894",
      queueUserIds: ["32"],
    });
    const second = await connector.createLine({
      name: "BrixChat24 - WhatsApp Web Live",
      queueUserIds: ["32"],
    });
    expect(first.lineId).not.toBe(second.lineId);
    expect(
      await connector.createLine({
        name: "BrixChat24 - WhatsApp Web Live",
        queueUserIds: ["32"],
      }),
    ).toEqual(second);
  });
  it("defaults both mode to one CRM timeline comment per message", () =>
    expect(bothModeTimelinePolicy("both")).toBe("per_message"));
  it("fails unsafe production configuration", () => {
    const result = validateProductionConfig({
      JWT_ACCESS_SECRET: "short",
      JWT_REFRESH_SECRET: "short",
      OBJECT_STORAGE_PROVIDER: "local",
      MALWARE_SCANNER_PROVIDER: "noop",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("LOCAL_OBJECT_STORAGE");
  });
});

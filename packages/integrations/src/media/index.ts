import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { connect } from "node:net";
import { FilesystemObjectStorageProvider } from "./filesystem";
export { FilesystemObjectStorageProvider } from "./filesystem";
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PutObjectInput {
  key: string;
  body: ReadableStream<Uint8Array> | Readable;
  contentType: string;
}
export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
  sha256: string;
}
export interface ObjectStorageProvider {
  putObject(input: PutObjectInput): Promise<StoredObject>;
  getObject(input: { key: string }): Promise<ReadableStream<Uint8Array>>;
  deleteObject(input: { key: string }): Promise<void>;
  createSignedDownloadUrl(input: {
    key: string;
    expiresInSeconds: number;
    downloadFilename?: string;
  }): Promise<{ url: string; expiresAt: Date }>;
  healthCheck(): Promise<{
    healthy: boolean;
    provider: string;
    warning?: string;
  }>;
}
export class DisabledObjectStorageProvider implements ObjectStorageProvider {
  private unavailable(): never {
    throw Object.assign(
      new Error("Dosya depolama bağlantısı henüz kurulmadı."),
      { statusCode: 503, code: "STORAGE_NOT_CONFIGURED" },
    );
  }
  async putObject(_input: PutObjectInput): Promise<StoredObject> {
    return this.unavailable();
  }
  async getObject(_input: {
    key: string;
  }): Promise<ReadableStream<Uint8Array>> {
    return this.unavailable();
  }
  async deleteObject(_input: { key: string }): Promise<void> {
    return this.unavailable();
  }
  async createSignedDownloadUrl(_input: {
    key: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }> {
    return this.unavailable();
  }
  async healthCheck() {
    return {
      healthy: false,
      provider: "disabled",
      warning: "STORAGE_NOT_CONFIGURED",
    };
  }
}
const asNode = (body: PutObjectInput["body"]): Readable =>
  body instanceof Readable ? body : Readable.fromWeb(body as never);
export function sanitizeFilename(value: string) {
  return (
    value
      .normalize("NFKC")
      .replace(/[\\/\0<>:"|?*\x00-\x1f]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 180) || "attachment"
  );
}
export function attachmentContentDisposition(filename: string) {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
export function storageKey(org: string, filename: string) {
  const ext = sanitizeFilename(filename).split(".").pop()?.toLowerCase();
  return `${org}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}${ext && ext.length < 8 ? `.` + ext : ""}`;
}
export class LocalObjectStorageProvider implements ObjectStorageProvider {
  constructor(
    private root: string,
    private base: string,
    private secret: string,
  ) {}
  private path(key: string) {
    const root = resolve(this.root),
      target = resolve(root, key);
    if (target !== root && !target.startsWith(root + sep))
      throw new Error("STORAGE_PATH_INVALID");
    return target;
  }
  async putObject(input: PutObjectInput) {
    const path = this.path(input.key);
    await mkdir(dirname(path), { recursive: true });
    const hash = createHash("sha256");
    let size = 0;
    const source = asNode(input.body);
    source.on("data", (c: Buffer) => {
      size += c.length;
      hash.update(c);
    });
    await pipeline(source, createWriteStream(path, { flags: "wx" }));
    return {
      key: input.key,
      size,
      contentType: input.contentType,
      sha256: hash.digest("hex"),
    };
  }
  async getObject(input: { key: string }) {
    return Readable.toWeb(
      createReadStream(this.path(input.key)),
    ) as ReadableStream<Uint8Array>;
  }
  async deleteObject(input: { key: string }) {
    await rm(this.path(input.key), { force: true });
  }
  async createSignedDownloadUrl(input: {
    key: string;
    expiresInSeconds: number;
    downloadFilename?: string;
  }) {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000),
      payload = Buffer.from(
        JSON.stringify({
          key: input.key,
          exp: Math.floor(expiresAt.getTime() / 1000),
          downloadFilename: input.downloadFilename,
        }),
      ).toString("base64url"),
      sig = createHmac("sha256", this.secret)
        .update(payload)
        .digest("base64url");
    return {
      url: `${this.base}/api/v1/media/object?token=${payload}.${sig}`,
      expiresAt,
    };
  }
  verify(token: string) {
    const [p, s] = token.split(".");
    if (!p || !s) return null;
    const e = createHmac("sha256", this.secret).update(p).digest(),
      a = Buffer.from(s, "base64url");
    if (a.length !== e.length || !timingSafeEqual(a, e)) return null;
    const v = JSON.parse(Buffer.from(p, "base64url").toString()) as {
      key: string;
      exp: number;
      downloadFilename?: string;
    };
    return v.exp > Date.now() / 1000 ? v : null;
  }
  async healthCheck() {
    try {
      await mkdir(this.root, { recursive: true });
      await stat(this.root);
      return {
        healthy: true,
        provider: "local",
        ...(process.env.NODE_ENV === "production"
          ? { warning: "local_storage_in_production" }
          : {}),
      };
    } catch {
      return { healthy: false, provider: "local" };
    }
  }
}
export interface S3Adapter {
  put(key: string, body: Readable, mime: string): Promise<StoredObject>;
  get(key: string): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
  signedUrl(
    key: string,
    ttl: number,
    downloadFilename?: string,
  ): Promise<string>;
  health(): Promise<boolean>;
}
export class S3ObjectStorageProvider implements ObjectStorageProvider {
  constructor(private a: S3Adapter) {}
  putObject(i: PutObjectInput) {
    return this.a.put(i.key, asNode(i.body), i.contentType);
  }
  getObject(i: { key: string }) {
    return this.a.get(i.key);
  }
  deleteObject(i: { key: string }) {
    return this.a.delete(i.key);
  }
  async createSignedDownloadUrl(i: {
    key: string;
    expiresInSeconds: number;
    downloadFilename?: string;
  }) {
    return {
      url: await this.a.signedUrl(
        i.key,
        i.expiresInSeconds,
        i.downloadFilename,
      ),
      expiresAt: new Date(Date.now() + i.expiresInSeconds * 1000),
    };
  }
  async healthCheck() {
    return { healthy: await this.a.health(), provider: "s3" };
  }
}
class AwsS3Adapter implements S3Adapter {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}
  async put(key: string, body: Readable, mime: string) {
    const hash = createHash("sha256");
    let size = 0;
    const measuredBody = new Transform({
      transform(chunk: Buffer | string, encoding, callback) {
        const value = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, encoding);
        size += value.length;
        hash.update(value);
        callback(null, value);
      },
    });
    const forwardSourceError = (error: Error) => measuredBody.destroy(error);
    body.once("error", forwardSourceError);
    body.pipe(measuredBody);
    try {
      await new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: measuredBody,
          ContentType: mime,
        },
        queueSize: 1,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
      }).done();
    } catch (error) {
      body.unpipe(measuredBody);
      if (!body.destroyed) body.destroy();
      if (!measuredBody.destroyed) measuredBody.destroy();
      throw error;
    } finally {
      body.off("error", forwardSourceError);
    }
    return { key, size, contentType: mime, sha256: hash.digest("hex") };
  }
  async get(key: string) {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) throw new Error("STORAGE_OBJECT_MISSING");
    const body = result.Body as AsyncIterable<Uint8Array> & {
      transformToWebStream?: () => ReadableStream<Uint8Array>;
    };
    return body.transformToWebStream
      ? body.transformToWebStream()
      : (Readable.toWeb(Readable.from(body)) as ReadableStream<Uint8Array>);
  }
  async delete(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
  async signedUrl(key: string, ttl: number, downloadFilename?: string) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(downloadFilename
          ? {
              ResponseContentDisposition:
                attachmentContentDisposition(downloadFilename),
            }
          : {}),
      }),
      { expiresIn: ttl },
    );
  }
  async health() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}

export function createObjectStorageProvider(
  env: NodeJS.ProcessEnv = process.env,
  baseUrl = env.API_PUBLIC_URL ?? "http://localhost:4400",
  signingSecret = env.APP_ENCRYPTION_KEY ?? "local-media-signing-secret",
): ObjectStorageProvider {
  const production = (env.APP_ENV ?? env.NODE_ENV) === "production";
  const provider = (
    env.OBJECT_STORAGE_PROVIDER ?? (production ? "disabled" : "local")
  ).toLowerCase();
  if (provider === "disabled") return new DisabledObjectStorageProvider();
  if (provider === "filesystem") {
    if (!env.OBJECT_STORAGE_FILESYSTEM_ROOT || !env.APP_ENCRYPTION_KEY)
      throw new Error("FILESYSTEM_STORAGE_CONFIG_REQUIRED");
    return new FilesystemObjectStorageProvider(env.OBJECT_STORAGE_FILESYSTEM_ROOT, baseUrl, signingSecret);
  }
  if (provider === "local") {
    if (production)
      throw new Error("PRODUCTION_OBJECT_STORAGE_PROVIDER_REQUIRED");
    return new LocalObjectStorageProvider(
      env.OBJECT_STORAGE_LOCAL_PATH ?? ".data/media",
      baseUrl,
      signingSecret,
    );
  }
  if (!["s3", "r2"].includes(provider))
    throw new Error("OBJECT_STORAGE_PROVIDER_UNSUPPORTED");
  const bucket = env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET_REQUIRED");
  const client = new S3Client({
    region: env.S3_REGION ?? "auto",
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  return new S3ObjectStorageProvider(new AwsS3Adapter(client, bucket));
}
export function objectStorageLocation(env: NodeJS.ProcessEnv = process.env) {
  const provider = (
    env.OBJECT_STORAGE_PROVIDER ??
    ((env.APP_ENV ?? env.NODE_ENV) === "production" ? "disabled" : "local")
  ).toLowerCase();
  return {
    provider,
    bucket: ["local", "filesystem"].includes(provider) ? null : (env.S3_BUCKET ?? null),
  };
}
export { detectMediaMime, mediaLimitBytes, mediaByteRange } from './formats';
export { prepareWhatsAppAudio } from './audio';
const allowed = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/gif",
  "video/mp4",
  "video/3gpp",
  "video/webm",
  "audio/ogg",
  "audio/webm",
  "audio/opus",
  "audio/mpeg",
  "audio/aac",
  "audio/mp4",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
]);
export const normalizeMediaMime = (mime: string) => mime.split(';', 1)[0]!.trim().toLowerCase();
export const mimeAllowed = (mime: string) => allowed.has(normalizeMediaMime(mime));
export function sniffMime(bytes: Uint8Array) {
  const h = Buffer.from(bytes);
  if (h.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
    return "image/jpeg";
  if (h.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (
    h.subarray(0, 4).toString() === "RIFF" &&
    h.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (h.subarray(0, 4).toString() === "%PDF") return "application/pdf";
  if (h.subarray(4, 8).toString() === "ftyp") return "video/mp4";
  if (h.subarray(0, 4).toString() === "OggS") return "audio/ogg";
  if (h.subarray(0, 2).toString() === "PK") return "application/zip";
}
export type MalwareScanStatus = "clean" | "infected" | "failed";
export interface MalwareScanner {
  scan(input: {
    stream: ReadableStream<Uint8Array>;
  }): Promise<{ status: MalwareScanStatus; signature?: string }>;
  healthCheck(): Promise<{ healthy: boolean; warning?: string }>;
}

export class MediaScanError extends Error {
  readonly code:
    "MEDIA_INFECTED" | "MEDIA_SCAN_FAILED" | "MEDIA_SCAN_CLEANUP_FAILED";
  readonly retryable: boolean;

  constructor(
    readonly scanStatus: Exclude<MalwareScanStatus, "clean">,
    readonly cleanupFailed = false,
    readonly storageKey?: string,
    options?: ErrorOptions,
  ) {
    const code = cleanupFailed
      ? "MEDIA_SCAN_CLEANUP_FAILED"
      : scanStatus === "infected"
        ? "MEDIA_INFECTED"
        : "MEDIA_SCAN_FAILED";
    super(code, options);
    this.name = "MediaScanError";
    this.code = code;
    this.retryable = cleanupFailed || scanStatus === "failed";
  }
}

async function rejectStoredObject(input: {
  storage: ObjectStorageProvider;
  key: string;
  status: Exclude<MalwareScanStatus, "clean">;
  cause?: unknown;
}): Promise<never> {
  let deletionError: unknown;
  try {
    await input.storage.deleteObject({ key: input.key });
  } catch (error) {
    deletionError = error;
  }
  if (deletionError !== undefined)
    throw new MediaScanError(input.status, true, input.key, {
      cause: deletionError,
    });
  throw input.cause === undefined
    ? new MediaScanError(input.status)
    : new MediaScanError(input.status, false, undefined, {
        cause: input.cause,
      });
}

export async function scanStoredObject(input: {
  storage: ObjectStorageProvider;
  scanner: MalwareScanner;
  key: string;
}) {
  let result: Awaited<ReturnType<MalwareScanner["scan"]>>;
  try {
    result = await input.scanner.scan({
      stream: await input.storage.getObject({ key: input.key }),
    });
  } catch (error) {
    return rejectStoredObject({
      storage: input.storage,
      key: input.key,
      status: "failed",
      cause: error,
    });
  }
  if (result.status === "clean") return result;
  return rejectStoredObject({
    storage: input.storage,
    key: input.key,
    status: result.status,
  });
}

/**
 * Production must never silently fall back to development local disk or a no-op scanner.
 * Both services may be explicitly disabled before onboarding; the disabled
 * adapters reject file operations instead of accepting unscanned content.
 */
export function assertProductionMediaAdapters(
  env: NodeJS.ProcessEnv = process.env,
) {
  const production = (env.APP_ENV ?? env.NODE_ENV) === "production";
  if (!production) return;
  const storage = (env.OBJECT_STORAGE_PROVIDER ?? "").toLowerCase();
  const scanner = (env.MALWARE_SCANNER_PROVIDER ?? "").toLowerCase();
  if (
    (!storage || storage === "disabled") &&
    (!scanner || scanner === "disabled")
  )
    return;
  if (!["s3", "r2", "filesystem"].includes(storage))
    throw new Error("PRODUCTION_OBJECT_STORAGE_PROVIDER_REQUIRED");
  if (scanner !== "clamav")
    throw new Error("PRODUCTION_MALWARE_SCANNER_PROVIDER_REQUIRED");
}
export class NoopMalwareScanner implements MalwareScanner {
  async scan(_input: {
    stream: ReadableStream<Uint8Array>;
  }): Promise<{ status: "clean" | "infected" | "failed"; signature?: string }> {
    return { status: "clean" as const };
  }
  async healthCheck() {
    return {
      healthy: true,
      ...(process.env.NODE_ENV === "production"
        ? { warning: "noop_scanner_in_production" }
        : {}),
    };
  }
}
const DEFAULT_CLAMAV_HEALTHCHECK_TIMEOUT_MS = 2_000;
const DEFAULT_CLAMAV_SCAN_TIMEOUT_MS = 30_000;
interface ClamAvConnection {
  host: string;
  port: number;
  healthCheckTimeoutMs: number;
}
export class ClamAvMalwareScanner implements MalwareScanner {
  constructor(
    private fn: MalwareScanner["scan"],
    private readonly connection: ClamAvConnection = {
      host: "127.0.0.1",
      port: 3310,
      healthCheckTimeoutMs: DEFAULT_CLAMAV_HEALTHCHECK_TIMEOUT_MS,
    },
  ) {}
  scan(i: { stream: ReadableStream<Uint8Array> }) {
    return this.fn(i);
  }
  async healthCheck() {
    return new Promise<{ healthy: boolean }>((resolveResult) => {
      let socket: ReturnType<typeof connect> | undefined;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const chunks: Buffer[] = [];
      const configuredTimeout = this.connection.healthCheckTimeoutMs;
      const timeoutMs =
        Number.isFinite(configuredTimeout) && configuredTimeout > 0
          ? configuredTimeout
          : DEFAULT_CLAMAV_HEALTHCHECK_TIMEOUT_MS;
      const finish = (healthy: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        socket?.destroy();
        resolveResult({ healthy });
      };
      const inspectResponse = (final: boolean) => {
        if (settled) return;
        const response = Buffer.concat(chunks);
        const terminator = response.indexOf(0);
        if (terminator >= 0) {
          finish(
            response.subarray(0, terminator).toString("utf8").trim() === "PONG",
          );
          return;
        }
        if (final) {
          finish(response.toString("utf8").trim() === "PONG");
          return;
        }
        if (response.length > 64) finish(false);
      };

      try {
        socket = connect({
          host: this.connection.host,
          port: this.connection.port,
        });
      } catch {
        finish(false);
        return;
      }
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref();
      socket.once("error", () => finish(false));
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        inspectResponse(false);
      });
      socket.once("end", () => inspectResponse(true));
      socket.once("close", () => inspectResponse(true));
      socket.once("connect", () => {
        try {
          socket?.write("zPING\0");
        } catch {
          finish(false);
        }
      });
    });
  }
}
export function createMalwareScanner(
  env: NodeJS.ProcessEnv = process.env,
): MalwareScanner {
  const provider = (
    env.MALWARE_SCANNER_PROVIDER ??
    ((env.APP_ENV ?? env.NODE_ENV) === "production" ? "disabled" : "noop")
  ).toLowerCase();
  if (provider === "disabled")
    return {
      async scan() {
        return { status: "failed" as const };
      },
      async healthCheck() {
        return {
          healthy: false,
          provider: "disabled",
          warning: "MALWARE_SCANNER_NOT_CONFIGURED",
        };
      },
    };
  if (provider === "noop") {
    if ((env.APP_ENV ?? env.NODE_ENV) === "production")
      throw new Error("PRODUCTION_MALWARE_SCANNER_PROVIDER_REQUIRED");
    return new NoopMalwareScanner();
  }
  if (provider !== "clamav")
    throw new Error("MALWARE_SCANNER_PROVIDER_UNSUPPORTED");
  const host = env.CLAMAV_HOST ?? "127.0.0.1";
  const port = Number(env.CLAMAV_PORT ?? 3310);
  const configuredHealthCheckTimeoutMs = Number(
    env.CLAMAV_HEALTHCHECK_TIMEOUT_MS ?? DEFAULT_CLAMAV_HEALTHCHECK_TIMEOUT_MS,
  );
  const healthCheckTimeoutMs =
    Number.isFinite(configuredHealthCheckTimeoutMs) &&
    configuredHealthCheckTimeoutMs > 0
      ? configuredHealthCheckTimeoutMs
      : DEFAULT_CLAMAV_HEALTHCHECK_TIMEOUT_MS;
  const configuredScanTimeoutMs = Number(
    env.CLAMAV_SCAN_TIMEOUT_MS ?? DEFAULT_CLAMAV_SCAN_TIMEOUT_MS,
  );
  const scanTimeoutMs =
    Number.isFinite(configuredScanTimeoutMs) && configuredScanTimeoutMs > 0
      ? configuredScanTimeoutMs
      : DEFAULT_CLAMAV_SCAN_TIMEOUT_MS;
  return new ClamAvMalwareScanner(
    async ({ stream }) =>
      new Promise((resolveResult) => {
        const socket = connect({ host, port });
        const chunks: Buffer[] = [];
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (result: {
          status: MalwareScanStatus;
          signature?: string;
        }) => {
          if (!settled) {
            settled = true;
            if (timer) clearTimeout(timer);
            socket.destroy();
            resolveResult(result);
          }
        };
        const inspectResponse = (final: boolean) => {
          if (settled) return;
          const response = Buffer.concat(chunks);
          const terminator = response.indexOf(0);
          if (terminator < 0) {
            if (final || response.length > 4_096) finish({ status: "failed" });
            return;
          }
          const value = response
            .subarray(0, terminator)
            .toString("utf8")
            .trim();
          if (/^stream: .+ FOUND$/i.test(value))
            return finish({ status: "infected", signature: value });
          finish(
            /^stream: OK$/i.test(value)
              ? { status: "clean" }
              : { status: "failed" },
          );
        };
        timer = setTimeout(() => finish({ status: "failed" }), scanTimeoutMs);
        timer.unref();
        socket.once("error", () => finish({ status: "failed" }));
        socket.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          inspectResponse(false);
        });
        socket.once("end", () => inspectResponse(true));
        socket.once("close", () => inspectResponse(true));
        socket.once("connect", async () => {
          try {
            socket.write("zINSTREAM\0");
            for await (const chunk of Readable.fromWeb(stream as never)) {
              const value = Buffer.from(chunk as Uint8Array);
              const size = Buffer.alloc(4);
              size.writeUInt32BE(value.length);
              socket.write(size);
              socket.write(value);
            }
            socket.write(Buffer.alloc(4));
            socket.end();
          } catch {
            finish({ status: "failed" });
          }
        });
      }),
    { host, port, healthCheckTimeoutMs },
  );
}
export const mediaRetryDelay = (attempt: number) =>
  Math.min(300000, 1000 * 2 ** Math.max(0, attempt - 1));

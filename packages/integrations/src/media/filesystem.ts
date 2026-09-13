import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, link, unlink } from "node:fs/promises";
import { isAbsolute, parse, resolve, sep, dirname } from "node:path";
import { Readable } from "node:stream";
import type { ObjectStorageProvider, PutObjectInput } from "./index";

/** Private, single-server storage. The root must be outside IIS and writable
 * only by the API/worker service accounts and server administrators. */
export class FilesystemObjectStorageProvider implements ObjectStorageProvider {
  private readonly root: string;
  constructor(root: string, private readonly base: string, private readonly secret: string) {
    if (!isAbsolute(root) || resolve(root) === parse(resolve(root)).root)
      throw new Error("FILESYSTEM_STORAGE_ROOT_INVALID");
    if (new URL(base).protocol !== "https:" || secret.length < 32)
      throw new Error("FILESYSTEM_STORAGE_SIGNING_CONFIG_INVALID");
    this.root = resolve(root);
  }

  private keyPath(key: string) {
    if (!key || key.length > 512 || key.includes("\\") || key.split("/").some(
      part => !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) || part.endsWith(".") ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    )) throw new Error("STORAGE_PATH_INVALID");
    const target = resolve(this.root, key);
    if (!target.startsWith(this.root + sep)) throw new Error("STORAGE_PATH_INVALID");
    return target;
  }

  private async directory(path: string, create: boolean) {
    const volume = parse(path).root;
    let current = volume;
    for (const part of path.slice(volume.length).split(sep).filter(Boolean)) {
      current = resolve(current, part);
      if (create) {
        try { await mkdir(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("STORAGE_PATH_INVALID");
    }
  }

  async putObject(input: PutObjectInput) {
    const target = this.keyPath(input.key);
    await this.directory(dirname(target), true);
    const staging = resolve(this.root, ".staging");
    await this.directory(staging, true);
    const temporary = resolve(staging, randomUUID());
    const file = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      const source = input.body instanceof Readable ? input.body : Readable.fromWeb(input.body as never);
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 25 * 1024 * 1024) throw new Error("MEDIA_TOO_LARGE");
        hash.update(bytes);
        await file.writeFile(bytes);
      }
      await file.sync();
      await file.close();
      await this.directory(dirname(target), false);
      // Hard-link publication is atomic and refuses to replace an existing key.
      await link(temporary, target);
      return { key: input.key, size, contentType: input.contentType, sha256: hash.digest("hex") };
    } finally {
      await file.close();
      await unlink(temporary);
    }
  }

  async getObject(input: { key: string }) {
    const path = this.keyPath(input.key);
    await this.directory(dirname(path), false);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("STORAGE_PATH_INVALID");
    const file = await open(path, "r");
    try {
      const opened = await file.stat();
      if (opened.ino !== info.ino || opened.dev !== info.dev || !opened.isFile() || opened.nlink !== 1)
        throw new Error("STORAGE_PATH_INVALID");
      return Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>;
    } catch (error) { await file.close(); throw error; }
  }

  async deleteObject(input: { key: string }) {
    const path = this.keyPath(input.key);
    try {
      await this.directory(dirname(path), false);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("STORAGE_PATH_INVALID");
      await unlink(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async createSignedDownloadUrl(input: { key: string; expiresInSeconds: number; downloadFilename?: string }) {
    this.keyPath(input.key);
    if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1 || input.expiresInSeconds > 3600)
      throw new Error("SIGNED_URL_TTL_INVALID");
    const exp = Math.floor(Date.now() / 1000) + input.expiresInSeconds;
    const payload = Buffer.from(JSON.stringify({ key: input.key, exp, downloadFilename: input.downloadFilename })).toString("base64url");
    const signature = createHmac("sha256", this.secret).update("filesystem-media-v1:" + payload).digest("base64url");
    return { url: `${this.base.replace(/\/$/, "")}/api/v1/media/object?token=${payload}.${signature}`, expiresAt: new Date(exp * 1000) };
  }

  verify(token: string): { key: string; exp: number; downloadFilename?: string } | null {
    try {
      if (token.length > 4096) return null;
      const parts = token.split(".");
      if (parts.length !== 2 || !parts.every(part => /^[\w-]+$/.test(part))) return null;
      const [payload, signature] = parts as [string, string];
      const expected = createHmac("sha256", this.secret).update("filesystem-media-v1:" + payload).digest();
      const actual = Buffer.from(signature, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      const value = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (typeof value.key !== "string" || !Number.isInteger(value.exp) || value.exp <= Date.now() / 1000 ||
          value.exp > Date.now() / 1000 + 3600 ||
          (value.downloadFilename !== undefined && typeof value.downloadFilename !== "string")) return null;
      this.keyPath(value.key);
      return value;
    } catch { return null; }
  }

  async healthCheck() {
    const key = `health/${randomUUID()}`;
    try {
      await this.putObject({ key, body: Readable.from(["storage-probe"]), contentType: "text/plain" });
      const bytes = await new Response(await this.getObject({ key })).text();
      await this.deleteObject({ key });
      return { healthy: bytes === "storage-probe", provider: "filesystem" };
    } catch { return { healthy: false, provider: "filesystem" }; }
    finally { await this.deleteObject({ key }).catch(() => {}); }
  }
}

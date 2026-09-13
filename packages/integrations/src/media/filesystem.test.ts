import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { FilesystemObjectStorageProvider } from "./filesystem";
import { createObjectStorageProvider, assertProductionMediaAdapters, scanStoredObject } from "./index";

describe("private filesystem storage", () => {
  let folder: string;
  let storage: FilesystemObjectStorageProvider;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "brixchat-filesystem-test-"));
    storage = new FilesystemObjectStorageProvider(join(folder, "data"), "https://api.example.test", "s".repeat(32));
  });
  afterEach(async () => { await rm(folder, { recursive: true, force: true }); });
  const put = (key: string, value = "hello") => ({ key, body: Readable.from([value]), contentType: "text/plain" });

  it("persists complete bytes, hashes content, refuses replacement and deletes privately", async () => {
    const object = await storage.putObject(put("org-a/file.txt"));
    expect(object.size).toBe(5);
    expect(object.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    const reopened = new FilesystemObjectStorageProvider(join(folder, "data"), "https://api.example.test", "s".repeat(32));
    expect(await new Response(await reopened.getObject({ key: object.key })).text()).toBe("hello");
    await expect(storage.putObject(put(object.key, "replacement"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await new Response(await reopened.getObject({ key: object.key })).text()).toBe("hello");
    await storage.deleteObject({ key: object.key });
    await expect(storage.getObject({ key: object.key })).rejects.toMatchObject({ code: "ENOENT" });
    await storage.deleteObject({ key: object.key });
  });

  it("rejects traversal, Windows alternate streams and reserved names", async () => {
    for (const key of ["", "../outside", "org/../outside", "/outside", "C:/outside", "org\\file", "org/file:stream", "org/NUL.txt", "org/file.", "org//file", ".staging/secret"]) {
      await expect(storage.putObject(put(key))).rejects.toThrow("STORAGE_PATH_INVALID");
      await expect(storage.getObject({ key })).rejects.toThrow("STORAGE_PATH_INVALID");
      await expect(storage.deleteObject({ key })).rejects.toThrow("STORAGE_PATH_INVALID");
    }
  });

  it("refuses junctions and symbolic links without touching the target", async () => {
    await mkdir(join(folder, "outside"));
    await writeFile(join(folder, "outside", "file.txt"), "private");
    await mkdir(join(folder, "data"));
    await symlink(join(folder, "outside"), join(folder, "data", "org"), process.platform === "win32" ? "junction" : "dir");
    await expect(storage.getObject({ key: "org/file.txt" })).rejects.toThrow("STORAGE_PATH_INVALID");
    await expect(storage.putObject(put("org/new.txt"))).rejects.toThrow("STORAGE_PATH_INVALID");
    await expect(storage.deleteObject({ key: "org/file.txt" })).rejects.toThrow("STORAGE_PATH_INVALID");
    expect(await readFile(join(folder, "outside", "file.txt"), "utf8")).toBe("private");
  });

  it("removes partial writes and never publishes a failed stream", async () => {
    async function* broken() { yield Buffer.from("partial"); throw new Error("upstream failed"); }
    await expect(storage.putObject({ ...put("org/file"), body: Readable.from(broken()) })).rejects.toThrow("upstream failed");
    await expect(storage.getObject({ key: "org/file" })).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(folder, "data", ".staging"))).toEqual([]);
  });

  it("enforces the size limit and permits only one concurrent writer per key", async () => {
    await expect(storage.putObject({ ...put("org/large"), body: Readable.from([Buffer.alloc(25 * 1024 * 1024 + 1)]) })).rejects.toThrow("MEDIA_TOO_LARGE");
    const results = await Promise.allSettled([storage.putObject(put("org/same", "one")), storage.putObject(put("org/same", "two"))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await readdir(join(folder, "data", ".staging"))).toEqual([]);
  });

  it("validates signatures, expiry and token structure", async () => {
    const signed = await storage.createSignedDownloadUrl({ key: "org/file", expiresInSeconds: 60 });
    const token = new URL(signed.url).searchParams.get("token")!;
    expect(storage.verify(token)?.key).toBe("org/file");
    expect(storage.verify(token + ".extra")).toBeNull();
    expect(storage.verify("broken")).toBeNull();
    const parts = token.split(".");
    expect(storage.verify(Buffer.from(JSON.stringify({ key: "other-org/file", exp: Date.now() / 1000 + 60 })).toString("base64url") + "." + parts[1])).toBeNull();
    const other = new FilesystemObjectStorageProvider(join(folder, "other"), "https://api.example.test", "x".repeat(32));
    expect(other.verify(token)).toBeNull();
    await expect(storage.createSignedDownloadUrl({ key: "org/file", expiresInSeconds: 3601 })).rejects.toThrow("SIGNED_URL_TTL_INVALID");
  });

  it("keeps fail-closed scanner cleanup and checks real disk operations", async () => {
    await storage.putObject(put("org/blocked"));
    await expect(scanStoredObject({ storage, key: "org/blocked", scanner: {
      scan: async () => ({ status: "infected" }), healthCheck: async () => ({ healthy: true }),
    } })).rejects.toMatchObject({ code: "MEDIA_INFECTED" });
    await expect(storage.getObject({ key: "org/blocked" })).rejects.toMatchObject({ code: "ENOENT" });
    expect(await storage.healthCheck()).toEqual({ healthy: true, provider: "filesystem" });
  });

  it("requires explicit production configuration and a real scanner", () => {
    const env = { APP_ENV: "production", OBJECT_STORAGE_PROVIDER: "filesystem", OBJECT_STORAGE_FILESYSTEM_ROOT: join(folder, "data"), APP_ENCRYPTION_KEY: "s".repeat(32), API_PUBLIC_URL: "https://api.example.test", MALWARE_SCANNER_PROVIDER: "clamav" };
    expect(createObjectStorageProvider(env)).toBeInstanceOf(FilesystemObjectStorageProvider);
    expect(() => assertProductionMediaAdapters(env)).not.toThrow();
    expect(() => assertProductionMediaAdapters({ ...env, MALWARE_SCANNER_PROVIDER: "noop" })).toThrow("PRODUCTION_MALWARE_SCANNER_PROVIDER_REQUIRED");
    expect(() => createObjectStorageProvider({ ...env, OBJECT_STORAGE_FILESYSTEM_ROOT: "relative" })).toThrow("FILESYSTEM_STORAGE_ROOT_INVALID");
    expect(() => createObjectStorageProvider({ ...env, APP_ENCRYPTION_KEY: "" })).toThrow("FILESYSTEM_STORAGE_CONFIG_REQUIRED");
  });
});

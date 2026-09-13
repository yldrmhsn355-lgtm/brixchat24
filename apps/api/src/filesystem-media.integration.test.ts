import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

const url = process.env.SCOPED_ROUTER_TEST_DATABASE_URL;
describe.skipIf(!url)("filesystem media HTTP with real PostgreSQL and ClamAV", () => {
  const sql = postgres(url!, { max: 3, onnotice: () => {} });
  const org = randomUUID(), otherOrg = randomUUID(), user = randomUUID();
  const channel = randomUUID(), contact = randomUUID(), conversation = randomUUID();
  let app: ReturnType<typeof buildApp>;
  let folder = "";
  let verified = false;
  let headers: { authorization: string };
  let otherHeaders: { authorization: string };
  const config: NodeJS.ProcessEnv = {
    OBJECT_STORAGE_PROVIDER: "filesystem", APP_ENCRYPTION_KEY: "s".repeat(32),
    MALWARE_SCANNER_PROVIDER: "clamav", CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: "3311",
  };
  beforeAll(async () => {
    if (!/restore|test/.test(new URL(url!).pathname)) throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
    verified = true;
    folder = await mkdtemp(join(tmpdir(), "brixchat-media-http-"));
    config.OBJECT_STORAGE_FILESYSTEM_ROOT = folder;
    await sql`INSERT INTO organizations(id,name,slug) VALUES(${org},'Media test',${org}),(${otherOrg},'Other media test',${otherOrg})`;
    await sql`INSERT INTO users(id,email,full_name,password_hash) VALUES(${user},${`${user}@example.invalid`},'Media test','login-disabled')`;
    await sql`INSERT INTO organization_members(organization_id,user_id,role) VALUES(${org},${user},'owner'),(${otherOrg},${user},'owner')`;
    await sql`INSERT INTO channels(id,organization_id,name,provider,status) VALUES(${channel},${org},'Test channel','whatsapp_web','connected')`;
    await sql`INSERT INTO contacts(id,organization_id,first_name,display_name,normalized_phone) VALUES(${contact},${org},'Test','Test contact','15551234567')`;
    await sql`INSERT INTO conversations(id,organization_id,channel_id,contact_id,status,customer_service_window_expires_at) VALUES(${conversation},${org},${channel},${contact},'open',now()+interval '1 hour')`;
    app = buildApp({ databaseUrl: url, scopedDatabaseUrl: process.env.API_SCOPED_TEST_DATABASE_URL,
      jwtSecret: "media-test-secret-at-least-32-characters", appEncryptionKey: "s".repeat(32),
      apiPublicUrl: "https://api.example.test", webUrl: "https://web.example.test", configEnv: config });
    await app.ready();
    headers = { authorization: `Bearer ${app.jwt.sign({ sub: user, organizationId: org, role: "owner" })}` };
    otherHeaders = { authorization: `Bearer ${app.jwt.sign({ sub: user, organizationId: otherOrg, role: "owner" })}` };
  }, 30000);
  afterAll(async () => {
    if (app) await app.close();
    if (verified) {
      await sql`DELETE FROM outbox_jobs WHERE organization_id IN (${org},${otherOrg})`;
      await sql`DELETE FROM organizations WHERE id IN (${org},${otherOrg})`;
      await sql`DELETE FROM users WHERE id=${user}`;
    }
    await sql.end();
    // Only this test's generated temporary directory may be removed.
    if (folder && resolve(folder).startsWith(resolve(tmpdir()) + requireSeparator()) && folder.includes("brixchat-media-http-"))
      await rm(folder, { recursive: true, force: true });
  });
  function requireSeparator() { return process.platform === "win32" ? "\\" : "/"; }
  it("uploads, scans and downloads bytes while refusing another tenant and invalid tokens", async () => {
    const content = "Private attachment integration verification.";
    const upload = await app.inject({ method: "POST", url: `/api/v1/media/uploads?conversationId=${conversation}`,
      headers: { ...headers, "content-type": "application/octet-stream", "x-filename": "test.txt", "x-mime-type": "text/plain" }, payload: Buffer.from(content) });
    expect(upload.statusCode, upload.body).toBe(201);
    const attachment = upload.json().data.attachmentId;
    const record = await sql`SELECT scan_status,storage_provider,storage_key FROM message_attachments WHERE id=${attachment}`;
    expect(record[0]?.scan_status).toBe("clean");
    expect(record[0]?.storage_provider).toBe("filesystem");
    const denied = await app.inject({ method: "POST", url: `/api/v1/attachments/${attachment}/download-url`, headers: otherHeaders });
    expect(denied.statusCode).toBe(409);
    const foreignUpload = await app.inject({ method: "POST", url: `/api/v1/media/uploads?conversationId=${conversation}`,
      headers: { ...otherHeaders, "content-type": "application/octet-stream", "x-mime-type": "text/plain" }, payload: Buffer.from(content) });
    expect(foreignUpload.statusCode).toBe(404);
    const signed = await app.inject({ method: "POST", url: `/api/v1/attachments/${attachment}/download-url`, headers });
    expect(signed.statusCode, signed.body).toBe(200);
    const link = new URL(signed.json().data.url);
    const downloaded = await app.inject({ method: "GET", url: link.pathname + link.search });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.body).toBe(content);
    expect(downloaded.headers["content-disposition"]).toContain("attachment;");
    const tampered = await app.inject({ method: "GET", url: link.pathname + link.search + ".invalid" });
    expect(tampered.statusCode).toBe(403);
    // No worker runs on this isolated database; this queued message is never sent.
    const pending = await sql`SELECT count(*)::int count FROM outbox_jobs WHERE organization_id=${org}`;
    expect(pending[0]?.count).toBe(1);
  }, 30000);
  it("rejects uploads when the scanner is unavailable without leaving a file or queue job", async () => {
    const files = async () => (await readdir(folder, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
    const beforeFiles = await files();
    const beforeJobs = await sql`SELECT count(*)::int count FROM outbox_jobs WHERE organization_id=${org}`;
    const unavailable = buildApp({ databaseUrl: url, scopedDatabaseUrl: process.env.API_SCOPED_TEST_DATABASE_URL,
      jwtSecret: "media-test-secret-at-least-32-characters", appEncryptionKey: "s".repeat(32),
      apiPublicUrl: "https://api.example.test", webUrl: "https://web.example.test",
      configEnv: { ...config, CLAMAV_PORT: "9" } });
    try {
      const response = await unavailable.inject({ method: "POST", url: `/api/v1/media/uploads?conversationId=${conversation}`,
        headers: { ...headers, "content-type": "application/octet-stream", "x-filename": "blocked.txt", "x-mime-type": "text/plain" }, payload: Buffer.from("Scanner unavailable probe") });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json().error.code).toBe("MEDIA_SCAN_FAILED");
      expect(await files()).toEqual(beforeFiles);
      const afterJobs = await sql`SELECT count(*)::int count FROM outbox_jobs WHERE organization_id=${org}`;
      expect(afterJobs[0]?.count).toBe(beforeJobs[0]?.count);
    } finally { await unavailable.close(); }
  }, 30000);
});

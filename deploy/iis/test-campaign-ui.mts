import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import { createRequire } from "node:module";
const postgres = createRequire(new URL("../../packages/database/package.json", import.meta.url))("postgres");
import { buildApp } from "../../apps/api/src/app";

const url = process.env.SCOPED_ROUTER_TEST_DATABASE_URL;
if (!url || !/restore|test/.test(new URL(url).pathname)) throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
if (new URL(process.env.API_SCOPED_TEST_DATABASE_URL!).pathname !== new URL(url).pathname) throw new Error("DATABASE_MISMATCH");
const sql = postgres(url, { max: 2, onnotice: () => {} });
const org = randomUUID(), user = randomUUID(), channel = randomUUID();
const output = "C:/ProgramData/Brixchat24/logs";
mkdirSync(output, { recursive: true });
const app = buildApp({ databaseUrl: url, scopedDatabaseUrl: process.env.API_SCOPED_TEST_DATABASE_URL,
  jwtSecret: randomBytes(32).toString("hex"), webUrl: "http://127.0.0.1:3320" });
let web: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await sql`INSERT INTO organizations(id,name,slug) VALUES(${org},'Kampanya test firması',${org})`;
  await sql`INSERT INTO users(id,email,full_name,password_hash) VALUES(${user},${`${user}@example.invalid`},'Test Yönetici','login-disabled')`;
  await sql`INSERT INTO organization_members(organization_id,user_id,role) VALUES(${org},${user},'owner')`;
  await sql`INSERT INTO channels(id,organization_id,name,phone_number,provider,status) VALUES(${channel},${org},'Test WhatsApp Hattı','+15550001111','meta','connected')`;
  const [contact] = await sql`INSERT INTO contacts(organization_id,first_name,display_name,normalized_phone) VALUES(${org},'Deneme','Deneme Alıcısı','+15550002222') RETURNING id`;
  await sql`INSERT INTO conversations(organization_id,channel_id,contact_id,status,customer_service_window_expires_at) VALUES(${org},${channel},${contact!.id},'open',now()+interval '1 hour')`;
  await sql`INSERT INTO consent_records(organization_id,subject_reference_hash,purpose,status,source) VALUES(${org},encode(sha256(convert_to('+15550002222','UTF8')),'hex'),'whatsapp','granted','isolated-ui-test')`;
  await app.listen({ host: "127.0.0.1", port: 4420 });
  const log = createWriteStream(`${output}/campaign-web-test.log`, { flags: "a" });
  web = spawn(process.execPath, ["apps/web/node_modules/next/dist/bin/next", "dev", "apps/web", "-H", "127.0.0.1", "-p", "3320"], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: "development", NEXT_PUBLIC_API_URL: "http://127.0.0.1:4420", NEXT_TELEMETRY_DISABLED: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  web.stdout!.pipe(log); web.stderr!.pipe(log);
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (web.exitCode !== null) throw new Error("WEB_TEST_PROCESS_EXITED");
    try { const response = await fetch("http://127.0.0.1:3320/login", { signal: AbortSignal.timeout(3000) }); if (response.ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error("WEB_TEST_START_TIMEOUT");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const token = app.jwt.sign({ sub: user, organizationId: org, role: "owner", email: `${user}@example.invalid` });
  await context.addInitScript((value) => localStorage.setItem("brixchat_access_token", value), token);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:3320/app/campaigns", { timeout: 90000 });
  await expect(page.getByLabel("Kampanya adı", { exact: true })).toBeVisible({ timeout: 45000 });
  await page.getByLabel("Kampanya adı", { exact: true }).fill("Eylül bilgilendirmesi — test");
  await page.getByLabel("Gönderici WhatsApp hattı").selectOption(channel);
  await page.getByLabel("Mesaj", { exact: true }).fill("Merhaba, bu yalnızca gönderimsiz test ön izlemesidir.");
  await page.getByLabel("Alıcı CSV dosyası").setInputFiles({ name: "recipients.csv", mimeType: "text/csv", buffer: Buffer.from("telefon,isim\n+15550002222,Deneme Alıcısı\n0015550002222,Tekrar\n123,Geçersiz\n+15550003333,Seçilmeyecek") });
  await expect(page.getByText("2 geçerli alıcı · 1 tekrar ayıklandı · 1 hatalı satır")).toBeVisible();
  await page.getByRole("checkbox", { name: /Seçilmeyecek/ }).uncheck();
  await page.getByRole("button", { name: "Taslağı oluştur · 1 alıcı" }).click();
  await expect(page.getByRole("button", { name: "Mesaj göndermeden dene (dry-run)" })).toBeVisible();
  await page.getByRole("button", { name: "Mesaj göndermeden dene (dry-run)" }).click();
  await expect(page.getByText(/1 uygun · 0 engelli alıcı/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Gerçek gönderimi başlat" })).toBeDisabled();
  const [counts] = await sql`SELECT (SELECT count(*)::int FROM messages WHERE organization_id=${org}) messages,(SELECT count(*)::int FROM outbox_jobs WHERE organization_id=${org}) jobs`;
  expect(counts).toMatchObject({ messages: 0, jobs: 0 });
  await page.screenshot({ path: `${output}/campaign-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/campaign-mobile.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ status: "passed", csvSelection: true, dryRunEligible: 1, messages: 0, outboxJobs: 0, explicitConfirmationRequired: true, desktop: "campaign-desktop.png", mobile: "campaign-mobile.png" }));
} finally {
  if (browser) await browser.close();
  if (web?.pid && web.exitCode === null) spawnSync("taskkill.exe", ["/PID", String(web.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  await app.close();
  await sql`DELETE FROM campaigns WHERE organization_id=${org}`;
  await sql`DELETE FROM organizations WHERE id=${org}`;
  await sql`DELETE FROM users WHERE id=${user}`;
  await sql.end();
}

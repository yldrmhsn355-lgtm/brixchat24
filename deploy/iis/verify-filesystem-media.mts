import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { FilesystemObjectStorageProvider, createMalwareScanner, scanStoredObject } from "../../packages/integrations/src/media/index";
const storage = new FilesystemObjectStorageProvider("C:/ProgramData/Brixchat24/media", "https://api.brixchat24.com", randomUUID());
const scanner = createMalwareScanner({ MALWARE_SCANNER_PROVIDER: "clamav", CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: "3311" });
const key = `verification/${randomUUID()}.txt`;
const content = "Brixchat24 private storage and real ClamAV verification.";
try {
  const stored = await storage.putObject({ key, contentType: "text/plain", body: Readable.from([content]) });
  const scan = await scanStoredObject({ storage, scanner, key });
  const received = await new Response(await storage.getObject({ key })).text();
  const signed = await storage.createSignedDownloadUrl({ key, expiresInSeconds: 60 });
  const token = new URL(signed.url).searchParams.get("token")!;
  const health = await storage.healthCheck();
  const report = { at: new Date().toISOString(), scan: scan.status, bytesMatch: received === content, size: stored.size, signedTokenValid: storage.verify(token)?.key === key, diskHealth: health.healthy };
  writeFileSync("C:/ProgramData/Brixchat24/logs/filesystem-media-verification.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (scan.status !== "clean" || !report.bytesMatch || !report.signedTokenValid || !health.healthy) throw new Error("Filesystem media verification failed");
} finally { await storage.deleteObject({ key }); }

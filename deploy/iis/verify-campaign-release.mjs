import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
const postgres = createRequire(new URL("../../packages/database/package.json", import.meta.url))("postgres");
const env = parseEnv(readFileSync("C:/ProgramData/Brixchat24/live/admin.env", "utf8"));
if (new URL(env.DATABASE_URL).pathname !== "/brixchat_live") throw new Error("LIVE_DATABASE_REQUIRED");
const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  const [migrations] = await sql`SELECT count(*)::int total FROM drizzle.__drizzle_migrations`;
  const channels = await sql`SELECT c.provider,c.status,s.status session_status,count(*)::int total
    FROM channels c LEFT JOIN whatsapp_web_sessions s ON s.channel_id=c.id AND s.organization_id=c.organization_id
    WHERE c.deleted_at IS NULL GROUP BY c.provider,c.status,s.status`;
  const [campaigns] = await sql`SELECT count(*)::int total FROM campaigns`;
  const rls = await sql`SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('campaigns','campaign_recipients') AND relnamespace='public'::regnamespace`;
  const [queues] = await sql`SELECT count(*)::int pending FROM outbox_jobs WHERE status IN ('pending','processing','retry')`;
  const result = { checkedAt: new Date().toISOString(), migrations: migrations.total, channels, campaigns: campaigns.total, rls, pendingOutbox: queues.pending };
  writeFileSync("C:/ProgramData/Brixchat24/logs/campaign-live-verification.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await sql.end(); }

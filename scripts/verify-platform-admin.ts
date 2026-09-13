import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { PlatformAdminRepository } from "../packages/database/src/index";
import {
  collectPlatformAlerts,
  persistPlatformAlerts,
} from "../apps/worker/src/platform-alerts";

function envValue(file: string, key: string) {
  const line = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((item) => item.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} is missing from verification environment`);
  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

const adminEnv = process.env.BRIXCHAT_ADMIN_ENV;
if (!adminEnv) throw new Error("BRIXCHAT_ADMIN_ENV is required");
const sourceUrl = new URL(envValue(adminEnv, "DATABASE_URL"));
const databaseName = `brixchat_platform_verify_${Date.now()}`;
const maintenanceUrl = new URL(sourceUrl);
maintenanceUrl.pathname = "/postgres";
const targetUrl = new URL(sourceUrl);
targetUrl.pathname = `/${databaseName}`;
const maintenance = postgres(maintenanceUrl.toString(), { max: 1 });
let target: ReturnType<typeof postgres> | null = null;

try {
  await maintenance.unsafe(`CREATE DATABASE ${databaseName}`);
  target = postgres(targetUrl.toString(), { max: 4 });
  await migrate(drizzle(target), {
    migrationsFolder: path.resolve("packages/database/migrations"),
  });
  await target`INSERT INTO organizations(name,slug)
    SELECT 'Performans firması '||n,'platform-perf-'||n FROM generate_series(1,10000) n`;
  await target`INSERT INTO users(email,password_hash,full_name,email_verified_at)
    SELECT 'platform-perf-'||n||'@example.test','verification-only','Performans Kullanıcısı '||n,now()
    FROM generate_series(1,100000) n`;
  await target`INSERT INTO organization_members(organization_id,user_id,role)
    SELECT organization.id,user_row.id,'agent'
    FROM (SELECT id,row_number() OVER(ORDER BY id) n FROM organizations WHERE slug LIKE 'platform-perf-%') organization
    JOIN (SELECT id,row_number() OVER(ORDER BY id) n FROM users WHERE email LIKE 'platform-perf-%') user_row
      ON ((user_row.n-1)%10000)+1=organization.n`;
  await target.unsafe(
    "ANALYZE organizations; ANALYZE users; ANALYZE organization_members; ANALYZE channels; ANALYZE integration_connections;",
  );
  const [actor] = await target<
    Array<{ id: string }>
  >`INSERT INTO users(email,password_hash,full_name,is_platform_admin,email_verified_at) VALUES('verification-admin@example.test','verification-only','Verification Admin',true,now()) RETURNING id`;
  const [pending] = await target<
    Array<{ id: string }>
  >`INSERT INTO organizations(name,slug,operational_status,activation_status,activation_requested_at) VALUES('Pending Verification','pending-verification','pending_review','pending',now()) RETURNING id`;
  const repository = new PlatformAdminRepository(target);
  const approved = await repository.approveOrganization({
    organizationId: pending!.id,
    actorId: actor!.id,
    planCode: "trial",
    trialDays: 14,
  });
  if (!approved?.updated) throw new Error("approval verification failed");
  const [state] = await target<
    Array<{ operational_status: string; trial_status: string; days: number }>
  >`SELECT o.operational_status,e.trial_status,round(extract(epoch FROM(e.trial_ends_at-e.trial_started_at))/86400)::int days FROM organizations o JOIN organization_entitlements e ON e.organization_id=o.id WHERE o.id=${pending!.id}::uuid`;
  if (
    state?.operational_status !== "active" ||
    state.trial_status !== "active" ||
    state.days !== 14
  )
    throw new Error("approval trial invariant failed");
  await target`INSERT INTO worker_instances(instance_id,service,version,last_heartbeat,status) VALUES('verification-stale','worker','test',now()-interval '2 minutes','healthy')`;
  const firstScan = await collectPlatformAlerts(target);
  await persistPlatformAlerts(target, firstScan);
  await persistPlatformAlerts(target, firstScan);
  const [deduplicated] = await target<
    Array<{ count: number }>
  >`SELECT count(*)::int count FROM platform_alerts WHERE category='worker'`;
  if (deduplicated?.count !== 1) throw new Error("alert deduplication failed");
  await target`DELETE FROM worker_instances WHERE instance_id='verification-stale'`;
  await persistPlatformAlerts(target, await collectPlatformAlerts(target));
  await persistPlatformAlerts(target, await collectPlatformAlerts(target));
  const [resolved] = await target<
    Array<{ status: string }>
  >`SELECT status FROM platform_alerts WHERE category='worker'`;
  if (resolved?.status !== "resolved")
    throw new Error("alert resolution failed");
  const timings: number[] = [];
  for (let index = 0; index < 20; index++) {
    const start = performance.now();
    await repository.listOrganizations({
      term: null,
      limit: 50,
      offset: index * 50,
      sort: "created_at",
      direction: "DESC",
      status: null,
      plan: null,
      trial: null,
      health: null,
      createdFrom: null,
      createdTo: null,
    });
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.ceil(timings.length * 0.95) - 1]!;
  if (p95 >= 500)
    throw new Error(`organization list p95 exceeded: ${p95.toFixed(1)}ms`);
  process.stdout.write(
    JSON.stringify({
      migrations: "ok",
      organizations: 10001,
      users: 100001,
      approval: "ok",
      alerts: "deduplicated-and-resolved",
      listP95Ms: Number(p95.toFixed(1)),
    }) + "\n",
  );
} finally {
  if (target) await target.end({ timeout: 5 }).catch(() => undefined);
  await maintenance
    .unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`)
    .catch(() => undefined);
  await maintenance.end({ timeout: 5 });
}

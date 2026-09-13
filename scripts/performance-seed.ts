import { mkdir, writeFile } from "node:fs/promises";
import postgres from "postgres";

async function main() {
const profile =
  process.argv.find((x) => x.startsWith("--profile="))?.split("=")[1] ??
  "small";
if (!["small", "standard"].includes(profile))
  throw new Error("profile must be small or standard");
if (
  profile === "standard" &&
  process.env.PERFORMANCE_SEED_CONFIRM !== "STANDARD"
)
  throw new Error(
    "Standard profile requires PERFORMANCE_SEED_CONFIRM=STANDARD",
  );
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const count = profile === "standard" ? 100000 : 1000;
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const [org] =
  await sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`;
if (!org) throw new Error("Seed an organization first");
await sql`INSERT INTO usage_events(organization_id,event_key,metric,quantity,occurred_at) SELECT ${org.id},'perf-'||${profile}||'-'||g,'monthly_outgoing_messages',1,now()-(g % 30 || ' days')::interval FROM generate_series(1,${count}) g ON CONFLICT DO NOTHING`;
const plans =
  await sql`EXPLAIN (FORMAT JSON) SELECT metric,sum(quantity) FROM usage_events WHERE organization_id=${org.id} AND occurred_at >= date_trunc('month',now()) GROUP BY metric`;
await mkdir("artifacts/performance", { recursive: true });
await writeFile(
  "artifacts/performance/query-plans.json",
  JSON.stringify({ profile, count, plans }, null, 2),
);
await sql.end();
process.stdout.write(
  JSON.stringify({ status: "seeded", profile, count }) + "\n",
);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

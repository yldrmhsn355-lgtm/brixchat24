import postgres from "postgres";

const command = process.argv[2];
const args = Object.fromEntries(
  process.argv
    .slice(3)
    .filter((x) => x.startsWith("--"))
    .map((x) => {
      const [key, ...value] = x.slice(2).split("=");
      return [key, value.join("=") || "true"];
    }),
);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = postgres(databaseUrl, { max: 1 });
const slug = args.slug;
function requireSlug() {
  if (!slug) throw new Error("--slug is required");
  if (
    process.env.NODE_ENV === "production" &&
    process.env.TENANT_OPERATION_CONFIRM !== slug
  )
    throw new Error(
      "Production operation requires TENANT_OPERATION_CONFIRM=<slug>",
    );
}
try {
  if (command === "list") {
    const rows =
      await sql`SELECT o.slug,o.name,o.operational_status,p.code AS plan,e.trial_status,e.trial_ends_at FROM organizations o LEFT JOIN organization_entitlements e ON e.organization_id=o.id LEFT JOIN plans p ON p.id=e.plan_id ORDER BY o.created_at`;
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  } else if (command === "create") {
    requireSlug();
    if (!args.name || !args.plan)
      throw new Error("--name and --plan are required");
    await sql.begin(async (tx) => {
      const [org] =
        await tx`INSERT INTO organizations(name,slug) VALUES(${args.name},${slug}) RETURNING id`;
      const [plan] =
        await tx`SELECT id FROM plans WHERE code=${args.plan} AND active=true`;
      if (!plan) throw new Error("Active plan not found");
      const trialDays = Number(args["trial-days"] ?? 0);
      await tx`INSERT INTO organization_entitlements(organization_id,plan_id,trial_started_at,trial_ends_at,trial_status) VALUES(${org.id},${plan.id},${trialDays ? new Date() : null},${trialDays ? new Date(Date.now() + trialDays * 86400000) : null},${trialDays ? "active" : "inactive"})`;
      await tx`INSERT INTO tenant_provisioning_audit(organization_id,action,actor,details) VALUES(${org.id},'create',${process.env.TENANT_ACTOR ?? "cli"},${tx.json({ plan: args.plan, ownerEmailProvided: Boolean(args["owner-email"]) })})`;
    });
    process.stdout.write(JSON.stringify({ status: "created", slug }) + "\n");
  } else if (command === "disable" || command === "enable") {
    requireSlug();
    const disabled = command === "disable";
    const rows =
      await sql`UPDATE organizations SET operational_status=${disabled ? "disabled" : "active"},disabled_at=${disabled ? new Date() : null},updated_at=now() WHERE slug=${slug} RETURNING id`;
    if (!rows.length) throw new Error("Tenant not found");
    await sql`INSERT INTO tenant_provisioning_audit(organization_id,action,actor) VALUES(${rows[0].id},${command},${process.env.TENANT_ACTOR ?? "cli"})`;
  } else if (command === "assign-plan") {
    requireSlug();
    if (!args.plan) throw new Error("--plan is required");
    const rows =
      await sql`UPDATE organization_entitlements e SET plan_id=p.id,updated_at=now() FROM organizations o,plans p WHERE e.organization_id=o.id AND o.slug=${slug} AND p.code=${args.plan} AND p.active=true RETURNING e.organization_id`;
    if (!rows.length) throw new Error("Tenant or plan not found");
    await sql`INSERT INTO tenant_provisioning_audit(organization_id,action,actor,details) VALUES(${rows[0].organization_id},'assign_plan',${process.env.TENANT_ACTOR ?? "cli"},${sql.json({ plan: args.plan })})`;
  } else if (command === "usage") {
    requireSlug();
    const rows =
      await sql`SELECT r.usage_date,r.metric,r.quantity FROM usage_daily_rollups r JOIN organizations o ON o.id=r.organization_id WHERE o.slug=${slug} ORDER BY r.usage_date DESC,r.metric LIMIT 100`;
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  } else throw new Error("Unknown tenant command");
} finally {
  await sql.end();
}

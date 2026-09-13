import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import type { Permission } from "@brixchat/auth";
import { safeEqual, validateProductionConfig } from "@brixchat/integrations";
import { deploymentMetadata } from "./deployment-metadata";

type Row = Record<string, unknown>;
type Authorize = (
  permission: Permission,
) => (request: FastifyRequest) => Promise<void>;

export async function mutationEntitlement(
  sql: Sql,
  organizationId: string,
  metric = "outgoing_messages",
) {
  const rows = await sql<Row[]>`
    SELECT o.operational_status,e.trial_status,e.trial_ends_at,e.grace_ends_at,
      COALESCE(l.hard_limit,(p.limits->>${metric})::bigint,(p.limits->>'monthly_outgoing_messages')::bigint) hard_limit,
      COALESCE((SELECT sum(quantity) FROM usage_events u WHERE u.organization_id=o.id AND u.metric=${metric} AND u.occurred_at>=date_trunc('month',now())),0)::bigint usage
    FROM organizations o
    LEFT JOIN organization_entitlements e ON e.organization_id=o.id
    LEFT JOIN plans p ON p.id=e.plan_id
    LEFT JOIN organization_usage_limits l ON l.organization_id=o.id AND l.metric=${metric}
    WHERE o.id=${organizationId}::uuid`;
  const value = rows[0];
  if (!value || value.operational_status !== "active")
    return { allowed: false, code: "organization_disabled" };
  if (
    value.trial_status === "expired" ||
    (value.trial_status === "active" &&
      value.trial_ends_at &&
      new Date(String(value.trial_ends_at)) < new Date()) ||
    (value.trial_status === "grace" &&
      value.grace_ends_at &&
      new Date(String(value.grace_ends_at)) < new Date())
  )
    return { allowed: false, code: "trial_expired" };
  if (
    value.hard_limit !== null &&
    value.hard_limit !== undefined &&
    Number(value.usage) >= Number(value.hard_limit)
  )
    return { allowed: false, code: "plan_limit_exceeded" };
  return { allowed: true, code: null };
}

export async function recordUsage(
  sql: Sql,
  input: {
    organizationId: string;
    eventKey: string;
    metric: string;
    quantity?: number;
  },
) {
  const inserted = await sql<Row[]>`
    INSERT INTO usage_events(organization_id,event_key,metric,quantity)
    VALUES(${input.organizationId}::uuid,${input.eventKey},${input.metric},${input.quantity ?? 1})
    ON CONFLICT(organization_id,event_key) DO NOTHING RETURNING id`;
  if (inserted[0])
    await sql`INSERT INTO usage_daily_rollups(organization_id,usage_date,metric,quantity)
      VALUES(${input.organizationId}::uuid,current_date,${input.metric},${input.quantity ?? 1})
      ON CONFLICT(organization_id,usage_date,metric) DO UPDATE SET quantity=usage_daily_rollups.quantity+excluded.quantity,updated_at=now()`;
  return Boolean(inserted[0]);
}

export function registerMilestone6Routes(
  app: FastifyInstance,
  sql: Sql,
  options: {
    authorize: Authorize;
    environment: string;
    configEnv: NodeJS.ProcessEnv;
    internalOperationsToken?: string;
  },
) {
  app.get("/health/configuration", async (request) => {
    const result = validateProductionConfig(options.configEnv);
    // The endpoint stays public per MILESTONE-6-SPEC FR-3, but per-check
    // detail (e.g. "jwt secret is weak") is a roadmap for an attacker;
    // anonymous callers only learn the overall verdict.
    let authenticated = false;
    try {
      const claims = await request.jwtVerify<{ aud?: string }>();
      authenticated = claims.aud !== "realtime";
    } catch {
      authenticated = false;
    }
    const providedOperationsToken =
      request.headers["x-internal-operations-token"];
    const internal = Boolean(
      options.internalOperationsToken &&
        typeof providedOperationsToken === "string" &&
        safeEqual(providedOperationsToken, options.internalOperationsToken),
    );
    return {
      data: {
        environment: options.environment,
        valid: result.valid,
        ...(authenticated || internal ? { checks: result.checks } : {}),
      },
    };
  });
  app.get("/version", async () => {
    const migration = await sql<Row[]>`
      SELECT count(*)::text version FROM drizzle.__drizzle_migrations`;
    return {
      data: {
        ...deploymentMetadata(options.configEnv),
        environment: options.environment,
        migrationVersion: String(migration[0]?.version ?? "unknown"),
      },
    };
  });

  app.get(
    "/api/v1/usage/current",
    { preHandler: options.authorize("usage:read") },
    async (request) => {
      const org = request.claims!.organizationId;
      const rows = await sql<Row[]>`
        SELECT metric,sum(quantity)::bigint quantity FROM usage_events
        WHERE organization_id=${org}::uuid AND occurred_at>=date_trunc('month',now()) GROUP BY metric`;
      const entitlement = (
        await sql<Row[]>`
          SELECT p.code,p.limits,e.trial_status,e.trial_ends_at,e.grace_ends_at,e.overrides
          FROM organization_entitlements e JOIN plans p ON p.id=e.plan_id WHERE e.organization_id=${org}::uuid`
      )[0];
      return {
        data: {
          period: new Date().toISOString().slice(0, 7),
          metrics: Object.fromEntries(
            rows.map((x) => [String(x.metric), Number(x.quantity)]),
          ),
          plan: entitlement?.code ?? null,
          limits: entitlement?.limits ?? {},
          trial: entitlement
            ? {
                status: entitlement.trial_status,
                endsAt: entitlement.trial_ends_at,
                graceEndsAt: entitlement.grace_ends_at,
              }
            : null,
        },
      };
    },
  );
  app.get(
    "/api/v1/usage/history",
    { preHandler: options.authorize("usage:read") },
    async (request) => ({
      data: await sql`SELECT usage_date,metric,quantity FROM usage_daily_rollups WHERE organization_id=${request.claims!.organizationId}::uuid ORDER BY usage_date DESC,metric LIMIT 400`,
    }),
  );

  const privacySchema = z.object({
    subjectReference: z.string().min(3).max(500),
    type: z.enum(["export", "delete", "restrict"]),
    reason: z.string().max(1000).optional(),
  });
  app.get(
    "/api/v1/privacy/requests",
    { preHandler: options.authorize("privacy:read") },
    async (request) => ({
      data: await sql`SELECT id,request_type,status,legal_hold_conflict,requested_at,completed_at,updated_at FROM privacy_requests WHERE organization_id=${request.claims!.organizationId}::uuid ORDER BY requested_at DESC`,
    }),
  );
  app.post(
    "/api/v1/privacy/requests",
    { preHandler: options.authorize("privacy:manage") },
    async (request, reply) => {
      const body = privacySchema.parse(request.body),
        hash = createHash("sha256")
          .update(
            `${request.claims!.organizationId}:${body.subjectReference.trim().toLowerCase()}`,
          )
          .digest("hex"),
        hold =
          (
            await sql<
              Row[]
            >`SELECT legal_hold FROM organization_retention_settings WHERE organization_id=${request.claims!.organizationId}::uuid`
          )[0]?.legal_hold === true,
        blocked = body.type === "delete" && hold;
      const rows = await sql<Row[]>`
        INSERT INTO privacy_requests(organization_id,request_type,subject_reference_hash,reason,status,requested_by,legal_hold_conflict)
        VALUES(${request.claims!.organizationId}::uuid,${body.type},${hash},${body.reason ?? null},${blocked ? "blocked" : "requested"},${request.claims!.sub}::uuid,${blocked}) RETURNING id,request_type,status,legal_hold_conflict,requested_at`;
      await sql`INSERT INTO privacy_request_events(organization_id,request_id,event_type,actor_id,metadata)
        VALUES(${request.claims!.organizationId}::uuid,${String(rows[0]!.id)}::uuid,${blocked ? "blocked.legal_hold" : "requested"},${request.claims!.sub}::uuid,'{}')`;
      return reply.code(blocked ? 409 : 201).send({ data: rows[0] });
    },
  );
  app.post<{ Params: { id: string; transition: string } }>(
    "/api/v1/privacy/requests/:id/:transition",
    { preHandler: options.authorize("privacy:manage") },
    async (request, reply) => {
      const transition = z
          .enum(["approve", "process", "complete", "reject"])
          .parse(request.params.transition),
        next = {
          approve: "approved",
          process: "processing",
          complete: "completed",
          reject: "rejected",
        }[transition];
      const rows = await sql<Row[]>`
        UPDATE privacy_requests SET status=${next},approved_by=CASE WHEN ${transition}='approve' THEN ${request.claims!.sub}::uuid ELSE approved_by END,
          completed_at=CASE WHEN ${transition}='complete' THEN now() ELSE completed_at END,updated_at=now()
        WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid AND status<>'blocked'
        RETURNING id,request_type,status,legal_hold_conflict,requested_at,completed_at`;
      if (!rows[0])
        return reply
          .code(404)
          .send({
            error: {
              code: "privacy_request_not_found",
              message: "Request not found",
            },
          });
      await sql`INSERT INTO privacy_request_events(organization_id,request_id,event_type,actor_id,metadata) VALUES(${request.claims!.organizationId}::uuid,${request.params.id}::uuid,${next},${request.claims!.sub}::uuid,'{}')`;
      return { data: rows[0] };
    },
  );

  app.get("/api/v1/internal/operations", async (request, reply) => {
    const providedOperationsToken =
      request.headers["x-internal-operations-token"];
    if (
      !options.internalOperationsToken ||
      typeof providedOperationsToken !== "string" ||
      !safeEqual(providedOperationsToken, options.internalOperationsToken)
    )
      return reply.code(403).send({
        error: { code: "internal_access_denied", message: "Forbidden" },
      });
    const [organizations, backlog, workers, failed] = await Promise.all([
      sql<Row[]>`SELECT count(*)::int count FROM organizations`,
      sql<
        Row[]
      >`SELECT status,count(*)::int count FROM outbox_jobs GROUP BY status`,
      sql<
        Row[]
      >`SELECT service,instance_id,last_heartbeat,status,(last_heartbeat<now()-interval '30 seconds') stale FROM worker_instances ORDER BY service,last_heartbeat DESC`,
      sql<
        Row[]
      >`SELECT count(*)::int count FROM integration_connections WHERE status='error'`,
    ]);
    return {
      data: {
        organizations: Number(organizations[0]?.count ?? 0),
        queueBacklog: Object.fromEntries(
          backlog.map((x) => [String(x.status), Number(x.count)]),
        ),
        workers,
        failedIntegrations: Number(failed[0]?.count ?? 0),
      },
    };
  });
}

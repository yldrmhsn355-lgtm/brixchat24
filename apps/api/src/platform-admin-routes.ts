import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  type AuthClaims,
} from "@brixchat/auth";
import {
  type BillingRepository,
  type PlatformAdminRepository,
  type PlatformOrganizationSort,
} from "@brixchat/database";
import type { EmailProvider } from "./email";

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .min(3)
  .max(60);

function generatePassword(): string {
  return randomBytes(15).toString("base64url");
}

const organizationSorts = new Set<PlatformOrganizationSort>([
  "name",
  "created_at",
  "status",
  "plan",
]);
const memberRoleSchema = z.enum([
  "owner",
  "admin",
  "team_lead",
  "agent",
  "viewer",
]);

/**
 * Cross-tenant organization and platform-admin management, backing the web
 * equivalent of scripts/tenant-cli.ts's list/disable/enable/assign-plan
 * commands plus admin-role management. Deliberately queries across all
 * organizations/users with no organizationId scoping -- that is the point
 * of this file -- gated entirely on claims.platformAdmin, never on RBAC
 * role, since an org owner must never reach these routes.
 */
export function registerPlatformAdminRoutes(
  app: FastifyInstance,
  repository: PlatformAdminRepository,
  billing?: BillingRepository,
  options?: { email?: EmailProvider; appPublicUrl?: string },
): void {
  const requirePlatformAdmin = async (request: FastifyRequest) => {
    let claims: AuthClaims;
    try {
      claims = await request.jwtVerify<AuthClaims>();
    } catch {
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    }
    if (!claims.platformAdmin)
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    request.claims = claims;
  };

  app.get<{ Querystring: { window?: string } }>(
    "/api/v1/platform-admin/overview",
    { preHandler: requirePlatformAdmin },
    async (request) => ({
      data: await repository.platformOverview(
        request.query.window === "30d" ? 30 : 7,
      ),
    }),
  );

  app.get(
    "/api/v1/platform-admin/operations",
    { preHandler: requirePlatformAdmin },
    async () => ({ data: await repository.operations() }),
  );

  app.get<{
    Querystring: {
      status?: string;
      severity?: string;
      category?: string;
      organizationId?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/api/v1/platform-admin/alerts",
    { preHandler: requirePlatformAdmin },
    async (request) => {
      const limit = Math.min(
        Math.max(Number(request.query.limit) || 50, 1),
        200,
      );
      const offset = Math.max(Number(request.query.offset) || 0, 0);
      const result = await repository.listAlerts({
        status: request.query.status || null,
        severity: request.query.severity || null,
        category: request.query.category || null,
        organizationId: request.query.organizationId || null,
        limit,
        offset,
      });
      return {
        data: result.rows,
        page: { limit, offset, total: result.total },
      };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/platform-admin/alerts/:id/acknowledge",
    { preHandler: requirePlatformAdmin },
    async (request, reply) =>
      (await repository.acknowledgeAlert(
        request.params.id,
        request.claims!.sub,
      ))
        ? { data: { acknowledged: true } }
        : reply.code(404).send({ error: { code: "alert_not_open" } }),
  );

  app.get<{
    Querystring: {
      search?: string;
      limit?: string;
      offset?: string;
      sort?: string;
      order?: string;
      status?: string;
      plan?: string;
      trial?: string;
      health?: string;
      createdFrom?: string;
      createdTo?: string;
    };
  }>(
    "/api/v1/platform-admin/organizations",
    { preHandler: requirePlatformAdmin },
    async (request) => {
      const search = request.query.search?.trim();
      const term = search ? `%${search}%` : null;
      const limit = Math.min(
        Math.max(Number(request.query.limit) || 25, 1),
        100,
      );
      const offset = Math.max(Number(request.query.offset) || 0, 0);
      const sortKey: PlatformOrganizationSort = organizationSorts.has(
        request.query.sort as PlatformOrganizationSort,
      )
        ? (request.query.sort as PlatformOrganizationSort)
        : "created_at";
      const direction = request.query.order === "asc" ? "ASC" : "DESC";
      const result = await repository.listOrganizations({
        term,
        limit,
        offset,
        sort: sortKey,
        direction,
        status: z
          .enum(["pending_review", "active", "disabled", "rejected"])
          .nullable()
          .parse(request.query.status || null),
        plan: request.query.plan || null,
        trial: request.query.trial || null,
        health: z
          .enum(["healthy", "attention", "critical"])
          .nullable()
          .parse(request.query.health || null),
        createdFrom: request.query.createdFrom
          ? z.coerce.date().parse(request.query.createdFrom)
          : null,
        createdTo: request.query.createdTo
          ? z.coerce.date().parse(request.query.createdTo)
          : null,
      });
      return {
        data: result.rows,
        page: { limit, offset, total: result.total },
      };
    },
  );

  app.post(
    "/api/v1/platform-admin/organizations",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(2).max(120),
          slug: slugSchema,
          planCode: z.string().trim().min(1),
          trialDays: z.number().int().min(0).max(365).optional(),
          ownerEmail: z.string().trim().toLowerCase().email().optional(),
          ownerFullName: z.string().trim().min(2).max(120).optional(),
          ownerPassword: z.string().min(8).max(200).optional(),
          activateNow: z.boolean().default(true),
        })
        .parse(request.body);
      const planId = await repository.activePlanId(body.planCode);
      if (!planId)
        return reply.code(400).send({
          error: { code: "invalid_plan", message: "Geçersiz plan." },
        });
      try {
        const ownerPassword = body.ownerEmail
          ? (body.ownerPassword ?? generatePassword())
          : undefined;
        const ownerPasswordHash = ownerPassword
          ? await hashPassword(ownerPassword)
          : undefined;
        const result = await repository.createOrganization({
          name: body.name,
          slug: body.slug,
          planId,
          planCode: body.planCode,
          trialDays: body.trialDays ?? 0,
          actorId: request.claims!.sub,
          activateNow: body.activateNow,
          ...(body.ownerEmail ? { ownerEmail: body.ownerEmail } : {}),
          ...(body.ownerFullName ? { ownerFullName: body.ownerFullName } : {}),
          ...(ownerPassword ? { ownerPassword } : {}),
          ...(ownerPasswordHash ? { ownerPasswordHash } : {}),
        });
        return reply.code(201).send({
          data: {
            organizationId: result.organizationId,
            ownerCreated: result.owner?.created ?? false,
            activationStatus: body.activateNow ? "approved" : "pending",
          },
        });
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23505"
        )
          return reply.code(409).send({
            error: {
              code: "slug_unavailable",
              message: "Bu slug zaten kullanılıyor.",
            },
          });
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/platform-admin/plans",
    { preHandler: requirePlatformAdmin },
    async () => ({
      data: await repository.listPlans(),
    }),
  );

  if (billing) {
    app.get(
      "/api/v1/platform-admin/billing/overview",
      { preHandler: requirePlatformAdmin },
      async () => ({ data: await repository.billingOverview() }),
    );

    app.get(
      "/api/v1/platform-admin/billing/prices",
      { preHandler: requirePlatformAdmin },
      async () => ({ data: await billing.listPrices() }),
    );

    app.put(
      "/api/v1/platform-admin/billing/prices",
      { preHandler: requirePlatformAdmin },
      async (request, reply) => {
        const body = z
          .object({
            productCode: z.string().trim().min(1).max(80),
            provider: z.string().trim().min(1).max(40).default("paddle"),
            providerPriceRef: z.string().trim().max(100).nullable().optional(),
            currency: z.string().trim().length(3).default("USD"),
            interval: z.enum(["month", "year", "one_time"]),
            unitAmountMinor: z.number().int().min(0).max(1_000_000_000),
            creditsPerUnit: z
              .number()
              .int()
              .min(1)
              .max(10_000_000)
              .nullable()
              .optional(),
            taxMode: z
              .enum(["provider", "inclusive", "exclusive"])
              .default("provider"),
            active: z.boolean().default(true),
          })
          .parse(request.body);
        const rows = await billing.upsertPrice({
          productCode: body.productCode,
          provider: body.provider,
          ...(body.providerPriceRef === undefined
            ? {}
            : { providerPriceRef: body.providerPriceRef }),
          currency: body.currency,
          interval: body.interval,
          unitAmountMinor: body.unitAmountMinor,
          ...(body.creditsPerUnit === undefined
            ? {}
            : { creditsPerUnit: body.creditsPerUnit }),
          taxMode: body.taxMode,
          active: body.active,
        });
        if (!rows.length)
          return reply.code(404).send({
            error: { code: "billing_product_not_found" },
          });
        return { data: rows[0] };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/v1/platform-admin/organizations/:id/billing",
      { preHandler: requirePlatformAdmin },
      async (request) => ({ data: await billing.overview(request.params.id) }),
    );

    app.put<{ Params: { id: string } }>(
      "/api/v1/platform-admin/organizations/:id/billing/manual",
      { preHandler: requirePlatformAdmin },
      async (request, reply) => {
        const body = z
          .object({
            planCode: z.string().trim().min(1).max(80),
            status: z.enum([
              "manual",
              "legacy_free",
              "active",
              "past_due",
              "canceled",
            ]),
            periodEnd: z.coerce.date().nullable().optional(),
            graceEndsAt: z.coerce.date().nullable().optional(),
            lineItems: z
              .array(
                z.object({
                  productCode: z.enum(["whatsapp_line", "telegram_line"]),
                  quantity: z.number().int().min(0).max(500),
                }),
              )
              .max(2)
              .optional(),
          })
          .parse(request.body);
        const updated = await billing.setManualSubscription({
          organizationId: request.params.id,
          planCode: body.planCode,
          status: body.status,
          periodEnd: body.periodEnd ?? null,
          graceEndsAt: body.graceEndsAt ?? null,
          ...(body.lineItems ? { lineItems: body.lineItems } : {}),
          actorId: request.claims!.sub,
        });
        if (!updated)
          return reply.code(404).send({
            error: { code: "organization_or_plan_not_found" },
          });
        return { data: { updated: true } };
      },
    );

    app.patch<{ Params: { organizationId: string; requestId: string } }>(
      "/api/v1/platform-admin/organizations/:organizationId/billing/line-requests/:requestId",
      { preHandler: requirePlatformAdmin },
      async (request, reply) => {
        const body = z
          .object({
            decision: z.enum(["approved", "rejected"]),
            reviewNote: z.string().trim().max(500).nullable().optional(),
          })
          .parse(request.body);
        const result = await billing.reviewLineSalesRequest({
          organizationId: request.params.organizationId,
          requestId: request.params.requestId,
          decision: body.decision,
          reviewNote: body.reviewNote ?? null,
          actorId: request.claims!.sub,
        });
        if (!result)
          return reply.code(404).send({
            error: { code: "billing_line_request_not_pending" },
          });
        return { data: result };
      },
    );
  }

  app.get<{ Params: { id: string } }>(
    "/api/v1/platform-admin/organizations/:id",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const details = await repository.organizationDetails(request.params.id);
      if (!details)
        return reply.code(404).send({
          error: { code: "not_found", message: "Organizasyon bulunamadı." },
        });
      return { data: details };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/platform-admin/organizations/:id/operations",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const data = await repository.organizationOperations(request.params.id);
      return data
        ? { data }
        : reply.code(404).send({ error: { code: "not_found" } });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/platform-admin/organizations/:id/approve",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const body = z
        .object({
          planCode: z.string().trim().min(1).default("trial"),
          trialDays: z.number().int().min(0).max(365).default(14),
        })
        .parse(request.body ?? {});
      const result = await repository.approveOrganization({
        organizationId: request.params.id,
        actorId: request.claims!.sub,
        planCode: body.planCode,
        trialDays: body.trialDays,
        requestId: request.id,
        ipAddress: request.clientIp,
        ...(request.headers["user-agent"]
          ? { userAgent: request.headers["user-agent"] }
          : {}),
      });
      return result
        ? { data: result }
        : reply.code(404).send({ error: { code: "not_found" } });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/platform-admin/organizations/:id/reject",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const body = z
        .object({ reason: z.string().trim().min(3).max(500) })
        .parse(request.body);
      const result = await repository.rejectOrganization({
        organizationId: request.params.id,
        actorId: request.claims!.sub,
        reason: body.reason,
        requestId: request.id,
        ipAddress: request.clientIp,
        ...(request.headers["user-agent"]
          ? { userAgent: request.headers["user-agent"] }
          : {}),
      });
      return result
        ? { data: result }
        : reply.code(404).send({ error: { code: "not_found" } });
    },
  );

  app.get<{
    Querystring: {
      search?: string;
      status?: string;
      organizationId?: string;
      role?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/api/v1/platform-admin/users",
    { preHandler: requirePlatformAdmin },
    async (request) => {
      const limit = Math.min(
        Math.max(Number(request.query.limit) || 50, 1),
        200,
      );
      const offset = Math.max(Number(request.query.offset) || 0, 0);
      const search = request.query.search?.trim();
      const result = await repository.listUsers({
        term: search ? `%${search}%` : null,
        status: request.query.status || null,
        organizationId: request.query.organizationId || null,
        role: request.query.role || null,
        limit,
        offset,
      });
      return {
        data: result.rows,
        page: { limit, offset, total: result.total },
      };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/platform-admin/users/:id/status",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const body = z
        .object({
          status: z.enum(["active", "suspended"]),
          reason: z.string().trim().min(3).max(500).optional(),
        })
        .parse(request.body);
      if (body.status === "suspended" && !body.reason)
        return reply.code(400).send({ error: { code: "reason_required" } });
      const result = await repository.setUserStatus({
        userId: request.params.id,
        actorId: request.claims!.sub,
        status: body.status,
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return result
        ? { data: result }
        : reply.code(404).send({ error: { code: "not_found" } });
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/platform-admin/organizations/:id",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(2).max(120).optional(),
          industry: z.string().trim().max(100).optional(),
          timezone: z.string().trim().min(3).max(80).optional(),
          defaultLocale: z.string().trim().min(2).max(10).optional(),
        })
        .parse(request.body);
      const updated = await repository.updateOrganization({
        organizationId: request.params.id,
        actorId: request.claims!.sub,
        ...(body.name ? { name: body.name } : {}),
        ...(body.industry ? { industry: body.industry } : {}),
        ...(body.timezone ? { timezone: body.timezone } : {}),
        ...(body.defaultLocale ? { defaultLocale: body.defaultLocale } : {}),
      });
      if (!updated)
        return reply.code(404).send({
          error: { code: "not_found", message: "Organizasyon bulunamadı." },
        });
      return { data: { updated: true } };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/platform-admin/organizations/:id/members",
    { preHandler: requirePlatformAdmin },
    async (request) => ({
      data: await repository.listMembers(request.params.id),
    }),
  );

  app.patch<{ Params: { id: string; userId: string } }>(
    "/api/v1/platform-admin/organizations/:id/members/:userId",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const body = z.object({ role: memberRoleSchema }).parse(request.body);
      const guard = await repository.memberGuard(
        request.params.id,
        request.params.userId,
      );
      if (!guard)
        return reply.code(404).send({
          error: { code: "not_found", message: "Üyelik bulunamadı." },
        });
      if (guard.role === "owner" && body.role !== "owner") {
        if (guard.otherOwnerCount === 0)
          return reply.code(409).send({
            error: {
              code: "last_owner",
              message: "Firmanın son sahibinin rolü değiştirilemez.",
            },
          });
      }
      await repository.updateMemberRole({
        organizationId: request.params.id,
        userId: request.params.userId,
        role: body.role,
        actorId: request.claims!.sub,
      });
      return { data: { updated: true } };
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/v1/platform-admin/organizations/:id/members/:userId",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const guard = await repository.memberGuard(
        request.params.id,
        request.params.userId,
      );
      if (!guard)
        return reply.code(404).send({
          error: { code: "not_found", message: "Üyelik bulunamadı." },
        });
      if (guard.role === "owner") {
        if (guard.otherOwnerCount === 0)
          return reply.code(409).send({
            error: {
              code: "last_owner",
              message: "Firmanın son sahibi kaldırılamaz.",
            },
          });
      }
      await repository.removeMember({
        organizationId: request.params.id,
        userId: request.params.userId,
        actorId: request.claims!.sub,
      });
      return { data: { removed: true } };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/platform-admin/organizations/:id/usage",
    { preHandler: requirePlatformAdmin },
    async (request) => ({
      data: await repository.usage(request.params.id),
    }),
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/platform-admin/organizations/:id/status",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const body = z
        .object({
          disabled: z.boolean(),
          reason: z.string().trim().min(3).max(500).optional(),
        })
        .parse(request.body);
      if (body.disabled && !body.reason)
        return reply.code(400).send({ error: { code: "reason_required" } });
      const updated = await repository.setOrganizationStatus({
        organizationId: request.params.id,
        disabled: body.disabled,
        actorId: request.claims!.sub,
        ...(body.reason ? { reason: body.reason } : {}),
      });
      if (!updated)
        return reply.code(404).send({
          error: { code: "not_found", message: "Organizasyon bulunamadı." },
        });
      return { data: { updated: true } };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/platform-admin/organizations/:id/plan",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const body = z
        .object({ planCode: z.string().min(1) })
        .parse(request.body);
      const updated = await repository.assignPlan({
        organizationId: request.params.id,
        planCode: body.planCode,
        actorId: request.claims!.sub,
      });
      if (!updated)
        return reply.code(404).send({
          error: {
            code: "not_found",
            message: "Organizasyon veya plan bulunamadı.",
          },
        });
      return { data: { updated: true } };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/platform-admin/users/:id/reset-password",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const token = createOpaqueToken();
      const user = await repository.createPasswordReset({
        userId: request.params.id,
        tokenHash: hashOpaqueToken(token),
        actorId: request.claims!.sub,
        actorEmail: request.claims!.email,
      });
      if (!user)
        return reply.code(404).send({
          error: { code: "not_found", message: "Kullanıcı bulunamadı." },
        });
      const url = new URL(
        "/reset-password",
        options?.appPublicUrl ?? "http://localhost:3000",
      );
      url.searchParams.set("token", token);
      const delivered = options?.email
        ? await options.email
            .sendPasswordResetEmail({
              to: user.email,
              resetUrl: url.toString(),
            })
            .then(() => true)
            .catch(() => false)
        : false;
      return {
        data: {
          reset: true,
          email: user.email,
          delivered,
          ...(delivered ? {} : { resetUrl: url.toString() }),
        },
      };
    },
  );

  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      organizationId?: string;
      actorId?: string;
      action?: string;
      severity?: string;
      createdFrom?: string;
      createdTo?: string;
    };
  }>(
    "/api/v1/platform-admin/audit-log",
    { preHandler: requirePlatformAdmin },
    async (request) => {
      const limit = Math.min(
        Math.max(Number(request.query.limit) || 50, 1),
        200,
      );
      const offset = Math.max(Number(request.query.offset) || 0, 0);
      const result = await repository.auditLog({
        limit,
        offset,
        organizationId: request.query.organizationId || null,
        actorId: request.query.actorId || null,
        action: request.query.action || null,
        severity: request.query.severity || null,
        createdFrom: request.query.createdFrom
          ? z.coerce.date().parse(request.query.createdFrom)
          : null,
        createdTo: request.query.createdTo
          ? z.coerce.date().parse(request.query.createdTo)
          : null,
      });
      return {
        data: result.rows,
        page: { limit, offset, total: result.total },
      };
    },
  );

  app.get<{
    Querystring: {
      organizationId?: string;
      actorId?: string;
      action?: string;
      severity?: string;
      createdFrom?: string;
      createdTo?: string;
    };
  }>(
    "/api/v1/platform-admin/audit-log/export",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const result = await repository.auditLog({
        limit: 10_000,
        offset: 0,
        organizationId: request.query.organizationId || null,
        actorId: request.query.actorId || null,
        action: request.query.action || null,
        severity: request.query.severity || null,
        createdFrom: request.query.createdFrom
          ? z.coerce.date().parse(request.query.createdFrom)
          : null,
        createdTo: request.query.createdTo
          ? z.coerce.date().parse(request.query.createdTo)
          : null,
      });
      const quote = (value: unknown) =>
        `"${String(value ?? "").replaceAll('"', '""')}"`;
      const lines = [
        ["created_at", "action", "organization", "actor", "severity"]
          .map(quote)
          .join(","),
        ...result.rows.map((row) =>
          [
            row.created_at,
            row.action,
            row.organization_name,
            row.actor_email ?? row.actor,
            row.severity,
          ]
            .map(quote)
            .join(","),
        ),
      ];
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header(
          "content-disposition",
          'attachment; filename="brixchat24-audit.csv"',
        )
        .send(`\uFEFF${lines.join("\n")}`);
    },
  );

  // Platform-admin role management: deliberately reachable only by an
  // existing platform admin (requirePlatformAdmin above), never
  // self-service. Granting is a real privilege-escalation surface, so every
  // grant/revoke is logged to user_security_events against the TARGET
  // user's row with the acting admin's id/email in metadata.
  app.get(
    "/api/v1/platform-admin/admins",
    { preHandler: requirePlatformAdmin },
    async () => ({
      data: await repository.listAdmins(),
    }),
  );

  app.post(
    "/api/v1/platform-admin/admins",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const body = z
        .object({ email: z.string().trim().toLowerCase().email() })
        .parse(request.body);
      const user = await repository.setPlatformAdmin({
        email: body.email,
        enabled: true,
        actorId: request.claims!.sub,
        actorEmail: request.claims!.email,
      });
      if (!user)
        return reply.code(404).send({
          error: {
            code: "not_found",
            message: "Bu e-postayla kayıtlı bir kullanıcı yok.",
          },
        });
      return { data: { granted: true, email: user.email } };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/platform-admin/admins/:id",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      if (request.params.id === request.claims!.sub)
        return reply.code(400).send({
          error: {
            code: "self_revoke_forbidden",
            message: "Kendi platform admin yetkinizi kaldıramazsınız.",
          },
        });
      const user = await repository.setPlatformAdmin({
        userId: request.params.id,
        enabled: false,
        actorId: request.claims!.sub,
        actorEmail: request.claims!.email,
      });
      if (!user)
        return reply.code(404).send({
          error: { code: "not_found", message: "Kullanıcı bulunamadı." },
        });
      return { data: { revoked: true, email: user.email } };
    },
  );
}

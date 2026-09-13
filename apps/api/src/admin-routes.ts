import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import {
  can,
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  type AuthClaims,
  type Role,
} from "@brixchat/auth";
import type { EmailProvider } from "./email";

type Sql = ReturnType<typeof postgres>;
const zeroOrganizationId = "00000000-0000-0000-0000-000000000000";
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .min(3)
  .max(60);
const roleSchema = z.enum(["owner", "admin", "team_lead", "agent", "viewer"]);

export function registerAdminRoutes(
  app: FastifyInstance,
  sql: Sql,
  options: {
    email: EmailProvider;
    appPublicUrl: string;
    accessTokenTtlMinutes: number;
    enforceBilling?: (
      organizationId: string,
      metric: string,
    ) => Promise<{ allowed: boolean; code: string | null }>;
    enforceInvitation?: (
      tokenHash: string,
      metric: string,
    ) => Promise<{ allowed: boolean; code: string | null }>;
  },
): void {
  const auth = async (request: FastifyRequest) => {
    try {
      request.claims = await request.jwtVerify<AuthClaims>();
    } catch {
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    }
  };
  const members = async (request: FastifyRequest) => {
    await auth(request);
    if (!request.claims || !can(request.claims.role, "members:manage"))
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
  };
  const audit = async (
    request: FastifyRequest,
    action: string,
    entityType: string,
    entityId: string | null,
    metadata: Record<string, unknown> = {},
  ) => {
    if (request.claims!.organizationId === zeroOrganizationId) return;
    await sql`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata,ip_address,user_agent) VALUES(${request.claims!.organizationId}::uuid,${request.claims!.sub}::uuid,${action},${entityType},${entityId}::uuid,${sql.json(metadata as never)},${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
  };
  const notify = async (
    organizationId: string,
    userId: string | null,
    type: string,
    title: string,
    body: string,
  ) => {
    await sql`INSERT INTO notifications(organization_id,user_id,type,title,body) VALUES(${organizationId}::uuid,${userId}::uuid,${type},${title},${body})`;
  };

  app.get("/api/v1/onboarding", { preHandler: auth }, async (request) => {
    const rows = await sql<
      Array<Record<string, unknown>>
    >`SELECT current_step,state,organization_id,completed_at FROM onboarding_progress WHERE user_id=${request.claims!.sub}::uuid`;
    return {
      data: rows[0] ?? {
        current_step: 1,
        state: {},
        organization_id: null,
        completed_at: null,
      },
    };
  });
  app.patch("/api/v1/onboarding", { preHandler: auth }, async (request) => {
    const body = z
      .object({
        currentStep: z.number().int().min(1).max(10),
        state: z.record(z.string(), z.unknown()),
      })
      .parse(request.body);
    await sql`INSERT INTO onboarding_progress(user_id,current_step,state,updated_at) VALUES(${request.claims!.sub}::uuid,${body.currentStep},${sql.json(body.state as never)},now()) ON CONFLICT(user_id) DO UPDATE SET current_step=EXCLUDED.current_step,state=onboarding_progress.state||EXCLUDED.state,updated_at=now()`;
    return { data: { saved: true, currentStep: body.currentStep } };
  });
  app.post(
    "/api/v1/onboarding/complete",
    { preHandler: auth },
    async (request, reply) => {
      const rows = await sql<
        Array<{ state: Record<string, unknown>; completed_at: Date | null }>
      >`SELECT state,completed_at FROM onboarding_progress WHERE user_id=${request.claims!.sub}::uuid FOR UPDATE`;
      const progress = rows[0];
      if (!progress)
        return reply.code(400).send({
          error: {
            code: "onboarding_not_started",
            message: "Onboarding başlatılmadı.",
          },
        });
      if (progress.completed_at) {
        const member = await sql<
          Array<{ organization_id: string; role: Role }>
        >`SELECT organization_id,role FROM organization_members WHERE user_id=${request.claims!.sub}::uuid LIMIT 1`;
        const current = member[0];
        return current
          ? {
              data: {
                accessToken: app.jwt.sign(
                  {
                    ...request.claims!,
                    organizationId: current.organization_id,
                    role: current.role,
                  },
                  { expiresIn: `${options.accessTokenTtlMinutes}m` },
                ),
                organizationId: current.organization_id,
                completed: true,
              },
            }
          : reply.code(409).send({
              error: {
                code: "onboarding_state_invalid",
                message: "Onboarding durumu geçersiz.",
              },
            });
      }
      const input = z
        .object({
          organizationName: z.string().trim().min(2).max(120),
          slug: slugSchema,
          industry: z.string().trim().max(100).optional(),
          locale: z.string().trim().min(2).max(10).default("tr"),
          timezone: z.string().trim().min(3).max(80).default("Europe/Istanbul"),
          teamName: z
            .string()
            .trim()
            .min(2)
            .max(100)
            .default("Customer Operations"),
        })
        .parse(progress.state);
      try {
        const result = await sql.begin(async (tx) => {
          const organizations = await tx<
            Array<{ id: string }>
          >`INSERT INTO organizations(
            name,slug,industry,default_locale,timezone,onboarding_completed_at,
            operational_status,activation_status,activation_requested_at,status_changed_at
          ) VALUES(
            ${input.organizationName},${input.slug},${input.industry ?? null},
            ${input.locale},${input.timezone},now(),'pending_review','pending',now(),now()
          ) RETURNING id`;
          const organizationId = organizations[0]!.id;
          await tx`INSERT INTO organization_members(organization_id,user_id,role) VALUES(${organizationId}::uuid,${request.claims!.sub}::uuid,'owner')`;
          const teams = await tx<
            Array<{ id: string }>
          >`INSERT INTO teams(organization_id,name) VALUES(${organizationId}::uuid,${input.teamName}) RETURNING id`;
          await tx`INSERT INTO team_members(organization_id,team_id,user_id) VALUES(${organizationId}::uuid,${teams[0]!.id}::uuid,${request.claims!.sub}::uuid)`;
          await tx`UPDATE users SET locale=${input.locale},timezone=${input.timezone},updated_at=now() WHERE id=${request.claims!.sub}::uuid`;
          await tx`UPDATE onboarding_progress SET organization_id=${organizationId}::uuid,current_step=10,completed_at=now(),updated_at=now() WHERE user_id=${request.claims!.sub}::uuid`;
          await tx`INSERT INTO tenant_provisioning_audit(
            organization_id,action,actor,actor_user_id,target_type,target_id,
            after_state,details
          ) VALUES(
            ${organizationId}::uuid,'approval_requested',${request.claims!.sub},
            ${request.claims!.sub}::uuid,'organization',${organizationId}::uuid,
            ${tx.json({ operationalStatus: "pending_review", activationStatus: "pending" } as never)},
            ${tx.json({ source: "self_service_onboarding" } as never)}
          )`;
          return { organizationId, teamId: teams[0]!.id };
        });
        const claims: AuthClaims = {
          ...request.claims!,
          organizationId: result.organizationId,
          role: "owner",
        };
        return {
          data: {
            ...result,
            accessToken: app.jwt.sign(claims, {
              expiresIn: `${options.accessTokenTtlMinutes}m`,
            }),
            completed: true,
          },
        };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23505"
        )
          return reply.code(409).send({
            error: {
              code: "workspace_unavailable",
              message: "Workspace oluşturulamadı.",
            },
          });
        throw error;
      }
    },
  );

  app.get("/api/v1/users", { preHandler: members }, async (request) => ({
    data: await sql`SELECT u.id,u.email,u.full_name,u.first_name,u.last_name,u.is_active,u.suspended_at,u.email_verified_at,om.role,om.created_at membership_created_at FROM organization_members om JOIN users u ON u.id=om.user_id WHERE om.organization_id=${request.claims!.organizationId}::uuid ORDER BY u.full_name`,
  }));
  app.get<{ Params: { id: string } }>(
    "/api/v1/users/:id",
    { preHandler: members },
    async (request, reply) => {
      const rows = await sql<
        Array<Record<string, unknown>>
      >`SELECT u.id,u.email,u.full_name,u.first_name,u.last_name,u.is_active,u.suspended_at,u.email_verified_at,om.role FROM organization_members om JOIN users u ON u.id=om.user_id WHERE om.organization_id=${request.claims!.organizationId}::uuid AND u.id=${request.params.id}::uuid`;
      return rows[0]
        ? { data: rows[0] }
        : reply.code(404).send({
            error: {
              code: "user_not_found",
              message: "Kullanıcı bulunamadı.",
            },
          });
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/users/:id",
    { preHandler: members },
    async (request, reply) => {
      const body = z.object({ role: roleSchema }).parse(request.body);
      const existing = await sql<
        Array<{ role: Role }>
      >`SELECT role FROM organization_members WHERE organization_id=${request.claims!.organizationId}::uuid AND user_id=${request.params.id}::uuid FOR UPDATE`;
      if (!existing[0])
        return reply.code(404).send({
          error: { code: "user_not_found", message: "Kullanıcı bulunamadı." },
        });
      if (existing[0].role === "owner" && body.role !== "owner") {
        const owners = await sql<
          Array<{ count: number }>
        >`SELECT count(*)::int count FROM organization_members om JOIN users u ON u.id=om.user_id WHERE om.organization_id=${request.claims!.organizationId}::uuid AND om.role='owner' AND u.is_active=true AND u.suspended_at IS NULL`;
        if ((owners[0]?.count ?? 0) <= 1)
          return reply.code(409).send({
            error: {
              code: "last_owner_required",
              message: "En az bir aktif owner kalmalıdır.",
            },
          });
      }
      await sql`UPDATE organization_members SET role=${body.role}::member_role,updated_at=now() WHERE organization_id=${request.claims!.organizationId}::uuid AND user_id=${request.params.id}::uuid`;
      await audit(request, "user.role_changed", "user", request.params.id, {
        from: existing[0].role,
        to: body.role,
      });
      return { data: { id: request.params.id, role: body.role } };
    },
  );
  for (const action of ["suspend", "activate"] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/v1/users/:id/${action}`,
      { preHandler: members },
      async (request, reply) => {
        const target = await sql<
          Array<{ role: Role }>
        >`SELECT om.role FROM organization_members om WHERE om.organization_id=${request.claims!.organizationId}::uuid AND om.user_id=${request.params.id}::uuid`;
        if (!target[0])
          return reply.code(404).send({
            error: {
              code: "user_not_found",
              message: "Kullanıcı bulunamadı.",
            },
          });
        if (action === "suspend" && target[0].role === "owner") {
          const owners = await sql<
            Array<{ count: number }>
          >`SELECT count(*)::int count FROM organization_members om JOIN users u ON u.id=om.user_id WHERE om.organization_id=${request.claims!.organizationId}::uuid AND om.role='owner' AND u.is_active=true AND u.suspended_at IS NULL`;
          if ((owners[0]?.count ?? 0) <= 1)
            return reply.code(409).send({
              error: {
                code: "last_owner_required",
                message: "En az bir aktif owner kalmalıdır.",
              },
            });
        }
        await sql`UPDATE users SET suspended_at=${action === "suspend" ? new Date() : null},is_active=${action === "activate"},updated_at=now() WHERE id=${request.params.id}::uuid`;
        if (action === "suspend")
          await sql`UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='user_suspended' WHERE user_id=${request.params.id}::uuid`;
        await audit(
          request,
          action === "suspend" ? "user.suspended" : "user.activated",
          "user",
          request.params.id,
        );
        await notify(
          request.claims!.organizationId,
          request.params.id,
          `user.${action}`,
          action === "suspend"
            ? "Hesap askıya alındı"
            : "Hesap etkinleştirildi",
          "Hesap durumunuz bir yönetici tarafından değiştirildi.",
        );
        return {
          data: {
            id: request.params.id,
            status: action === "suspend" ? "suspended" : "active",
          },
        };
      },
    );
  }

  app.get("/api/v1/teams", { preHandler: auth }, async (request) => ({
    data: await sql`SELECT t.id,t.name,t.created_at,count(tm.id)::int member_count FROM teams t LEFT JOIN team_members tm ON tm.team_id=t.id AND tm.organization_id=t.organization_id WHERE t.organization_id=${request.claims!.organizationId}::uuid GROUP BY t.id ORDER BY t.name`,
  }));
  app.post("/api/v1/teams", { preHandler: members }, async (request, reply) => {
    const body = z
      .object({ name: z.string().trim().min(2).max(100) })
      .parse(request.body);
    const rows = await sql<
      Array<Record<string, unknown>>
    >`INSERT INTO teams(organization_id,name) VALUES(${request.claims!.organizationId}::uuid,${body.name}) RETURNING *`;
    await audit(request, "team.created", "team", String(rows[0]!.id));
    return reply.code(201).send({ data: rows[0] });
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/teams/:id",
    { preHandler: auth },
    async (request, reply) => {
      const rows = await sql<
        Array<Record<string, unknown>>
      >`SELECT id,name,created_at FROM teams WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid`;
      if (!rows[0])
        return reply.code(404).send({
          error: { code: "team_not_found", message: "Ekip bulunamadı." },
        });
      const teamMembers =
        await sql`SELECT u.id,u.full_name,u.email,om.role FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN organization_members om ON om.user_id=u.id AND om.organization_id=tm.organization_id WHERE tm.organization_id=${request.claims!.organizationId}::uuid AND tm.team_id=${request.params.id}::uuid`;
      return { data: { ...rows[0], members: teamMembers } };
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/teams/:id",
    { preHandler: members },
    async (request, reply) => {
      const body = z
        .object({ name: z.string().trim().min(2).max(100) })
        .parse(request.body);
      const rows =
        await sql`UPDATE teams SET name=${body.name},updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid RETURNING id`;
      if (!rows[0])
        return reply.code(404).send({
          error: { code: "team_not_found", message: "Ekip bulunamadı." },
        });
      await audit(request, "team.updated", "team", request.params.id);
      return { data: { id: request.params.id, name: body.name } };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/teams/:id",
    { preHandler: members },
    async (request, reply) => {
      const rows =
        await sql`DELETE FROM teams WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid RETURNING id`;
      if (!rows[0])
        return reply.code(404).send({
          error: { code: "team_not_found", message: "Ekip bulunamadı." },
        });
      await audit(request, "team.deleted", "team", request.params.id);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/teams/:id/members",
    { preHandler: members },
    async (request, reply) => {
      const body = z.object({ userId: z.string().uuid() }).parse(request.body);
      const rows =
        await sql`INSERT INTO team_members(organization_id,team_id,user_id) SELECT ${request.claims!.organizationId}::uuid,t.id,om.user_id FROM teams t JOIN organization_members om ON om.organization_id=t.organization_id AND om.user_id=${body.userId}::uuid WHERE t.id=${request.params.id}::uuid AND t.organization_id=${request.claims!.organizationId}::uuid ON CONFLICT(team_id,user_id) DO NOTHING RETURNING id`;
      return rows[0]
        ? reply.code(201).send({ data: { added: true } })
        : reply.code(404).send({
            error: {
              code: "team_or_user_not_found",
              message: "Ekip veya kullanıcı bulunamadı.",
            },
          });
    },
  );
  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/v1/teams/:id/members/:userId",
    { preHandler: members },
    async (request, reply) => {
      await sql`DELETE FROM team_members WHERE organization_id=${request.claims!.organizationId}::uuid AND team_id=${request.params.id}::uuid AND user_id=${request.params.userId}::uuid`;
      return reply.code(204).send();
    },
  );

  app.get("/api/v1/invitations", { preHandler: members }, async (request) => ({
    data: await sql`SELECT id,email,role,expires_at,accepted_at,revoked_at,created_at FROM organization_invitations WHERE organization_id=${request.claims!.organizationId}::uuid ORDER BY created_at DESC`,
  }));
  app.post(
    "/api/v1/invitations",
    {
      preHandler: members,
      config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const body = z
        .object({
          email: z
            .string()
            .trim()
            .email()
            .transform((v) => v.toLowerCase()),
          role: roleSchema.refine((v) => v !== "owner"),
        })
        .parse(request.body);
      const billing = await options.enforceBilling?.(
        request.claims!.organizationId,
        "users",
      );
      if (billing && !billing.allowed)
        return reply.code(409).send({
          error: {
            code: billing.code,
            message: "Abonelik planınız yeni kullanıcı davetine izin vermiyor.",
          },
        });
      const token = createOpaqueToken();
      const rows = await sql<
        Array<{ id: string }>
      >`INSERT INTO organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES(${request.claims!.organizationId}::uuid,${body.email},${body.role},${hashOpaqueToken(token)},${request.claims!.sub}::uuid,now()+interval '7 days') RETURNING id`;
      await options.email.sendOrganizationInvitation({
        to: body.email,
        invitationUrl: `${options.appPublicUrl}/invite?token=${token}`,
      });
      await audit(request, "user.invited", "invitation", rows[0]!.id, {
        role: body.role,
      });
      return reply.code(201).send({
        data: {
          id: rows[0]!.id,
          email: body.email,
          role: body.role,
          expiresInDays: 7,
        },
      });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/invitations/:id/resend",
    {
      preHandler: members,
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const token = createOpaqueToken();
      const rows = await sql<
        Array<{ email: string }>
      >`UPDATE organization_invitations SET token_hash=${hashOpaqueToken(token)},expires_at=now()+interval '7 days',updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email`;
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "invitation_not_found",
            message: "Davet bulunamadı.",
          },
        });
      await options.email.sendOrganizationInvitation({
        to: rows[0].email,
        invitationUrl: `${options.appPublicUrl}/invite?token=${token}`,
      });
      return { data: { resent: true } };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/invitations/:id",
    { preHandler: members },
    async (request, reply) => {
      await sql`UPDATE organization_invitations SET revoked_at=COALESCE(revoked_at,now()),updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid`;
      return reply.code(204).send();
    },
  );
  app.post("/api/v1/invitations/accept", async (request, reply) => {
    const body = z
      .object({
        token: z.string().min(20),
        firstName: z.string().trim().min(1).max(80).optional(),
        lastName: z.string().trim().min(1).max(80).optional(),
        password: z.string().min(12).max(128).optional(),
      })
      .parse(request.body);
    const invitationBilling = await options.enforceInvitation?.(
      hashOpaqueToken(body.token),
      "users",
    );
    if (invitationBilling && !invitationBilling.allowed)
      return reply.code(409).send({
        error: {
          code: invitationBilling.code,
          message: "Organizasyonun kullanıcı kotası dolu.",
        },
      });
    const result = await sql.begin(async (tx) => {
      const invitations = await tx<
        Array<Record<string, unknown>>
      >`SELECT * FROM organization_invitations WHERE token_hash=${hashOpaqueToken(body.token)} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`;
      const invitation = invitations[0];
      if (!invitation) return null;
      let users = await tx<
        Array<{ id: string }>
      >`SELECT id FROM users WHERE lower(email)=lower(${String(invitation.email)})`;
      if (!users[0]) {
        if (!body.firstName || !body.lastName || !body.password)
          throw Object.assign(new Error("registration_fields_required"), {
            statusCode: 400,
          });
        const passwordHash = await hashPassword(body.password);
        users = await tx<
          Array<{ id: string }>
        >`INSERT INTO users(email,password_hash,full_name,first_name,last_name,email_verified_at) VALUES(${String(invitation.email).toLowerCase()},${passwordHash},${`${body.firstName} ${body.lastName}`},${body.firstName},${body.lastName},now()) RETURNING id`;
        await tx`INSERT INTO user_credentials(user_id,password_hash) VALUES(${users[0]!.id}::uuid,${passwordHash})`;
      }
      const userId = users[0]!.id;
      await tx`INSERT INTO organization_members(organization_id,user_id,role) VALUES(${String(invitation.organization_id)}::uuid,${userId}::uuid,${String(invitation.role)}::member_role) ON CONFLICT(organization_id,user_id) DO NOTHING`;
      await tx`UPDATE organization_invitations SET accepted_at=now(),accepted_by=${userId}::uuid,updated_at=now() WHERE id=${String(invitation.id)}::uuid`;
      return {
        organizationId: String(invitation.organization_id),
        userId,
        role: String(invitation.role),
        invitationId: String(invitation.id),
      };
    });
    if (!result)
      return reply.code(400).send({
        error: {
          code: "invalid_or_expired_invitation",
          message: "Davet geçersiz veya süresi dolmuş.",
        },
      });
    await sql`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata,ip_address,user_agent) VALUES(${result.organizationId}::uuid,${result.userId}::uuid,'user.invitation_accepted','invitation',${result.invitationId}::uuid,'{}'::jsonb,${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
    await notify(
      result.organizationId,
      null,
      "invitation.accepted",
      "Davet kabul edildi",
      "Yeni bir ekip üyesi workspace'e katıldı.",
    );
    return { data: { accepted: true, organizationId: result.organizationId } };
  });

  app.get("/api/v1/profile", { preHandler: auth }, async (request) => {
    const rows =
      await sql`SELECT id,email,full_name,first_name,last_name,avatar_url,locale,timezone,notification_preferences,email_verified_at FROM users WHERE id=${request.claims!.sub}::uuid`;
    return { data: rows[0] };
  });
  app.patch("/api/v1/profile", { preHandler: auth }, async (request) => {
    const body = z
      .object({
        firstName: z.string().trim().min(1).max(80).optional(),
        lastName: z.string().trim().min(1).max(80).optional(),
        email: z
          .string()
          .trim()
          .email()
          .transform((v) => v.toLowerCase())
          .optional(),
        avatarUrl: z.string().url().max(1000).nullable().optional(),
        locale: z.string().min(2).max(10).optional(),
        timezone: z.string().min(3).max(80).optional(),
        notificationPreferences: z.record(z.string(), z.boolean()).optional(),
      })
      .parse(request.body);
    await sql`UPDATE users SET first_name=COALESCE(${body.firstName ?? null},first_name),last_name=COALESCE(${body.lastName ?? null},last_name),full_name=concat_ws(' ',COALESCE(${body.firstName ?? null},first_name),COALESCE(${body.lastName ?? null},last_name)),email=COALESCE(${body.email ?? null},email),email_verified_at=CASE WHEN ${body.email ?? null}::text IS NULL OR lower(email)=lower(${body.email ?? null}) THEN email_verified_at ELSE NULL END,avatar_url=CASE WHEN ${body.avatarUrl === undefined ? null : body.avatarUrl}::text IS NULL THEN avatar_url ELSE ${body.avatarUrl ?? null} END,locale=COALESCE(${body.locale ?? null},locale),timezone=COALESCE(${body.timezone ?? null},timezone),notification_preferences=COALESCE(${body.notificationPreferences ? sql.json(body.notificationPreferences as never) : null},notification_preferences),updated_at=now() WHERE id=${request.claims!.sub}::uuid`;
    return {
      data: { updated: true, emailVerificationRequired: Boolean(body.email) },
    };
  });
  app.get("/api/v1/security-events", { preHandler: auth }, async (request) => ({
    data: await sql`SELECT id,event_type,metadata,ip_address::text,user_agent,created_at FROM user_security_events WHERE user_id=${request.claims!.sub}::uuid ORDER BY created_at DESC LIMIT 50`,
  }));
  app.get("/api/v1/notifications", { preHandler: auth }, async (request) => ({
    data: await sql`SELECT id,type,title,body,metadata,read_at,created_at FROM notifications WHERE organization_id=${request.claims!.organizationId}::uuid AND (user_id IS NULL OR user_id=${request.claims!.sub}::uuid) ORDER BY created_at DESC LIMIT 100`,
  }));
  app.post<{ Params: { id: string } }>(
    "/api/v1/notifications/:id/read",
    { preHandler: auth },
    async (request, reply) => {
      await sql`UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid AND (user_id IS NULL OR user_id=${request.claims!.sub}::uuid)`;
      return reply.code(204).send();
    },
  );
}

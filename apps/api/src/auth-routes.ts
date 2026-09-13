import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import {
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  refreshReuseAction,
  type AuthClaims,
  type Role,
  verifyPassword,
} from "@brixchat/auth";
import { AuthWorkspaceRepository } from "@brixchat/database";
import type { EmailProvider } from "./email";

type Sql = ReturnType<typeof postgres>;
type AuthOptions = {
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
  cookieSecure: boolean;
  cookieSameSite: "lax" | "strict" | "none";
  cookieDomain?: string;
  email: EmailProvider;
  appPublicUrl: string;
};

const refreshCookie = "brixchat_refresh";
const zeroOrganizationId = "00000000-0000-0000-0000-000000000000";
const emailSchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((value) => value.toLowerCase());
const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .regex(/[a-z]/)
  .regex(/[A-Z]/)
  .regex(/[0-9]/);
const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
});
const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
const workspaceSwitchSchema = z.object({ organizationId: z.string().uuid() });
const tokenSchema = z.object({ token: z.string().min(20).max(500) });

function requestMeta(request: FastifyRequest) {
  return {
    ip: request.clientIp,
    userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null,
  };
}

function cookieOptions(options: AuthOptions) {
  return {
    httpOnly: true,
    secure: options.cookieSecure,
    sameSite: options.cookieSameSite,
    path: "/api/v1/auth",
    maxAge: options.refreshTokenTtlDays * 24 * 60 * 60,
    ...(options.cookieDomain ? { domain: options.cookieDomain } : {}),
  } as const;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  sql: Sql,
  options: AuthOptions,
): void {
  const workspaces = new AuthWorkspaceRepository(sql);
  const publicUrl = (path: string, token: string) => {
    const url = new URL(path, options.appPublicUrl);
    url.searchParams.set("token", token);
    return url.toString();
  };

  const authenticate = async (request: FastifyRequest) => {
    try {
      request.claims = await request.jwtVerify<AuthClaims>();
    } catch {
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    }
  };

  const signAccess = (claims: AuthClaims) =>
    app.jwt.sign(claims, { expiresIn: `${options.accessTokenTtlMinutes}m` });

  async function createSession(
    reply: FastifyReply,
    input: {
      userId: string;
      organizationId?: string | null;
      familyId?: string;
      ip: string;
      userAgent: string | null;
    },
    db: Sql = sql,
  ) {
    const token = createOpaqueToken();
    const familyId = input.familyId ?? crypto.randomUUID();
    const rows = await db<
      Array<{ id: string }>
    >`INSERT INTO user_sessions(user_id,organization_id,family_id,token_hash,expires_at,ip_address,user_agent)
      VALUES(${input.userId}::uuid,${input.organizationId ?? null}::uuid,${familyId}::uuid,${hashOpaqueToken(token)},now()+(${options.refreshTokenTtlDays}::text||' days')::interval,${input.ip}::inet,${input.userAgent}) RETURNING id`;
    reply.setCookie(refreshCookie, token, cookieOptions(options));
    return { id: rows[0]!.id, token, familyId };
  }

  async function identity(userId: string, organizationId?: string) {
    const rows = await sql<
      Array<Record<string, unknown>>
    >`SELECT u.id,u.email,u.full_name,u.first_name,u.last_name,u.email_verified_at,u.locale,u.timezone,
      u.is_platform_admin,
      om.organization_id,om.role,o.name organization_name,o.slug organization_slug,
      o.operational_status organization_status,o.activation_status
      FROM users u LEFT JOIN organization_members om ON om.user_id=u.id LEFT JOIN organizations o ON o.id=om.organization_id
      WHERE u.id=${userId}::uuid
        AND u.is_active=true
        AND u.suspended_at IS NULL
        AND (${organizationId ?? null}::uuid IS NULL OR om.organization_id=${organizationId ?? null}::uuid)
      ORDER BY om.created_at LIMIT 1`;
    return rows[0] ?? null;
  }

  app.post(
    "/api/v1/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const body = registerSchema.parse(request.body);
      const passwordHash = await hashPassword(body.password);
      const verificationToken = createOpaqueToken();
      try {
        const user = await sql.begin(async (tx) => {
          const users = await tx<
            Array<{ id: string }>
          >`INSERT INTO users(email,password_hash,full_name,first_name,last_name)
          VALUES(${body.email},${passwordHash},${`${body.firstName} ${body.lastName}`},${body.firstName},${body.lastName}) RETURNING id`;
          const userId = users[0]!.id;
          await tx`INSERT INTO user_credentials(user_id,password_hash) VALUES(${userId}::uuid,${passwordHash})`;
          await tx`INSERT INTO email_verification_tokens(user_id,email,token_hash,expires_at) VALUES(${userId}::uuid,${body.email},${hashOpaqueToken(verificationToken)},now()+interval '24 hours')`;
          await tx`INSERT INTO onboarding_progress(user_id) VALUES(${userId}::uuid)`;
          await tx`INSERT INTO user_security_events(user_id,event_type,ip_address,user_agent) VALUES(${userId}::uuid,'auth.registered',${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
          return userId;
        });
        const verificationDispatched = await options.email
          .sendVerificationEmail({
            to: body.email,
            verificationUrl: publicUrl("/verify-email", verificationToken),
          })
          .then(() => true)
          .catch((error: unknown) => {
            app.log.warn(
              { error: error instanceof Error ? error.message : "email_error" },
              "verification email delivery failed",
            );
            return false;
          });
        await createSession(reply, { userId: user, ...requestMeta(request) });
        const claims: AuthClaims = {
          sub: user,
          organizationId: zeroOrganizationId,
          role: "owner",
          email: body.email,
          platformAdmin: false,
        };
        return reply.code(201).send({
          data: {
            accessToken: signAccess(claims),
            user: {
              id: user,
              email: body.email,
              fullName: `${body.firstName} ${body.lastName}`,
            },
            onboardingRequired: true,
            verificationDispatched,
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
              code: "account_unavailable",
              message: "Hesap oluşturulamadı.",
            },
          });
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const emailHash = hashOpaqueToken(body.email);
      const rows = await sql<
        Array<Record<string, unknown>>
      >`SELECT u.id,u.email,u.full_name,u.is_active,u.suspended_at,uc.password_hash
      FROM users u JOIN user_credentials uc ON uc.user_id=u.id WHERE lower(u.email)=${body.email} LIMIT 1`;
      const user = rows[0];
      const valid = Boolean(
        user &&
        user.is_active &&
        !user.suspended_at &&
        (await verifyPassword(String(user.password_hash), body.password)),
      );
      await sql`INSERT INTO login_attempts(normalized_email_hash,ip_hash,success) VALUES(${emailHash},${hashOpaqueToken(request.clientIp)},${valid})`;
      if (!valid) {
        if (user)
          await sql`INSERT INTO user_security_events(user_id,event_type,ip_address,user_agent) VALUES(${String(user.id)}::uuid,'auth.login_failed',${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
        return reply.code(401).send({
          error: {
            code: "invalid_credentials",
            message: "E-posta veya parola geçersiz.",
          },
        });
      }
      const current = await identity(String(user!.id));
      if (!current)
        return reply.code(401).send({
          error: {
            code: "invalid_credentials",
            message: "E-posta veya parola geçersiz.",
          },
        });
      await createSession(reply, {
        userId: String(user!.id),
        organizationId: current.organization_id
          ? String(current.organization_id)
          : null,
        ...requestMeta(request),
      });
      await sql`UPDATE users SET last_login_at=now(),updated_at=now() WHERE id=${String(user!.id)}::uuid`;
      await sql`INSERT INTO user_security_events(user_id,organization_id,event_type,ip_address,user_agent) VALUES(${String(user!.id)}::uuid,${current.organization_id ? String(current.organization_id) : null}::uuid,'auth.login_success',${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
      const claims: AuthClaims = {
        sub: String(user!.id),
        organizationId: current.organization_id
          ? String(current.organization_id)
          : zeroOrganizationId,
        role: (current.role ?? "owner") as Role,
        email: String(user!.email),
        platformAdmin: Boolean(current.is_platform_admin),
      };
      return {
        data: {
          accessToken: signAccess(claims),
          user: {
            id: claims.sub,
            email: claims.email,
            fullName: String(user!.full_name),
            role: claims.role,
          },
          organization: current.organization_id
            ? {
                id: String(current.organization_id),
                name: String(current.organization_name),
                slug: String(current.organization_slug),
                status: String(current.organization_status),
                activationStatus: String(current.activation_status),
              }
            : null,
          onboardingRequired: !current.organization_id,
        },
      };
    },
  );

  app.post(
    "/api/v1/auth/refresh",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const token = request.cookies[refreshCookie];
      if (!token)
        return reply.code(401).send({
          error: { code: "invalid_session", message: "Oturum geçersiz." },
        });
      // The row lock only serializes concurrent refreshes while it is held,
      // so the read-check-rotate sequence must share one transaction.
      const outcome = await sql.begin(async (tx) => {
        const rows = await tx<
          Array<Record<string, unknown>>
        >`SELECT * FROM user_sessions WHERE token_hash=${hashOpaqueToken(token)} FOR UPDATE`;
        const current = rows[0];
        if (!current || new Date(String(current.expires_at)) <= new Date())
          return { kind: "invalid" as const };
        const action = refreshReuseAction({
          revokedAt: current.revoked_at
            ? new Date(String(current.revoked_at))
            : null,
          replacedById: current.replaced_by_id
            ? String(current.replaced_by_id)
            : null,
        });
        if (action !== "rotate") {
          if (action === "revoke_family")
            await tx`UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='refresh_reuse' WHERE family_id=${String(current.family_id)}::uuid`;
          return { kind: "reject" as const };
        }
        const user = await identity(
          String(current.user_id),
          current.organization_id ? String(current.organization_id) : undefined,
        );
        if (!user) return { kind: "invalid" as const };
        const next = await createSession(
          reply,
          {
            userId: String(current.user_id),
            organizationId: user.organization_id
              ? String(user.organization_id)
              : null,
            familyId: String(current.family_id),
            ...requestMeta(request),
          },
          tx as unknown as Sql,
        );
        await tx`UPDATE user_sessions SET replaced_by_id=${next.id}::uuid,revoked_at=now(),revoke_reason='rotated',last_seen_at=now() WHERE id=${String(current.id)}::uuid`;
        return { kind: "rotated" as const, user };
      });
      if (outcome.kind === "invalid")
        return reply.code(401).send({
          error: { code: "invalid_session", message: "Oturum geçersiz." },
        });
      if (outcome.kind === "reject") {
        reply.clearCookie(refreshCookie, { path: "/api/v1/auth" });
        return reply.code(401).send({
          error: { code: "invalid_session", message: "Oturum geçersiz." },
        });
      }
      const user = outcome.user;
      const claims: AuthClaims = {
        sub: String(user.id),
        organizationId: user.organization_id
          ? String(user.organization_id)
          : zeroOrganizationId,
        role: (user.role ?? "owner") as Role,
        email: String(user.email),
        platformAdmin: Boolean(user.is_platform_admin),
      };
      return { data: { accessToken: signAccess(claims) } };
    },
  );

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = request.cookies[refreshCookie];
    if (token)
      await sql`UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='logout' WHERE token_hash=${hashOpaqueToken(token)}`;
    reply.clearCookie(refreshCookie, { path: "/api/v1/auth" });
    return reply.code(204).send();
  });

  app.get(
    "/api/v1/auth/workspaces",
    { preHandler: authenticate },
    async (request) => ({
      data: await workspaces.list(
        request.claims!.sub,
        request.claims!.organizationId,
      ),
    }),
  );

  app.post(
    "/api/v1/auth/switch-workspace",
    { preHandler: authenticate },
    async (request, reply) => {
      const body = workspaceSwitchSchema.parse(request.body);
      const refreshToken = request.cookies[refreshCookie];
      if (!refreshToken)
        return reply.code(401).send({
          error: { code: "invalid_session", message: "Oturum geçersiz." },
        });
      const target = await workspaces.switchCurrentSession({
        userId: request.claims!.sub,
        targetOrganizationId: body.organizationId,
        currentOrganizationId: request.claims!.organizationId,
        refreshTokenHash: hashOpaqueToken(refreshToken),
        ipAddress: request.clientIp,
        ...(request.headers["user-agent"]
          ? { userAgent: request.headers["user-agent"] }
          : {}),
      });
      if (!target)
        return reply.code(404).send({
          error: {
            code: "workspace_unavailable",
            message:
              "Workspace bulunamadı, erişiminiz yok veya oturum geçersiz.",
          },
        });
      const claims: AuthClaims = {
        sub: target.userId,
        organizationId: target.organizationId,
        role: target.role as Role,
        email: target.email,
        platformAdmin: Boolean(request.claims!.platformAdmin),
      };
      return {
        data: {
          accessToken: signAccess(claims),
          organization: {
            id: target.organizationId,
            name: target.organizationName,
            slug: target.organizationSlug,
            role: claims.role,
          },
        },
      };
    },
  );

  app.get(
    "/api/v1/auth/me",
    { preHandler: authenticate },
    async (request, reply) => {
      const user = await identity(
        request.claims!.sub,
        request.claims!.organizationId === zeroOrganizationId
          ? undefined
          : request.claims!.organizationId,
      );
      return user
        ? {
            data: {
              id: String(user.id),
              email: String(user.email),
              fullName: String(user.full_name),
              firstName: user.first_name,
              lastName: user.last_name,
              emailVerified: Boolean(user.email_verified_at),
              locale: user.locale,
              timezone: user.timezone,
              organizationId: user.organization_id,
              role: user.role,
              platformAdmin: Boolean(user.is_platform_admin),
              organizationStatus: user.organization_status,
              activationStatus: user.activation_status,
            },
          }
        : reply.code(404).send({
            error: {
              code: "user_not_found",
              message: "Kullanıcı bulunamadı.",
            },
          });
    },
  );

  app.get(
    "/api/v1/auth/sessions",
    { preHandler: authenticate },
    async (request) => ({
      data: await sql`SELECT id,created_at,last_seen_at,expires_at,ip_address::text,user_agent,(token_hash=${request.cookies[refreshCookie] ? hashOpaqueToken(request.cookies[refreshCookie]!) : ""}) current FROM user_sessions WHERE user_id=${request.claims!.sub}::uuid AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC`,
    }),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/auth/sessions/:id",
    { preHandler: authenticate },
    async (request, reply) => {
      await sql`UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='user_revoked' WHERE id=${request.params.id}::uuid AND user_id=${request.claims!.sub}::uuid`;
      return reply.code(204).send();
    },
  );
  app.post(
    "/api/v1/auth/sessions/revoke-others",
    { preHandler: authenticate },
    async (request, reply) => {
      const current = request.cookies[refreshCookie];
      await sql`UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='revoke_others' WHERE user_id=${request.claims!.sub}::uuid AND revoked_at IS NULL AND token_hash<>${current ? hashOpaqueToken(current) : ""}`;
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/auth/forgot-password",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request) => {
      const email = emailSchema.parse(
        (request.body as { email?: unknown }).email,
      );
      const users = await sql<
        Array<{ id: string; email: string }>
      >`SELECT id,email FROM users WHERE lower(email)=${email}`;
      if (users[0]) {
        const token = createOpaqueToken();
        await sql`UPDATE password_reset_tokens SET consumed_at=COALESCE(consumed_at,now()) WHERE user_id=${users[0].id}::uuid AND consumed_at IS NULL`;
        await sql`INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES(${users[0].id}::uuid,${hashOpaqueToken(token)},now()+interval '1 hour')`;
        await sql`INSERT INTO user_security_events(user_id,event_type,ip_address,user_agent) VALUES(${users[0].id}::uuid,'auth.password_reset_requested',${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
        await options.email
          .sendPasswordResetEmail({
            to: users[0].email,
            resetUrl: publicUrl("/reset-password", token),
          })
          .catch((error: unknown) =>
            app.log.warn(
              { error: error instanceof Error ? error.message : "email_error" },
              "password reset email delivery failed",
            ),
          );
      }
      return { data: { accepted: true } };
    },
  );
  app.post(
    "/api/v1/auth/reset-password",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const body = z
        .object({ token: z.string().min(20), password: passwordSchema })
        .parse(request.body);
      const passwordHash = await hashPassword(body.password);
      const changed = await sql.begin(async (tx) => {
        const rows = await tx<
          Array<{ id: string; user_id: string }>
        >`SELECT id,user_id FROM password_reset_tokens WHERE token_hash=${hashOpaqueToken(body.token)} AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`;
        if (!rows[0]) return null;
        await tx`UPDATE password_reset_tokens SET consumed_at=now() WHERE id=${rows[0].id}::uuid`;
        await tx`UPDATE user_credentials SET password_hash=${passwordHash},password_changed_at=now(),updated_at=now() WHERE user_id=${rows[0].user_id}::uuid`;
        await tx`UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='password_reset' WHERE user_id=${rows[0].user_id}::uuid`;
        return rows[0].user_id;
      });
      return changed
        ? { data: { reset: true } }
        : reply.code(400).send({
            error: {
              code: "invalid_or_expired_token",
              message: "Bağlantı geçersiz veya süresi dolmuş.",
            },
          });
    },
  );
  app.post("/api/v1/auth/verify-email", async (request, reply) => {
    const body = tokenSchema.parse(request.body);
    const verified = await sql.begin(async (tx) => {
      const rows = await tx<
        Array<{ id: string; user_id: string; email: string }>
      >`SELECT id,user_id,email FROM email_verification_tokens WHERE token_hash=${hashOpaqueToken(body.token)} AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`;
      if (!rows[0]) return false;
      await tx`UPDATE email_verification_tokens SET consumed_at=now() WHERE id=${rows[0].id}::uuid`;
      await tx`UPDATE users SET email_verified_at=now(),updated_at=now() WHERE id=${rows[0].user_id}::uuid AND lower(email)=lower(${rows[0].email})`;
      return true;
    });
    return verified
      ? { data: { verified: true } }
      : reply.code(400).send({
          error: {
            code: "invalid_or_expired_token",
            message: "Bağlantı geçersiz veya süresi dolmuş.",
          },
        });
  });
  app.post(
    "/api/v1/auth/bitrix24-setup/complete",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const body = z
        .object({
          token: z.string().min(20).max(500),
          email: emailSchema,
          password: passwordSchema,
          firstName: z.string().trim().min(1).max(80),
          lastName: z.string().trim().min(1).max(80),
        })
        .parse(request.body);
      const passwordHash = await hashPassword(body.password);
      const fullName = `${body.firstName} ${body.lastName}`;
      const outcome = await sql.begin(async (tx) => {
        const rows = await tx<
          Array<{ id: string; user_id: string; organization_id: string }>
        >`SELECT id,user_id,organization_id FROM bitrix_setup_tokens WHERE token_hash=${hashOpaqueToken(body.token)} AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`;
        const row = rows[0];
        if (!row) return "invalid" as const;
        const emailTaken = await tx<
          Array<{ id: string }>
        >`SELECT id FROM users WHERE lower(email)=${body.email} AND id<>${row.user_id}::uuid`;
        if (emailTaken[0]) return "email_taken" as const;
        await tx`UPDATE bitrix_setup_tokens SET consumed_at=now() WHERE id=${row.id}::uuid`;
        await tx`UPDATE users SET email=${body.email},full_name=${fullName},first_name=${body.firstName},last_name=${body.lastName},password_hash=${passwordHash},email_verified_at=now(),updated_at=now() WHERE id=${row.user_id}::uuid`;
        await tx`UPDATE user_credentials SET password_hash=${passwordHash},password_changed_at=now(),updated_at=now() WHERE user_id=${row.user_id}::uuid`;
        await tx`UPDATE onboarding_progress SET completed_at=now(),updated_at=now() WHERE user_id=${row.user_id}::uuid`;
        await tx`INSERT INTO user_security_events(user_id,organization_id,event_type,ip_address,user_agent) VALUES(${row.user_id}::uuid,${row.organization_id}::uuid,'auth.bitrix_setup_completed',${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
        return { userId: row.user_id, organizationId: row.organization_id };
      });
      if (outcome === "invalid")
        return reply.code(400).send({
          error: {
            code: "invalid_or_expired_token",
            message: "Bağlantı geçersiz veya süresi dolmuş.",
          },
        });
      if (outcome === "email_taken")
        return reply.code(409).send({
          error: {
            code: "email_taken",
            message: "Bu e-posta adresi zaten kullanılıyor.",
          },
        });
      const current = await identity(outcome.userId, outcome.organizationId);
      if (!current)
        return reply.code(400).send({
          error: {
            code: "invalid_or_expired_token",
            message: "Bağlantı geçersiz veya süresi dolmuş.",
          },
        });
      await createSession(reply, {
        userId: outcome.userId,
        organizationId: outcome.organizationId,
        ...requestMeta(request),
      });
      const claims: AuthClaims = {
        sub: outcome.userId,
        organizationId: outcome.organizationId,
        role: (current.role ?? "owner") as Role,
        email: body.email,
        platformAdmin: Boolean(current.is_platform_admin),
      };
      return reply.code(200).send({
        data: {
          accessToken: signAccess(claims),
          user: {
            id: claims.sub,
            email: claims.email,
            fullName,
            role: claims.role,
          },
          organization: {
            id: outcome.organizationId,
            name: String(current.organization_name),
            slug: String(current.organization_slug),
          },
          onboardingRequired: false,
        },
      });
    },
  );
  app.post(
    "/api/v1/auth/resend-verification",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
    },
    async (request) => {
      const user = await identity(request.claims!.sub);
      if (user && !user.email_verified_at) {
        const token = createOpaqueToken();
        await sql`UPDATE email_verification_tokens SET consumed_at=COALESCE(consumed_at,now()) WHERE user_id=${request.claims!.sub}::uuid AND consumed_at IS NULL`;
        await sql`INSERT INTO email_verification_tokens(user_id,email,token_hash,expires_at) VALUES(${request.claims!.sub}::uuid,${String(user.email)},${hashOpaqueToken(token)},now()+interval '24 hours')`;
        await options.email
          .sendVerificationEmail({
            to: String(user.email),
            verificationUrl: publicUrl("/verify-email", token),
          })
          .catch((error: unknown) =>
            app.log.warn(
              { error: error instanceof Error ? error.message : "email_error" },
              "verification email delivery failed",
            ),
          );
      }
      return { data: { accepted: true } };
    },
  );
  app.post(
    "/api/v1/auth/change-password",
    { preHandler: authenticate },
    async (request, reply) => {
      const body = z
        .object({
          currentPassword: z.string().min(1),
          newPassword: passwordSchema,
        })
        .parse(request.body);
      const rows = await sql<
        Array<{ password_hash: string }>
      >`SELECT password_hash FROM user_credentials WHERE user_id=${request.claims!.sub}::uuid`;
      if (
        !rows[0] ||
        !(await verifyPassword(rows[0].password_hash, body.currentPassword))
      )
        return reply.code(400).send({
          error: {
            code: "invalid_current_password",
            message: "Mevcut parola geçersiz.",
          },
        });
      const passwordHash = await hashPassword(body.newPassword);
      const current = request.cookies[refreshCookie];
      await sql.begin(async (tx) => {
        await tx`UPDATE user_credentials SET password_hash=${passwordHash},password_changed_at=now(),updated_at=now() WHERE user_id=${request.claims!.sub}::uuid`;
        await tx`UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='password_changed' WHERE user_id=${request.claims!.sub}::uuid AND token_hash<>${current ? hashOpaqueToken(current) : ""}`;
        await tx`INSERT INTO user_security_events(user_id,organization_id,event_type,ip_address,user_agent) VALUES(${request.claims!.sub}::uuid,${request.claims!.organizationId === zeroOrganizationId ? null : request.claims!.organizationId}::uuid,'auth.password_changed',${request.clientIp}::inet,${request.headers["user-agent"] ?? null})`;
      });
      return { data: { changed: true } };
    },
  );
}

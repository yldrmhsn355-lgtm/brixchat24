import type postgres from "postgres";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
} from "fastify";
import type { AuthClaims } from "@brixchat/auth";
import { createScopedDatabaseRouter } from "@brixchat/database";

// Control-plane entry points resolve identity before a tenant is known, or
// verify provider signatures. An unlisted route ALWAYS requires a tenant JWT.
const controlRoutes = new Set([
  "/health",
  "/health/live",
  "/health/ready",
  "/health/configuration",
  "/metrics",
  "/version",
  "/openapi.json",
  "/api/v1/internal/operations",
  "/api/v1/invitations/accept",
  "/api/v1/onboarding",
  "/api/v1/onboarding/complete",
  "/api/v1/webhooks/meta",
  "/webhooks/meta/whatsapp/:channelPublicId",
  "/webhooks/telegram/:channelPublicId",
  "/api/v1/billing/webhooks/paddle",
  "/webhooks/bitrix24/install/:connectionPublicId",
  "/webhooks/bitrix24/market-install",
  "/api/v1/integrations/bitrix24/oauth/callback",
  "/webhooks/bitrix24/:connectionPublicId",
  "/webhooks/bitrix24/:connectionPublicId/automation/:token",
  "/api/v1/media/object",
  "/api/v1/integrations/google-drive/callback",
  "/webhooks/google-drive/:channelId",
]);

export function databaseRouteScope(path: string) {
  if (path === "/api/v1/realtime") return "realtime";
  if (path.startsWith("/api/v1/platform-admin/")) return "platform";
  if (path.startsWith("/api/v1/auth/") || controlRoutes.has(path))
    return "control";
  return "tenant";
}

export function organizationAccessError(status: string | null | undefined) {
  if (status === "active") return null;
  if (status === "pending_review") return "organization_pending_approval";
  if (status === "rejected") return "organization_rejected";
  return "organization_disabled";
}

/** Buffers send() until commit. The proxy is deliberately not thenable: an
 * async handler returning reply.send() must not wait for an HTTP response that
 * cannot be sent until its own transaction has committed.
 */
function deferredReply(reply: FastifyReply) {
  let sent = false;
  let payload: unknown;
  const facade: FastifyReply = new Proxy(reply, {
    get(target, key) {
      if (key === "then") return undefined;
      if (key === "sent") return sent || target.sent;
      if (key === "send")
        return (value: unknown) => {
          sent = true;
          payload = value;
          return facade;
        };
      const member = Reflect.get(target, key, facade);
      return typeof member === "function" ? member.bind(facade) : member;
    },
  });
  return {
    facade,
    flush: () => {
      if (sent) reply.send(payload);
      return sent;
    },
    isFacade: (value: unknown) => value === facade,
  };
}

export function registerDatabaseScopes(
  app: FastifyInstance,
  router: ReturnType<typeof createScopedDatabaseRouter>,
  controlPool: ReturnType<typeof postgres>,
) {
  app.addHook("onRoute", (route) => {
    const kind = databaseRouteScope(route.url);
    // SSE authorizes its short-lived URL token itself; each later database
    // event callback must explicitly re-enter the authenticated tenant scope.
    if (kind === "realtime") return;
    const run = async <T>(
      request: FastifyRequest,
      callback: () => Promise<T>,
    ) => {
      if (kind === "control") return router.control(controlPool, callback);
      let claims: AuthClaims & { aud?: string };
      try {
        claims = await request.jwtVerify<AuthClaims & { aud?: string }>();
      } catch {
        throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
      }
      if (claims.aud === "realtime")
        throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
      request.claims = claims;
      if (kind === "platform") {
        if (!claims.platformAdmin)
          throw Object.assign(new Error("forbidden"), { statusCode: 403 });
        return router.control(controlPool, callback);
      }
      const states = await controlPool<Array<{ operational_status: string }>>`
        SELECT operational_status FROM organizations
        WHERE id=${claims.organizationId}::uuid`;
      const status = states[0]?.operational_status;
      const code = organizationAccessError(status);
      if (code) {
        throw Object.assign(new Error(code), { statusCode: 403, code });
      }
      return router.tenant(claims.organizationId, callback, claims.sub);
    };
    const handler = route.handler;
    route.handler = async function (this: FastifyInstance, request, reply) {
      const deferred = deferredReply(reply);
      const result = await run(request, async () => {
        const value = await handler.call(this, request, deferred.facade);
        return { value: deferred.isFacade(value) ? undefined : value };
      });
      // Streams can be sending while reply.sent is still false. Returning the
      // real reply waits for completion and prevents an empty automatic send.
      if (deferred.flush()) return reply;
      return reply.sent ? reply : result.value;
    } as RouteHandlerMethod;
    if (route.preHandler) {
      const hooks = Array.isArray(route.preHandler)
        ? route.preHandler
        : [route.preHandler];
      route.preHandler = hooks.map(
        (hook) =>
          async function (this: FastifyInstance, request, reply) {
            const deferred = deferredReply(reply);
            await run(request, async () => {
              if (hook.length >= 3) {
                await new Promise<void>((resolve, reject) => {
                  hook.call(this, request, deferred.facade, (error) =>
                    error ? reject(error) : resolve(),
                  );
                });
              } else {
                await (
                  hook as (
                    request: FastifyRequest,
                    reply: FastifyReply,
                  ) => unknown
                ).call(this, request, deferred.facade);
              }
            });
            if (deferred.flush()) return reply;
          },
      );
    }
  });
}

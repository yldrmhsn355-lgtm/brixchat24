import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Permission } from "@brixchat/auth";
import { BillingRepository } from "@brixchat/database";
import {
  normalizePaddleWebhook,
  PaddleBillingClient,
  verifyPaddleSignature,
} from "@brixchat/integrations";

type Authorize = (
  permission: Permission,
) => (request: FastifyRequest) => Promise<void>;

const checkoutSchema = z.object({
  priceId: z.string().uuid(),
  quantity: z.number().int().min(1).max(500).default(1),
});
const lineRequestSchema = z.object({
  productCode: z.enum(["whatsapp_line", "telegram_line"]),
  quantity: z.number().int().min(1).max(500),
  customerNote: z.string().trim().max(500).nullable().optional(),
});

export function registerBillingRoutes(
  app: FastifyInstance,
  repository: BillingRepository,
  options: {
    authorize: Authorize;
    paddle?: PaddleBillingClient;
    graceDays?: number;
  },
) {
  app.get(
    "/api/v1/billing/catalog",
    { preHandler: options.authorize("billing:manage") },
    async () => ({ data: await repository.catalog("paddle") }),
  );

  app.get(
    "/api/v1/billing/overview",
    { preHandler: options.authorize("billing:manage") },
    async (request) => ({
      data: await repository.overview(request.claims!.organizationId),
    }),
  );

  app.get(
    "/api/v1/billing/provider-config",
    { preHandler: options.authorize("billing:manage") },
    async () => ({
      data: options.paddle
        ? {
            provider: "paddle",
            configured: true,
            clientToken: options.paddle.clientToken,
            environment: options.paddle.environment,
          }
        : { provider: "paddle", configured: false },
    }),
  );

  app.post(
    "/api/v1/billing/line-requests",
    { preHandler: options.authorize("billing:manage") },
    async (request, reply) => {
      const body = lineRequestSchema.parse(request.body);
      const result = await repository.createLineSalesRequest({
        organizationId: request.claims!.organizationId,
        productCode: body.productCode,
        quantity: body.quantity,
        customerNote: body.customerNote ?? null,
        requestedBy: request.claims!.sub,
      });
      if (!result)
        return reply.code(404).send({
          error: { code: "billing_line_product_not_found" },
        });
      return reply.code(201).send({ data: result });
    },
  );

  app.post(
    "/api/v1/billing/checkout",
    { preHandler: options.authorize("billing:manage") },
    async (request, reply) => {
      if (!options.paddle)
        return reply.code(503).send({
          error: {
            code: "billing_provider_not_configured",
            message: "Ödeme sağlayıcısı henüz yapılandırılmadı.",
          },
        });
      const body = checkoutSchema.parse(request.body);
      const context = await repository.checkoutContext(
        request.claims!.organizationId,
        body.priceId,
      );
      if (!context || context.price.provider !== "paddle")
        return reply.code(404).send({
          error: {
            code: "billing_price_not_found",
            message: "Fiyat bulunamadı.",
          },
        });
      if (String(context.price.product_type) === "plan" && body.quantity !== 1)
        return reply.code(400).send({
          error: {
            code: "billing_quantity_invalid",
            message: "Plan aboneliği yalnızca tek adet olabilir.",
          },
        });
      if (String(context.price.product_type) === "channel")
        return reply.code(409).send({
          error: {
            code: "billing_line_activation_request_required",
            message:
              "Hat lisansları satış onayı sonrasında aboneliğinize eklenir.",
          },
        });
      if (
        String(context.price.product_type) === "credit" &&
        !context.price.credits_per_unit
      )
        return reply.code(409).send({
          error: {
            code: "billing_credit_package_incomplete",
            message: "Kredi paketinin miktarı henüz yapılandırılmadı.",
          },
        });
      const transaction = await options.paddle.createCheckout({
        providerPriceRef: String(context.price.provider_price_ref),
        quantity: body.quantity,
        organizationId: request.claims!.organizationId,
        organizationName: String(context.organization.name),
        ownerEmail: context.organization.owner_email
          ? String(context.organization.owner_email)
          : null,
        planCode: context.price.plan_code
          ? String(context.price.plan_code)
          : null,
        creditAmount:
          String(context.price.product_type) === "credit" &&
          context.price.credits_per_unit
            ? Number(context.price.credits_per_unit) * body.quantity
            : null,
      });
      const checkout =
        transaction.checkout && typeof transaction.checkout === "object"
          ? (transaction.checkout as Record<string, unknown>)
          : {};
      return reply.code(201).send({
        data: {
          transactionId: transaction.id,
          checkoutUrl: checkout.url ?? null,
          clientToken: options.paddle.clientToken,
          environment: options.paddle.environment,
        },
      });
    },
  );

  app.post(
    "/api/v1/billing/portal-session",
    { preHandler: options.authorize("billing:manage") },
    async (request, reply) => {
      if (!options.paddle)
        return reply.code(503).send({
          error: {
            code: "billing_provider_not_configured",
            message: "Ödeme sağlayıcısı henüz yapılandırılmadı.",
          },
        });
      const context = await repository.portalContext(
        request.claims!.organizationId,
      );
      if (!context)
        return reply.code(409).send({
          error: {
            code: "billing_customer_not_found",
            message: "Henüz yönetilebilir bir ödeme hesabı yok.",
          },
        });
      const session = await options.paddle.createPortalSession({
        customerRef: String(context.provider_customer_ref),
        subscriptionRef: context.provider_subscription_ref
          ? String(context.provider_subscription_ref)
          : null,
      });
      const urls =
        session.urls && typeof session.urls === "object"
          ? (session.urls as Record<string, unknown>)
          : {};
      const general =
        urls.general && typeof urls.general === "object"
          ? (urls.general as Record<string, unknown>)
          : {};
      return { data: { url: general.overview ?? null } };
    },
  );

  app.post("/api/v1/billing/webhooks/paddle", async (request, reply) => {
    if (!options.paddle)
      return reply.code(503).send({
        error: { code: "billing_provider_not_configured" },
      });
    const signature = request.headers["paddle-signature"];
    const rawBody = request.rawBody ?? "";
    if (
      !verifyPaddleSignature({
        rawBody,
        signature: typeof signature === "string" ? signature : undefined,
        secret: options.paddle.webhookSecret,
      })
    )
      return reply.code(401).send({
        error: { code: "invalid_billing_webhook_signature" },
      });
    const event = normalizePaddleWebhook(request.body, options.graceDays ?? 7);
    const organizationId = z.string().uuid().safeParse(event.organizationId);
    if (!organizationId.success)
      return reply.code(422).send({
        error: { code: "billing_webhook_organization_missing" },
      });
    const result = await repository.reconcile({
      organizationId: organizationId.data,
      provider: "paddle",
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payloadHash: BillingRepository.payloadHash(rawBody),
      ...(event.subscription ? { subscription: event.subscription } : {}),
      ...(event.transaction ? { transaction: event.transaction } : {}),
      ...(event.creditPurchase ? { creditPurchase: event.creditPurchase } : {}),
    });
    return { data: result };
  });
}

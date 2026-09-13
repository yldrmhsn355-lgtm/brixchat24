import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Permission } from "@brixchat/auth";
import { CampaignRepository } from "@brixchat/database";
import { previewCampaignCsv } from "@brixchat/shared";
import { z } from "zod";

const idSchema = z.object({ id: z.string().uuid() });
const draftSchema = z.object({
  requestKey: z.string().uuid(),
  channelId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  content: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("text"),
      text: z.string().trim().min(1).max(4096),
    }),
    z.object({
      type: z.literal("template"),
      templateId: z.string().uuid(),
      variables: z
        .record(z.string().regex(/^[a-z_]+\.\d+$/), z.string().max(1024))
        .refine((value) => Object.keys(value).length <= 100),
    }),
  ]),
  recipients: z
    .array(
      z.object({
        phone: z.string().max(40),
        name: z.string().trim().max(120).default(""),
      }),
    )
    .min(1)
    .max(1000),
});

export function registerCampaignRoutes(
  app: FastifyInstance,
  repository: CampaignRepository,
  authorize: (
    permission: Permission,
  ) => (request: FastifyRequest) => Promise<void>,
) {
  const manager = async (request: FastifyRequest) => {
    await authorize("message:send")(request);
    await repository.assertManager(
      request.claims!.organizationId,
      request.claims!.sub,
    );
  };
  const route = { preHandler: manager };
  app.get("/api/v1/campaigns/options", route, async (request) => ({
    data: await repository.options(request.claims!.organizationId),
  }));
  app.get("/api/v1/campaigns", route, async (request) => ({
    data: await repository.list(request.claims!.organizationId),
  }));
  app.get("/api/v1/campaigns/:id", route, async (request) => {
    const { id } = idSchema.parse(request.params);
    const organizationId = request.claims!.organizationId;
    return {
      data: {
        campaign: await repository.get(organizationId, id),
        recipients: await repository.recipients(organizationId, id),
      },
    };
  });
  app.post("/api/v1/campaigns/preview-csv", route, async (request, reply) => {
    const { csv } = z
      .object({ csv: z.string().max(1_000_000) })
      .parse(request.body);
    try {
      return { data: previewCampaignCsv(csv) };
    } catch (error) {
      return reply
        .code(400)
        .send({
          error: {
            code: "campaign_csv_invalid",
            message: error instanceof Error ? error.message : "CSV okunamadı.",
          },
        });
    }
  });
  app.post("/api/v1/campaigns", route, async (request, reply) => {
    const result = await repository.createDraft({
      ...draftSchema.parse(request.body),
      organizationId: request.claims!.organizationId,
      userId: request.claims!.sub,
    });
    return reply
      .code(result.created ? 201 : 200)
      .send({ data: result.campaign });
  });
  app.post("/api/v1/campaigns/:id/dry-run", route, async (request) => ({
    data: await repository.dryRun(
      request.claims!.organizationId,
      idSchema.parse(request.params).id,
      request.claims!.sub,
    ),
  }));
  app.post("/api/v1/campaigns/:id/start", route, async (request) => {
    const body = z
      .object({
        confirm: z.literal(true),
        token: z.string().uuid(),
        recipientCount: z.number().int().min(1).max(1000),
      })
      .parse(request.body);
    return {
      data: await repository.start(
        request.claims!.organizationId,
        idSchema.parse(request.params).id,
        request.claims!.sub,
        body.token,
        body.recipientCount,
      ),
    };
  });
  app.post("/api/v1/campaigns/:id/cancel", route, async (request) => ({
    data: await repository.cancel(
      request.claims!.organizationId,
      idSchema.parse(request.params).id,
      request.claims!.sub,
    ),
  }));
}

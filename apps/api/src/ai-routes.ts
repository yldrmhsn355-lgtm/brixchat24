import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Permission } from "@brixchat/auth";
import type { AiRepository, AiWorkerRepository } from "@brixchat/database";
import {
  HashEmbeddingProvider,
  OpenRouterEmbeddingProvider,
  executeAgentRun,
  generateForConversation,
  parseAgentVersionRow,
  resolveModelChain,
  retrieveScopedKnowledge,
  type AiToolGateway,
  type ConversationContextData,
  type EmbeddingProvider,
  type PromptContext,
  type RunScope,
  type VisionObjectStorage,
} from "@brixchat/ai";
import { decryptSecret, encryptSecret } from "@brixchat/integrations";

type Row = Record<string, unknown>;
type Authorize = (
  permission: Permission,
) => (request: FastifyRequest) => Promise<void>;

export interface AiEnvOptions {
  enabled: boolean;
  apiKey: string | null;
  defaultModel: string | null;
  fallbackModel: string | null;
  embeddingModel: string | null;
}

const uuid = z.string().uuid();
const modeEnum = z.enum(["observe", "copilot", "approval", "autopilot"]);
const toolAccessEnum = z.enum(["allowed", "approval", "denied"]);

const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().min(10).max(300).nullable().optional(),
  defaultModel: z.string().max(120).nullable().optional(),
  fallbackModel: z.string().max(120).nullable().optional(),
  dailyBudgetUsd: z.number().min(0).max(100000).nullable().optional(),
  debounceMs: z.number().int().min(0).max(120000).optional(),
  sensitiveBusinessMode: z.boolean().optional(),
  extraPolicy: z.string().max(4000).optional(),
  takeoverPauseMinutes: z.number().int().min(0).max(10080).optional(),
});

const agentCreateSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
});

const versionFieldsSchema = z.object({
  mode: modeEnum.optional(),
  model: z.string().max(120).optional(),
  fallbackModel: z.string().max(120).nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxSteps: z.number().int().min(1).max(32).optional(),
  maxCostPerRunUsd: z.number().min(0.001).max(50).optional(),
  defaultLanguage: z.string().min(2).max(12).optional(),
  allowedLanguages: z.array(z.string().min(2).max(12)).max(10).optional(),
  systemInstruction: z.string().max(8000).optional(),
  businessObjective: z.string().max(2000).optional(),
  persona: z
    .object({
      tone: z.string().max(200).optional(),
      personality: z.string().max(500).optional(),
      communicationStyle: z.string().max(500).optional(),
      responseLength: z.enum(["short", "medium", "long"]).optional(),
      emojiPolicy: z.enum(["none", "sparse", "free"]).optional(),
    })
    .optional(),
  behaviorRules: z.array(z.string().min(1).max(500)).max(40).optional(),
  forbiddenTopics: z.array(z.string().min(1).max(200)).max(40).optional(),
  exampleResponses: z
    .array(
      z.object({
        customer: z.string().min(1).max(1000),
        reply: z.string().min(1).max(2000),
      }),
    )
    .max(20)
    .optional(),
  handoffRules: z
    .object({
      onHumanRequest: z.boolean().optional(),
      onNegativeSentiment: z.boolean().optional(),
      onMissingKnowledge: z.boolean().optional(),
      restrictedIntents: z.array(z.string().max(60)).max(30).optional(),
      maxConsecutiveAiMessages: z.number().int().min(1).max(20).optional(),
    })
    .optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  workingHours: z
    .object({
      timezone: z.string().max(60).optional(),
      schedule: z
        .record(
          z.array(z.object({ start: z.string(), end: z.string() })).max(4),
        )
        .optional(),
      outsideHoursMode: z.enum(["off", "observe", "normal"]).optional(),
    })
    .optional(),
  responseDelayMinMs: z.number().int().min(0).max(60000).optional(),
  responseDelayMaxMs: z.number().int().min(0).max(60000).optional(),
  toolPermissions: z.record(toolAccessEnum).optional(),
  config: z
    .object({
      maxOutputTokens: z.number().int().min(64).max(8000).optional(),
      visionEnabled: z.boolean().optional(),
      webSearchEnabled: z.boolean().optional(),
      citeSources: z.boolean().optional(),
    })
    .optional(),
});

const agentPatchSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .merge(versionFieldsSchema);

const channelAssignmentsSchema = z.object({
  assignments: z
    .array(
      z.object({
        channelId: uuid,
        enabled: z.boolean().default(true),
        modeOverride: modeEnum.nullable().optional(),
      }),
    )
    .max(50),
});

const knowledgeBaseSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  scope: z.enum(["workspace", "agent", "channel"]).default("workspace"),
  channelId: uuid.nullable().optional(),
});

const documentSchema = z.object({
  title: z.string().min(2).max(200),
  sourceType: z
    .enum(["text", "faq", "snippet", "conversation"])
    .default("text"),
  content: z.string().min(1).max(200000),
  language: z.string().max(12).optional(),
});

const feedbackSchema = z.object({
  runId: uuid,
  action: z.enum(["rated_good", "rated_bad", "sent", "edited", "regenerated"]),
  finalText: z.string().max(4000).optional(),
  comment: z.string().max(1000).optional(),
});

const playgroundSchema = z.object({
  agentId: uuid,
  useDraft: z.boolean().default(true),
  messages: z
    .array(
      z.object({
        role: z.enum(["customer", "business"]),
        text: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(20),
  customerName: z.string().max(120).optional(),
  customerLanguage: z.string().max(12).optional(),
  modelOverride: z.string().max(120).optional(),
});

const evaluationDatasetSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  agentId: uuid.nullable().optional(),
});

const evaluationCaseSchema = z.object({
  name: z.string().min(2).max(120),
  messages: z
    .array(
      z.object({
        role: z.enum(["customer", "business"]),
        text: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(20),
  expectations: z
    .object({
      mustContain: z.array(z.string().max(200)).max(10).optional(),
      mustNotContain: z.array(z.string().max(200)).max(10).optional(),
      expectHandoff: z.boolean().optional(),
      language: z.string().max(12).optional(),
      minConfidence: z.number().min(0).max(1).optional(),
    })
    .default({}),
});

export function registerAiRoutes(
  app: FastifyInstance,
  repository: AiRepository,
  options: {
    authorize: Authorize;
    publish: (
      organizationId: string,
      event: Record<string, unknown>,
    ) => Promise<void>;
    workerStore: AiWorkerRepository;
    aiEnv: AiEnvOptions;
    appEncryptionKey?: string;
    imageStorage?: VisionObjectStorage;
    reserveAiUsage?: (
      organizationId: string,
      eventKey: string,
    ) => Promise<{ allowed: boolean; code: string | null }>;
  },
) {
  const dbQuery = repository.query.bind(repository);
  const workerStore = options.workerStore;

  const orgId = (request: FastifyRequest) => request.claims!.organizationId;

  const aiEvent = (
    type: string,
    organizationId: string,
    entityId: string,
    conversationId: string | undefined,
    payload: Record<string, unknown>,
  ) => ({
    eventId: crypto.randomUUID(),
    eventType: type,
    organizationId,
    entityType: "conversation",
    entityId,
    ...(conversationId ? { conversationId } : {}),
    occurredAt: new Date().toISOString(),
    payloadVersion: 1 as const,
    payload,
  });

  const audit = async (
    request: FastifyRequest,
    action: string,
    entityId: string | null,
    metadata: Record<string, unknown>,
  ) =>
    dbQuery`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,metadata)
      VALUES(${orgId(request)}::uuid,${request.claims!.sub}::uuid,${action},'ai',
        ${entityId ? repository.fragment`${entityId}::uuid` : null},
        ${repository.json(metadata)})`;

  const resolveWorkspaceApiKey = (context: ConversationContextData) => {
    if (context.aiApiKeyEncrypted && options.appEncryptionKey) {
      try {
        return decryptSecret(
          context.aiApiKeyEncrypted,
          options.appEncryptionKey,
        );
      } catch {
        return null;
      }
    }
    return options.aiEnv.apiKey;
  };

  const workspaceApiKeyFromRow = (row: Row | null) => {
    const encrypted = row?.api_key_encrypted;
    if (encrypted && options.appEncryptionKey) {
      try {
        return decryptSecret(String(encrypted), options.appEncryptionKey);
      } catch {
        return null;
      }
    }
    return options.aiEnv.apiKey;
  };

  const makeEmbedder = (apiKey: string): EmbeddingProvider | null => {
    if (!options.aiEnv.embeddingModel) return null;
    if (options.aiEnv.embeddingModel === "local/hash-256") {
      return new HashEmbeddingProvider();
    }
    return new OpenRouterEmbeddingProvider(
      apiKey,
      options.aiEnv.embeddingModel,
    );
  };

  const noopEvents = () => undefined;

  // -------------------------------------------------------------------- models
  // Public OpenRouter catalog proxied server-side (no key required upstream)
  // so admins pick model ids from a list instead of typing them blind.
  // Cached in-memory for an hour; on upstream failure the stale cache is
  // served rather than breaking the settings screens.
  let modelCatalog: {
    at: number;
    data: Array<{
      id: string;
      name: string;
      contextLength: number | null;
      promptPerMillion: string | null;
      completionPerMillion: string | null;
    }>;
  } | null = null;

  const perMillion = (value: unknown): string | null => {
    const price = Number(value);
    if (!Number.isFinite(price)) return null;
    if (price === 0) return "0";
    return (price * 1_000_000).toFixed(2);
  };

  app.get(
    "/api/v1/ai/models",
    { preHandler: options.authorize("ai:read") },
    async () => {
      if (modelCatalog && Date.now() - modelCatalog.at < 3_600_000) {
        return { data: modelCatalog.data };
      }
      try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`upstream_${response.status}`);
        const payload = (await response.json()) as {
          data?: Array<Record<string, unknown>>;
        };
        const data = (payload.data ?? [])
          .map((model) => {
            const pricing =
              model.pricing && typeof model.pricing === "object"
                ? (model.pricing as Record<string, unknown>)
                : {};
            return {
              id: String(model.id ?? ""),
              name: String(model.name ?? model.id ?? ""),
              contextLength: Number.isFinite(Number(model.context_length))
                ? Number(model.context_length)
                : null,
              promptPerMillion: perMillion(pricing.prompt),
              completionPerMillion: perMillion(pricing.completion),
            };
          })
          .filter((model) => model.id.length > 0)
          .sort((a, b) => a.id.localeCompare(b.id));
        modelCatalog = { at: Date.now(), data };
        return { data };
      } catch (reason) {
        app.log.warn(
          { error: reason instanceof Error ? reason.message : "unknown" },
          "openrouter model catalog fetch failed",
        );
        return { data: modelCatalog?.data ?? [] };
      }
    },
  );

  // ------------------------------------------------------------------ settings
  app.get(
    "/api/v1/ai/settings",
    { preHandler: options.authorize("ai:read") },
    async (request) => {
      const rows = await dbQuery<Row[]>`
        SELECT enabled,default_model,fallback_model,daily_budget_usd,debounce_ms,
          config,(api_key_encrypted IS NOT NULL) has_api_key
        FROM ai_settings WHERE organization_id=${orgId(request)}::uuid
      `;
      const row = rows[0];
      return {
        data: {
          globalEnabled: options.aiEnv.enabled,
          enabled: row?.enabled === true,
          hasApiKey: row?.has_api_key === true,
          hasEnvApiKey: options.aiEnv.apiKey !== null,
          defaultModel: row?.default_model ?? null,
          fallbackModel: row?.fallback_model ?? null,
          dailyBudgetUsd: row?.daily_budget_usd ?? null,
          debounceMs: row?.debounce_ms ?? 3000,
          config: row?.config ?? {},
          environmentDefaultModel: options.aiEnv.defaultModel,
        },
      };
    },
  );

  app.patch(
    "/api/v1/ai/settings",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = settingsPatchSchema.parse(request.body);
      if (body.apiKey !== undefined && body.apiKey !== null) {
        if (!options.appEncryptionKey) {
          return reply.code(409).send({
            error: {
              code: "encryption_key_missing",
              message:
                "API anahtarı saklanamıyor: sunucuda şifreleme anahtarı tanımlı değil.",
            },
          });
        }
      }
      const encryptedKey =
        body.apiKey === undefined
          ? undefined
          : body.apiKey === null
            ? null
            : encryptSecret(body.apiKey, options.appEncryptionKey!);
      const configPatch: Record<string, unknown> = {};
      if (body.sensitiveBusinessMode !== undefined) {
        configPatch.sensitiveBusinessMode = body.sensitiveBusinessMode;
      }
      if (body.extraPolicy !== undefined)
        configPatch.extraPolicy = body.extraPolicy;
      if (body.takeoverPauseMinutes !== undefined) {
        configPatch.takeoverPauseMinutes = body.takeoverPauseMinutes;
      }
      const rows = await dbQuery<Row[]>`
        INSERT INTO ai_settings(organization_id,enabled,api_key_encrypted,
          default_model,fallback_model,daily_budget_usd,debounce_ms,config)
        VALUES(${orgId(request)}::uuid,${body.enabled ?? false},
          ${encryptedKey ?? null},${body.defaultModel ?? null},
          ${body.fallbackModel ?? null},${body.dailyBudgetUsd ?? null},
          ${body.debounceMs ?? 3000},${repository.json(configPatch)})
        ON CONFLICT(organization_id) DO UPDATE SET
          enabled=COALESCE(${body.enabled ?? null},ai_settings.enabled),
          api_key_encrypted=CASE
            WHEN ${encryptedKey === undefined} THEN ai_settings.api_key_encrypted
            ELSE ${encryptedKey ?? null} END,
          default_model=CASE WHEN ${body.defaultModel === undefined}
            THEN ai_settings.default_model ELSE ${body.defaultModel ?? null} END,
          fallback_model=CASE WHEN ${body.fallbackModel === undefined}
            THEN ai_settings.fallback_model ELSE ${body.fallbackModel ?? null} END,
          daily_budget_usd=CASE WHEN ${body.dailyBudgetUsd === undefined}
            THEN ai_settings.daily_budget_usd ELSE ${body.dailyBudgetUsd ?? null} END,
          debounce_ms=COALESCE(${body.debounceMs ?? null},ai_settings.debounce_ms),
          config=ai_settings.config || ${repository.json(configPatch)},
          updated_at=now()
        RETURNING enabled,default_model,fallback_model,daily_budget_usd,debounce_ms,config
      `;
      await audit(request, "ai.settings.updated", null, {
        enabled: body.enabled,
      });
      return { data: rows[0] };
    },
  );

  // ------------------------------------------------------------------- agents
  app.get(
    "/api/v1/ai/agents",
    { preHandler: options.authorize("ai:read") },
    async (request) => {
      const rows = await dbQuery<Row[]>`
        SELECT agent.id,agent.name,agent.description,agent.status,agent.version,
          agent.created_at,agent.updated_at,
          published.version published_version,published.mode published_mode,
          published.model published_model,published.default_language,
          draft.version draft_version,
          (SELECT count(*)::int FROM ai_agent_channel_assignments assignment
            WHERE assignment.agent_id=agent.id AND assignment.enabled) channel_count,
          COALESCE(usage.runs,0) runs_today,COALESCE(usage.total_cost_usd,0) cost_today
        FROM ai_agents agent
        LEFT JOIN ai_agent_versions published ON published.id=agent.published_version_id
        LEFT JOIN ai_agent_versions draft ON draft.id=agent.draft_version_id
        LEFT JOIN ai_usage_daily usage
          ON usage.agent_id=agent.id AND usage.day=CURRENT_DATE
        WHERE agent.organization_id=${orgId(request)}::uuid
          AND agent.archived_at IS NULL
        ORDER BY agent.created_at DESC
      `;
      return { data: rows };
    },
  );

  app.post(
    "/api/v1/ai/agents",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = agentCreateSchema.parse(request.body);
      const conflict = await dbQuery<Row[]>`
        SELECT id FROM ai_agents
        WHERE organization_id=${orgId(request)}::uuid AND lower(name)=lower(${body.name})
      `;
      if (conflict.length > 0) {
        return reply.code(409).send({
          error: {
            code: "ai_agent_name_conflict",
            message: "Bu adla bir AI ajanı zaten var.",
          },
        });
      }
      const created = await repository.begin(async (tx) => {
        const agents = await tx<Row[]>`
          INSERT INTO ai_agents(organization_id,name,description,status,created_by,updated_by)
          VALUES(${orgId(request)}::uuid,${body.name},${body.description ?? null},
            'draft',${request.claims!.sub}::uuid,${request.claims!.sub}::uuid)
          RETURNING *
        `;
        const agent = agents[0]!;
        const versions = await tx<Row[]>`
          INSERT INTO ai_agent_versions(organization_id,agent_id,version,status,created_by)
          VALUES(${orgId(request)}::uuid,${String(agent.id)}::uuid,1,'draft',
            ${request.claims!.sub}::uuid)
          RETURNING id
        `;
        await tx`
          UPDATE ai_agents SET draft_version_id=${String(versions[0]!.id)}::uuid
          WHERE id=${String(agent.id)}::uuid
        `;
        return agent;
      });
      await audit(request, "ai.agent.created", String(created.id), {
        name: body.name,
      });
      return reply.code(201).send({ data: created });
    },
  );

  const loadAgent = async (request: FastifyRequest, id: string) => {
    const rows = await dbQuery<Row[]>`
      SELECT * FROM ai_agents
      WHERE id=${id}::uuid AND organization_id=${orgId(request)}::uuid
        AND archived_at IS NULL
    `;
    return rows[0] ?? null;
  };

  app.get<{ Params: { id: string } }>(
    "/api/v1/ai/agents/:id",
    { preHandler: options.authorize("ai:read") },
    async (request, reply) => {
      const agent = await loadAgent(request, request.params.id);
      if (!agent) {
        return reply.code(404).send({
          error: {
            code: "ai_agent_not_found",
            message: "AI ajanı bulunamadı.",
          },
        });
      }
      const [versions, assignments, knowledge] = await Promise.all([
        dbQuery<Row[]>`
          SELECT * FROM ai_agent_versions
          WHERE agent_id=${request.params.id}::uuid
            AND organization_id=${orgId(request)}::uuid
            AND id IN(${agent.draft_version_id ? repository.fragment`${String(agent.draft_version_id)}::uuid` : repository.fragment`'00000000-0000-0000-0000-000000000000'::uuid`},
              ${agent.published_version_id ? repository.fragment`${String(agent.published_version_id)}::uuid` : repository.fragment`'00000000-0000-0000-0000-000000000000'::uuid`})
        `,
        dbQuery<Row[]>`
          SELECT assignment.id,assignment.channel_id,assignment.enabled,
            assignment.mode_override,channel.name channel_name,
            channel.provider,channel.platform,channel.phone_number
          FROM ai_agent_channel_assignments assignment
          JOIN channels channel ON channel.id=assignment.channel_id
          WHERE assignment.agent_id=${request.params.id}::uuid
            AND assignment.organization_id=${orgId(request)}::uuid
        `,
        dbQuery<Row[]>`
          SELECT link.knowledge_base_id,kb.name
          FROM ai_agent_knowledge link
          JOIN ai_knowledge_bases kb ON kb.id=link.knowledge_base_id
          WHERE link.agent_id=${request.params.id}::uuid
            AND link.organization_id=${orgId(request)}::uuid
        `,
      ]);
      const draft =
        versions.find((v) => String(v.id) === String(agent.draft_version_id)) ??
        null;
      const published =
        versions.find(
          (v) => String(v.id) === String(agent.published_version_id),
        ) ?? null;
      return { data: { agent, draft, published, assignments, knowledge } };
    },
  );

  /** Ensure the agent has a mutable draft version; clone published if needed. */
  const ensureDraft = async (
    request: FastifyRequest,
    agent: Row,
  ): Promise<string> => {
    if (agent.draft_version_id) return String(agent.draft_version_id);
    const cloned = await repository.begin(async (tx) => {
      const next = await tx<Row[]>`
        SELECT COALESCE(max(version),0)+1 next FROM ai_agent_versions
        WHERE agent_id=${String(agent.id)}::uuid
      `;
      const nextVersion = Number(next[0]!.next);
      const rows = agent.published_version_id
        ? await tx<Row[]>`
            INSERT INTO ai_agent_versions(
              organization_id,agent_id,version,status,mode,model,fallback_model,
              temperature,max_steps,max_cost_per_run_usd,default_language,
              allowed_languages,system_instruction,business_objective,persona,
              behavior_rules,forbidden_topics,example_responses,handoff_rules,
              confidence_threshold,working_hours,response_delay_min_ms,
              response_delay_max_ms,tool_permissions,config,created_by)
            SELECT organization_id,agent_id,${nextVersion},'draft',mode,model,
              fallback_model,temperature,max_steps,max_cost_per_run_usd,
              default_language,allowed_languages,system_instruction,
              business_objective,persona,behavior_rules,forbidden_topics,
              example_responses,handoff_rules,confidence_threshold,working_hours,
              response_delay_min_ms,response_delay_max_ms,tool_permissions,config,
              ${request.claims!.sub}::uuid
            FROM ai_agent_versions WHERE id=${String(agent.published_version_id)}::uuid
            RETURNING id
          `
        : await tx<Row[]>`
            INSERT INTO ai_agent_versions(organization_id,agent_id,version,status,created_by)
            VALUES(${orgId(request)}::uuid,${String(agent.id)}::uuid,${nextVersion},
              'draft',${request.claims!.sub}::uuid)
            RETURNING id
          `;
      await tx`
        UPDATE ai_agents SET draft_version_id=${String(rows[0]!.id)}::uuid,updated_at=now()
        WHERE id=${String(agent.id)}::uuid
      `;
      return String(rows[0]!.id);
    });
    return cloned;
  };

  app.patch<{ Params: { id: string } }>(
    "/api/v1/ai/agents/:id",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = agentPatchSchema.parse(request.body);
      const agent = await loadAgent(request, request.params.id);
      if (!agent) {
        return reply.code(404).send({
          error: {
            code: "ai_agent_not_found",
            message: "AI ajanı bulunamadı.",
          },
        });
      }
      if (body.name !== undefined || body.description !== undefined) {
        await dbQuery`
          UPDATE ai_agents SET
            name=COALESCE(${body.name ?? null},name),
            description=CASE WHEN ${body.description === undefined}
              THEN description ELSE ${body.description ?? null} END,
            updated_by=${request.claims!.sub}::uuid,updated_at=now()
          WHERE id=${request.params.id}::uuid
            AND organization_id=${orgId(request)}::uuid
        `;
      }
      const draftId = await ensureDraft(request, agent);
      await dbQuery`
        UPDATE ai_agent_versions SET
          mode=COALESCE(${body.mode ?? null},mode),
          model=COALESCE(${body.model ?? null},model),
          fallback_model=CASE WHEN ${body.fallbackModel === undefined}
            THEN fallback_model ELSE ${body.fallbackModel ?? null} END,
          temperature=COALESCE(${body.temperature ?? null},temperature),
          max_steps=COALESCE(${body.maxSteps ?? null},max_steps),
          max_cost_per_run_usd=COALESCE(${body.maxCostPerRunUsd ?? null},max_cost_per_run_usd),
          default_language=COALESCE(${body.defaultLanguage ?? null},default_language),
          allowed_languages=CASE WHEN ${body.allowedLanguages === undefined}
            THEN allowed_languages ELSE ${repository.json(body.allowedLanguages ?? [])} END,
          system_instruction=COALESCE(${body.systemInstruction ?? null},system_instruction),
          business_objective=COALESCE(${body.businessObjective ?? null},business_objective),
          persona=CASE WHEN ${body.persona === undefined}
            THEN persona ELSE ${repository.json(body.persona ?? {})} END,
          behavior_rules=CASE WHEN ${body.behaviorRules === undefined}
            THEN behavior_rules ELSE ${repository.json(body.behaviorRules ?? [])} END,
          forbidden_topics=CASE WHEN ${body.forbiddenTopics === undefined}
            THEN forbidden_topics ELSE ${repository.json(body.forbiddenTopics ?? [])} END,
          example_responses=CASE WHEN ${body.exampleResponses === undefined}
            THEN example_responses ELSE ${repository.json(body.exampleResponses ?? [])} END,
          handoff_rules=CASE WHEN ${body.handoffRules === undefined}
            THEN handoff_rules ELSE ${repository.json(body.handoffRules ?? {})} END,
          confidence_threshold=COALESCE(${body.confidenceThreshold ?? null},confidence_threshold),
          working_hours=CASE WHEN ${body.workingHours === undefined}
            THEN working_hours ELSE ${repository.json(body.workingHours ?? {})} END,
          response_delay_min_ms=COALESCE(${body.responseDelayMinMs ?? null},response_delay_min_ms),
          response_delay_max_ms=COALESCE(${body.responseDelayMaxMs ?? null},response_delay_max_ms),
          tool_permissions=CASE WHEN ${body.toolPermissions === undefined}
            THEN tool_permissions ELSE ${repository.json(body.toolPermissions ?? {})} END,
          config=CASE WHEN ${body.config === undefined}
            THEN config ELSE config || ${repository.json(body.config ?? {})} END,
          updated_at=now()
        WHERE id=${draftId}::uuid AND organization_id=${orgId(request)}::uuid
      `;
      await audit(request, "ai.agent.updated", request.params.id, {});
      const refreshed = await dbQuery<Row[]>`
        SELECT * FROM ai_agent_versions WHERE id=${draftId}::uuid
      `;
      return { data: { draft: refreshed[0] } };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/agents/:id/publish",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const agent = await loadAgent(request, request.params.id);
      if (!agent) {
        return reply.code(404).send({
          error: {
            code: "ai_agent_not_found",
            message: "AI ajanı bulunamadı.",
          },
        });
      }
      if (!agent.draft_version_id) {
        return reply.code(409).send({
          error: {
            code: "ai_agent_no_draft",
            message: "Yayınlanacak taslak sürüm yok.",
          },
        });
      }
      const draftRows = await dbQuery<Row[]>`
        SELECT model FROM ai_agent_versions
        WHERE id=${String(agent.draft_version_id)}::uuid
      `;
      const hasModel =
        (draftRows[0]?.model && String(draftRows[0].model).trim().length > 0) ||
        options.aiEnv.defaultModel !== null;
      if (!hasModel) {
        const settings = await dbQuery<Row[]>`
          SELECT default_model FROM ai_settings
          WHERE organization_id=${orgId(request)}::uuid
        `;
        if (!settings[0]?.default_model) {
          return reply.code(409).send({
            error: {
              code: "ai_model_not_configured",
              message:
                "Yayınlamadan önce ajan için bir model seçin veya AI ayarlarında varsayılan model tanımlayın.",
            },
          });
        }
      }
      await repository.begin(async (tx) => {
        if (agent.published_version_id) {
          await tx`
            UPDATE ai_agent_versions SET status='retired',retired_at=now(),updated_at=now()
            WHERE id=${String(agent.published_version_id)}::uuid
          `;
        }
        await tx`
          UPDATE ai_agent_versions SET status='published',published_at=now(),updated_at=now()
          WHERE id=${String(agent.draft_version_id)}::uuid
        `;
        await tx`
          UPDATE ai_agents SET
            published_version_id=${String(agent.draft_version_id)}::uuid,
            draft_version_id=NULL,
            status=CASE WHEN status='draft' THEN 'active' ELSE status END,
            updated_by=${request.claims!.sub}::uuid,updated_at=now()
          WHERE id=${String(agent.id)}::uuid
        `;
      });
      await audit(request, "ai.agent.published", request.params.id, {});
      return { data: { published: true } };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/agents/:id/rollback",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = z
        .object({ version: z.number().int().min(1) })
        .parse(request.body);
      const agent = await loadAgent(request, request.params.id);
      if (!agent) {
        return reply.code(404).send({
          error: {
            code: "ai_agent_not_found",
            message: "AI ajanı bulunamadı.",
          },
        });
      }
      const targets = await dbQuery<Row[]>`
        SELECT id FROM ai_agent_versions
        WHERE agent_id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid AND version=${body.version}
      `;
      const target = targets[0];
      if (!target) {
        return reply.code(404).send({
          error: { code: "ai_version_not_found", message: "Sürüm bulunamadı." },
        });
      }
      await repository.begin(async (tx) => {
        if (agent.published_version_id) {
          await tx`
            UPDATE ai_agent_versions SET status='retired',retired_at=now(),updated_at=now()
            WHERE id=${String(agent.published_version_id)}::uuid
          `;
        }
        await tx`
          UPDATE ai_agent_versions SET status='published',published_at=now(),
            retired_at=NULL,updated_at=now()
          WHERE id=${String(target.id)}::uuid
        `;
        await tx`
          UPDATE ai_agents SET published_version_id=${String(target.id)}::uuid,
            updated_by=${request.claims!.sub}::uuid,updated_at=now()
          WHERE id=${String(agent.id)}::uuid
        `;
      });
      await audit(request, "ai.agent.rolled_back", request.params.id, {
        version: body.version,
      });
      return { data: { publishedVersion: body.version } };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/agents/:id/status",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = z
        .object({ status: z.enum(["active", "paused", "archived"]) })
        .parse(request.body);
      const agent = await loadAgent(request, request.params.id);
      if (!agent) {
        return reply.code(404).send({
          error: {
            code: "ai_agent_not_found",
            message: "AI ajanı bulunamadı.",
          },
        });
      }
      if (body.status === "active" && !agent.published_version_id) {
        return reply.code(409).send({
          error: {
            code: "ai_agent_not_published",
            message: "Ajanı etkinleştirmeden önce bir sürüm yayınlayın.",
          },
        });
      }
      await dbQuery`
        UPDATE ai_agents SET status=${body.status},
          archived_at=${body.status === "archived" ? repository.fragment`now()` : null},
          updated_by=${request.claims!.sub}::uuid,updated_at=now()
        WHERE id=${request.params.id}::uuid AND organization_id=${orgId(request)}::uuid
      `;
      await audit(request, "ai.agent.status_changed", request.params.id, {
        status: body.status,
      });
      return { data: { status: body.status } };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/ai/agents/:id/versions",
    { preHandler: options.authorize("ai:read") },
    async (request) => {
      const rows = await dbQuery<Row[]>`
        SELECT id,version,status,mode,model,published_at,retired_at,created_at
        FROM ai_agent_versions
        WHERE agent_id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid
        ORDER BY version DESC
      `;
      return { data: rows };
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/ai/agents/:id/channels",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = channelAssignmentsSchema.parse(request.body);
      const agent = await loadAgent(request, request.params.id);
      if (!agent) {
        return reply.code(404).send({
          error: {
            code: "ai_agent_not_found",
            message: "AI ajanı bulunamadı.",
          },
        });
      }
      const channelIds = body.assignments.map(
        (assignment) => assignment.channelId,
      );
      if (channelIds.length > 0) {
        const taken = await dbQuery<Row[]>`
          SELECT assignment.channel_id,agent.name agent_name
          FROM ai_agent_channel_assignments assignment
          JOIN ai_agents agent ON agent.id=assignment.agent_id
          WHERE assignment.organization_id=${orgId(request)}::uuid
            AND assignment.channel_id=ANY(${repository.fragment`${channelIds}::uuid[]`})
            AND assignment.agent_id<>${request.params.id}::uuid
        `;
        if (taken.length > 0) {
          return reply.code(409).send({
            error: {
              code: "ai_channel_already_assigned",
              message: `Kanal başka bir ajana atanmış: ${String(taken[0]!.agent_name)}. Önce o atamayı kaldırın.`,
            },
          });
        }
      }
      await repository.begin(async (tx) => {
        await tx`
          DELETE FROM ai_agent_channel_assignments
          WHERE agent_id=${request.params.id}::uuid
            AND organization_id=${orgId(request)}::uuid
        `;
        for (const assignment of body.assignments) {
          await tx`
            INSERT INTO ai_agent_channel_assignments(
              organization_id,agent_id,channel_id,enabled,mode_override,created_by)
            SELECT ${orgId(request)}::uuid,${request.params.id}::uuid,
              ${assignment.channelId}::uuid,${assignment.enabled},
              ${assignment.modeOverride ?? null},${request.claims!.sub}::uuid
            WHERE EXISTS(SELECT 1 FROM channels
              WHERE id=${assignment.channelId}::uuid
                AND organization_id=${orgId(request)}::uuid
                AND deleted_at IS NULL)
          `;
        }
      });
      await audit(request, "ai.agent.channels_updated", request.params.id, {
        channels: channelIds.length,
      });
      return { data: { assigned: channelIds.length } };
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/ai/agents/:id/knowledge",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = z
        .object({ knowledgeBaseIds: z.array(uuid).max(50) })
        .parse(request.body);
      const agent = await loadAgent(request, request.params.id);
      if (!agent) {
        return reply.code(404).send({
          error: {
            code: "ai_agent_not_found",
            message: "AI ajanı bulunamadı.",
          },
        });
      }
      await repository.begin(async (tx) => {
        await tx`
          DELETE FROM ai_agent_knowledge
          WHERE agent_id=${request.params.id}::uuid
            AND organization_id=${orgId(request)}::uuid
        `;
        for (const knowledgeBaseId of body.knowledgeBaseIds) {
          await tx`
            INSERT INTO ai_agent_knowledge(organization_id,agent_id,knowledge_base_id)
            SELECT ${orgId(request)}::uuid,${request.params.id}::uuid,${knowledgeBaseId}::uuid
            WHERE EXISTS(SELECT 1 FROM ai_knowledge_bases
              WHERE id=${knowledgeBaseId}::uuid
                AND organization_id=${orgId(request)}::uuid)
            ON CONFLICT DO NOTHING
          `;
        }
      });
      return { data: { linked: body.knowledgeBaseIds.length } };
    },
  );

  // ---------------------------------------------------------------- knowledge
  app.get(
    "/api/v1/ai/knowledge",
    { preHandler: options.authorize("ai:read") },
    async (request) => {
      const rows = await dbQuery<Row[]>`
        SELECT kb.id,kb.name,kb.description,kb.scope,kb.channel_id,kb.status,
          kb.created_at,kb.updated_at,
          (SELECT count(*)::int FROM ai_knowledge_documents document
            WHERE document.knowledge_base_id=kb.id) document_count,
          (SELECT count(*)::int FROM ai_knowledge_chunks chunk
            WHERE chunk.knowledge_base_id=kb.id) chunk_count,
          (SELECT max(document.indexed_at) FROM ai_knowledge_documents document
            WHERE document.knowledge_base_id=kb.id) last_indexed_at
        FROM ai_knowledge_bases kb
        WHERE kb.organization_id=${orgId(request)}::uuid AND kb.status='active'
        ORDER BY kb.created_at DESC
      `;
      return { data: rows };
    },
  );

  app.post(
    "/api/v1/ai/knowledge",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = knowledgeBaseSchema.parse(request.body);
      const rows = await dbQuery<Row[]>`
        INSERT INTO ai_knowledge_bases(organization_id,name,description,scope,channel_id,created_by)
        VALUES(${orgId(request)}::uuid,${body.name},${body.description ?? null},
          ${body.scope},${body.channelId ?? null},${request.claims!.sub}::uuid)
        ON CONFLICT(organization_id,name) DO NOTHING
        RETURNING *
      `;
      if (!rows[0]) {
        return reply.code(409).send({
          error: {
            code: "ai_knowledge_name_conflict",
            message: "Bu adla bir bilgi tabanı zaten var.",
          },
        });
      }
      return reply.code(201).send({ data: rows[0] });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/ai/knowledge/:id",
    { preHandler: options.authorize("ai:manage") },
    async (request) => {
      await dbQuery`
        UPDATE ai_knowledge_bases SET status='archived',updated_at=now()
        WHERE id=${request.params.id}::uuid AND organization_id=${orgId(request)}::uuid
      `;
      return { data: { archived: true } };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/ai/knowledge/:id/documents",
    { preHandler: options.authorize("ai:read") },
    async (request) => {
      const rows = await dbQuery<Row[]>`
        SELECT id,title,source_type,status,error_message,chunk_count,version,
          indexed_at,language,created_at,updated_at,
          left(content,240) content_preview
        FROM ai_knowledge_documents
        WHERE knowledge_base_id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid
        ORDER BY created_at DESC
      `;
      return { data: rows };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/knowledge/:id/documents",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = documentSchema.parse(request.body);
      const rows = await dbQuery<Row[]>`
        INSERT INTO ai_knowledge_documents(
          organization_id,knowledge_base_id,title,source_type,content,language,
          status,created_by)
        SELECT ${orgId(request)}::uuid,${request.params.id}::uuid,${body.title},
          ${body.sourceType},${body.content},${body.language ?? null},'pending',
          ${request.claims!.sub}::uuid
        WHERE EXISTS(SELECT 1 FROM ai_knowledge_bases
          WHERE id=${request.params.id}::uuid
            AND organization_id=${orgId(request)}::uuid AND status='active')
        RETURNING id,title,status
      `;
      if (!rows[0]) {
        return reply.code(404).send({
          error: {
            code: "ai_knowledge_not_found",
            message: "Bilgi tabanı bulunamadı.",
          },
        });
      }
      return reply.code(201).send({ data: rows[0] });
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/ai/documents/:id",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = z
        .object({
          title: z.string().min(2).max(200).optional(),
          content: z.string().min(1).max(200000).optional(),
        })
        .parse(request.body);
      const rows = await dbQuery<Row[]>`
        UPDATE ai_knowledge_documents SET
          title=COALESCE(${body.title ?? null},title),
          content=COALESCE(${body.content ?? null},content),
          version=version+CASE WHEN ${body.content !== undefined} THEN 1 ELSE 0 END,
          status=CASE WHEN ${body.content !== undefined} THEN 'pending' ELSE status END,
          updated_at=now()
        WHERE id=${request.params.id}::uuid AND organization_id=${orgId(request)}::uuid
        RETURNING id,title,status,version
      `;
      if (!rows[0]) {
        return reply.code(404).send({
          error: {
            code: "ai_document_not_found",
            message: "Belge bulunamadı.",
          },
        });
      }
      return { data: rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/ai/documents/:id",
    { preHandler: options.authorize("ai:manage") },
    async (request) => {
      await dbQuery`
        DELETE FROM ai_knowledge_documents
        WHERE id=${request.params.id}::uuid AND organization_id=${orgId(request)}::uuid
      `;
      return { data: { deleted: true } };
    },
  );

  // ------------------------------------------------------------- conversations
  app.get<{ Params: { id: string } }>(
    "/api/v1/ai/conversations/:id",
    { preHandler: options.authorize("ai:copilot") },
    async (request) => {
      const rows = await dbQuery<Row[]>`
        SELECT conv_ai.status,conv_ai.mode_override,conv_ai.paused_until,
          conv_ai.paused_reason,conv_ai.human_takeover_at,
          COALESCE(conv_ai.agent_id,assignment.agent_id) agent_id,
          agent.name agent_name,agent.status agent_status,
          published.mode agent_mode,published.model agent_model
        FROM conversations conversation
        LEFT JOIN ai_conversation_settings conv_ai
          ON conv_ai.conversation_id=conversation.id
        LEFT JOIN ai_agent_channel_assignments assignment
          ON assignment.organization_id=conversation.organization_id
         AND assignment.channel_id=conversation.channel_id AND assignment.enabled
        LEFT JOIN ai_agents agent
          ON agent.id=COALESCE(conv_ai.agent_id,assignment.agent_id)
        LEFT JOIN ai_agent_versions published ON published.id=agent.published_version_id
        WHERE conversation.id=${request.params.id}::uuid
          AND conversation.organization_id=${orgId(request)}::uuid
      `;
      const latest = await dbQuery<Row[]>`
        SELECT id,decision,response_text,confidence,handoff_reason,started_at,final_text
        FROM ai_runs
        WHERE conversation_id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid
          AND decision IN('suggested','draft_created','handoff')
        ORDER BY started_at DESC LIMIT 1
      `;
      return {
        data: { state: rows[0] ?? null, latestSuggestion: latest[0] ?? null },
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/conversations/:id/generate",
    { preHandler: options.authorize("ai:copilot") },
    async (request, reply) => {
      if (!options.aiEnv.enabled) {
        return reply.code(409).send({
          error: { code: "ai_disabled", message: "AI özelliği kapalı." },
        });
      }
      const body = z
        .object({
          style: z
            .enum(["shorter", "longer", "friendlier", "professional"])
            .optional(),
          translateTo: z.string().min(2).max(12).optional(),
        })
        .default({})
        .parse(request.body ?? {});
      const styleHints: Record<string, string> = {
        shorter:
          "Make this reply noticeably shorter than usual: one or two sentences.",
        longer: "Provide a fuller, more detailed reply than usual.",
        friendlier: "Use an especially warm, friendly tone in this reply.",
        professional:
          "Use an especially formal, professional tone in this reply.",
      };
      const styleHint = body.translateTo
        ? `Write the reply in ${body.translateTo}.`
        : body.style
          ? styleHints[body.style]
          : undefined;
      try {
        const result = await generateForConversation({
          store: workerStore,
          organizationId: orgId(request),
          conversationId: request.params.id,
          requestedBy: request.claims!.sub,
          apiKeyResolver: resolveWorkspaceApiKey,
          environmentDefaultModel: options.aiEnv.defaultModel,
          embedder: options.aiEnv.apiKey
            ? makeEmbedder(options.aiEnv.apiKey)
            : null,
          events: noopEvents,
          styleHint,
          imageStorage: options.imageStorage,
        });
        return {
          data: {
            runId: result.runId,
            agentName: result.agentName,
            agentVersion: result.agentVersion,
            text: result.verdict.contract.text,
            language: result.verdict.contract.language,
            confidence: result.verdict.contract.confidence,
            requiresHuman: result.verdict.contract.requiresHuman,
            handoffReason: result.verdict.contract.handoffReason,
            knowledgeSources: result.verdict.contract.knowledgeSources,
            usage: result.verdict.contract.usage,
            model: result.verdict.contract.modelUsed,
            latencyMs: result.verdict.contract.latencyMs,
          },
        };
      } catch (reason) {
        const statusCode =
          (reason as { statusCode?: number }).statusCode ?? 502;
        const code =
          reason instanceof Error && statusCode !== 502
            ? reason.message
            : "ai_generation_failed";
        return reply.code(statusCode).send({
          error: {
            code,
            message:
              statusCode === 502
                ? "AI yanıtı üretilemedi. Lütfen tekrar deneyin."
                : code === "ai_agent_not_assigned"
                  ? "Bu kanala atanmış yayınlanmış bir AI ajanı yok."
                  : code === "no_customer_message"
                    ? "Yanıtlanacak yeni bir müşteri mesajı yok."
                    : "AI yanıtı üretilemedi.",
          },
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/conversations/:id/pause",
    { preHandler: options.authorize("ai:copilot") },
    async (request) => {
      const body = z
        .object({
          minutes: z.number().int().min(1).max(10080).nullable().optional(),
        })
        .default({})
        .parse(request.body ?? {});
      const pausedUntil = body.minutes
        ? new Date(Date.now() + body.minutes * 60_000)
        : null;
      await workerStore.upsertConversationAiState({
        organizationId: orgId(request),
        conversationId: request.params.id,
        status: "paused",
        pausedUntil,
        pausedReason: "manual",
        pausedBy: request.claims!.sub,
      });
      await options.publish(
        orgId(request),
        aiEvent(
          "ai.state.changed",
          orgId(request),
          request.params.id,
          request.params.id,
          {
            status: "paused",
            pausedUntil: pausedUntil?.toISOString() ?? null,
          },
        ),
      );
      return { data: { status: "paused", pausedUntil } };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/conversations/:id/resume",
    { preHandler: options.authorize("ai:copilot") },
    async (request) => {
      await workerStore.upsertConversationAiState({
        organizationId: orgId(request),
        conversationId: request.params.id,
        status: "active",
        pausedUntil: null,
        pausedReason: null,
        pausedBy: null,
      });
      await dbQuery`
        UPDATE ai_conversation_settings SET human_takeover_at=NULL,updated_at=now()
        WHERE conversation_id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid
      `;
      await options.publish(
        orgId(request),
        aiEvent(
          "ai.state.changed",
          orgId(request),
          request.params.id,
          request.params.id,
          {
            status: "active",
          },
        ),
      );
      return { data: { status: "active" } };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/conversations/:id/agent",
    { preHandler: options.authorize("ai:manage") },
    async (request) => {
      const body = z.object({ agentId: uuid.nullable() }).parse(request.body);
      await workerStore.upsertConversationAiState({
        organizationId: orgId(request),
        conversationId: request.params.id,
        agentId: body.agentId,
      });
      return { data: { agentId: body.agentId } };
    },
  );

  // --------------------------------------------------------------------- runs
  app.get(
    "/api/v1/ai/runs",
    { preHandler: options.authorize("ai:read") },
    async (request) => {
      const query = z
        .object({
          agentId: uuid.optional(),
          conversationId: uuid.optional(),
          decision: z.string().max(30).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query ?? {});
      const rows = await dbQuery<Row[]>`
        SELECT run.id,run.agent_id,run.agent_version,run.conversation_id,
          run.channel_id,run.mode,run.status,run.decision,run.confidence,
          run.requires_human,run.handoff_reason,run.model_used,run.fallback_used,
          run.input_tokens,run.output_tokens,run.total_cost_usd,run.latency_ms,
          run.started_at,run.completed_at,run.error_code,
          left(coalesce(run.response_text,''),160) response_preview,
          agent.name agent_name
        FROM ai_runs run
        LEFT JOIN ai_agents agent ON agent.id=run.agent_id
        WHERE run.organization_id=${orgId(request)}::uuid
          ${query.agentId ? repository.fragment`AND run.agent_id=${query.agentId}::uuid` : repository.fragment``}
          ${query.conversationId ? repository.fragment`AND run.conversation_id=${query.conversationId}::uuid` : repository.fragment``}
          ${query.decision ? repository.fragment`AND run.decision=${query.decision}` : repository.fragment``}
        ORDER BY run.started_at DESC
        LIMIT ${query.limit}
      `;
      return { data: rows };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/ai/runs/:id",
    { preHandler: options.authorize("ai:read") },
    async (request, reply) => {
      const rows = await dbQuery<Row[]>`
        SELECT run.*,agent.name agent_name
        FROM ai_runs run
        LEFT JOIN ai_agents agent ON agent.id=run.agent_id
        WHERE run.id=${request.params.id}::uuid
          AND run.organization_id=${orgId(request)}::uuid
      `;
      if (!rows[0]) {
        return reply.code(404).send({
          error: {
            code: "ai_run_not_found",
            message: "Çalıştırma bulunamadı.",
          },
        });
      }
      const feedback = await dbQuery<Row[]>`
        SELECT action,final_text,comment,created_by,created_at FROM ai_feedback
        WHERE run_id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid
        ORDER BY created_at
      `;
      return { data: { run: rows[0], feedback } };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/runs/:id/approve",
    { preHandler: options.authorize("ai:approve") },
    async (request, reply) => {
      const body = z
        .object({ text: z.string().min(1).max(4000).optional() })
        .default({})
        .parse(request.body ?? {});
      const runs = await dbQuery<Row[]>`
        SELECT id,conversation_id,response_text,decision,final_text
        FROM ai_runs
        WHERE id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid
      `;
      const run = runs[0];
      if (!run || !run.conversation_id) {
        return reply.code(404).send({
          error: {
            code: "ai_run_not_found",
            message: "Çalıştırma bulunamadı.",
          },
        });
      }
      if (
        run.decision !== "draft_created" &&
        run.decision !== "suggested" &&
        run.decision !== "handoff"
      ) {
        return reply.code(409).send({
          error: {
            code: "ai_run_not_approvable",
            message: "Bu çalıştırma onaylanabilir durumda değil.",
          },
        });
      }
      if (run.final_text) {
        return reply.code(409).send({
          error: {
            code: "ai_run_already_sent",
            message: "Bu yanıt zaten gönderilmiş.",
          },
        });
      }
      const original = String(run.response_text ?? "");
      const finalText = body.text ?? original;
      const edited = finalText.trim() !== original.trim();
      const sent = await workerStore.sendAiMessage({
        organizationId: orgId(request),
        conversationId: String(run.conversation_id),
        runId: String(run.id),
        requestId: `approve:${String(run.id)}`,
        text: finalText,
      });
      if (sent.blocked) {
        return reply.code(409).send({
          error: {
            code: sent.blocked,
            message:
              sent.blocked === "ai_message_window_closed"
                ? "24 saatlik mesaj penceresi kapalı; yalnızca onaylı şablon gönderilebilir."
                : "Mesaj gönderilemedi: kanal bağlı değil.",
          },
        });
      }
      await dbQuery`
        UPDATE ai_runs SET final_text=${finalText}
        WHERE id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid
      `;
      await dbQuery`
        INSERT INTO ai_feedback(organization_id,run_id,action,original_text,final_text,created_by)
        VALUES(${orgId(request)}::uuid,${request.params.id}::uuid,
          ${edited ? "edited" : "approved"},${original},${finalText},
          ${request.claims!.sub}::uuid)
      `;
      if (edited) {
        await dbQuery`
          INSERT INTO ai_training_examples(
            organization_id,agent_id,source_run_id,status,customer_message,
            ai_output,human_output,language)
          SELECT run.organization_id,run.agent_id,run.id,'pending',
            COALESCE((SELECT body FROM messages
              WHERE id=run.trigger_message_id
                AND organization_id=run.organization_id),''),
            run.response_text,${finalText},run.response_meta->>'language'
          FROM ai_runs run
          WHERE run.id=${request.params.id}::uuid
            AND run.organization_id=${orgId(request)}::uuid
            AND run.agent_id IS NOT NULL
        `;
      }
      if (sent.messageId) {
        await options.publish(
          orgId(request),
          aiEvent(
            "message.created",
            orgId(request),
            sent.messageId,
            String(run.conversation_id),
            {
              messageId: sent.messageId,
              origin: "ai_agent",
              approvedBy: request.claims!.sub,
            },
          ),
        );
      }
      return {
        data: {
          sent: Boolean(sent.messageId),
          duplicate: sent.duplicate === true,
          edited,
        },
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/runs/:id/reject",
    { preHandler: options.authorize("ai:approve") },
    async (request, reply) => {
      const body = z
        .object({ comment: z.string().max(1000).optional() })
        .default({})
        .parse(request.body ?? {});
      const runs = await dbQuery<Row[]>`
        SELECT id,response_text,agent_id,trigger_message_id FROM ai_runs
        WHERE id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid
      `;
      if (!runs[0]) {
        return reply.code(404).send({
          error: {
            code: "ai_run_not_found",
            message: "Çalıştırma bulunamadı.",
          },
        });
      }
      await dbQuery`
        INSERT INTO ai_feedback(organization_id,run_id,action,original_text,comment,created_by)
        VALUES(${orgId(request)}::uuid,${request.params.id}::uuid,'rejected',
          ${String(runs[0].response_text ?? "")},${body.comment ?? null},
          ${request.claims!.sub}::uuid)
      `;
      return { data: { rejected: true } };
    },
  );

  app.post(
    "/api/v1/ai/feedback",
    { preHandler: options.authorize("ai:copilot") },
    async (request, reply) => {
      const body = feedbackSchema.parse(request.body);
      const runs = await dbQuery<Row[]>`
        SELECT id,response_text,agent_id,trigger_message_id,response_meta
        FROM ai_runs
        WHERE id=${body.runId}::uuid AND organization_id=${orgId(request)}::uuid
      `;
      const run = runs[0];
      if (!run) {
        return reply.code(404).send({
          error: {
            code: "ai_run_not_found",
            message: "Çalıştırma bulunamadı.",
          },
        });
      }
      await dbQuery`
        INSERT INTO ai_feedback(organization_id,run_id,action,original_text,final_text,comment,created_by)
        VALUES(${orgId(request)}::uuid,${body.runId}::uuid,${body.action},
          ${String(run.response_text ?? "")},${body.finalText ?? null},
          ${body.comment ?? null},${request.claims!.sub}::uuid)
      `;
      if (body.action === "edited" && body.finalText && run.agent_id) {
        await dbQuery`
          INSERT INTO ai_training_examples(
            organization_id,agent_id,source_run_id,status,customer_message,
            ai_output,human_output,language)
          VALUES(${orgId(request)}::uuid,${String(run.agent_id)}::uuid,
            ${body.runId}::uuid,'pending',
            COALESCE((SELECT body FROM messages
              WHERE id=${run.trigger_message_id ? repository.fragment`${String(run.trigger_message_id)}::uuid` : null}
                AND organization_id=${orgId(request)}::uuid),''),
            ${String(run.response_text ?? "")},${body.finalText},
            ${(run.response_meta as Row | null)?.language ? String((run.response_meta as Row).language) : null})
        `;
      }
      return reply.code(201).send({ data: { recorded: true } });
    },
  );

  // ----------------------------------------------------------------- training
  app.get(
    "/api/v1/ai/training",
    { preHandler: options.authorize("ai:training") },
    async (request) => {
      const query = z
        .object({
          status: z
            .enum(["pending", "approved", "rejected"])
            .default("pending"),
          agentId: uuid.optional(),
        })
        .parse(request.query ?? {});
      const rows = await dbQuery<Row[]>`
        SELECT example.*,agent.name agent_name
        FROM ai_training_examples example
        JOIN ai_agents agent ON agent.id=example.agent_id
        WHERE example.organization_id=${orgId(request)}::uuid
          AND example.status=${query.status}
          ${query.agentId ? repository.fragment`AND example.agent_id=${query.agentId}::uuid` : repository.fragment``}
        ORDER BY example.created_at DESC
        LIMIT 100
      `;
      return { data: rows };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/training/:id/review",
    { preHandler: options.authorize("ai:training") },
    async (request, reply) => {
      const body = z
        .object({
          status: z.enum(["approved", "rejected"]),
          notes: z.string().max(1000).optional(),
        })
        .parse(request.body);
      const rows = await dbQuery<Row[]>`
        UPDATE ai_training_examples SET status=${body.status},
          notes=COALESCE(${body.notes ?? null},notes),
          reviewed_by=${request.claims!.sub}::uuid,reviewed_at=now(),updated_at=now()
        WHERE id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid AND status='pending'
        RETURNING id,status
      `;
      if (!rows[0]) {
        return reply.code(404).send({
          error: {
            code: "ai_training_example_not_found",
            message: "Bekleyen eğitim örneği bulunamadı.",
          },
        });
      }
      return { data: rows[0] };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/training/:id/promote",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = z
        .object({
          target: z.enum(["example", "knowledge"]),
          knowledgeBaseId: uuid.optional(),
        })
        .parse(request.body);
      const rows = await dbQuery<Row[]>`
        SELECT * FROM ai_training_examples
        WHERE id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid AND status='approved'
      `;
      const example = rows[0];
      if (!example) {
        return reply.code(409).send({
          error: {
            code: "ai_training_example_not_approved",
            message: "Yalnızca onaylanmış örnekler tanıtılabilir.",
          },
        });
      }
      if (body.target === "example") {
        const agent = await loadAgent(request, String(example.agent_id));
        if (!agent) {
          return reply.code(404).send({
            error: {
              code: "ai_agent_not_found",
              message: "AI ajanı bulunamadı.",
            },
          });
        }
        const draftId = await ensureDraft(request, agent);
        await dbQuery`
          UPDATE ai_agent_versions SET
            example_responses=example_responses || ${repository.json([
              {
                customer: String(example.customer_message),
                reply: String(example.human_output),
              },
            ])},
            updated_at=now()
          WHERE id=${draftId}::uuid AND organization_id=${orgId(request)}::uuid
        `;
      } else {
        if (!body.knowledgeBaseId) {
          return reply.code(400).send({
            error: {
              code: "knowledge_base_required",
              message: "Bilgi tabanı seçin.",
            },
          });
        }
        await dbQuery`
          INSERT INTO ai_knowledge_documents(
            organization_id,knowledge_base_id,title,source_type,content,status,created_by)
          SELECT ${orgId(request)}::uuid,${body.knowledgeBaseId}::uuid,
            ${"Onaylı yanıt: " + String(example.customer_message).slice(0, 80)},
            'conversation',
            ${`Müşteri sorusu: ${String(example.customer_message)}\n\nOnaylı yanıt: ${String(example.human_output)}`},
            'pending',${request.claims!.sub}::uuid
          WHERE EXISTS(SELECT 1 FROM ai_knowledge_bases
            WHERE id=${body.knowledgeBaseId}::uuid
              AND organization_id=${orgId(request)}::uuid AND status='active')
        `;
      }
      await dbQuery`
        UPDATE ai_training_examples SET promoted_to=${body.target},promoted_at=now(),
          updated_at=now()
        WHERE id=${request.params.id}::uuid AND organization_id=${orgId(request)}::uuid
      `;
      return { data: { promoted: body.target } };
    },
  );

  // --------------------------------------------------------------- playground
  const runPlayground = async (
    request: FastifyRequest,
    input: z.infer<typeof playgroundSchema>,
    triggerSource: "playground" | "evaluation",
  ) => {
    const agents = await dbQuery<Row[]>`
      SELECT agent.id,agent.name,agent.status,agent.draft_version_id,
        agent.published_version_id
      FROM ai_agents agent
      WHERE agent.id=${input.agentId}::uuid
        AND agent.organization_id=${orgId(request)}::uuid
        AND agent.archived_at IS NULL
    `;
    const agentRow = agents[0];
    if (!agentRow) {
      throw Object.assign(new Error("ai_agent_not_found"), { statusCode: 404 });
    }
    const versionId = input.useDraft
      ? (agentRow.draft_version_id ?? agentRow.published_version_id)
      : (agentRow.published_version_id ?? agentRow.draft_version_id);
    if (!versionId) {
      throw Object.assign(new Error("ai_agent_no_version"), {
        statusCode: 409,
      });
    }
    const versionRows = await dbQuery<Row[]>`
      SELECT version.*,${String(agentRow.name)} agent_name
      FROM ai_agent_versions version
      WHERE version.id=${String(versionId)}::uuid
        AND version.organization_id=${orgId(request)}::uuid
    `;
    const agent = parseAgentVersionRow(versionRows[0]!);
    if (input.modelOverride) agent.model = input.modelOverride;

    const settingsRows = await dbQuery<Row[]>`
      SELECT api_key_encrypted,default_model,fallback_model,config
      FROM ai_settings WHERE organization_id=${orgId(request)}::uuid
    `;
    const apiKey = workspaceApiKeyFromRow(settingsRows[0] ?? null);
    if (!apiKey) {
      throw Object.assign(new Error("ai_api_key_missing"), { statusCode: 409 });
    }
    const settingsConfig =
      settingsRows[0]?.config && typeof settingsRows[0].config === "object"
        ? (settingsRows[0].config as Row)
        : {};

    const modelChain = resolveModelChain({
      agentModel: agent.model,
      agentFallbackModel: agent.fallbackModel,
      workspaceDefaultModel: settingsRows[0]?.default_model
        ? String(settingsRows[0].default_model)
        : null,
      workspaceFallbackModel: settingsRows[0]?.fallback_model
        ? String(settingsRows[0].fallback_model)
        : null,
      environmentDefaultModel: options.aiEnv.defaultModel,
    });

    const run = await workerStore.createRun({
      organizationId: orgId(request),
      agentId: String(agentRow.id),
      agentVersionId: String(versionId),
      agentVersion: agent.version,
      conversationId: null,
      channelId: null,
      contactId: null,
      triggerSource,
      triggerMessageId: null,
      triggerMessageIds: [],
      requestedBy: request.claims!.sub,
      idempotencyKey: `${triggerSource}:${crypto.randomUUID()}`,
      correlationId: crypto.randomUUID(),
      mode: "copilot",
      model: modelChain[0] ?? null,
    });

    const billing = await options.reserveAiUsage?.(
      orgId(request),
      `ai.run:${run.id}`,
    );
    if (billing && !billing.allowed) {
      await workerStore.finishRun({
        runId: run.id,
        organizationId: orgId(request),
        status: "failed",
        decision: null,
        modelUsed: null,
        fallbackUsed: false,
        responseText: null,
        finalText: null,
        responseMeta: {},
        confidence: null,
        requiresHuman: true,
        handoffReason: null,
        knowledgeRefs: [],
        toolCalls: [],
        promptMeta: {},
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        latencyMs: null,
        steps: 0,
        errorCode: billing.code ?? "ai_credits_required",
        errorMessage: "AI kullanım hakkı veya kredi bakiyesi yetersiz.",
      });
      throw Object.assign(new Error(billing.code ?? "ai_credits_required"), {
        statusCode: 402,
      });
    }

    const scope: RunScope = {
      organizationId: orgId(request),
      agentId: String(agentRow.id),
      agentVersionId: String(versionId),
      conversationId: crypto.randomUUID(),
      channelId: crypto.randomUUID(),
      contactId: crypto.randomUUID(),
      runId: run.id,
      correlationId: run.id,
    };

    const history = input.messages.slice(0, -1).map((message, index) => ({
      id: `synthetic-${index}`,
      direction:
        message.role === "customer"
          ? ("inbound" as const)
          : ("outbound" as const),
      type: "text",
      body: message.text,
      sentAt: new Date().toISOString(),
    }));
    const lastMessage = input.messages[input.messages.length - 1]!;
    const triggers = [
      {
        id: "synthetic-current",
        direction: "inbound" as const,
        type: "text",
        body: lastMessage.text,
        sentAt: new Date().toISOString(),
      },
    ];

    const embedder = makeEmbedder(apiKey);
    const gateway: AiToolGateway = {
      async searchKnowledge(query, limit) {
        // Playground uses the agent's real knowledge scoping (channel-scope
        // KBs are excluded because there is no real channel in a test run).
        return retrieveScopedKnowledge({
          store: workerStore,
          organizationId: orgId(request),
          agentId: String(agentRow.id),
          channelId: scope.channelId,
          query,
          limit,
          embedder,
        });
      },
      async getContact() {
        return {
          displayName: input.customerName ?? "Test Müşterisi",
          language: input.customerLanguage ?? null,
          country: null,
          phoneMasked: "****0000",
          tags: [],
          customFields: {},
          memory: {},
        };
      },
      async getConversationContext() {
        return {
          status: "open",
          stage: "Test",
          priority: "normal",
          assigneeName: null,
          summary: null,
          summaryFacts: {},
          recentMessages: history,
        };
      },
      async getBusinessHours() {
        return { open: true, schedule: "Playground" };
      },
      async listApprovedTemplates() {
        return [];
      },
      async addLabel() {
        return { ok: false, message: "playground_noop" };
      },
      async createInternalNote() {
        return { ok: true };
      },
      async requestHandoff() {
        return { ok: true };
      },
      async rememberCustomerFact() {
        return { ok: false, message: "playground_noop" };
      },
    };

    const promptContext: PromptContext = {
      workspace: {
        organizationName: "Playground",
        sensitiveBusinessMode: settingsConfig.sensitiveBusinessMode === true,
        extraPolicy:
          typeof settingsConfig.extraPolicy === "string"
            ? settingsConfig.extraPolicy
            : "",
      },
      agent,
      channel: {
        name: "Playground",
        provider: "playground",
        platform: "whatsapp",
        phoneNumber: null,
        serviceWindowOpen: true,
      },
      customer: await gateway.getContact(),
      conversation: await gateway.getConversationContext(),
      knowledge: [],
      currentMessages: triggers,
      nowIso: new Date().toISOString(),
    };

    try {
      const { verdict, prompt } = await executeAgentRun({
        apiKey,
        scope,
        agent,
        mode: "copilot",
        modelChain,
        promptContext,
        gateway,
        events: noopEvents,
        serviceWindowOpen: true,
        humanTakeoverActive: false,
        consecutiveAiMessages: 0,
      });
      await workerStore.finishRun({
        runId: run.id,
        organizationId: orgId(request),
        status: "completed",
        decision: verdict.decision,
        modelUsed: verdict.contract.modelUsed,
        fallbackUsed: verdict.contract.fallbackUsed,
        responseText: verdict.contract.text,
        finalText: null,
        responseMeta: {
          language: verdict.contract.language,
          intent: verdict.contract.intent,
          sentiment: verdict.contract.sentiment,
        },
        confidence: verdict.contract.confidence,
        requiresHuman: verdict.contract.requiresHuman,
        handoffReason: verdict.contract.handoffReason,
        knowledgeRefs: verdict.contract.knowledgeSources,
        toolCalls: verdict.contract.toolCalls,
        promptMeta: { layers: prompt.layers },
        inputTokens: verdict.contract.usage.inputTokens,
        outputTokens: verdict.contract.usage.outputTokens,
        totalCostUsd: verdict.contract.usage.totalCostUsd,
        latencyMs: verdict.contract.latencyMs,
        steps: verdict.contract.steps,
        errorCode: null,
        errorMessage: null,
      });
      await workerStore.recordUsage({
        organizationId: orgId(request),
        agentId: String(agentRow.id),
        decision: verdict.decision,
        failed: false,
        inputTokens: verdict.contract.usage.inputTokens,
        outputTokens: verdict.contract.usage.outputTokens,
        totalCostUsd: verdict.contract.usage.totalCostUsd,
      });
      return { runId: run.id, verdict, prompt, agentVersion: agent.version };
    } catch (reason) {
      await workerStore.finishRun({
        runId: run.id,
        organizationId: orgId(request),
        status: "failed",
        decision: null,
        modelUsed: null,
        fallbackUsed: false,
        responseText: null,
        finalText: null,
        responseMeta: {},
        confidence: null,
        requiresHuman: true,
        handoffReason: null,
        knowledgeRefs: [],
        toolCalls: [],
        promptMeta: {},
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        latencyMs: null,
        steps: 0,
        errorCode: "ai_generation_failed",
        errorMessage:
          reason instanceof Error ? reason.message.slice(0, 300) : "unknown",
      });
      throw reason;
    }
  };

  app.post(
    "/api/v1/ai/playground",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      if (!options.aiEnv.enabled) {
        return reply.code(409).send({
          error: { code: "ai_disabled", message: "AI özelliği kapalı." },
        });
      }
      const body = playgroundSchema.parse(request.body);
      try {
        const result = await runPlayground(request, body, "playground");
        return {
          data: {
            runId: result.runId,
            agentVersion: result.agentVersion,
            text: result.verdict.contract.text,
            language: result.verdict.contract.language,
            intent: result.verdict.contract.intent,
            sentiment: result.verdict.contract.sentiment,
            confidence: result.verdict.contract.confidence,
            decision: result.verdict.decision,
            requiresHuman: result.verdict.contract.requiresHuman,
            handoffReason: result.verdict.contract.handoffReason,
            knowledgeSources: result.verdict.contract.knowledgeSources,
            toolCalls: result.verdict.contract.toolCalls,
            usage: result.verdict.contract.usage,
            model: result.verdict.contract.modelUsed,
            fallbackUsed: result.verdict.contract.fallbackUsed,
            latencyMs: result.verdict.contract.latencyMs,
            promptLayers: result.prompt.layers,
          },
        };
      } catch (reason) {
        const statusCode =
          (reason as { statusCode?: number }).statusCode ?? 502;
        return reply.code(statusCode).send({
          error: {
            code:
              reason instanceof Error && statusCode !== 502
                ? reason.message
                : "ai_generation_failed",
            message:
              statusCode === 404
                ? "AI ajanı bulunamadı."
                : statusCode === 402
                  ? "AI kullanım hakkınız doldu; cüzdanınıza kredi ekleyin."
                  : statusCode === 409
                    ? "Ajan yapılandırması eksik: sürüm veya API anahtarı yok."
                    : "AI yanıtı üretilemedi. Lütfen tekrar deneyin.",
          },
        });
      }
    },
  );

  // -------------------------------------------------------------- evaluations
  app.get(
    "/api/v1/ai/evaluations",
    { preHandler: options.authorize("ai:read") },
    async (request) => {
      const rows = await dbQuery<Row[]>`
        SELECT dataset.id,dataset.name,dataset.description,dataset.agent_id,
          dataset.created_at,agent.name agent_name,
          (SELECT count(*)::int FROM ai_evaluation_cases c
            WHERE c.dataset_id=dataset.id) case_count,
          (SELECT row_to_json(latest) FROM (
            SELECT id,status,score,passed_cases,total_cases,started_at
            FROM ai_evaluation_runs
            WHERE dataset_id=dataset.id
            ORDER BY started_at DESC LIMIT 1) latest) last_run
        FROM ai_evaluation_datasets dataset
        LEFT JOIN ai_agents agent ON agent.id=dataset.agent_id
        WHERE dataset.organization_id=${orgId(request)}::uuid
        ORDER BY dataset.created_at DESC
      `;
      return { data: rows };
    },
  );

  app.post(
    "/api/v1/ai/evaluations",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = evaluationDatasetSchema.parse(request.body);
      const rows = await dbQuery<Row[]>`
        INSERT INTO ai_evaluation_datasets(organization_id,agent_id,name,description,created_by)
        VALUES(${orgId(request)}::uuid,${body.agentId ?? null},${body.name},
          ${body.description ?? null},${request.claims!.sub}::uuid)
        ON CONFLICT(organization_id,name) DO NOTHING
        RETURNING *
      `;
      if (!rows[0]) {
        return reply.code(409).send({
          error: {
            code: "ai_evaluation_name_conflict",
            message: "Bu adla bir değerlendirme seti zaten var.",
          },
        });
      }
      return reply.code(201).send({ data: rows[0] });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/ai/evaluations/:id/cases",
    { preHandler: options.authorize("ai:read") },
    async (request) => {
      const rows = await dbQuery<Row[]>`
        SELECT id,name,position,input,expectations,created_at
        FROM ai_evaluation_cases
        WHERE dataset_id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid
        ORDER BY position,created_at
      `;
      return { data: rows };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/evaluations/:id/cases",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      const body = evaluationCaseSchema.parse(request.body);
      const rows = await dbQuery<Row[]>`
        INSERT INTO ai_evaluation_cases(organization_id,dataset_id,name,position,input,expectations)
        SELECT ${orgId(request)}::uuid,${request.params.id}::uuid,${body.name},
          COALESCE((SELECT max(position)+1 FROM ai_evaluation_cases
            WHERE dataset_id=${request.params.id}::uuid),0),
          ${repository.json(body.messages)},${repository.json(body.expectations)}
        WHERE EXISTS(SELECT 1 FROM ai_evaluation_datasets
          WHERE id=${request.params.id}::uuid
            AND organization_id=${orgId(request)}::uuid)
        ON CONFLICT(dataset_id,name) DO NOTHING
        RETURNING id,name,position
      `;
      if (!rows[0]) {
        return reply.code(409).send({
          error: {
            code: "ai_evaluation_case_conflict",
            message: "Set bulunamadı veya bu adla bir senaryo zaten var.",
          },
        });
      }
      return reply.code(201).send({ data: rows[0] });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/ai/evaluations/cases/:id",
    { preHandler: options.authorize("ai:manage") },
    async (request) => {
      await dbQuery`
        DELETE FROM ai_evaluation_cases
        WHERE id=${request.params.id}::uuid AND organization_id=${orgId(request)}::uuid
      `;
      return { data: { deleted: true } };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/ai/evaluations/:id/run",
    { preHandler: options.authorize("ai:manage") },
    async (request, reply) => {
      if (!options.aiEnv.enabled) {
        return reply.code(409).send({
          error: { code: "ai_disabled", message: "AI özelliği kapalı." },
        });
      }
      const body = z
        .object({ agentId: uuid, useDraft: z.boolean().default(true) })
        .parse(request.body);
      const cases = await dbQuery<Row[]>`
        SELECT id,name,input,expectations FROM ai_evaluation_cases
        WHERE dataset_id=${request.params.id}::uuid
          AND organization_id=${orgId(request)}::uuid
        ORDER BY position LIMIT 20
      `;
      if (cases.length === 0) {
        return reply.code(409).send({
          error: {
            code: "ai_evaluation_empty",
            message: "Bu sette çalıştırılacak senaryo yok.",
          },
        });
      }
      const evalRunRows = await dbQuery<Row[]>`
        INSERT INTO ai_evaluation_runs(organization_id,dataset_id,agent_id,status,
          total_cases,requested_by)
        VALUES(${orgId(request)}::uuid,${request.params.id}::uuid,${body.agentId}::uuid,
          'running',${cases.length},${request.claims!.sub}::uuid)
        RETURNING id
      `;
      const evalRunId = String(evalRunRows[0]!.id);

      const results: Row[] = [];
      let passed = 0;
      let totalTokensIn = 0;
      let totalTokensOut = 0;
      let totalCost = 0;
      let agentVersionUsed: number | null = null;

      for (const testCase of cases) {
        const messages = (
          Array.isArray(testCase.input) ? testCase.input : []
        ) as Array<{
          role: "customer" | "business";
          text: string;
        }>;
        const expectations =
          testCase.expectations && typeof testCase.expectations === "object"
            ? (testCase.expectations as Row)
            : {};
        try {
          const result = await runPlayground(
            request,
            {
              agentId: body.agentId,
              useDraft: body.useDraft,
              messages:
                messages.length > 0
                  ? messages
                  : [{ role: "customer", text: "Merhaba" }],
            },
            "evaluation",
          );
          agentVersionUsed = result.agentVersion;
          const text = result.verdict.contract.text.toLowerCase();
          const failures: string[] = [];
          for (const needle of (expectations.mustContain as
            string[] | undefined) ?? []) {
            if (!text.includes(needle.toLowerCase()))
              failures.push(`eksik: "${needle}"`);
          }
          for (const needle of (expectations.mustNotContain as
            string[] | undefined) ?? []) {
            if (text.includes(needle.toLowerCase()))
              failures.push(`yasaklı: "${needle}"`);
          }
          if (
            expectations.expectHandoff === true &&
            !result.verdict.contract.requiresHuman
          ) {
            failures.push("insan devri bekleniyordu");
          }
          if (
            expectations.expectHandoff === false &&
            result.verdict.contract.requiresHuman
          ) {
            failures.push("beklenmeyen insan devri");
          }
          if (
            typeof expectations.language === "string" &&
            !result.verdict.contract.language
              .toLowerCase()
              .startsWith(expectations.language.toLowerCase())
          ) {
            failures.push(`dil: ${result.verdict.contract.language}`);
          }
          if (
            typeof expectations.minConfidence === "number" &&
            result.verdict.contract.confidence < expectations.minConfidence
          ) {
            failures.push(`düşük güven: ${result.verdict.contract.confidence}`);
          }
          const pass = failures.length === 0;
          if (pass) passed += 1;
          totalTokensIn += result.verdict.contract.usage.inputTokens;
          totalTokensOut += result.verdict.contract.usage.outputTokens;
          totalCost += result.verdict.contract.usage.totalCostUsd;
          results.push({
            caseId: String(testCase.id),
            name: String(testCase.name),
            pass,
            failures,
            text: result.verdict.contract.text.slice(0, 500),
            confidence: result.verdict.contract.confidence,
            requiresHuman: result.verdict.contract.requiresHuman,
            latencyMs: result.verdict.contract.latencyMs,
            runId: result.runId,
          });
        } catch (reason) {
          results.push({
            caseId: String(testCase.id),
            name: String(testCase.name),
            pass: false,
            failures: [
              reason instanceof Error
                ? reason.message.slice(0, 120)
                : "çalıştırılamadı",
            ],
          });
        }
      }

      const score = Number(((passed / cases.length) * 100).toFixed(2));
      await dbQuery`
        UPDATE ai_evaluation_runs SET status='completed',passed_cases=${passed},
          results=${repository.json(results)},score=${score},
          input_tokens=${totalTokensIn},output_tokens=${totalTokensOut},
          total_cost_usd=${totalCost},
          agent_version_id=(SELECT ${body.useDraft ? repository.fragment`COALESCE(draft_version_id,published_version_id)` : repository.fragment`COALESCE(published_version_id,draft_version_id)`}
            FROM ai_agents WHERE id=${body.agentId}::uuid),
          completed_at=now()
        WHERE id=${evalRunId}::uuid
      `;
      return {
        data: {
          evaluationRunId: evalRunId,
          score,
          passed,
          total: cases.length,
          agentVersion: agentVersionUsed,
          results,
        },
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/ai/evaluations/:id/runs",
    { preHandler: options.authorize("ai:read") },
    async (request) => {
      const rows = await dbQuery<Row[]>`
        SELECT run.id,run.status,run.score,run.passed_cases,run.total_cases,
          run.total_cost_usd,run.started_at,run.completed_at,
          version.version agent_version,agent.name agent_name
        FROM ai_evaluation_runs run
        LEFT JOIN ai_agent_versions version ON version.id=run.agent_version_id
        LEFT JOIN ai_agents agent ON agent.id=run.agent_id
        WHERE run.dataset_id=${request.params.id}::uuid
          AND run.organization_id=${orgId(request)}::uuid
        ORDER BY run.started_at DESC LIMIT 30
      `;
      return { data: rows };
    },
  );

  // -------------------------------------------------------------------- usage
  app.get(
    "/api/v1/ai/usage",
    { preHandler: options.authorize("ai:read") },
    async (request) => {
      const query = z
        .object({ days: z.coerce.number().int().min(1).max(90).default(30) })
        .parse(request.query ?? {});
      const [daily, byAgent] = await Promise.all([
        dbQuery<Row[]>`
          SELECT day,sum(runs)::int runs,sum(auto_sent)::int auto_sent,
            sum(drafts)::int drafts,sum(suggested)::int suggested,
            sum(handoffs)::int handoffs,sum(failures)::int failures,
            sum(input_tokens)::bigint input_tokens,
            sum(output_tokens)::bigint output_tokens,
            sum(total_cost_usd) total_cost_usd
          FROM ai_usage_daily
          WHERE organization_id=${orgId(request)}::uuid
            AND day>=CURRENT_DATE-make_interval(days=>${query.days})
          GROUP BY day ORDER BY day
        `,
        dbQuery<Row[]>`
          SELECT usage.agent_id,agent.name agent_name,sum(usage.runs)::int runs,
            sum(usage.auto_sent)::int auto_sent,sum(usage.handoffs)::int handoffs,
            sum(usage.total_cost_usd) total_cost_usd
          FROM ai_usage_daily usage
          JOIN ai_agents agent ON agent.id=usage.agent_id
          WHERE usage.organization_id=${orgId(request)}::uuid
            AND usage.day>=CURRENT_DATE-make_interval(days=>${query.days})
          GROUP BY usage.agent_id,agent.name
          ORDER BY sum(usage.total_cost_usd) DESC
        `,
      ]);
      return { data: { daily, byAgent } };
    },
  );
}

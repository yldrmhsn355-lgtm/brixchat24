import { parseAgentVersionRow } from "./config";
import { attachImagesToTriggers, type VisionObjectStorage } from "./vision";
import { buildRetrievalQuery, rankCandidates } from "./knowledge";
import type { RetrievalCandidate } from "./knowledge";
import { executeAgentRun } from "./orchestrate";
import type { PolicyVerdict } from "./policy";
import { resolveModelChain } from "./runner";
import type {
  AgentVersionConfig,
  AiMode,
  AiRunEventSink,
  AiToolGateway,
  ConversationMessageDto,
  CustomerContextDto,
  EmbeddingProvider,
  KnowledgeChunkRef,
  PromptContext,
  RunScope,
} from "./types";

/**
 * Conversation-scoped run pipeline shared by the worker (queued
 * autopilot/approval runs) and the API (synchronous copilot generation).
 * The store is a structural subset of AiWorkerRepository so this package
 * stays free of database dependencies.
 */

type Row = Record<string, unknown>;

export interface ConversationContextData {
  organizationId: string;
  organizationName: string;
  conversationId: string;
  conversationStatus: string;
  conversationStage: string;
  conversationPriority: string;
  assigneeName: string | null;
  serviceWindowExpiresAt: Date | null;
  channelId: string;
  channelName: string;
  channelProvider: string;
  channelPlatform: string;
  channelPhoneNumber: string | null;
  contactId: string;
  contactDisplayName: string;
  contactLanguage: string | null;
  contactCountry: string | null;
  contactPhoneMasked: string;
  contactCustomFields: Record<string, unknown>;
  aiEnabled: boolean;
  aiApiKeyEncrypted: string | null;
  aiDefaultModel: string | null;
  aiFallbackModel: string | null;
  aiSensitiveMode: boolean;
  aiExtraPolicy: string;
  aiTakeoverPauseMinutes: number;
  assignmentAgentId: string | null;
  assignmentModeOverride: string | null;
  conversationAiAgentId: string | null;
  conversationAiModeOverride: string | null;
  humanTakeoverAt: Date | null;
  consecutiveAiMessages: number;
  agentVersionRow: Row | null;
  labels: string[];
}

export interface ConversationRunStore {
  loadOrchestrationContext(
    organizationId: string,
    conversationId: string,
  ): Promise<ConversationContextData | null>;
  recentMessages(
    organizationId: string,
    conversationId: string,
    limit: number,
  ): Promise<Row[]>;
  latestSummary(organizationId: string, conversationId: string): Promise<Row | null>;
  getCustomerMemory(
    organizationId: string,
    contactId: string,
  ): Promise<Record<string, unknown>>;
  upsertCustomerMemoryFact(input: {
    organizationId: string;
    contactId: string;
    key: string;
    value: string;
    runId: string;
  }): Promise<void>;
  agentKnowledgeBaseIds(
    organizationId: string,
    agentId: string,
    channelId: string,
  ): Promise<string[]>;
  knowledgeCandidates(input: {
    organizationId: string;
    knowledgeBaseIds: string[];
    query: string;
    limit: number;
  }): Promise<Row[]>;
  listApprovedTemplates(organizationId: string, channelId: string): Promise<Row[]>;
  addLabelToConversation(input: {
    organizationId: string;
    conversationId: string;
    labelName: string;
  }): Promise<{ ok: boolean; message: string }>;
  createInternalNote(input: {
    organizationId: string;
    conversationId: string;
    body: string;
  }): Promise<{ ok: boolean }>;
  imageAttachmentsForMessages?(
    organizationId: string,
    messageIds: string[],
  ): Promise<
    Array<{ messageId: string; storageKey: string; mimeType: string; size: number }>
  >;
  createRun(input: {
    organizationId: string;
    agentId: string | null;
    agentVersionId: string | null;
    agentVersion: number | null;
    conversationId: string | null;
    channelId: string | null;
    contactId: string | null;
    triggerSource: string;
    triggerMessageId: string | null;
    triggerMessageIds: string[];
    requestedBy: string | null;
    idempotencyKey: string;
    correlationId: string;
    mode: string;
    model: string | null;
  }): Promise<{ id: string; created: boolean }>;
  finishRun(input: {
    runId: string;
    organizationId: string;
    status: string;
    decision: string | null;
    modelUsed: string | null;
    fallbackUsed: boolean;
    responseText: string | null;
    finalText: string | null;
    responseMeta: Record<string, unknown>;
    confidence: number | null;
    requiresHuman: boolean;
    handoffReason: string | null;
    knowledgeRefs: unknown[];
    toolCalls: unknown[];
    promptMeta: Record<string, unknown>;
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
    latencyMs: number | null;
    steps: number;
    errorCode: string | null;
    errorMessage: string | null;
  }): Promise<void>;
  recordUsage(input: {
    organizationId: string;
    agentId: string;
    decision: string | null;
    failed: boolean;
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
  }): Promise<void>;
}

export function toConversationMessageDto(row: Row): ConversationMessageDto {
  const metadata =
    row.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : {};
  return {
    id: String(row.id),
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    type: String(row.type ?? "text"),
    body: String(row.body ?? ""),
    senderName:
      typeof metadata.senderName === "string" ? metadata.senderName : null,
    origin: typeof metadata.origin === "string" ? metadata.origin : null,
    sentAt: String(row.sent_at ?? ""),
  };
}

export async function retrieveScopedKnowledge(input: {
  store: ConversationRunStore;
  organizationId: string;
  agentId: string;
  channelId: string;
  query: string;
  limit: number;
  embedder: EmbeddingProvider | null;
}): Promise<KnowledgeChunkRef[]> {
  const kbIds = await input.store.agentKnowledgeBaseIds(
    input.organizationId,
    input.agentId,
    input.channelId,
  );
  if (kbIds.length === 0) return [];
  const rows = await input.store.knowledgeCandidates({
    organizationId: input.organizationId,
    knowledgeBaseIds: kbIds,
    query: input.query,
    limit: 24,
  });
  const candidates: RetrievalCandidate[] = rows.map((row) => ({
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    documentTitle: String(row.document_title ?? ""),
    knowledgeBaseId: String(row.knowledge_base_id),
    content: String(row.content ?? ""),
    lexicalScore: Number(row.lexical_score ?? 0),
    embedding: Array.isArray(row.embedding) ? (row.embedding as number[]) : null,
  }));
  let queryEmbedding: number[] | null = null;
  if (input.embedder && candidates.some((candidate) => candidate.embedding)) {
    try {
      const vectors = await input.embedder.embed([input.query]);
      queryEmbedding = vectors[0] ?? null;
    } catch {
      queryEmbedding = null; // Degrade to lexical ranking, never fail the run.
    }
  }
  return rankCandidates(candidates, queryEmbedding, { limit: input.limit });
}

export function buildConversationGateway(input: {
  store: ConversationRunStore;
  scope: RunScope;
  customer: CustomerContextDto;
  conversation: PromptContext["conversation"];
  embedder: EmbeddingProvider | null;
}): AiToolGateway {
  const { store, scope } = input;
  return {
    async searchKnowledge(query, limit) {
      return retrieveScopedKnowledge({
        store,
        organizationId: scope.organizationId,
        agentId: scope.agentId,
        channelId: scope.channelId,
        query,
        limit,
        embedder: input.embedder,
      });
    },
    async getContact() {
      return input.customer;
    },
    async getConversationContext() {
      return input.conversation;
    },
    async getBusinessHours() {
      return { open: true, schedule: "Configured per agent working hours." };
    },
    async listApprovedTemplates() {
      const rows = await store.listApprovedTemplates(
        scope.organizationId,
        scope.channelId,
      );
      return rows.map((row) => ({
        name: String(row.name),
        description: String(row.description ?? ""),
      }));
    },
    async addLabel(label) {
      return store.addLabelToConversation({
        organizationId: scope.organizationId,
        conversationId: scope.conversationId,
        labelName: label,
      });
    },
    async createInternalNote(note) {
      return store.createInternalNote({
        organizationId: scope.organizationId,
        conversationId: scope.conversationId,
        body: note,
      });
    },
    async requestHandoff(reason) {
      await store.createInternalNote({
        organizationId: scope.organizationId,
        conversationId: scope.conversationId,
        body: `İnsan devri istendi: ${reason}`,
      });
      return { ok: true };
    },
    async rememberCustomerFact(key, value) {
      await store.upsertCustomerMemoryFact({
        organizationId: scope.organizationId,
        contactId: scope.contactId,
        key,
        value,
        runId: scope.runId,
      });
      return { ok: true, message: "stored" };
    },
  };
}

export interface GenerateForConversationInput {
  store: ConversationRunStore;
  organizationId: string;
  conversationId: string;
  requestedBy: string;
  apiKeyResolver: (context: ConversationContextData) => string | null;
  environmentDefaultModel: string | null;
  embedder: EmbeddingProvider | null;
  events: AiRunEventSink;
  /** Optional explicit instruction, e.g. tone adjustment for regenerate. */
  styleHint?: string | undefined;
  recentWindow?: number;
  /** Object storage for vision-enabled agents; omit to skip image loading. */
  imageStorage?: VisionObjectStorage | undefined;
}

export interface GenerateForConversationResult {
  runId: string;
  verdict: PolicyVerdict;
  agentName: string;
  agentVersion: number;
}

/**
 * Synchronous copilot generation for the inbox composer. Always runs in
 * copilot mode regardless of the agent's configured mode — the human is
 * explicitly asking for a suggestion, nothing is ever sent automatically.
 */
export async function generateForConversation(
  input: GenerateForConversationInput,
): Promise<GenerateForConversationResult> {
  const store = input.store;
  const context = await store.loadOrchestrationContext(
    input.organizationId,
    input.conversationId,
  );
  if (!context) {
    throw Object.assign(new Error("conversation_not_found"), { statusCode: 404 });
  }
  if (!context.aiEnabled) {
    throw Object.assign(new Error("ai_disabled"), { statusCode: 409 });
  }
  if (!context.agentVersionRow) {
    throw Object.assign(new Error("ai_agent_not_assigned"), { statusCode: 409 });
  }
  const agent: AgentVersionConfig = parseAgentVersionRow(context.agentVersionRow);
  const apiKey = input.apiKeyResolver(context);
  if (!apiKey) {
    throw Object.assign(new Error("ai_api_key_missing"), { statusCode: 409 });
  }
  const mode: AiMode = "copilot";

  const recentRows = await store.recentMessages(
    input.organizationId,
    input.conversationId,
    input.recentWindow ?? 12,
  );
  const recent = recentRows.map(toConversationMessageDto);
  // Trigger = trailing inbound customer messages (up to 3).
  const triggers: ConversationMessageDto[] = [];
  for (let i = recent.length - 1; i >= 0 && triggers.length < 3; i -= 1) {
    const message = recent[i]!;
    if (message.direction === "outbound") break;
    if (!message.origin) triggers.unshift(message);
  }
  if (triggers.length === 0) {
    throw Object.assign(new Error("no_customer_message"), { statusCode: 409 });
  }

  if (
    agent.config.visionEnabled &&
    input.imageStorage &&
    store.imageAttachmentsForMessages
  ) {
    await attachImagesToTriggers({
      lookup: {
        imageAttachmentsForMessages:
          store.imageAttachmentsForMessages.bind(store),
      },
      storage: input.imageStorage,
      organizationId: input.organizationId,
      triggers,
    });
  }

  const summaryRow = await store.latestSummary(
    input.organizationId,
    input.conversationId,
  );
  const memory = await store.getCustomerMemory(
    input.organizationId,
    context.contactId,
  );

  const modelChain = resolveModelChain({
    agentModel: agent.model,
    agentFallbackModel: agent.fallbackModel,
    workspaceDefaultModel: context.aiDefaultModel,
    workspaceFallbackModel: context.aiFallbackModel,
    environmentDefaultModel: input.environmentDefaultModel,
  });

  const run = await store.createRun({
    organizationId: input.organizationId,
    agentId: agent.agentId,
    agentVersionId: agent.agentVersionId,
    agentVersion: agent.version,
    conversationId: input.conversationId,
    channelId: context.channelId,
    contactId: context.contactId,
    triggerSource: "manual",
    triggerMessageId: triggers[0]?.id ?? null,
    triggerMessageIds: triggers.map((message) => message.id),
    requestedBy: input.requestedBy,
    idempotencyKey: `manual:${crypto.randomUUID()}`,
    correlationId: crypto.randomUUID(),
    mode,
    model: modelChain[0] ?? null,
  });

  const scope: RunScope = {
    organizationId: input.organizationId,
    agentId: agent.agentId,
    agentVersionId: agent.agentVersionId,
    conversationId: input.conversationId,
    channelId: context.channelId,
    contactId: context.contactId,
    runId: run.id,
    correlationId: run.id,
  };

  const customer: CustomerContextDto = {
    displayName: context.contactDisplayName,
    language: context.contactLanguage,
    country: context.contactCountry,
    phoneMasked: context.contactPhoneMasked,
    tags: context.labels,
    customFields: context.contactCustomFields,
    memory,
  };
  const conversation: PromptContext["conversation"] = {
    status: context.conversationStatus,
    stage: context.conversationStage,
    priority: context.conversationPriority,
    assigneeName: context.assigneeName,
    summary: summaryRow ? String(summaryRow.summary ?? "") : null,
    summaryFacts:
      summaryRow && summaryRow.facts && typeof summaryRow.facts === "object"
        ? (summaryRow.facts as Record<string, unknown>)
        : {},
    recentMessages: recent,
  };

  const retrievalQuery = buildRetrievalQuery(triggers.map((m) => m.body));
  const knowledge =
    retrievalQuery.length >= 2
      ? await retrieveScopedKnowledge({
          store,
          organizationId: input.organizationId,
          agentId: agent.agentId,
          channelId: context.channelId,
          query: retrievalQuery,
          limit: 5,
          embedder: input.embedder,
        })
      : [];

  const serviceWindowOpen =
    context.serviceWindowExpiresAt !== null &&
    context.serviceWindowExpiresAt > new Date();

  const styledAgent: AgentVersionConfig = input.styleHint
    ? {
        ...agent,
        behaviorRules: [...agent.behaviorRules, input.styleHint],
      }
    : agent;

  const promptContext: PromptContext = {
    workspace: {
      organizationName: context.organizationName,
      sensitiveBusinessMode: context.aiSensitiveMode,
      extraPolicy: context.aiExtraPolicy,
    },
    agent: styledAgent,
    channel: {
      name: context.channelName,
      provider: context.channelProvider,
      platform: context.channelPlatform,
      phoneNumber: context.channelPhoneNumber,
      serviceWindowOpen,
    },
    customer,
    conversation,
    knowledge,
    currentMessages: triggers,
    nowIso: new Date().toISOString(),
  };

  const gateway = buildConversationGateway({
    store,
    scope,
    customer,
    conversation,
    embedder: input.embedder,
  });

  try {
    const { verdict, prompt } = await executeAgentRun({
      apiKey,
      scope,
      agent: styledAgent,
      mode,
      modelChain,
      promptContext,
      gateway,
      events: input.events,
      serviceWindowOpen,
      humanTakeoverActive: false,
      consecutiveAiMessages: context.consecutiveAiMessages,
    });

    await store.finishRun({
      runId: run.id,
      organizationId: input.organizationId,
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
        suggestedActions: verdict.contract.suggestedActions,
        blockedReason: verdict.blockedReason,
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
    await store.recordUsage({
      organizationId: input.organizationId,
      agentId: agent.agentId,
      decision: verdict.decision,
      failed: false,
      inputTokens: verdict.contract.usage.inputTokens,
      outputTokens: verdict.contract.usage.outputTokens,
      totalCostUsd: verdict.contract.usage.totalCostUsd,
    });

    return {
      runId: run.id,
      verdict,
      agentName: agent.agentName,
      agentVersion: agent.version,
    };
  } catch (reason) {
    await store.finishRun({
      runId: run.id,
      organizationId: input.organizationId,
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
      errorMessage: reason instanceof Error ? reason.message.slice(0, 300) : "unknown",
    });
    await store.recordUsage({
      organizationId: input.organizationId,
      agentId: agent.agentId,
      decision: null,
      failed: true,
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
    });
    throw reason;
  }
}

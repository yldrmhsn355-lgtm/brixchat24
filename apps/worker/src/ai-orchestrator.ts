import {
  AiRunError,
  HashEmbeddingProvider,
  OpenRouterEmbeddingProvider,
  RECENT_WINDOW,
  attachImagesToTriggers,
  buildConversationGateway,
  buildRetrievalQuery,
  chunkText,
  evaluateEligibility,
  executeAgentRun,
  needsCompaction,
  parseAgentVersionRow,
  parseAiMode,
  retrieveScopedKnowledge,
  resolveModelChain,
  summarizeConversation,
  toConversationMessageDto,
  type AiRunEvent,
  type CustomerContextDto,
  type EmbeddingProvider,
  type PromptContext,
  type RunScope,
  type VisionObjectStorage,
} from "@brixchat/ai";
import type { AiOrchestrationContext, AiWorkerRepository } from "@brixchat/database";

/**
 * Worker-side AI orchestration. Runs in its own claim loop, decoupled from
 * the main 500ms tick so multi-second LLM latency never stalls webhook
 * ingestion or outbox delivery. One request per conversation is in flight at
 * a time (enforced by the claim query + partial unique index); rapid
 * messages are batched by the enqueue debounce and claim-time merge.
 */

type Row = Record<string, unknown>;

export interface AiEnv {
  enabled: boolean;
  apiKey: string | null;
  defaultModel: string | null;
  fallbackModel: string | null;
  embeddingModel: string | null;
}

export interface AiOrchestratorDeps {
  repository: AiWorkerRepository;
  publish: (
    organizationId: string,
    eventType: string,
    entityId: string,
    conversationId: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  decryptSecret: (encrypted: string, key: string) => string;
  encryptionKey: string;
  storage: VisionObjectStorage;
  env: AiEnv;
  workerId: string;
  log: (level: "info" | "warn" | "error", event: string, detail: Row) => void;
  /**
   * Gates and meters automated AI runs against the org's plan allowance and
   * AI-credit wallet, same enforcement as the manual copilot-draft HTTP path
   * (apps/api/src/app.ts's reserveAiUsage). Optional so orchestration still
   * works in tests/environments that don't wire billing.
   */
  reserveAiUsage?: (
    organizationId: string,
    eventKey: string,
  ) => Promise<{ allowed: boolean; code: string | null }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function runEventLogger(deps: AiOrchestratorDeps) {
  return (event: AiRunEvent) => {
    deps.log("info", `ai.${event.type}`, {
      runId: event.runId,
      organizationId: event.organizationId,
      agentId: event.agentId,
      ...(event.detail ?? {}),
    });
  };
}

function resolveApiKey(
  deps: AiOrchestratorDeps,
  context: AiOrchestrationContext,
): string | null {
  if (context.aiApiKeyEncrypted) {
    try {
      return deps.decryptSecret(context.aiApiKeyEncrypted, deps.encryptionKey);
    } catch {
      deps.log("error", "ai.api_key_decrypt_failed", {
        organizationId: context.organizationId,
      });
      return null;
    }
  }
  return deps.env.apiKey;
}

export function makeEmbedder(
  deps: AiOrchestratorDeps,
  apiKey: string,
): EmbeddingProvider | null {
  if (!deps.env.embeddingModel) return null;
  if (deps.env.embeddingModel === "local/hash-256") return new HashEmbeddingProvider();
  return new OpenRouterEmbeddingProvider(apiKey, deps.env.embeddingModel);
}

/** Process one queued AI run request. Returns true when work was done. */
export async function processAiRunRequest(deps: AiOrchestratorDeps): Promise<boolean> {
  if (!deps.env.enabled) return false;
  const claim = await deps.repository.claimRunRequest(deps.workerId);
  if (!claim) return false;
  const repo = deps.repository;

  try {
    const context = await repo.loadOrchestrationContext(
      claim.organizationId,
      claim.conversationId,
    );
    if (!context) {
      await repo.skipRunRequest(claim.id, "conversation_missing");
      return true;
    }

    const triggerRows = await repo.messagesByIds(
      claim.organizationId,
      claim.messageIds,
    );
    const triggers = triggerRows
      .map(toConversationMessageDto)
      .filter((message) => message.direction === "inbound" && !message.origin);
    if (triggers.length === 0) {
      await repo.skipRunRequest(claim.id, "no_trigger_messages");
      return true;
    }

    const now = new Date();
    const takeoverActive =
      context.humanTakeoverAt !== null &&
      now.getTime() - context.humanTakeoverAt.getTime() <
        context.aiTakeoverPauseMinutes * 60_000;

    const firstTrigger = triggers[0]!;
    const eligibility = evaluateEligibility({
      aiGloballyEnabled: deps.env.enabled,
      workspaceAiEnabled: context.aiEnabled,
      assignmentExists:
        context.assignmentAgentId !== null || context.conversationAiAgentId !== null,
      assignmentEnabled:
        context.conversationAiAgentId !== null ? true : context.assignmentEnabled,
      agentStatus: context.agentStatus,
      conversationAiStatus:
        (context.conversationAiStatus as "active" | "paused" | "disabled" | null) ??
        null,
      pausedUntil: context.pausedUntil,
      humanTakeoverActive: takeoverActive,
      messageDirection: firstTrigger.direction,
      messageOrigin: firstTrigger.origin ?? null,
      messageType: firstTrigger.type,
      isGroupConversation: false,
      contactBlocked: false,
      conversationStatus: context.conversationStatus,
      now,
    });
    if (!eligibility.eligible) {
      await repo.skipRunRequest(claim.id, eligibility.reason);
      return true;
    }

    if (!context.agentVersionRow) {
      await repo.skipRunRequest(claim.id, "agent_unpublished");
      return true;
    }
    const agent = parseAgentVersionRow(context.agentVersionRow);
    const mode = parseAiMode(
      context.conversationAiModeOverride ??
        context.assignmentModeOverride ??
        agent.mode,
    );

    const apiKey = resolveApiKey(deps, context);
    if (!apiKey) {
      await repo.failRunRequest({
        id: claim.id,
        error: "ai_api_key_missing",
        retryable: false,
        attemptCount: claim.attemptCount,
        maxAttempts: claim.maxAttempts,
      });
      return true;
    }

    if (context.aiDailyBudgetUsd !== null) {
      const spend = await repo.todaySpend(claim.organizationId);
      if (spend >= context.aiDailyBudgetUsd) {
        await repo.skipRunRequest(claim.id, "daily_budget_exhausted");
        return true;
      }
    }

    if (deps.reserveAiUsage) {
      const billing = await deps.reserveAiUsage(
        claim.organizationId,
        `ai.run:${claim.id}:a${claim.attemptCount}`,
      );
      if (!billing.allowed) {
        await repo.skipRunRequest(
          claim.id,
          billing.code ?? "ai_credits_required",
        );
        return true;
      }
    }

    const modelChain = resolveModelChain({
      agentModel: agent.model,
      agentFallbackModel: agent.fallbackModel,
      workspaceDefaultModel: context.aiDefaultModel,
      workspaceFallbackModel: context.aiFallbackModel,
      environmentDefaultModel: deps.env.defaultModel,
    });

    const run = await repo.createRun({
      organizationId: claim.organizationId,
      agentId: agent.agentId,
      agentVersionId: agent.agentVersionId,
      agentVersion: agent.version,
      conversationId: claim.conversationId,
      channelId: context.channelId,
      contactId: context.contactId,
      triggerSource: "incoming_message",
      triggerMessageId: firstTrigger.id,
      triggerMessageIds: triggers.map((message) => message.id),
      requestedBy: null,
      idempotencyKey: `req:${claim.id}:a${claim.attemptCount}`,
      correlationId: crypto.randomUUID(),
      mode,
      model: modelChain[0] ?? null,
    });
    if (!run.id) {
      await repo.skipRunRequest(claim.id, "run_create_failed");
      return true;
    }

    const scope: RunScope = {
      organizationId: claim.organizationId,
      agentId: agent.agentId,
      agentVersionId: agent.agentVersionId,
      conversationId: claim.conversationId,
      channelId: context.channelId,
      contactId: context.contactId,
      runId: run.id,
      correlationId: claim.id,
    };
    const events = runEventLogger(deps);
    const embedder = makeEmbedder(deps, apiKey);

    if (agent.config.visionEnabled) {
      const attached = await attachImagesToTriggers({
        lookup: repo,
        storage: deps.storage,
        organizationId: claim.organizationId,
        triggers,
      });
      if (attached > 0) {
        deps.log("info", "ai.vision_images_attached", {
          runId: run.id,
          images: attached,
        });
      }
    }

    // --- Conversation memory: summary + optional compaction -----------------
    const summaryRow = await repo.latestSummary(
      claim.organizationId,
      claim.conversationId,
    );
    let summary = summaryRow ? String(summaryRow.summary ?? "") : null;
    let summaryFacts =
      summaryRow && summaryRow.facts && typeof summaryRow.facts === "object"
        ? (summaryRow.facts as Record<string, unknown>)
        : {};
    const coveredCount = Number(summaryRow?.covered_message_count ?? 0);
    const totalMessages = await repo.countConversationMessages(
      claim.organizationId,
      claim.conversationId,
    );
    if (
      needsCompaction({ totalMessages, coveredMessageCount: coveredCount }) &&
      modelChain.length > 0
    ) {
      try {
        const olderRows = await repo.recentMessages(
          claim.organizationId,
          claim.conversationId,
          200,
        );
        const older = olderRows.map(toConversationMessageDto).slice(0, -RECENT_WINDOW);
        if (older.length > 0) {
          const compacted = await summarizeConversation({
            apiKey,
            model: modelChain[modelChain.length - 1]!,
            previousSummary: summary,
            previousFacts: summaryFacts,
            messages: older,
          });
          summary = compacted.summary;
          summaryFacts = compacted.facts;
          await repo.insertSummary({
            organizationId: claim.organizationId,
            conversationId: claim.conversationId,
            summary: compacted.summary,
            facts: compacted.facts,
            coveredMessageCount: totalMessages - RECENT_WINDOW,
            lastMessageId: older[older.length - 1]?.id ?? null,
            model: modelChain[modelChain.length - 1]!,
          });
        }
      } catch (reason) {
        deps.log("warn", "ai.compaction_failed", {
          runId: run.id,
          error: reason instanceof Error ? reason.message : "unknown",
        });
      }
    }

    const recentRows = await repo.recentMessages(
      claim.organizationId,
      claim.conversationId,
      RECENT_WINDOW,
    );
    const recent = recentRows.map(toConversationMessageDto);
    const memory = await repo.getCustomerMemory(
      claim.organizationId,
      context.contactId,
    );

    const customer: CustomerContextDto = {
      displayName: context.contactDisplayName,
      language: context.contactLanguage,
      country: context.contactCountry,
      phoneMasked: context.contactPhoneMasked,
      tags: context.labels,
      customFields: context.contactCustomFields,
      memory,
    };
    const conversationContext: PromptContext["conversation"] = {
      status: context.conversationStatus,
      stage: context.conversationStage,
      priority: context.conversationPriority,
      assigneeName: context.assigneeName,
      summary,
      summaryFacts,
      recentMessages: recent,
    };

    const retrievalQuery = buildRetrievalQuery(triggers.map((m) => m.body));
    const knowledge =
      retrievalQuery.length >= 2
        ? await retrieveScopedKnowledge({
            store: repo,
            organizationId: claim.organizationId,
            agentId: agent.agentId,
            channelId: context.channelId,
            query: retrievalQuery,
            limit: 5,
            embedder,
          })
        : [];
    events({
      type: "knowledge_retrieved",
      runId: run.id,
      organizationId: claim.organizationId,
      agentId: agent.agentId,
      detail: { chunks: knowledge.length, query: retrievalQuery.slice(0, 80) },
    });

    const serviceWindowOpen =
      context.serviceWindowExpiresAt !== null &&
      context.serviceWindowExpiresAt > new Date();

    const promptContext: PromptContext = {
      workspace: {
        organizationName: context.organizationName,
        sensitiveBusinessMode: context.aiSensitiveMode,
        extraPolicy: context.aiExtraPolicy,
      },
      agent,
      channel: {
        name: context.channelName,
        provider: context.channelProvider,
        platform: context.channelPlatform,
        phoneNumber: context.channelPhoneNumber,
        serviceWindowOpen,
      },
      customer,
      conversation: conversationContext,
      knowledge,
      currentMessages: triggers,
      nowIso: new Date().toISOString(),
    };

    const gateway = buildConversationGateway({
      store: repo,
      scope,
      customer,
      conversation: conversationContext,
      embedder,
    });

    const { verdict, prompt } = await executeAgentRun({
      apiKey,
      scope,
      agent,
      mode,
      modelChain,
      promptContext,
      gateway,
      events,
      serviceWindowOpen,
      humanTakeoverActive: takeoverActive,
      consecutiveAiMessages: context.consecutiveAiMessages,
    });

    // --- Act on the verdict -------------------------------------------------
    let decision = verdict.decision;
    let finalText: string | null = null;

    if (decision === "auto_sent" && verdict.contract.shouldSend) {
      if (agent.responseDelayMaxMs > 0) {
        const min = Math.min(agent.responseDelayMinMs, agent.responseDelayMaxMs);
        const max = Math.max(agent.responseDelayMinMs, agent.responseDelayMaxMs);
        const jitterSeed = parseInt(run.id.replaceAll("-", "").slice(0, 8), 16);
        const delay = Math.min(min + (jitterSeed % Math.max(max - min, 1)), 15_000);
        await sleep(delay);
      }
      const sent = await repo.sendAiMessage({
        organizationId: claim.organizationId,
        conversationId: claim.conversationId,
        runId: run.id,
        requestId: claim.id,
        text: verdict.contract.text,
      });
      if (sent.messageId) {
        finalText = verdict.contract.text;
        await repo.upsertConversationAiState({
          organizationId: claim.organizationId,
          conversationId: claim.conversationId,
          incrementConsecutive: true,
        });
        await deps.publish(
          claim.organizationId,
          "message.created",
          sent.messageId,
          claim.conversationId,
          { messageId: sent.messageId, origin: "ai_agent", runId: run.id },
        );
      } else if (sent.duplicate) {
        finalText = verdict.contract.text;
      } else {
        decision = "blocked";
      }
    } else if (decision === "handoff") {
      await repo.upsertConversationAiState({
        organizationId: claim.organizationId,
        conversationId: claim.conversationId,
        status: "paused",
        pausedUntil: null,
        pausedReason: verdict.contract.handoffReason ?? "HANDOFF",
      });
      await repo.createInternalNote({
        organizationId: claim.organizationId,
        conversationId: claim.conversationId,
        body: `Konuşma yapay zekadan devralınmalı. Neden: ${
          verdict.contract.handoffReason ?? "belirtilmedi"
        }. Önerilen yanıt: ${verdict.contract.text.slice(0, 400)}`,
      });
      await deps.publish(
        claim.organizationId,
        "ai.handoff.created",
        run.id,
        claim.conversationId,
        {
          runId: run.id,
          reason: verdict.contract.handoffReason,
          suggestedText: verdict.contract.text,
        },
      );
    } else if (decision === "draft_created" || decision === "suggested") {
      await deps.publish(
        claim.organizationId,
        "ai.suggestion.created",
        run.id,
        claim.conversationId,
        {
          runId: run.id,
          mode,
          decision,
          text: verdict.contract.text,
          confidence: verdict.contract.confidence,
          language: verdict.contract.language,
        },
      );
    }

    await repo.finishRun({
      runId: run.id,
      organizationId: claim.organizationId,
      status: "completed",
      decision,
      modelUsed: verdict.contract.modelUsed,
      fallbackUsed: verdict.contract.fallbackUsed,
      responseText: verdict.contract.text,
      finalText,
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
    await repo.recordUsage({
      organizationId: claim.organizationId,
      agentId: agent.agentId,
      decision,
      failed: false,
      inputTokens: verdict.contract.usage.inputTokens,
      outputTokens: verdict.contract.usage.outputTokens,
      totalCostUsd: verdict.contract.usage.totalCostUsd,
    });
    await repo.completeRunRequest(claim.id, run.id);
    await deps.publish(
      claim.organizationId,
      "ai.run.completed",
      run.id,
      claim.conversationId,
      { runId: run.id, decision, mode },
    );
    return true;
  } catch (reason) {
    const error =
      reason instanceof Error ? reason.message : "ai_run_unknown_error";
    const retryable = reason instanceof AiRunError ? reason.retryable : true;
    const outcome = await repo.failRunRequest({
      id: claim.id,
      error,
      retryable,
      attemptCount: claim.attemptCount,
      maxAttempts: claim.maxAttempts,
    });
    deps.log("error", "ai.run_request_failed", {
      requestId: claim.id,
      conversationId: claim.conversationId,
      error: error.slice(0, 200),
      outcome,
    });
    if (outcome === "failed") {
      await deps.publish(
        claim.organizationId,
        "ai.run.failed",
        claim.id,
        claim.conversationId,
        { requestId: claim.id, error: error.slice(0, 200) },
      );
    }
    return true;
  }
}

/** Index one pending knowledge document: chunk, embed, store. */
export async function processAiKnowledgeDocument(
  deps: AiOrchestratorDeps,
): Promise<boolean> {
  if (!deps.env.enabled) return false;
  const document = await deps.repository.claimKnowledgeDocument();
  if (!document) return false;
  const organizationId = String(document.organization_id);
  const documentId = String(document.id);
  try {
    const chunks = chunkText(String(document.content ?? ""));
    let embeddings: Array<number[] | null> = chunks.map(() => null);
    let embeddingModel: string | null = null;
    if (deps.env.embeddingModel && deps.env.apiKey && chunks.length > 0) {
      const embedder = makeEmbedder(deps, deps.env.apiKey);
      if (embedder) {
        try {
          const vectors = await embedder.embed(chunks.map((chunk) => chunk.content));
          embeddings = chunks.map((_, index) => vectors[index] ?? null);
          embeddingModel = embedder.model;
        } catch (reason) {
          deps.log("warn", "ai.embedding_failed", {
            documentId,
            error: reason instanceof Error ? reason.message : "unknown",
          });
        }
      }
    }
    await deps.repository.storeDocumentChunks({
      organizationId,
      documentId,
      knowledgeBaseId: String(document.knowledge_base_id),
      documentVersion: Number(document.version ?? 1),
      chunks: chunks.map((chunk, index) => ({
        index: chunk.index,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        embedding: embeddings[index] ?? null,
        embeddingModel,
      })),
    });
    deps.log("info", "ai.document_indexed", {
      documentId,
      chunks: chunks.length,
      embedded: embeddingModel !== null,
    });
    return true;
  } catch (reason) {
    await deps.repository.failKnowledgeDocument(
      organizationId,
      documentId,
      reason instanceof Error ? reason.message : "index_failed",
    );
    return true;
  }
}

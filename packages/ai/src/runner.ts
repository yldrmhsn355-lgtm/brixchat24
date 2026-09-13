import { OpenRouter, maxCost, stepCountIs } from "@openrouter/agent";
import type { ComposedPrompt } from "./prompts";
import type { BuiltTools, FinalizeReplyInput } from "./tools";
import {
  AiRunError,
  type AgentVersionConfig,
  type AiRunEventSink,
  type RunScope,
} from "./types";

/**
 * OpenRouter runtime. One client per API key (cached), one bounded agent
 * loop per run: primary model with transient-error retry, then fallback
 * model, stop conditions on step count and per-run cost. AI-generation retry
 * is fully separate from channel delivery retry — this module never sends
 * anything to a customer.
 */

const clientCache = new Map<string, OpenRouter>();

export function getOpenRouterClient(apiKey: string): OpenRouter {
  const cached = clientCache.get(apiKey);
  if (cached) return cached;
  const client = new OpenRouter({ apiKey });
  clientCache.set(apiKey, client);
  return client;
}

export interface ModelChainInput {
  agentModel: string;
  agentFallbackModel: string | null;
  workspaceDefaultModel: string | null;
  workspaceFallbackModel: string | null;
  environmentDefaultModel: string | null;
}

/**
 * Model routing precedence: agent config > workspace settings > environment
 * default; the fallback chain is deduplicated and never empty when at least
 * one source is configured.
 */
export function resolveModelChain(input: ModelChainInput): string[] {
  const chain = [
    input.agentModel,
    input.agentFallbackModel,
    input.workspaceDefaultModel,
    input.workspaceFallbackModel,
    input.environmentDefaultModel,
  ]
    .map((model) => model?.trim() ?? "")
    .filter((model) => model.length > 0);
  return [...new Set(chain)];
}

interface TransientCheck {
  transient: boolean;
  status: number | null;
}

function classifyError(reason: unknown): TransientCheck {
  const status =
    typeof reason === "object" && reason !== null
      ? Number(
          (reason as { status?: unknown; statusCode?: unknown }).status ??
            (reason as { statusCode?: unknown }).statusCode ??
            NaN,
        )
      : NaN;
  if (!Number.isNaN(status)) {
    return { transient: status === 429 || status >= 500, status };
  }
  const message = reason instanceof Error ? reason.message.toLowerCase() : "";
  const transient =
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("fetch failed") ||
    message.includes("socket") ||
    message.includes("network");
  return { transient, status: null };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RunAgentTurnInput {
  apiKey: string;
  scope: RunScope;
  agent: AgentVersionConfig;
  modelChain: string[];
  instructions: ComposedPrompt;
  /** Plain text, or pre-built OpenResponses items for multimodal turns. */
  userInput: string | unknown[];
  built: BuiltTools;
  events: AiRunEventSink;
  signal?: AbortSignal;
  maxTransientRetries?: number;
}

export interface RunAgentTurnResult {
  finalReply: FinalizeReplyInput | null;
  rawText: string;
  modelUsed: string;
  fallbackUsed: boolean;
  steps: number;
  usage: { inputTokens: number; outputTokens: number; totalCostUsd: number };
  latencyMs: number;
}

/**
 * Execute one bounded agent loop. Throws AiRunError only when every model in
 * the chain failed; partial tool side effects are recorded by the tool
 * journal either way.
 */
export async function runAgentTurn(
  input: RunAgentTurnInput,
): Promise<RunAgentTurnResult> {
  const startedAt = Date.now();
  const client = getOpenRouterClient(input.apiKey);
  const maxRetries = input.maxTransientRetries ?? 2;
  if (input.modelChain.length === 0) {
    throw new AiRunError("ai_model_not_configured", "No model configured", false);
  }

  const usage = { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
  let steps = 0;
  let lastError: unknown = null;

  for (let modelIndex = 0; modelIndex < input.modelChain.length; modelIndex += 1) {
    const model = input.modelChain[modelIndex]!;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (input.signal?.aborted) {
        throw new AiRunError("ai_run_aborted", "Run aborted", false);
      }
      input.events({
        type: "model_request_started",
        runId: input.scope.runId,
        organizationId: input.scope.organizationId,
        agentId: input.scope.agentId,
        detail: { model, attempt, fallback: modelIndex > 0 },
      });
      try {
        const result = client.callModel(
          {
            model,
            instructions: input.instructions.instructions,
            input: input.userInput as never,
            tools: input.built.tools,
            temperature: input.agent.temperature,
            ...(input.agent.config.maxOutputTokens
              ? { maxOutputTokens: input.agent.config.maxOutputTokens }
              : {}),
            stopWhen: [
              stepCountIs(input.agent.maxSteps),
              maxCost(input.agent.maxCostPerRunUsd),
            ],
            onTurnEnd: (_context, response) => {
              steps += 1;
              const turnUsage = response.usage;
              if (turnUsage) {
                usage.inputTokens += turnUsage.inputTokens ?? 0;
                usage.outputTokens += turnUsage.outputTokens ?? 0;
                usage.totalCostUsd += turnUsage.cost ?? 0;
              }
            },
          },
          input.signal ? { fetchOptions: { signal: input.signal } } : undefined,
        );

        const rawText = await result.getText();
        return {
          finalReply: input.built.getFinalReply(),
          rawText,
          modelUsed: model,
          fallbackUsed: modelIndex > 0,
          steps,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalCostUsd: Number(usage.totalCostUsd.toFixed(6)),
          },
          latencyMs: Date.now() - startedAt,
        };
      } catch (reason) {
        lastError = reason;
        const { transient, status } = classifyError(reason);
        const isLastAttempt = attempt === maxRetries;
        if (transient && !isLastAttempt) {
          await sleep(Math.min(1000 * 2 ** attempt, 15000));
          continue;
        }
        // Non-transient or exhausted: move to the next model in the chain.
        input.events({
          type: "ai_run_failed",
          runId: input.scope.runId,
          organizationId: input.scope.organizationId,
          agentId: input.scope.agentId,
          detail: {
            model,
            status,
            transient,
            willFallback: modelIndex < input.modelChain.length - 1,
          },
        });
        break;
      }
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : "model_request_failed";
  const { transient } = classifyError(lastError);
  throw new AiRunError("ai_model_failed", message.slice(0, 300), transient);
}

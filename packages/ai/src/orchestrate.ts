import {
  buildSystemPrompt,
  buildUserInput,
  buildUserInputItems,
  detectInjectionSignals,
} from "./prompts";
import type { ComposedPrompt } from "./prompts";
import { evaluatePolicy, withinWorkingHours } from "./policy";
import type { PolicyVerdict } from "./policy";
import { runAgentTurn } from "./runner";
import { buildTools } from "./tools";
import type {
  AgentVersionConfig,
  AiMode,
  AiRunEventSink,
  AiToolGateway,
  PromptContext,
  RunScope,
} from "./types";

/**
 * The shared run pipeline: prompt composition -> bounded agent loop ->
 * server-side policy verdict. Both the worker (autopilot/approval/observe on
 * incoming messages) and the API (copilot generate, playground) call this;
 * they differ only in how they load context and what they do with the
 * verdict. Nothing in here sends messages to customers.
 */

export interface ExecuteAgentRunInput {
  apiKey: string;
  scope: RunScope;
  agent: AgentVersionConfig;
  mode: AiMode;
  modelChain: string[];
  promptContext: PromptContext;
  gateway: AiToolGateway;
  events: AiRunEventSink;
  serviceWindowOpen: boolean;
  humanTakeoverActive: boolean;
  consecutiveAiMessages: number;
  signal?: AbortSignal;
}

export interface ExecuteAgentRunResult {
  verdict: PolicyVerdict;
  prompt: ComposedPrompt;
  injectionSignals: string[];
}

export async function executeAgentRun(
  input: ExecuteAgentRunInput,
): Promise<ExecuteAgentRunResult> {
  const { scope, agent, events } = input;

  events({
    type: "ai_run_started",
    runId: scope.runId,
    organizationId: scope.organizationId,
    agentId: scope.agentId,
    detail: { mode: input.mode, model: input.modelChain[0] ?? null },
  });

  const injectionSignals = input.promptContext.currentMessages.flatMap((message) =>
    detectInjectionSignals(message.body),
  );

  const prompt = buildSystemPrompt(input.promptContext);
  const hasImages = input.promptContext.currentMessages.some(
    (message) => message.imageDataUrl,
  );
  const userInput = hasImages
    ? buildUserInputItems(input.promptContext)
    : buildUserInput(input.promptContext);
  events({
    type: "context_built",
    runId: scope.runId,
    organizationId: scope.organizationId,
    agentId: scope.agentId,
    detail: {
      layers: prompt.layers,
      knowledgeChunks: input.promptContext.knowledge.length,
      injectionSignals,
    },
  });

  const built = buildTools({ scope, agent, gateway: input.gateway, events });

  const result = await runAgentTurn({
    apiKey: input.apiKey,
    scope,
    agent,
    modelChain: input.modelChain,
    instructions: prompt,
    userInput,
    built,
    events,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  events({
    type: "ai_response_generated",
    runId: scope.runId,
    organizationId: scope.organizationId,
    agentId: scope.agentId,
    detail: {
      model: result.modelUsed,
      fallback: result.fallbackUsed,
      steps: result.steps,
      hasFinalReply: result.finalReply !== null,
    },
  });

  const verdict = evaluatePolicy({
    agent,
    mode: input.mode,
    result,
    toolJournal: built.getToolJournal(),
    handoff: built.handoffRequested(),
    injectionSignals,
    serviceWindowOpen: input.serviceWindowOpen,
    humanTakeoverActive: input.humanTakeoverActive,
    consecutiveAiMessages: input.consecutiveAiMessages,
    knowledgeSources: input.promptContext.knowledge.map((chunk) => ({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      title: chunk.documentTitle,
      score: chunk.score,
    })),
    withinWorkingHours: withinWorkingHours(agent, new Date()),
  });

  events({
    type: "policy_checked",
    runId: scope.runId,
    organizationId: scope.organizationId,
    agentId: scope.agentId,
    detail: {
      decision: verdict.decision,
      blockedReason: verdict.blockedReason,
      confidence: verdict.contract.confidence,
      requiresHuman: verdict.contract.requiresHuman,
    },
  });

  return { verdict, prompt, injectionSignals };
}

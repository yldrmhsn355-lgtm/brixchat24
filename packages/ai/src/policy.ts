import type { RunAgentTurnResult } from "./runner";
import type {
  AgentVersionConfig,
  AiMode,
  AiResponseContract,
  AiRunDecision,
  HandoffReason,
} from "./types";

/**
 * Response policy + escalation engine. The model proposes; this module
 * disposes. Raw model output is never trusted to decide whether it reaches a
 * customer — every autopilot send passes these server-side checks.
 */

export interface PolicyInput {
  agent: AgentVersionConfig;
  mode: AiMode;
  result: RunAgentTurnResult;
  toolJournal: Array<{
    name: string;
    status: "completed" | "failed" | "denied";
    durationMs: number;
    summary: string;
  }>;
  handoff: { requested: boolean; reason: string };
  injectionSignals: string[];
  serviceWindowOpen: boolean;
  humanTakeoverActive: boolean;
  consecutiveAiMessages: number;
  knowledgeSources: Array<{
    chunkId: string;
    documentId: string;
    title: string;
    score: number;
  }>;
  withinWorkingHours: boolean;
}

export interface PolicyVerdict {
  contract: AiResponseContract;
  decision: AiRunDecision;
  blockedReason: string | null;
}

function forbiddenTopicHit(agent: AgentVersionConfig, text: string): string | null {
  const lowered = text.toLowerCase();
  for (const topic of agent.forbiddenTopics) {
    const trimmed = topic.trim().toLowerCase();
    if (trimmed.length >= 3 && lowered.includes(trimmed)) return topic;
  }
  return null;
}

export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const { agent, mode, result } = input;
  const final = result.finalReply;

  // Safe fallback when the model never produced a valid finalize_reply.
  const base: AiResponseContract = {
    text: final?.text ?? result.rawText.trim(),
    language: final?.language ?? agent.defaultLanguage,
    intent: final?.intent ?? null,
    sentiment: final?.sentiment ?? null,
    confidence: final ? final.confidence : 0.2,
    shouldSend: false,
    requiresHuman: final?.requiresHuman ?? true,
    handoffReason: (final?.handoffReason as HandoffReason | null) ?? null,
    suggestedActions: final?.suggestedActions ?? [],
    knowledgeSources: input.knowledgeSources,
    toolCalls: input.toolJournal,
    usage: result.usage,
    modelUsed: result.modelUsed,
    fallbackUsed: result.fallbackUsed,
    steps: result.steps,
    latencyMs: result.latencyMs,
  };

  const escalate = (reason: HandoffReason): PolicyVerdict => ({
    contract: {
      ...base,
      shouldSend: false,
      requiresHuman: true,
      handoffReason: base.handoffReason ?? reason,
    },
    decision: "handoff",
    blockedReason: reason,
  });

  // Empty output is never sendable.
  if (!base.text) {
    return {
      contract: { ...base, requiresHuman: true, handoffReason: "MODEL_FAILURE" },
      decision: "blocked",
      blockedReason: "empty_response",
    };
  }

  // Observe mode records the analysis and stops.
  if (mode === "observe") {
    return { contract: base, decision: "observed", blockedReason: null };
  }

  // Explicit tool-driven or model-declared handoff wins over everything.
  if (input.handoff.requested) return escalate("HUMAN_REQUESTED");
  if (base.requiresHuman) {
    return escalate(base.handoffReason ?? "LOW_CONFIDENCE");
  }

  // Escalation rules evaluated server-side, regardless of model opinion.
  if (base.confidence < agent.confidenceThreshold) return escalate("LOW_CONFIDENCE");
  if (
    agent.handoffRules.onNegativeSentiment !== false &&
    base.sentiment === "negative"
  ) {
    return escalate("NEGATIVE_SENTIMENT");
  }
  const forbidden = forbiddenTopicHit(agent, base.text);
  if (forbidden) return escalate("RESTRICTED_TOPIC");
  if (
    base.intent &&
    (agent.handoffRules.restrictedIntents ?? []).some(
      (intent) => intent.toLowerCase() === base.intent!.toLowerCase(),
    )
  ) {
    return escalate("RESTRICTED_TOPIC");
  }
  const criticalToolFailure = input.toolJournal.some(
    (entry) => entry.status === "failed" && entry.name === "search_knowledge",
  );
  if (criticalToolFailure && agent.handoffRules.onMissingKnowledge !== false) {
    return escalate("TOOL_FAILURE");
  }
  if (input.injectionSignals.length >= 2) return escalate("BUSINESS_RULE");
  if (
    agent.allowedLanguages.length > 0 &&
    !agent.allowedLanguages.some(
      (lang) => base.language.toLowerCase().startsWith(lang.toLowerCase()),
    )
  ) {
    return escalate("BUSINESS_RULE");
  }

  // Copilot only ever suggests.
  if (mode === "copilot") {
    return {
      contract: { ...base, shouldSend: false },
      decision: "suggested",
      blockedReason: null,
    };
  }

  // Approval mode creates a draft for human review.
  if (mode === "approval") {
    return {
      contract: { ...base, shouldSend: false },
      decision: "draft_created",
      blockedReason: null,
    };
  }

  // Autopilot: final server-side gates before an automatic send.
  if (input.humanTakeoverActive) {
    return {
      contract: { ...base, shouldSend: false },
      decision: "suggested",
      blockedReason: "human_takeover",
    };
  }
  if (!input.serviceWindowOpen) {
    return escalate("BUSINESS_RULE");
  }
  if (!input.withinWorkingHours) {
    return {
      contract: { ...base, shouldSend: false },
      decision: "draft_created",
      blockedReason: "outside_working_hours",
    };
  }
  const maxConsecutive = agent.handoffRules.maxConsecutiveAiMessages ?? 5;
  if (input.consecutiveAiMessages >= maxConsecutive) {
    return escalate("BUSINESS_RULE");
  }

  return {
    contract: { ...base, shouldSend: true },
    decision: "auto_sent",
    blockedReason: null,
  };
}

/** Working-hours check against the agent's configured schedule. */
export function withinWorkingHours(
  agent: AgentVersionConfig,
  now: Date,
): boolean {
  const schedule = agent.workingHours.schedule;
  if (!schedule || Object.keys(schedule).length === 0) return true;
  const timezone = agent.workingHours.timezone ?? "Europe/Istanbul";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = formatter.formatToParts(now);
  const weekdayShort = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  const isoWeekday = String(
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekdayShort) + 1,
  );
  const current = `${hour}:${minute}`;
  const windows = schedule[isoWeekday] ?? [];
  return windows.some((window) => window.start <= current && current < window.end);
}

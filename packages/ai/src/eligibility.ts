/**
 * AI eligibility engine: decides whether an inbound event should reach the
 * OpenRouter runtime at all. Pure predicate — inputs are loaded by the
 * orchestrator, so this stays unit-testable without a database.
 */

export interface EligibilityInput {
  aiGloballyEnabled: boolean;
  workspaceAiEnabled: boolean;
  assignmentExists: boolean;
  assignmentEnabled: boolean;
  agentStatus: string | null;
  conversationAiStatus: "active" | "paused" | "disabled" | null;
  pausedUntil: Date | null;
  humanTakeoverActive: boolean;
  messageDirection: "inbound" | "outbound";
  messageOrigin: string | null;
  messageType: string;
  isGroupConversation: boolean;
  contactBlocked: boolean;
  conversationStatus: string;
  now: Date;
}

export interface EligibilityVerdict {
  eligible: boolean;
  reason: string;
}

const SUPPORTED_MESSAGE_TYPES = new Set([
  "text",
  "image",
  "document",
  "audio",
  "video",
  "location",
  "contact",
  "interactive",
  "button",
]);

export function evaluateEligibility(input: EligibilityInput): EligibilityVerdict {
  if (!input.aiGloballyEnabled) return skip("ai_disabled_globally");
  if (!input.workspaceAiEnabled) return skip("ai_disabled_workspace");
  if (input.messageDirection !== "inbound") return skip("not_inbound");
  // Messages produced by this platform (automation, AI itself, CRM mirror)
  // must never trigger another AI run — this is the AI-to-AI loop breaker.
  if (input.messageOrigin) return skip(`origin_${input.messageOrigin}`);
  if (!SUPPORTED_MESSAGE_TYPES.has(input.messageType)) {
    return skip("unsupported_message_type");
  }
  if (input.isGroupConversation) return skip("group_conversation");
  if (input.contactBlocked) return skip("contact_blocked");
  if (input.conversationStatus === "closed") return skip("conversation_closed");
  if (!input.assignmentExists) return skip("no_agent_assigned");
  if (!input.assignmentEnabled) return skip("assignment_disabled");
  if (input.agentStatus !== "active") return skip("agent_not_active");
  if (input.conversationAiStatus === "disabled") return skip("conversation_ai_disabled");
  if (input.conversationAiStatus === "paused") {
    if (!input.pausedUntil || input.pausedUntil > input.now) {
      return skip("conversation_ai_paused");
    }
  }
  if (input.humanTakeoverActive) return skip("human_takeover");
  return { eligible: true, reason: "eligible" };
}

function skip(reason: string): EligibilityVerdict {
  return { eligible: false, reason };
}

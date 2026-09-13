import { describe, expect, it } from "vitest";
import { evaluateEligibility, type EligibilityInput } from "./eligibility";

const base: EligibilityInput = {
  aiGloballyEnabled: true,
  workspaceAiEnabled: true,
  assignmentExists: true,
  assignmentEnabled: true,
  agentStatus: "active",
  conversationAiStatus: "active",
  pausedUntil: null,
  humanTakeoverActive: false,
  messageDirection: "inbound",
  messageOrigin: null,
  messageType: "text",
  isGroupConversation: false,
  contactBlocked: false,
  conversationStatus: "open",
  now: new Date("2026-08-07T10:00:00Z"),
};

describe("evaluateEligibility", () => {
  it("accepts a plain inbound customer message", () => {
    expect(evaluateEligibility(base)).toEqual({
      eligible: true,
      reason: "eligible",
    });
  });

  it("never triggers on platform-originated messages (AI-to-AI loop breaker)", () => {
    for (const origin of ["ai_agent", "automation", "bitrix_open_channels"]) {
      const verdict = evaluateEligibility({ ...base, messageOrigin: origin });
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toBe(`origin_${origin}`);
    }
  });

  it("skips outbound messages", () => {
    expect(
      evaluateEligibility({ ...base, messageDirection: "outbound" }).eligible,
    ).toBe(false);
  });

  it("skips when workspace or global toggle is off", () => {
    expect(
      evaluateEligibility({ ...base, aiGloballyEnabled: false }).reason,
    ).toBe("ai_disabled_globally");
    expect(
      evaluateEligibility({ ...base, workspaceAiEnabled: false }).reason,
    ).toBe("ai_disabled_workspace");
  });

  it("skips groups, blocked contacts, closed conversations, receipts", () => {
    expect(
      evaluateEligibility({ ...base, isGroupConversation: true }).reason,
    ).toBe("group_conversation");
    expect(evaluateEligibility({ ...base, contactBlocked: true }).reason).toBe(
      "contact_blocked",
    );
    expect(
      evaluateEligibility({ ...base, conversationStatus: "closed" }).reason,
    ).toBe("conversation_closed");
    expect(
      evaluateEligibility({ ...base, messageType: "reaction" }).reason,
    ).toBe("unsupported_message_type");
  });

  it("respects agent lifecycle and assignment state", () => {
    expect(evaluateEligibility({ ...base, agentStatus: "paused" }).reason).toBe(
      "agent_not_active",
    );
    expect(
      evaluateEligibility({ ...base, assignmentExists: false }).reason,
    ).toBe("no_agent_assigned");
    expect(
      evaluateEligibility({ ...base, assignmentEnabled: false }).reason,
    ).toBe("assignment_disabled");
  });

  it("honors conversation pause until its expiry passes", () => {
    const paused = evaluateEligibility({
      ...base,
      conversationAiStatus: "paused",
      pausedUntil: new Date("2026-08-07T11:00:00Z"),
    });
    expect(paused.reason).toBe("conversation_ai_paused");

    const expired = evaluateEligibility({
      ...base,
      conversationAiStatus: "paused",
      pausedUntil: new Date("2026-08-07T09:00:00Z"),
    });
    expect(expired.eligible).toBe(true);

    const indefinite = evaluateEligibility({
      ...base,
      conversationAiStatus: "paused",
      pausedUntil: null,
    });
    expect(indefinite.reason).toBe("conversation_ai_paused");
  });

  it("always yields to an active human takeover", () => {
    expect(
      evaluateEligibility({ ...base, humanTakeoverActive: true }).reason,
    ).toBe("human_takeover");
  });

  it("skips disabled conversations permanently", () => {
    expect(
      evaluateEligibility({ ...base, conversationAiStatus: "disabled" }).reason,
    ).toBe("conversation_ai_disabled");
  });
});

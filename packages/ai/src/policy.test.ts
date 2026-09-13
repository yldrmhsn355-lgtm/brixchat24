import { describe, expect, it } from "vitest";
import { evaluatePolicy, withinWorkingHours, type PolicyInput } from "./policy";
import type { RunAgentTurnResult } from "./runner";
import type { AgentVersionConfig } from "./types";

const agent: AgentVersionConfig = {
  agentId: "agent-1",
  agentVersionId: "version-1",
  agentName: "Test Agent",
  version: 1,
  mode: "autopilot",
  model: "test/model",
  fallbackModel: null,
  temperature: 0.3,
  maxSteps: 6,
  maxCostPerRunUsd: 0.25,
  defaultLanguage: "tr",
  allowedLanguages: [],
  systemInstruction: "",
  businessObjective: "",
  persona: {},
  behaviorRules: [],
  forbiddenTopics: ["kripto yatırım"],
  exampleResponses: [],
  handoffRules: { maxConsecutiveAiMessages: 3 },
  confidenceThreshold: 0.6,
  workingHours: {},
  responseDelayMinMs: 0,
  responseDelayMaxMs: 0,
  toolPermissions: {},
  config: {},
};

const result = (overrides: Partial<RunAgentTurnResult["finalReply"]> = {}): RunAgentTurnResult => ({
  finalReply: {
    text: "Merhaba, size nasıl yardımcı olabilirim?",
    language: "tr",
    intent: "greeting",
    sentiment: "neutral",
    confidence: 0.9,
    requiresHuman: false,
    handoffReason: null,
    suggestedActions: [],
    ...overrides,
  },
  rawText: "",
  modelUsed: "test/model",
  fallbackUsed: false,
  steps: 1,
  usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
  latencyMs: 900,
});

const baseInput = (mode: PolicyInput["mode"], overrides: Partial<PolicyInput> = {}): PolicyInput => ({
  agent,
  mode,
  result: result(),
  toolJournal: [],
  handoff: { requested: false, reason: "" },
  injectionSignals: [],
  serviceWindowOpen: true,
  humanTakeoverActive: false,
  consecutiveAiMessages: 0,
  knowledgeSources: [],
  withinWorkingHours: true,
  ...overrides,
});

describe("evaluatePolicy", () => {
  it("autopilot with high confidence auto-sends", () => {
    const verdict = evaluatePolicy(baseInput("autopilot"));
    expect(verdict.decision).toBe("auto_sent");
    expect(verdict.contract.shouldSend).toBe(true);
  });

  it("copilot never sends, only suggests", () => {
    const verdict = evaluatePolicy(baseInput("copilot"));
    expect(verdict.decision).toBe("suggested");
    expect(verdict.contract.shouldSend).toBe(false);
  });

  it("approval mode creates a draft", () => {
    const verdict = evaluatePolicy(baseInput("approval"));
    expect(verdict.decision).toBe("draft_created");
    expect(verdict.contract.shouldSend).toBe(false);
  });

  it("observe mode only records", () => {
    const verdict = evaluatePolicy(baseInput("observe"));
    expect(verdict.decision).toBe("observed");
    expect(verdict.contract.shouldSend).toBe(false);
  });

  it("escalates below the confidence threshold", () => {
    const verdict = evaluatePolicy(
      baseInput("autopilot", { result: result({ confidence: 0.4 }) }),
    );
    expect(verdict.decision).toBe("handoff");
    expect(verdict.contract.handoffReason).toBe("LOW_CONFIDENCE");
    expect(verdict.contract.shouldSend).toBe(false);
  });

  it("escalates on negative sentiment", () => {
    const verdict = evaluatePolicy(
      baseInput("autopilot", { result: result({ sentiment: "negative" }) }),
    );
    expect(verdict.contract.handoffReason).toBe("NEGATIVE_SENTIMENT");
  });

  it("blocks replies that mention a forbidden topic server-side", () => {
    const verdict = evaluatePolicy(
      baseInput("autopilot", {
        result: result({ text: "Kripto yatırım tavsiyem şu..." }),
      }),
    );
    expect(verdict.decision).toBe("handoff");
    expect(verdict.contract.handoffReason).toBe("RESTRICTED_TOPIC");
  });

  it("tool-requested handoff always wins", () => {
    const verdict = evaluatePolicy(
      baseInput("autopilot", {
        handoff: { requested: true, reason: "customer asked" },
      }),
    );
    expect(verdict.decision).toBe("handoff");
    expect(verdict.contract.handoffReason).toBe("HUMAN_REQUESTED");
  });

  it("closed service window blocks autopilot sends", () => {
    const verdict = evaluatePolicy(
      baseInput("autopilot", { serviceWindowOpen: false }),
    );
    expect(verdict.contract.shouldSend).toBe(false);
    expect(verdict.decision).toBe("handoff");
  });

  it("human takeover downgrades autopilot to a suggestion", () => {
    const verdict = evaluatePolicy(
      baseInput("autopilot", { humanTakeoverActive: true }),
    );
    expect(verdict.decision).toBe("suggested");
    expect(verdict.contract.shouldSend).toBe(false);
  });

  it("caps consecutive AI messages", () => {
    const verdict = evaluatePolicy(
      baseInput("autopilot", { consecutiveAiMessages: 3 }),
    );
    expect(verdict.decision).toBe("handoff");
  });

  it("missing finalize_reply falls back safely and never sends", () => {
    const verdict = evaluatePolicy(
      baseInput("autopilot", {
        result: { ...result(), finalReply: null, rawText: "some raw text" },
      }),
    );
    expect(verdict.contract.shouldSend).toBe(false);
    expect(verdict.contract.requiresHuman).toBe(true);
    expect(verdict.contract.confidence).toBeLessThan(0.5);
  });

  it("empty output is blocked", () => {
    const verdict = evaluatePolicy(
      baseInput("autopilot", {
        result: { ...result(), finalReply: null, rawText: "" },
      }),
    );
    expect(verdict.decision).toBe("blocked");
  });

  it("multiple injection signals trigger escalation", () => {
    const verdict = evaluatePolicy(
      baseInput("autopilot", {
        injectionSignals: ["ignore_instructions", "system_prompt_probe"],
      }),
    );
    expect(verdict.decision).toBe("handoff");
  });

  it("language allowlist is enforced server-side", () => {
    const verdict = evaluatePolicy(
      baseInput("autopilot", {
        agent: { ...agent, allowedLanguages: ["tr"] },
        result: result({ language: "en" }),
      }),
    );
    expect(verdict.decision).toBe("handoff");
  });
});

describe("withinWorkingHours", () => {
  it("returns true when no schedule configured", () => {
    expect(withinWorkingHours(agent, new Date())).toBe(true);
  });

  it("checks the schedule in the configured timezone", () => {
    const scheduled: AgentVersionConfig = {
      ...agent,
      workingHours: {
        timezone: "UTC",
        schedule: { "4": [{ start: "09:00", end: "18:00" }] },
      },
    };
    // 2026-08-06 is a Thursday (ISO weekday 4).
    expect(
      withinWorkingHours(scheduled, new Date("2026-08-06T10:00:00Z")),
    ).toBe(true);
    expect(
      withinWorkingHours(scheduled, new Date("2026-08-06T20:00:00Z")),
    ).toBe(false);
  });
});

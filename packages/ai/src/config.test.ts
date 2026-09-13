import { describe, expect, it } from "vitest";
import { parseAgentVersionRow, parseAiMode } from "./config";
import { resolveModelChain } from "./runner";
import { resolveToolAccess } from "./tools";

describe("parseAgentVersionRow", () => {
  it("applies safe defaults to an empty row", () => {
    const config = parseAgentVersionRow({});
    expect(config.mode).toBe("copilot");
    expect(config.temperature).toBe(0.3);
    expect(config.maxSteps).toBe(6);
    expect(config.confidenceThreshold).toBe(0.6);
    expect(config.defaultLanguage).toBe("tr");
    expect(config.behaviorRules).toEqual([]);
    expect(config.handoffRules.maxConsecutiveAiMessages).toBe(5);
  });

  it("clamps out-of-range numeric values", () => {
    const config = parseAgentVersionRow({
      temperature: "9",
      max_steps: 500,
      confidence_threshold: 3,
      max_cost_per_run_usd: -1,
    });
    expect(config.temperature).toBe(2);
    expect(config.maxSteps).toBe(32);
    expect(config.confidenceThreshold).toBe(1);
    expect(config.maxCostPerRunUsd).toBe(0.001);
  });

  it("drops malformed jsonb entries instead of crashing", () => {
    const config = parseAgentVersionRow({
      behavior_rules: [1, "valid rule", null],
      example_responses: [{ customer: "q" }, { customer: "q", reply: "a" }],
      tool_permissions: { search_knowledge: "allowed", bad_tool: "nonsense" },
    });
    expect(config.behaviorRules).toEqual(["valid rule"]);
    expect(config.exampleResponses).toEqual([{ customer: "q", reply: "a" }]);
    expect(config.toolPermissions).toEqual({ search_knowledge: "allowed" });
  });

  it("parses working-hours schedules defensively", () => {
    const config = parseAgentVersionRow({
      working_hours: {
        timezone: "Europe/Istanbul",
        schedule: { "1": [{ start: "09:00", end: "18:00" }], "2": "garbage" },
      },
    });
    expect(config.workingHours.schedule).toEqual({
      "1": [{ start: "09:00", end: "18:00" }],
    });
  });
});

describe("parseAiMode", () => {
  it("accepts valid modes and falls back otherwise", () => {
    expect(parseAiMode("autopilot")).toBe("autopilot");
    expect(parseAiMode("nonsense")).toBe("copilot");
    expect(parseAiMode(null, "observe")).toBe("observe");
  });
});

describe("resolveModelChain", () => {
  it("orders agent > workspace > environment and deduplicates", () => {
    expect(
      resolveModelChain({
        agentModel: "a/model",
        agentFallbackModel: "b/model",
        workspaceDefaultModel: "a/model",
        workspaceFallbackModel: "c/model",
        environmentDefaultModel: "d/model",
      }),
    ).toEqual(["a/model", "b/model", "c/model", "d/model"]);
  });

  it("skips blanks and can be empty", () => {
    expect(
      resolveModelChain({
        agentModel: " ",
        agentFallbackModel: null,
        workspaceDefaultModel: null,
        workspaceFallbackModel: null,
        environmentDefaultModel: null,
      }),
    ).toEqual([]);
  });
});

describe("resolveToolAccess", () => {
  const agent = parseAgentVersionRow({
    tool_permissions: { add_label: "denied", remember_customer_fact: "allowed" },
  });

  it("safety-critical tools are always allowed", () => {
    expect(resolveToolAccess(agent, "finalize_reply")).toBe("allowed");
    expect(resolveToolAccess(agent, "handoff_to_human")).toBe("allowed");
    expect(resolveToolAccess(agent, "search_knowledge")).toBe("allowed");
  });

  it("honors the per-agent allowlist", () => {
    expect(resolveToolAccess(agent, "add_label")).toBe("denied");
    expect(resolveToolAccess(agent, "remember_customer_fact")).toBe("allowed");
  });

  it("defaults sensitive tools to approval and unknown tools to approval", () => {
    const bare = parseAgentVersionRow({});
    expect(resolveToolAccess(bare, "remember_customer_fact")).toBe("approval");
    expect(resolveToolAccess(bare, "totally_unknown_tool")).toBe("approval");
    expect(resolveToolAccess(bare, "get_contact")).toBe("allowed");
  });
});

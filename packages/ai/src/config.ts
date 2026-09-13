import type { AgentVersionConfig, AiMode, ToolAccess } from "./types";

/**
 * Defensive parser turning a raw ai_agent_versions row (snake_case, jsonb
 * columns as unknown) into a typed AgentVersionConfig. Database content is
 * admin-authored but still validated field by field with safe defaults so a
 * malformed config can never crash a run.
 */

type Row = Record<string, unknown>;

const MODES: readonly AiMode[] = ["observe", "copilot", "approval", "autopilot"];
const ACCESS: readonly ToolAccess[] = ["allowed", "approval", "denied"];

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const num = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const strArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function parseAiMode(value: unknown, fallback: AiMode = "copilot"): AiMode {
  return MODES.includes(value as AiMode) ? (value as AiMode) : fallback;
}

export function parseAgentVersionRow(row: Row): AgentVersionConfig {
  const persona = obj(row.persona);
  const handoff = obj(row.handoff_rules);
  const working = obj(row.working_hours);
  const config = obj(row.config);

  const toolPermissions: Record<string, ToolAccess> = {};
  for (const [key, value] of Object.entries(obj(row.tool_permissions))) {
    if (ACCESS.includes(value as ToolAccess)) {
      toolPermissions[key] = value as ToolAccess;
    }
  }

  const exampleResponses = Array.isArray(row.example_responses)
    ? row.example_responses
        .map((entry) => obj(entry))
        .filter((entry) => typeof entry.customer === "string" && typeof entry.reply === "string")
        .map((entry) => ({
          customer: String(entry.customer),
          reply: String(entry.reply),
        }))
    : [];

  const responseLength = ["short", "medium", "long"].includes(
    String(persona.responseLength),
  )
    ? (String(persona.responseLength) as "short" | "medium" | "long")
    : undefined;
  const emojiPolicy = ["none", "sparse", "free"].includes(String(persona.emojiPolicy))
    ? (String(persona.emojiPolicy) as "none" | "sparse" | "free")
    : undefined;

  const schedule = obj(working.schedule);
  const parsedSchedule: Record<string, Array<{ start: string; end: string }>> = {};
  for (const [day, windows] of Object.entries(schedule)) {
    if (!Array.isArray(windows)) continue;
    parsedSchedule[day] = windows
      .map((window) => obj(window))
      .filter(
        (window) =>
          typeof window.start === "string" && typeof window.end === "string",
      )
      .map((window) => ({ start: String(window.start), end: String(window.end) }));
  }

  return {
    agentId: str(row.agent_id),
    agentVersionId: str(row.id),
    agentName: str(row.agent_name, "AI Agent"),
    version: num(row.version, 1),
    mode: parseAiMode(row.mode),
    model: str(row.model),
    fallbackModel: row.fallback_model ? str(row.fallback_model) : null,
    temperature: Math.min(Math.max(num(row.temperature, 0.3), 0), 2),
    maxSteps: Math.min(Math.max(Math.trunc(num(row.max_steps, 6)), 1), 32),
    maxCostPerRunUsd: Math.max(num(row.max_cost_per_run_usd, 0.25), 0.001),
    defaultLanguage: str(row.default_language, "tr"),
    allowedLanguages: strArray(row.allowed_languages),
    systemInstruction: str(row.system_instruction),
    businessObjective: str(row.business_objective),
    persona: {
      ...(persona.tone ? { tone: str(persona.tone) } : {}),
      ...(persona.personality ? { personality: str(persona.personality) } : {}),
      ...(persona.communicationStyle
        ? { communicationStyle: str(persona.communicationStyle) }
        : {}),
      ...(responseLength ? { responseLength } : {}),
      ...(emojiPolicy ? { emojiPolicy } : {}),
    },
    behaviorRules: strArray(row.behavior_rules),
    forbiddenTopics: strArray(row.forbidden_topics),
    exampleResponses,
    handoffRules: {
      onHumanRequest: handoff.onHumanRequest !== false,
      onNegativeSentiment: handoff.onNegativeSentiment !== false,
      onMissingKnowledge: handoff.onMissingKnowledge !== false,
      restrictedIntents: strArray(handoff.restrictedIntents),
      maxConsecutiveAiMessages: Math.min(
        Math.max(Math.trunc(num(handoff.maxConsecutiveAiMessages, 5)), 1),
        20,
      ),
    },
    confidenceThreshold: Math.min(Math.max(num(row.confidence_threshold, 0.6), 0), 1),
    workingHours: {
      ...(working.timezone ? { timezone: str(working.timezone) } : {}),
      schedule: parsedSchedule,
      outsideHoursMode: ["off", "observe", "normal"].includes(
        String(working.outsideHoursMode),
      )
        ? (String(working.outsideHoursMode) as "off" | "observe" | "normal")
        : "normal",
    },
    responseDelayMinMs: Math.max(Math.trunc(num(row.response_delay_min_ms, 0)), 0),
    responseDelayMaxMs: Math.max(Math.trunc(num(row.response_delay_max_ms, 0)), 0),
    toolPermissions,
    config: {
      ...(Number.isFinite(Number(config.debounceMs))
        ? { debounceMs: Number(config.debounceMs) }
        : {}),
      webSearchEnabled: config.webSearchEnabled === true,
      visionEnabled: config.visionEnabled === true,
      ...(Number.isFinite(Number(config.maxOutputTokens)) &&
      Number(config.maxOutputTokens) > 0
        ? { maxOutputTokens: Math.trunc(Number(config.maxOutputTokens)) }
        : {}),
      citeSources: config.citeSources === true,
    },
  };
}

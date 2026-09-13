import {
  evaluateCondition,
  type AutomationNodeContract,
  type CompiledAutomationPlatformDefinition,
} from "@brixchat/integrations";

export type AutomationEngineStepStatus =
  "completed" | "skipped" | "blocked" | "waiting" | "failed";

export type AutomationNodeHandlerResult = {
  status: AutomationEngineStepStatus;
  port: string | null;
  output: Record<string, unknown>;
  errorCode?: string;
};

export type AutomationNodeHandlerContext = {
  node: AutomationNodeContract;
  input: Record<string, unknown>;
  dryRun: boolean;
};

export type AutomationNodeHandler = (
  context: AutomationNodeHandlerContext,
) => Promise<AutomationNodeHandlerResult> | AutomationNodeHandlerResult;

export type AutomationEngineStep = {
  position: number;
  nodeId: string;
  nodeType: string;
  nodeVersion: number;
  status: AutomationEngineStepStatus;
  selectedPort: string | null;
  output: Record<string, unknown>;
  errorCode: string | null;
};

export type AutomationEngineResult = {
  status: AutomationEngineStepStatus;
  steps: AutomationEngineStep[];
  errorCode: string | null;
};

function failed(
  steps: AutomationEngineStep[],
  errorCode: string,
): AutomationEngineResult {
  return { status: "failed", steps, errorCode };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

function channelScopeMatches(
  config: Record<string, unknown>,
  input: Record<string, unknown>,
) {
  const scope =
    config.channelScope &&
    typeof config.channelScope === "object" &&
    !Array.isArray(config.channelScope)
      ? (config.channelScope as Record<string, unknown>)
      : {};
  const channelId = typeof input.channelId === "string" ? input.channelId : "";
  const excluded = stringList(scope.excludedChannelIds);
  if (excluded.includes(channelId)) return false;
  return (
    scope.mode !== "selected" ||
    stringList(scope.channelIds).includes(channelId)
  );
}

function groupTriggerResult(
  matched: boolean,
  output: Record<string, unknown>,
): AutomationNodeHandlerResult {
  return matched
    ? { status: "completed", port: "success", output: { ...output, matched } }
    : { status: "skipped", port: null, output: { ...output, matched } };
}

function groupEventMatches(
  node: AutomationNodeContract,
  input: Record<string, unknown>,
) {
  return input.isGroup === true && channelScopeMatches(node.config, input);
}

export function createBuiltinAutomationHandlers(): Record<
  string,
  AutomationNodeHandler
> {
  return {
    "trigger.message.received": ({ node, input }) =>
      groupTriggerResult(channelScopeMatches(node.config, input), {}),
    "trigger.message.delivery_failed": ({ node, input }) =>
      groupTriggerResult(channelScopeMatches(node.config, input), {
        messageId: input.messageId,
        errorCode: input.errorCode,
        retryable: input.retryable,
        failureCategory: input.failureCategory,
        customerRelated: input.customerRelated,
        automationEligible: input.automationEligible,
        metaCode: input.metaCode,
      }),
    "trigger.group.message.received": ({ node, input }) => {
      const messageTypes = stringList(node.config.messageTypes);
      const matched =
        groupEventMatches(node, input) &&
        (!messageTypes.length ||
          messageTypes.includes(String(input.type ?? "")));
      return groupTriggerResult(matched, {
        chatId: input.chatId,
        messageType: input.type,
      });
    },
    "trigger.group.mentioned": ({ node, input }) => {
      const actual = stringList(input.mentionedJids);
      const selected = stringList(node.config.mentionedJids);
      const mentionMode = String(node.config.mentionMode ?? "any");
      const matched =
        groupEventMatches(node, input) &&
        actual.length > 0 &&
        (mentionMode !== "selected" ||
          selected.some((jid) => actual.includes(jid)));
      return groupTriggerResult(matched, {
        mentionedJids: actual,
        mentionMode,
      });
    },
    "trigger.group.keyword_matched": ({ node, input }) => {
      const caseSensitive = node.config.caseSensitive === true;
      const normalize = (value: string) =>
        caseSensitive ? value : value.toLocaleLowerCase("tr-TR");
      const text = normalize(String(input.displayText ?? input.text ?? ""));
      const keywords = stringList(node.config.keywords).map(normalize);
      const matches = keywords.map((keyword) => text.includes(keyword));
      const matchMode = String(node.config.matchMode ?? "any");
      const matched =
        groupEventMatches(node, input) &&
        keywords.length > 0 &&
        (matchMode === "all" ? matches.every(Boolean) : matches.some(Boolean));
      return groupTriggerResult(matched, {
        keywords: stringList(node.config.keywords),
        matchedKeywords: stringList(node.config.keywords).filter(
          (_, index) => matches[index],
        ),
        matchMode,
      });
    },
    ...Object.fromEntries(
      ["added", "removed", "promoted", "demoted"].map((event) => [
        `trigger.group.participant_${event}`,
        ({ node, input }: AutomationNodeHandlerContext) => {
          const actual = stringList(input.participantJids);
          const selected = stringList(node.config.participantJids);
          const matched =
            groupEventMatches(node, input) &&
            actual.length > 0 &&
            (!selected.length || selected.some((jid) => actual.includes(jid)));
          return groupTriggerResult(matched, { participantJids: actual });
        },
      ]),
    ),
    "condition.evaluate": ({ node, input }) => {
      const field = String(node.config.field ?? "");
      const operator = String(node.config.operator ?? "");
      const matched = evaluateCondition(
        { field, operator, value: node.config.value },
        input,
      );
      const selectedPort = matched ? "true" : "false";
      return {
        status: matched ? "completed" : "skipped",
        port: selectedPort,
        output: {
          field,
          operator,
          matched,
          selectedPort,
          comparison: node.config.value === undefined ? "none" : "configured",
        },
      };
    },
    "control.end.success": () => ({
      status: "completed",
      port: null,
      output: { terminal: "success" },
    }),
    "control.end.skipped": () => ({
      status: "skipped",
      port: null,
      output: { terminal: "skipped" },
    }),
    "control.end.failure": () => ({
      status: "failed",
      port: null,
      output: { terminal: "failure" },
      errorCode: "automation_end_failure",
    }),
  };
}

export async function executeCompiledAutomation(input: {
  definition: CompiledAutomationPlatformDefinition;
  input: Record<string, unknown>;
  handlers: Record<string, AutomationNodeHandler>;
  dryRun: boolean;
}): Promise<AutomationEngineResult> {
  const nodes = new Map(input.definition.nodes.map((node) => [node.id, node]));
  const steps: AutomationEngineStep[] = [];
  let currentNodeId = input.definition.entryNodeId;

  for (
    let position = 0;
    position < input.definition.limits.maxSteps;
    position += 1
  ) {
    const node = nodes.get(currentNodeId);
    if (!node) return failed(steps, "automation_node_missing");
    const handlerKey = node.runtimeMetadata.handlerKey;
    const handler = handlerKey ? input.handlers[handlerKey] : undefined;
    if (!handler) return failed(steps, "automation_handler_missing");

    let result: AutomationNodeHandlerResult;
    try {
      result = await handler({
        node,
        input: input.input,
        dryRun: input.dryRun,
      });
    } catch {
      result = {
        status: "failed",
        port: "error",
        output: {},
        errorCode: "automation_handler_failed",
      };
    }
    steps.push({
      position,
      nodeId: node.id,
      nodeType: node.type,
      nodeVersion: node.version,
      status: result.status,
      selectedPort: result.port,
      output: result.output,
      errorCode: result.errorCode ?? null,
    });

    if (result.port === null)
      return {
        status: result.status,
        steps,
        errorCode: result.errorCode ?? null,
      };
    if (result.status === "waiting")
      return { status: "waiting", steps, errorCode: null };

    const targets = input.definition.adjacency[node.id]?.[result.port] ?? [];
    if (targets.length !== 1)
      return failed(
        steps,
        targets.length
          ? "automation_ambiguous_route"
          : "automation_route_missing",
      );
    currentNodeId = targets[0]!;
  }

  return failed(steps, "automation_step_limit");
}

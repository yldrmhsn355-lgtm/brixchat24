import {
  hydrateCompiledAutomationDefinition,
  type AutomationNodeContract,
  type CompiledAutomationPlatformDefinition,
} from "@brixchat/integrations";
import {
  createBuiltinAutomationHandlers,
  executeCompiledAutomation,
  type AutomationEngineResult,
  type AutomationNodeHandler,
} from "./automation-engine";

export type PlannedAutomationAction = {
  nodeId: string;
  nodeType: string;
  nodeVersion: number;
  config: Record<string, unknown>;
};

export type CompiledAutomationPlan = {
  definition: CompiledAutomationPlatformDefinition;
  result: AutomationEngineResult;
  actions: PlannedAutomationAction[];
};

function successfulRoute(port: string): ReturnType<AutomationNodeHandler> {
  return {
    status: "completed",
    port,
    output: { planned: true },
  };
}

export async function planCompiledAutomation(
  storedDefinition: unknown,
  payload: Record<string, unknown>,
): Promise<CompiledAutomationPlan> {
  const definition = hydrateCompiledAutomationDefinition(storedDefinition);
  const actions: PlannedAutomationAction[] = [];
  const handlers = createBuiltinAutomationHandlers();

  for (const node of definition.nodes) {
    const handlerKey = node.runtimeMetadata.handlerKey;
    if (!handlerKey || handlers[handlerKey]) continue;
    if (node.category === "trigger") {
      handlers[handlerKey] = () => successfulRoute("success");
      continue;
    }
    if (
      ["messaging", "assignment", "conversation", "crm", "integration"].includes(
        node.category,
      )
    ) {
      handlers[handlerKey] = ({ node: selected }: { node: AutomationNodeContract }) => {
        actions.push({
          nodeId: selected.id,
          nodeType: selected.type,
          nodeVersion: selected.version,
          config: selected.config,
        });
        return successfulRoute("success");
      };
    }
  }

  const result = await executeCompiledAutomation({
    definition,
    input: payload,
    handlers,
    dryRun: true,
  });
  return { definition, result, actions };
}

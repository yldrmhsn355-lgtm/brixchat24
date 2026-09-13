import { createHash } from "node:crypto";
import {
  deepFreeze,
  parseAutomationNodeContract,
  type AutomationNodeContract,
} from "./contracts";

export type AutomationSourceEdge = {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
};

export type AutomationSourceGraph = {
  nodes: readonly AutomationNodeContract[];
  edges: readonly AutomationSourceEdge[];
};

export type AutomationCompilationLimits = {
  maxSteps: number;
  maxLoopIterations: number;
  maxSubflowDepth: number;
};

export type AutomationCompilationIssue = {
  code:
    | "empty_graph"
    | "duplicate_node"
    | "duplicate_edge"
    | "missing_trigger"
    | "multiple_triggers"
    | "missing_endpoint"
    | "self_link"
    | "unknown_input_port"
    | "unknown_output_port"
    | "required_input_unconnected"
    | "required_output_unconnected"
    | "unreachable_node"
    | "unsupported_cycle"
    | "missing_termination"
    | "runtime_handler_unavailable";
  nodeId?: string;
  edgeId?: string;
};

export type CompiledAutomationPlatformDefinition = {
  compilerVersion: 1;
  checksum: string;
  entryNodeId: string;
  nodes: readonly AutomationNodeContract[];
  edges: readonly AutomationSourceEdge[];
  adjacency: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
  limits: Readonly<AutomationCompilationLimits>;
};

export type LegacyLinearAutomationDefinition = {
  trigger: { type: string; config: Record<string, unknown> };
  conditions: Array<{ field: string; operator: string; value?: unknown }>;
  actions: Array<{ type: string; config: Record<string, unknown> }>;
};

const defaultLimits: AutomationCompilationLimits = {
  maxSteps: 100,
  maxLoopIterations: 20,
  maxSubflowDepth: 5,
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  return value;
}

function semanticNode(node: AutomationNodeContract) {
  return {
    id: node.id,
    type: node.type,
    version: node.version,
    category: node.category,
    config: stableValue(node.config),
    inputPorts: node.inputPorts,
    outputPorts: node.outputPorts,
    retryPolicy: node.retryPolicy,
    timeoutPolicy: node.timeoutPolicy,
    errorPolicy: node.errorPolicy,
    runtimeMetadata: node.runtimeMetadata,
  };
}

export function validateAutomationDefinition(
  graph: AutomationSourceGraph,
): AutomationCompilationIssue[] {
  if (!graph.nodes.length) return [{ code: "empty_graph" }];

  const issues: AutomationCompilationIssue[] = [];
  const nodes = new Map<string, AutomationNodeContract>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id))
      issues.push({ code: "duplicate_node", nodeId: node.id });
    nodes.set(node.id, node);
    if (
      node.runtimeMetadata.capability !== "production" ||
      !node.runtimeMetadata.handlerKey
    )
      issues.push({ code: "runtime_handler_unavailable", nodeId: node.id });
  }

  const triggers = graph.nodes.filter((node) => node.category === "trigger");
  if (!triggers.length) issues.push({ code: "missing_trigger" });
  if (triggers.length > 1) issues.push({ code: "multiple_triggers" });

  const outgoing = new Map<string, AutomationSourceEdge[]>();
  const incoming = new Map<string, AutomationSourceEdge[]>();
  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) {
      issues.push({ code: "missing_endpoint", edgeId: edge.id });
      continue;
    }
    if (edge.source === edge.target) {
      issues.push({
        code: "self_link",
        nodeId: edge.source,
        edgeId: edge.id,
      });
      continue;
    }
    if (!source.outputPorts.some((port) => port.id === edge.sourcePort))
      issues.push({
        code: "unknown_output_port",
        nodeId: source.id,
        edgeId: edge.id,
      });
    if (!target.inputPorts.some((port) => port.id === edge.targetPort))
      issues.push({
        code: "unknown_input_port",
        nodeId: target.id,
        edgeId: edge.id,
      });
    const edgeKey = [
      edge.source,
      edge.sourcePort,
      edge.target,
      edge.targetPort,
    ].join(":");
    if (edgeKeys.has(edgeKey))
      issues.push({
        code: "duplicate_edge",
        nodeId: edge.source,
        edgeId: edge.id,
      });
    edgeKeys.add(edgeKey);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  }

  for (const node of graph.nodes) {
    const outgoingPorts = new Set(
      (outgoing.get(node.id) ?? []).map((edge) => edge.sourcePort),
    );
    const incomingPorts = new Set(
      (incoming.get(node.id) ?? []).map((edge) => edge.targetPort),
    );
    for (const port of node.outputPorts)
      if (port.required && !outgoingPorts.has(port.id))
        issues.push({
          code: "required_output_unconnected",
          nodeId: node.id,
        });
    for (const port of node.inputPorts)
      if (port.required && !incomingPorts.has(port.id))
        issues.push({
          code: "required_input_unconnected",
          nodeId: node.id,
        });
  }

  const entry = triggers[0];
  if (entry) {
    const reachable = new Set<string>();
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const walk = (nodeId: string) => {
      reachable.add(nodeId);
      visiting.add(nodeId);
      for (const edge of outgoing.get(nodeId) ?? []) {
        if (visiting.has(edge.target)) {
          issues.push({
            code: "unsupported_cycle",
            nodeId: edge.target,
            edgeId: edge.id,
          });
          continue;
        }
        if (!visited.has(edge.target)) walk(edge.target);
      }
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    walk(entry.id);
    for (const node of graph.nodes)
      if (!reachable.has(node.id))
        issues.push({ code: "unreachable_node", nodeId: node.id });
  }

  if (
    !graph.nodes.some(
      (node) => node.type === "end.success" || node.type === "end.failure",
    )
  )
    issues.push({ code: "missing_termination" });

  return issues;
}

export function compileAutomationDefinition(
  graph: AutomationSourceGraph,
  limits: Partial<AutomationCompilationLimits> = {},
): CompiledAutomationPlatformDefinition {
  const issues = validateAutomationDefinition(graph);
  if (issues.length)
    throw new Error(
      issues
        .map((issue) =>
          [issue.code, issue.nodeId, issue.edgeId].filter(Boolean).join(":"),
        )
        .join(","),
    );

  const normalizedLimits = {
    maxSteps: Math.min(1_000, Math.max(1, limits.maxSteps ?? defaultLimits.maxSteps)),
    maxLoopIterations: Math.min(
      100,
      Math.max(1, limits.maxLoopIterations ?? defaultLimits.maxLoopIterations),
    ),
    maxSubflowDepth: Math.min(
      20,
      Math.max(1, limits.maxSubflowDepth ?? defaultLimits.maxSubflowDepth),
    ),
  };
  const nodes = [...graph.nodes]
    .map((node) => structuredClone(node))
    .sort((left, right) => left.id.localeCompare(right.id));
  const edges = [...graph.edges]
    .map((edge) => structuredClone(edge))
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.sourcePort.localeCompare(right.sourcePort) ||
        left.target.localeCompare(right.target) ||
        left.targetPort.localeCompare(right.targetPort) ||
        left.id.localeCompare(right.id),
    );
  const adjacency: Record<string, Record<string, string[]>> = {};
  for (const edge of edges) {
    adjacency[edge.source] ??= {};
    adjacency[edge.source]![edge.sourcePort] ??= [];
    adjacency[edge.source]![edge.sourcePort]!.push(edge.target);
  }
  const semantic = stableValue({
    compilerVersion: 1,
    nodes: nodes.map(semanticNode),
    edges: edges.map(({ source, sourcePort, target, targetPort }) => ({
      source,
      sourcePort,
      target,
      targetPort,
    })),
    limits: normalizedLimits,
  });
  const checksum = createHash("sha256")
    .update(JSON.stringify(semantic))
    .digest("hex");
  const entryNodeId = nodes.find((node) => node.category === "trigger")!.id;

  return deepFreeze({
    compilerVersion: 1 as const,
    checksum,
    entryNodeId,
    nodes,
    edges,
    adjacency,
    limits: normalizedLimits,
  });
}

export function hydrateCompiledAutomationDefinition(
  value: unknown,
): CompiledAutomationPlatformDefinition {
  if (!value || typeof value !== "object")
    throw new Error("automation_compiled_definition_invalid");
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges))
    throw new Error("automation_compiled_definition_invalid");
  const nodes = candidate.nodes.map((node) =>
    parseAutomationNodeContract(node),
  );
  const edges = candidate.edges.map((edge) => {
    if (!edge || typeof edge !== "object")
      throw new Error("automation_compiled_edge_invalid");
    const item = edge as Record<string, unknown>;
    for (const field of [
      "id",
      "source",
      "sourcePort",
      "target",
      "targetPort",
    ])
      if (typeof item[field] !== "string" || !item[field])
        throw new Error(`automation_compiled_edge_invalid:${field}`);
    return {
      id: String(item.id),
      source: String(item.source),
      sourcePort: String(item.sourcePort),
      target: String(item.target),
      targetPort: String(item.targetPort),
    };
  });
  const limits =
    candidate.limits && typeof candidate.limits === "object"
      ? (candidate.limits as Partial<AutomationCompilationLimits>)
      : {};
  const compiled = compileAutomationDefinition({ nodes, edges }, limits);
  if (
    candidate.compilerVersion !== compiled.compilerVersion ||
    candidate.checksum !== compiled.checksum ||
    candidate.entryNodeId !== compiled.entryNodeId
  )
    throw new Error("automation_compiled_definition_checksum_mismatch");
  return compiled;
}

const compatibilityPolicy = {
  retryPolicy: {
    maxAttempts: 5,
    backoffMs: 1_000,
    maxBackoffMs: 300_000,
  },
  timeoutPolicy: { timeoutMs: null },
  errorPolicy: { mode: "fail" as const },
};

function compatibilityActionCategory(type: string) {
  if (type === "assign_user") return "assignment" as const;
  if (type === "send_whatsapp_template") return "messaging" as const;
  return "conversation" as const;
}

export function compileLegacyLinearDefinition(
  definition: LegacyLinearAutomationDefinition,
): CompiledAutomationPlatformDefinition {
  const nodes: AutomationNodeContract[] = [
    parseAutomationNodeContract({
      id: "trigger",
      type: definition.trigger.type,
      version: 1,
      category: "trigger",
      name: definition.trigger.type,
      description: "Legacy trigger compatibility node.",
      position: { x: 0, y: 0 },
      config: definition.trigger.config,
      inputPorts: [],
      outputPorts: [{ id: "success", kind: "success", required: true }],
      ...compatibilityPolicy,
      uiMetadata: {
        label: definition.trigger.type,
        icon: "message-circle",
        color: "green",
      },
      runtimeMetadata: {
        capability: "production",
        handlerKey: `trigger.${definition.trigger.type}`,
      },
    }),
  ];

  for (const [index, condition] of definition.conditions.entries()) {
    nodes.push(
      parseAutomationNodeContract({
        id: `condition-${index + 1}`,
        type: "condition.evaluate",
        version: 1,
        category: "condition",
        name: condition.field,
        description: "Legacy AND condition compatibility node.",
        position: { x: 0, y: (index + 1) * 140 },
        config: condition,
        inputPorts: [{ id: "input", kind: "control", required: true }],
        outputPorts: [
          { id: "true", kind: "true", required: true },
          { id: "false", kind: "false", required: true },
        ],
        ...compatibilityPolicy,
        uiMetadata: {
          label: condition.field,
          icon: "split",
          color: "amber",
        },
        runtimeMetadata: {
          capability: "production",
          handlerKey: "condition.evaluate",
        },
      }),
    );
  }

  for (const [index, action] of definition.actions.entries()) {
    nodes.push(
      parseAutomationNodeContract({
        id: `action-${index + 1}`,
        type: action.type,
        version: 1,
        category: compatibilityActionCategory(action.type),
        name: action.type,
        description: "Legacy action compatibility node.",
        position: {
          x: 0,
          y: (definition.conditions.length + index + 1) * 140,
        },
        config: action.config,
        inputPorts: [{ id: "input", kind: "control", required: true }],
        outputPorts: [
          { id: "success", kind: "success", required: true },
          { id: "error", kind: "error", required: false },
        ],
        ...compatibilityPolicy,
        uiMetadata: { label: action.type, icon: "zap", color: "indigo" },
        runtimeMetadata: {
          capability: "production",
          handlerKey: `action.${action.type}`,
        },
      }),
    );
  }

  nodes.push(
    parseAutomationNodeContract({
      id: "end-success",
      type: "end.success",
      version: 1,
      category: "control",
      name: "Success",
      description: "Completes the legacy execution.",
      position: {
        x: 0,
        y:
          (definition.conditions.length + definition.actions.length + 1) * 140,
      },
      config: {},
      inputPorts: [{ id: "input", kind: "control", required: true }],
      outputPorts: [],
      ...compatibilityPolicy,
      uiMetadata: { label: "Başarıyla tamamla", icon: "check", color: "green" },
      runtimeMetadata: {
        capability: "production",
        handlerKey: "control.end.success",
      },
    }),
  );
  if (definition.conditions.length)
    nodes.push(
      parseAutomationNodeContract({
        id: "end-skipped",
        type: "end.skipped",
        version: 1,
        category: "control",
        name: "Skipped",
        description: "Completes a non-matching legacy execution without actions.",
        position: { x: 320, y: 280 },
        config: {},
        inputPorts: [{ id: "input", kind: "control", required: true }],
        outputPorts: [],
        ...compatibilityPolicy,
        uiMetadata: { label: "Eşleşmedi", icon: "skip-forward", color: "gray" },
        runtimeMetadata: {
          capability: "production",
          handlerKey: "control.end.skipped",
        },
      }),
    );

  const primaryPath = [
    "trigger",
    ...definition.conditions.map((_, index) => `condition-${index + 1}`),
    ...definition.actions.map((_, index) => `action-${index + 1}`),
    "end-success",
  ];
  const edges: AutomationSourceEdge[] = [];
  for (let index = 0; index < primaryPath.length - 1; index += 1) {
    const source = primaryPath[index]!;
    edges.push({
      id: `legacy-${source}-${primaryPath[index + 1]}`,
      source,
      sourcePort: source.startsWith("condition-") ? "true" : "success",
      target: primaryPath[index + 1]!,
      targetPort: "input",
    });
  }
  for (let index = 0; index < definition.conditions.length; index += 1)
    edges.push({
      id: `legacy-condition-${index + 1}-false`,
      source: `condition-${index + 1}`,
      sourcePort: "false",
      target: "end-skipped",
      targetPort: "input",
    });

  return compileAutomationDefinition({ nodes, edges });
}

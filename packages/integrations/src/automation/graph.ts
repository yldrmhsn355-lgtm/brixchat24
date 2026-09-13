export type AutomationNodeCategory =
  "trigger" | "condition" | "action" | "delay" | "branch" | "merge" | "end";

export type AutomationGraphNode = {
  id: string;
  type: string;
  category: AutomationNodeCategory;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  metadata?: { label?: string; description?: string };
};

export type AutomationGraphEdge = {
  id: string;
  source: string;
  target: string;
  handle?: string;
  label?: string;
};

export type AutomationGraph = {
  nodes: AutomationGraphNode[];
  edges: AutomationGraphEdge[];
};

export type CompiledAutomationDefinition = {
  checksum: string;
  graph: AutomationGraph;
  entryNodeId: string;
  reachableNodeIds: string[];
  orderedNodeIds: string[];
};

export type GraphValidationIssue = {
  code:
    | "empty_graph"
    | "duplicate_node"
    | "missing_endpoint"
    | "multiple_triggers"
    | "missing_trigger"
    | "unreachable_node"
    | "missing_branch"
    | "unsupported_cycle"
    | "self_link"
    | "duplicate_edge"
    | "multiple_incoming"
    | "multiple_outgoing"
    | "invalid_linear_order";
  message: string;
  nodeId?: string;
};

const categories = new Set<AutomationNodeCategory>([
  "trigger",
  "condition",
  "action",
  "delay",
  "branch",
  "merge",
  "end",
]);

export type AutomationGraphMode = "branching" | "linear";

export function validateAutomationGraph(
  graph: AutomationGraph,
  options: { mode?: AutomationGraphMode } = {},
): GraphValidationIssue[] {
  const mode = options.mode ?? "branching";
  const issues: GraphValidationIssue[] = [];
  if (!graph.nodes.length)
    return [
      { code: "empty_graph", message: "Akış en az bir node içermelidir." },
    ];
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id))
      issues.push({
        code: "duplicate_node",
        nodeId: node.id,
        message: `Node kimliği tekrar ediyor: ${node.id}`,
      });
    ids.add(node.id);
    if (!categories.has(node.category))
      issues.push({
        code: "missing_endpoint",
        nodeId: node.id,
        message: `Geçersiz node kategorisi: ${node.category}`,
      });
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, AutomationGraphEdge[]>();
  const incoming = new Map<string, AutomationGraphEdge[]>();
  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      issues.push({
        code: "missing_endpoint",
        message: `Bağlantı endpoint'i bulunamadı: ${edge.id}`,
      });
      continue;
    }
    if (edge.source === edge.target) {
      issues.push({
        code: "self_link",
        nodeId: edge.source,
        message: "Bir node kendisine bağlanamaz.",
      });
      continue;
    }
    const edgeKey = `${edge.source}:${edge.target}:${edge.handle ?? "default"}`;
    if (edgeKeys.has(edgeKey)) {
      issues.push({
        code: "duplicate_edge",
        nodeId: edge.source,
        message: "Aynı bağlantı birden fazla kez oluşturulamaz.",
      });
      continue;
    }
    edgeKeys.add(edgeKey);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  }
  const triggers = graph.nodes.filter((node) => node.category === "trigger");
  if (!triggers.length)
    issues.push({
      code: "missing_trigger",
      message: "Akış tam olarak bir trigger node içermelidir.",
    });
  if (triggers.length > 1)
    issues.push({
      code: "multiple_triggers",
      message: "Akış tam olarak bir trigger node içermelidir.",
    });
  const entry = triggers[0];
  if (!entry) return issues;
  const reachable = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function walk(id: string) {
    reachable.add(id);
    visiting.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (visiting.has(edge.target)) {
        const target = byId.get(edge.target);
        if (target?.category !== "merge")
          issues.push({
            code: "unsupported_cycle",
            nodeId: edge.target,
            message: "Merge node dışındaki döngüler desteklenmez.",
          });
        continue;
      }
      if (!visited.has(edge.target)) walk(edge.target);
    }
    visiting.delete(id);
    visited.add(id);
  }
  walk(entry.id);
  for (const node of graph.nodes)
    if (!reachable.has(node.id))
      issues.push({
        code: "unreachable_node",
        nodeId: node.id,
        message: `Node trigger'dan erişilemiyor: ${node.id}`,
      });
  if (mode === "linear") {
    for (const node of graph.nodes) {
      if ((outgoing.get(node.id)?.length ?? 0) > 1)
        issues.push({
          code: "multiple_outgoing",
          nodeId: node.id,
          message:
            "Doğrusal akışta bir node yalnızca bir sonraki node'a bağlanabilir.",
        });
      if ((incoming.get(node.id)?.length ?? 0) > 1)
        issues.push({
          code: "multiple_incoming",
          nodeId: node.id,
          message:
            "Doğrusal akışta bir node yalnızca bir önceki node'dan bağlantı alabilir.",
        });
    }
    let actionSeen = false;
    for (const nodeId of reachable) {
      const category = byId.get(nodeId)?.category;
      if (category === "action") actionSeen = true;
      if (category === "condition" && actionSeen)
        issues.push({
          code: "invalid_linear_order",
          nodeId,
          message: "Doğrusal akışta koşullar aksiyonlardan önce yer almalıdır.",
        });
    }
  } else {
    for (const node of graph.nodes.filter(
      (item) => item.category === "condition" || item.category === "branch",
    )) {
      const edges = outgoing.get(node.id) ?? [];
      const handles = new Set(edges.map((edge) => edge.handle ?? "default"));
      if (!handles.has("true") || !handles.has("false"))
        issues.push({
          code: "missing_branch",
          nodeId: node.id,
          message: "Koşul node'u true ve false çıkışlarına sahip olmalıdır.",
        });
    }
  }
  return issues;
}

export function compileAutomationGraph(
  graph: AutomationGraph,
  options: { mode?: AutomationGraphMode } = {},
): CompiledAutomationDefinition {
  const issues = validateAutomationGraph(graph, options);
  if (issues.length)
    throw new Error(issues.map((issue) => issue.message).join(" "));
  const entryNodeId = graph.nodes.find(
    (node) => node.category === "trigger",
  )!.id;
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges)
    outgoing.set(edge.source, [
      ...(outgoing.get(edge.source) ?? []),
      edge.target,
    ]);
  const reachable = new Set<string>();
  const orderedNodeIds: string[] = [];
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    orderedNodeIds.push(id);
    for (const target of outgoing.get(id) ?? []) visit(target);
  };
  visit(entryNodeId);
  const reachableNodeIds = [...reachable].sort();
  const normalized = JSON.stringify({
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
  });
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return {
    checksum: (hash >>> 0).toString(16).padStart(8, "0"),
    graph: JSON.parse(normalized) as AutomationGraph,
    entryNodeId,
    reachableNodeIds,
    orderedNodeIds,
  };
}

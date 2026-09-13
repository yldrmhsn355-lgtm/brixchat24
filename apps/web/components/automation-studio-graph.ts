export type LinearEdge = { source: string; target: string; handle?: string };
export type LinearReorderPlan =
  | { valid: true; orderedNodeIds: string[] }
  | { valid: false; reason: string };
export type LinearConnectionPlan =
  | {
      valid: true;
      mode: "append" | "insert_after" | "insert_before";
      remove: LinearEdge[];
      add: LinearEdge[];
    }
  | { valid: false; reason: string };

export function analyzeLinearGraph(
  nodeIds: string[],
  edges: LinearEdge[],
  triggerId: string | undefined,
) {
  const outgoing = new Map<string, string>();
  const issues: string[] = [];
  for (const edge of edges) {
    if (outgoing.has(edge.source)) issues.push("multiple_outgoing");
    else outgoing.set(edge.source, edge.target);
  }

  const orderedNodeIds: string[] = [];
  const reachable = new Set<string>();
  let current = triggerId;
  while (current && !reachable.has(current)) {
    reachable.add(current);
    orderedNodeIds.push(current);
    current = outgoing.get(current);
  }
  if (current) issues.push("cycle");

  return {
    orderedNodeIds,
    disconnectedNodeIds: nodeIds.filter((id) => !reachable.has(id)),
    issues,
  };
}

export function planLinearReorder(
  nodeIds: string[],
  edges: LinearEdge[],
  triggerId: string | undefined,
  nodeId: string,
  direction: -1 | 1,
): LinearReorderPlan {
  const analysis = analyzeLinearGraph(nodeIds, edges, triggerId);
  if (
    !triggerId ||
    analysis.issues.length > 0 ||
    analysis.disconnectedNodeIds.length > 0 ||
    edges.length !== Math.max(0, nodeIds.length - 1) ||
    edges.some((edge) => edge.handle)
  )
    return { valid: false, reason: "non_linear_graph" };

  const index = analysis.orderedNodeIds.indexOf(nodeId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= nodeIds.length)
    return { valid: false, reason: "out_of_bounds" };
  if (nodeId === triggerId || analysis.orderedNodeIds[nextIndex] === triggerId)
    return { valid: false, reason: "trigger_locked" };

  const orderedNodeIds = [...analysis.orderedNodeIds];
  const [moving] = orderedNodeIds.splice(index, 1);
  if (!moving) return { valid: false, reason: "missing_node" };
  orderedNodeIds.splice(nextIndex, 0, moving);
  return { valid: true, orderedNodeIds };
}

export function canConnectLinearGraph(
  nodeIds: string[],
  edges: LinearEdge[],
  source: string,
  target: string,
): { valid: true } | { valid: false; reason: string } {
  if (!nodeIds.includes(source) || !nodeIds.includes(target))
    return { valid: false, reason: "missing_endpoint" };
  if (source === target) return { valid: false, reason: "self_link" };
  if (edges.some((edge) => edge.source === source && edge.target === target))
    return { valid: false, reason: "duplicate_edge" };
  if (edges.some((edge) => edge.source === source))
    return { valid: false, reason: "source_occupied" };
  if (edges.some((edge) => edge.target === target))
    return { valid: false, reason: "target_occupied" };

  const outgoing = new Map(edges.map((edge) => [edge.source, edge.target]));
  let current: string | undefined = target;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === source) return { valid: false, reason: "cycle" };
    seen.add(current);
    current = outgoing.get(current);
  }
  return { valid: true };
}

export function planLinearConnection(
  nodeIds: string[],
  edges: LinearEdge[],
  source: string,
  target: string,
): LinearConnectionPlan {
  const direct = canConnectLinearGraph(nodeIds, edges, source, target);
  if (direct.valid)
    return {
      valid: true,
      mode: "append",
      remove: [],
      add: [{ source, target }],
    };

  if (
    direct.reason !== "source_occupied" &&
    direct.reason !== "target_occupied"
  )
    return direct;

  const sourceIncoming = edges.find((edge) => edge.target === source);
  const sourceOutgoing = edges.find((edge) => edge.source === source);
  const targetIncoming = edges.find((edge) => edge.target === target);
  const targetOutgoing = edges.find((edge) => edge.source === target);

  if (sourceOutgoing && !targetIncoming && !targetOutgoing)
    return {
      valid: true,
      mode: "insert_after",
      remove: [sourceOutgoing],
      add: [
        { source, target },
        { source: target, target: sourceOutgoing.target },
      ],
    };

  if (!sourceIncoming && !sourceOutgoing && targetIncoming)
    return {
      valid: true,
      mode: "insert_before",
      remove: [targetIncoming],
      add: [
        { source: targetIncoming.source, target: source },
        { source, target },
      ],
    };

  return direct;
}

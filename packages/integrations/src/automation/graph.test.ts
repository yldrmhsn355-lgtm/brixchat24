import { describe, expect, it } from "vitest";
import {
  compileAutomationGraph,
  validateAutomationGraph,
  type AutomationGraph,
} from "./graph";

const graph: AutomationGraph = {
  nodes: [
    {
      id: "trigger",
      type: "message.received",
      category: "trigger",
      position: { x: 0, y: 0 },
      config: {},
    },
    {
      id: "condition",
      type: "message.content_matched",
      category: "condition",
      position: { x: 0, y: 120 },
      config: {},
    },
    {
      id: "yes",
      type: "add_label",
      category: "action",
      position: { x: -120, y: 260 },
      config: {},
    },
    {
      id: "no",
      type: "end",
      category: "end",
      position: { x: 120, y: 260 },
      config: {},
    },
  ],
  edges: [
    { id: "e1", source: "trigger", target: "condition" },
    { id: "e2", source: "condition", target: "yes", handle: "true" },
    { id: "e3", source: "condition", target: "no", handle: "false" },
  ],
};

describe("automation graph", () => {
  it("requires one trigger and both condition branches", () => {
    expect(validateAutomationGraph(graph)).toEqual([]);
    expect(
      validateAutomationGraph({
        ...graph,
        edges: graph.edges.slice(0, 2),
      }).some((issue) => issue.code === "missing_branch"),
    ).toBe(true);
  });

  it("compiles a normalized immutable definition with a stable checksum", () => {
    const compiled = compileAutomationGraph(graph);
    expect(compiled.entryNodeId).toBe("trigger");
    expect(compiled.reachableNodeIds).toEqual([
      "condition",
      "no",
      "trigger",
      "yes",
    ]);
    expect(
      compileAutomationGraph({ ...graph, nodes: [...graph.nodes].reverse() })
        .checksum,
    ).toBe(compiled.checksum);
  });

  it("validates and compiles a connected linear path in edge order", () => {
    const linear: AutomationGraph = {
      nodes: [graph.nodes[0]!, graph.nodes[1]!, graph.nodes[2]!],
      edges: [
        { id: "linear-1", source: "trigger", target: "condition" },
        { id: "linear-2", source: "condition", target: "yes" },
      ],
    };

    expect(validateAutomationGraph(linear, { mode: "linear" })).toEqual([]);
    expect(
      compileAutomationGraph(linear, { mode: "linear" }).orderedNodeIds,
    ).toEqual(["trigger", "condition", "yes"]);
  });

  it("rejects disconnected nodes, cycles and multiple linear outputs", () => {
    const disconnected: AutomationGraph = {
      nodes: [graph.nodes[0]!, graph.nodes[1]!, graph.nodes[2]!],
      edges: [{ id: "linear-1", source: "trigger", target: "condition" }],
    };
    expect(
      validateAutomationGraph(disconnected, { mode: "linear" }).some(
        (issue) => issue.code === "unreachable_node",
      ),
    ).toBe(true);

    const invalid: AutomationGraph = {
      ...disconnected,
      edges: [
        { id: "linear-1", source: "trigger", target: "condition" },
        { id: "linear-2", source: "trigger", target: "yes" },
        { id: "linear-3", source: "condition", target: "trigger" },
      ],
    };
    const issues = validateAutomationGraph(invalid, { mode: "linear" });
    expect(issues.some((issue) => issue.code === "multiple_outgoing")).toBe(
      true,
    );
    expect(issues.some((issue) => issue.code === "unsupported_cycle")).toBe(
      true,
    );
  });

  it("rejects a condition placed after an action in linear mode", () => {
    const invalidOrder: AutomationGraph = {
      nodes: [graph.nodes[0]!, graph.nodes[1]!, graph.nodes[2]!],
      edges: [
        { id: "linear-1", source: "trigger", target: "yes" },
        { id: "linear-2", source: "yes", target: "condition" },
      ],
    };
    expect(
      validateAutomationGraph(invalidOrder, { mode: "linear" }).some(
        (issue) => issue.code === "invalid_linear_order",
      ),
    ).toBe(true);
  });
});

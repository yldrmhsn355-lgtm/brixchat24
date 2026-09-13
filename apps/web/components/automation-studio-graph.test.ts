import { describe, expect, it } from "vitest";
import {
  analyzeLinearGraph,
  canConnectLinearGraph,
  planLinearConnection,
  planLinearReorder,
} from "./automation-studio-graph";

const nodeIds = ["trigger", "condition", "action"];

describe("Automation Studio linear graph", () => {
  it("orders nodes from the trigger and reports disconnected nodes", () => {
    expect(
      analyzeLinearGraph(
        nodeIds,
        [{ source: "trigger", target: "condition" }],
        "trigger",
      ),
    ).toMatchObject({
      orderedNodeIds: ["trigger", "condition"],
      disconnectedNodeIds: ["action"],
    });
  });

  it("accepts a valid next connection", () => {
    expect(
      canConnectLinearGraph(
        nodeIds,
        [{ source: "trigger", target: "condition" }],
        "condition",
        "action",
      ),
    ).toEqual({ valid: true });
  });

  it("rejects self links, duplicate edges, occupied ports and cycles", () => {
    const edges = [
      { source: "trigger", target: "condition" },
      { source: "condition", target: "action" },
    ];
    expect(
      canConnectLinearGraph(nodeIds, edges, "action", "action").valid,
    ).toBe(false);
    expect(
      canConnectLinearGraph(nodeIds, edges, "trigger", "condition").valid,
    ).toBe(false);
    expect(canConnectLinearGraph(nodeIds, edges, "trigger", "action")).toEqual({
      valid: false,
      reason: "source_occupied",
    });
    expect(canConnectLinearGraph(nodeIds, edges, "action", "trigger")).toEqual({
      valid: false,
      reason: "cycle",
    });
  });

  it("inserts an isolated target after an occupied source", () => {
    expect(
      planLinearConnection(
        ["trigger", "condition", "action", "label"],
        [
          { source: "trigger", target: "condition" },
          { source: "condition", target: "action" },
        ],
        "condition",
        "label",
      ),
    ).toEqual({
      valid: true,
      mode: "insert_after",
      remove: [{ source: "condition", target: "action" }],
      add: [
        { source: "condition", target: "label" },
        { source: "label", target: "action" },
      ],
    });
  });

  it("inserts an isolated source before an occupied target", () => {
    expect(
      planLinearConnection(
        ["trigger", "condition", "action", "label"],
        [
          { source: "trigger", target: "condition" },
          { source: "condition", target: "action" },
        ],
        "label",
        "action",
      ),
    ).toEqual({
      valid: true,
      mode: "insert_before",
      remove: [{ source: "condition", target: "action" }],
      add: [
        { source: "condition", target: "label" },
        { source: "label", target: "action" },
      ],
    });
  });

  it("does not silently move a node that is already part of another chain", () => {
    expect(
      planLinearConnection(
        ["trigger", "condition", "action", "label", "other"],
        [
          { source: "trigger", target: "condition" },
          { source: "condition", target: "action" },
          { source: "label", target: "other" },
        ],
        "condition",
        "label",
      ),
    ).toEqual({ valid: false, reason: "source_occupied" });
  });

  it("reorders a strictly linear flow without moving its trigger", () => {
    const edges = [
      { source: "trigger", target: "condition" },
      { source: "condition", target: "action" },
    ];
    expect(
      planLinearReorder(nodeIds, edges, "trigger", "action", -1),
    ).toEqual({
      valid: true,
      orderedNodeIds: ["trigger", "action", "condition"],
    });
    expect(
      planLinearReorder(nodeIds, edges, "trigger", "condition", -1),
    ).toEqual({ valid: false, reason: "trigger_locked" });
  });

  it("refuses to flatten branches or handled condition edges", () => {
    expect(
      planLinearReorder(
        ["trigger", "condition", "action", "end"],
        [
          { source: "trigger", target: "condition" },
          { source: "condition", target: "action", handle: "true" },
          { source: "condition", target: "end", handle: "false" },
        ],
        "trigger",
        "action",
        -1,
      ),
    ).toEqual({ valid: false, reason: "non_linear_graph" });

    expect(
      planLinearReorder(
        nodeIds,
        [
          { source: "trigger", target: "condition" },
          { source: "condition", target: "action", handle: "true" },
        ],
        "trigger",
        "action",
        -1,
      ),
    ).toEqual({ valid: false, reason: "non_linear_graph" });
  });
});

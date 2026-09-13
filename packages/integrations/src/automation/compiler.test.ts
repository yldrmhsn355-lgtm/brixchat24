import { describe, expect, it } from "vitest";
import {
  compileAutomationDefinition,
  compileLegacyLinearDefinition,
  hydrateCompiledAutomationDefinition,
  type AutomationSourceGraph,
} from "./compiler";
import { parseAutomationNodeContract } from "./contracts";

const policy = {
  retryPolicy: {
    maxAttempts: 5,
    backoffMs: 1_000,
    maxBackoffMs: 300_000,
  },
  timeoutPolicy: { timeoutMs: null },
  errorPolicy: { mode: "fail" as const },
};

const graph: AutomationSourceGraph = {
  nodes: [
    parseAutomationNodeContract({
      id: "trigger",
      type: "message.received",
      version: 1,
      category: "trigger",
      name: "Inbound",
      description: "Inbound trigger",
      position: { x: 0, y: 0 },
      config: {},
      inputPorts: [],
      outputPorts: [{ id: "success", kind: "success", required: true }],
      ...policy,
      uiMetadata: { label: "Mesaj alındı", icon: "message", color: "green" },
      runtimeMetadata: {
        capability: "production",
        handlerKey: "trigger.message.received",
      },
    }),
    parseAutomationNodeContract({
      id: "condition",
      type: "message.content",
      version: 1,
      category: "condition",
      name: "Contains",
      description: "Content condition",
      position: { x: 0, y: 120 },
      config: { operator: "contains", value: "implant" },
      inputPorts: [{ id: "input", kind: "control", required: true }],
      outputPorts: [
        { id: "true", kind: "true", required: true },
        { id: "false", kind: "false", required: true },
      ],
      ...policy,
      uiMetadata: { label: "Mesaj içeriği", icon: "split", color: "amber" },
      runtimeMetadata: {
        capability: "production",
        handlerKey: "condition.message.content",
      },
    }),
    parseAutomationNodeContract({
      id: "success",
      type: "end.success",
      version: 1,
      category: "control",
      name: "Success",
      description: "Complete execution",
      position: { x: -120, y: 260 },
      config: {},
      inputPorts: [{ id: "input", kind: "control", required: true }],
      outputPorts: [],
      ...policy,
      uiMetadata: { label: "Başarıyla tamamla", icon: "check", color: "green" },
      runtimeMetadata: {
        capability: "production",
        handlerKey: "control.end.success",
      },
    }),
    parseAutomationNodeContract({
      id: "failure",
      type: "end.failure",
      version: 1,
      category: "control",
      name: "Failure",
      description: "Fail execution",
      position: { x: 120, y: 260 },
      config: {},
      inputPorts: [{ id: "input", kind: "control", required: true }],
      outputPorts: [],
      ...policy,
      uiMetadata: { label: "Hata ile tamamla", icon: "x", color: "red" },
      runtimeMetadata: {
        capability: "production",
        handlerKey: "control.end.failure",
      },
    }),
  ],
  edges: [
    {
      id: "e-trigger",
      source: "trigger",
      sourcePort: "success",
      target: "condition",
      targetPort: "input",
    },
    {
      id: "e-true",
      source: "condition",
      sourcePort: "true",
      target: "success",
      targetPort: "input",
    },
    {
      id: "e-false",
      source: "condition",
      sourcePort: "false",
      target: "failure",
      targetPort: "input",
    },
  ],
};

describe("automation definition compiler", () => {
  it("creates an immutable semantic definition with stable checksum", () => {
    const compiled = compileAutomationDefinition(graph);
    const reordered = compileAutomationDefinition({
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    });
    const moved = compileAutomationDefinition({
      ...graph,
      nodes: graph.nodes.map((node) => ({
        ...node,
        position: { x: node.position.x + 500, y: node.position.y + 300 },
      })),
    });

    expect(compiled.compilerVersion).toBe(1);
    expect(compiled.entryNodeId).toBe("trigger");
    expect(compiled.checksum).toBe(reordered.checksum);
    expect(compiled.checksum).toBe(moved.checksum);
    expect(compiled.adjacency.condition?.true).toEqual(["success"]);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.nodes)).toBe(true);
  });

  it("rejects unknown ports, required empty branches, cycles and unreachable nodes", () => {
    const invalid = {
      ...graph,
      edges: [
        graph.edges[0]!,
        {
          ...graph.edges[1]!,
          sourcePort: "unknown",
          target: "trigger",
          targetPort: "missing",
        },
      ],
    };

    expect(() => compileAutomationDefinition(invalid)).toThrowError(
      /unknown_output_port|required_output_unconnected|unsupported_cycle|unknown_input_port/,
    );
  });

  it("adapts the existing linear rule model into one compiled node definition", () => {
    const compiled = compileLegacyLinearDefinition({
      trigger: { type: "message.received", config: { channelId: null } },
      conditions: [
        { field: "text", operator: "contains", value: "implant" },
        { field: "direction", operator: "equals", value: "inbound" },
      ],
      actions: [
        {
          type: "add_label",
          config: { labelId: "52000000-0000-4000-8000-000000000002" },
        },
      ],
    });

    expect(compiled.adjacency.trigger?.success).toEqual(["condition-1"]);
    expect(compiled.adjacency["condition-1"]?.true).toEqual(["condition-2"]);
    expect(compiled.adjacency["condition-1"]?.false).toEqual(["end-skipped"]);
    expect(compiled.adjacency["condition-2"]?.true).toEqual(["action-1"]);
    expect(compiled.adjacency["action-1"]?.success).toEqual(["end-success"]);
  });

  it("hydrates only checksum-valid compiled definitions", () => {
    const compiled = compileLegacyLinearDefinition({
      trigger: { type: "message.received", config: {} },
      conditions: [],
      actions: [
        {
          type: "add_label",
          config: { labelId: "52000000-0000-4000-8000-000000000002" },
        },
      ],
    });

    expect(hydrateCompiledAutomationDefinition(compiled)).toEqual(compiled);
    expect(() =>
      hydrateCompiledAutomationDefinition({
        ...compiled,
        checksum: "tampered",
      }),
    ).toThrow("automation_compiled_definition_checksum_mismatch");
  });
});

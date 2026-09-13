import { describe, expect, it } from "vitest";
import { compileLegacyLinearDefinition } from "@brixchat/integrations";
import { planCompiledAutomation } from "./automation-plan";

const definition = compileLegacyLinearDefinition({
  trigger: { type: "message.received", config: {} },
  conditions: [{ field: "text", operator: "contains", value: "implant" }],
  actions: [
    {
      type: "add_label",
      config: { labelId: "52000000-0000-4000-8000-000000000002" },
    },
  ],
});

describe("compiled automation planner", () => {
  it("selects action nodes from the matching compiled route", async () => {
    const plan = await planCompiledAutomation(definition, {
      text: "implant randevusu",
    });

    expect(plan.result.status).toBe("completed");
    expect(plan.actions).toEqual([
      expect.objectContaining({ nodeId: "action-1", nodeType: "add_label" }),
    ]);
  });

  it("takes the skipped route without selecting side effects", async () => {
    const plan = await planCompiledAutomation(definition, {
      text: "Genel kontrol",
    });

    expect(plan.result.status).toBe("skipped");
    expect(plan.actions).toEqual([]);
  });

  it("rejects tampered stored definitions", async () => {
    await expect(
      planCompiledAutomation({ ...definition, checksum: "tampered" }, {}),
    ).rejects.toThrow("automation_compiled_definition_checksum_mismatch");
  });
});

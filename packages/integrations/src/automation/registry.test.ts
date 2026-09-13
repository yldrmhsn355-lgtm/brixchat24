import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  AutomationNodeRegistry,
  automationNodeCatalog,
  builtinAutomationNodeRegistry,
  type AutomationNodeDefinition,
} from "./registry";

const definition: AutomationNodeDefinition = {
  type: "message.received",
  version: 1,
  displayName: "Mesaj alındı",
  description: "Canonical inbound message trigger.",
  category: "trigger",
  icon: "message-circle",
  color: "green",
  configSchema: z.object({}).passthrough(),
  inputPorts: [],
  outputPorts: [{ id: "success", kind: "success", required: true }],
  availability: "available",
  runtimeCapability: "production",
  handlerKey: "trigger.message.received",
};

describe("automation node registry", () => {
  it("looks definitions up by type and version and exposes publishable entries", () => {
    const registry = new AutomationNodeRegistry([definition]);

    expect(registry.get("message.received", 1)).toEqual(definition);
    expect(registry.get("message.received", 2)).toBeUndefined();
    expect(registry.listPublishable()).toEqual([definition]);
  });

  it("rejects duplicate keys and excludes definitions without production handlers", () => {
    expect(
      () => new AutomationNodeRegistry([definition, definition]),
    ).toThrowError("automation_registry_duplicate:message.received@1");

    const registry = new AutomationNodeRegistry([
      {
        ...definition,
        type: "wait.duration",
        displayName: "Süre bekle",
        runtimeCapability: "planned",
        handlerKey: null,
      },
    ]);

    expect(registry.listPublishable()).toEqual([]);
  });

  it("publishes only the current executable node package", () => {
    expect(
      builtinAutomationNodeRegistry.get("message.received", 1)
        ?.runtimeCapability,
    ).toBe("production");
    expect(
      builtinAutomationNodeRegistry
        .get("add_label", 1)
        ?.configSchema.safeParse({}).success,
    ).toBe(false);
    expect(
      builtinAutomationNodeRegistry.get("wait.duration", 1)?.runtimeCapability,
    ).toBe("planned");
    expect(
      builtinAutomationNodeRegistry
        .get("update_bitrix_record", 1)
        ?.configSchema.safeParse({
          entityType: "deal",
          stageId: "C8:NEW",
          customFieldId: "UF_CRM_WHATSAPP_STATUS",
          customFieldValue: "unavailable",
        }).success,
    ).toBe(true);
    expect(
      builtinAutomationNodeRegistry
        .get("update_bitrix_record", 1)
        ?.configSchema.safeParse({
          entityType: "lead",
          stageId: "IN_PROCESS",
          customFieldId: "",
        }).success,
    ).toBe(true);
    expect(
      builtinAutomationNodeRegistry
        .get("update_bitrix_record", 1)
        ?.configSchema.safeParse({ entityType: "contact" }).success,
    ).toBe(false);
    expect(
      builtinAutomationNodeRegistry.listPublishable().map((item) => item.type),
    ).toEqual(
      expect.arrayContaining([
        "message.received",
        "message.delivery_failed",
        "group.message.received",
        "group.mentioned",
        "group.keyword_matched",
        "group.participant_added",
        "group.participant_removed",
        "group.participant_promoted",
        "group.participant_demoted",
        "condition.evaluate",
        "add_label",
        "remove_label",
        "assign_user",
        "send_whatsapp_template",
        "send_group_message",
        "create_bitrix_task",
        "update_bitrix_record",
      ]),
    );
  });

  it("serializes schema-driven UI metadata without runtime handler internals", () => {
    const catalog = automationNodeCatalog();
    const addLabel = catalog.find((item) => item.type === "add_label");

    expect(addLabel?.configSchema).toMatchObject({
      type: "object",
      required: ["labelId"],
    });
    expect(addLabel).not.toHaveProperty("handlerKey");
    expect(addLabel?.runtimeCapability).toBe("production");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  compileLegacyLinearDefinition,
  type AutomationNodeContract,
  type CompiledAutomationPlatformDefinition,
} from "@brixchat/integrations";
import {
  createBuiltinAutomationHandlers,
  executeCompiledAutomation,
} from "./automation-engine";

function definition() {
  return compileLegacyLinearDefinition({
    trigger: { type: "message.received", config: {} },
    conditions: [{ field: "text", operator: "contains", value: "implant" }],
    actions: [
      {
        type: "add_label",
        config: { labelId: "52000000-0000-4000-8000-000000000002" },
      },
    ],
  });
}

describe("compiled automation engine", () => {
  it("selects the true branch, invokes an action adapter, and completes", async () => {
    const addLabel = vi.fn(async () => ({
      status: "completed" as const,
      port: "success",
      output: { labelApplied: true },
    }));
    const result = await executeCompiledAutomation({
      definition: definition(),
      input: { text: "İmplant fiyatı" },
      handlers: {
        ...createBuiltinAutomationHandlers(),
        "action.add_label": addLabel,
      },
      dryRun: false,
    });

    expect(result.status).toBe("completed");
    expect(addLabel).toHaveBeenCalledOnce();
    expect(result.steps.map((step) => step.selectedPort)).toEqual([
      "success",
      "true",
      "success",
      null,
    ]);
    expect(result.steps[1]).toMatchObject({
      nodeId: "condition-1",
      output: { matched: true, selectedPort: "true" },
    });
  });

  it("selects the false branch without invoking side effects", async () => {
    const addLabel = vi.fn();
    const result = await executeCompiledAutomation({
      definition: definition(),
      input: { text: "Merhaba" },
      handlers: {
        ...createBuiltinAutomationHandlers(),
        "action.add_label": addLabel,
      },
      dryRun: true,
    });

    expect(result.status).toBe("skipped");
    expect(addLabel).not.toHaveBeenCalled();
    expect(result.steps.map((step) => step.nodeId)).toEqual([
      "trigger",
      "condition-1",
      "end-skipped",
    ]);
  });

  it("fails safely when the compiled step limit is exceeded", async () => {
    const compiled = definition();
    const limited: CompiledAutomationPlatformDefinition = {
      ...compiled,
      limits: { ...compiled.limits, maxSteps: 2 },
    };
    const result = await executeCompiledAutomation({
      definition: limited,
      input: { text: "implant" },
      handlers: {
        ...createBuiltinAutomationHandlers(),
        "action.add_label": async () => ({
          status: "completed",
          port: "success",
          output: {},
        }),
      },
      dryRun: false,
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "automation_step_limit",
    });
  });

  it("matches group keywords with Turkish case normalization and channel scope", () => {
    const handler =
      createBuiltinAutomationHandlers()["trigger.group.keyword_matched"]!;
    const result = handler({
      node: {
        id: "trigger",
        type: "group.keyword_matched",
        version: 1,
        config: {
          keywords: ["İMPLANT", "randevu"],
          matchMode: "any",
          caseSensitive: false,
          channelScope: {
            mode: "selected",
            channelIds: ["channel-1"],
            excludedChannelIds: [],
          },
        },
        inputPorts: [],
        outputPorts: [{ id: "success", kind: "success", required: true }],
        runtimeMetadata: {
          capability: "production",
          handlerKey: "trigger.group.keyword_matched",
        },
      } as unknown as AutomationNodeContract,
      input: {
        isGroup: true,
        channelId: "channel-1",
        text: "implant hakkında bilgi istiyorum",
      },
      dryRun: true,
    });

    expect(result).toMatchObject({
      status: "completed",
      port: "success",
      output: { matched: true, matchedKeywords: ["İMPLANT"] },
    });
  });

  it("matches terminal delivery failures within the configured channel scope", () => {
    const handler =
      createBuiltinAutomationHandlers()["trigger.message.delivery_failed"]!;
    const result = handler({
      node: {
        id: "trigger",
        type: "message.delivery_failed",
        version: 1,
        config: {
          channelScope: {
            mode: "selected",
            channelIds: ["channel-1"],
            excludedChannelIds: [],
          },
        },
        inputPorts: [],
        outputPorts: [{ id: "success", kind: "success", required: true }],
        runtimeMetadata: {
          capability: "production",
          handlerKey: "trigger.message.delivery_failed",
        },
      } as unknown as AutomationNodeContract,
      input: {
        channelId: "channel-1",
        messageId: "message-1",
        errorCode: "recipient_unavailable",
        retryable: false,
        failureCategory: "recipient_unavailable",
        customerRelated: true,
        automationEligible: true,
        metaCode: 131026,
      },
      dryRun: false,
    });

    expect(result).toMatchObject({
      status: "completed",
      port: "success",
      output: {
        matched: true,
        messageId: "message-1",
        errorCode: "recipient_unavailable",
        retryable: false,
        failureCategory: "recipient_unavailable",
        customerRelated: true,
        automationEligible: true,
        metaCode: 131026,
      },
    });
  });

  it("skips selected mention triggers when another participant is tagged", () => {
    const handler =
      createBuiltinAutomationHandlers()["trigger.group.mentioned"]!;
    const result = handler({
      node: {
        id: "trigger",
        type: "group.mentioned",
        version: 1,
        config: {
          mentionMode: "selected",
          mentionedJids: ["905551112233@s.whatsapp.net"],
        },
        inputPorts: [],
        outputPorts: [{ id: "success", kind: "success", required: true }],
        runtimeMetadata: {
          capability: "production",
          handlerKey: "trigger.group.mentioned",
        },
      } as unknown as AutomationNodeContract,
      input: {
        isGroup: true,
        channelId: "channel-1",
        mentionedJids: ["905559998877@s.whatsapp.net"],
      },
      dryRun: true,
    });

    expect(result).toMatchObject({ status: "skipped", port: null });
  });
});

import { describe, expect, it } from "vitest";
import {
  automationNodeContractSchema,
  parseAutomationNodeContract,
} from "./contracts";

const validNode = {
  id: "trigger-1",
  type: "message.received",
  version: 1,
  category: "trigger",
  name: "Inbound message",
  description: "Starts for a canonical inbound message.",
  position: { x: 120, y: 80 },
  config: { channelScope: { mode: "all_current_and_future" } },
  inputPorts: [],
  outputPorts: [{ id: "success", kind: "success", required: true }],
  retryPolicy: {
    maxAttempts: 5,
    backoffMs: 1_000,
    maxBackoffMs: 300_000,
  },
  timeoutPolicy: { timeoutMs: null },
  errorPolicy: { mode: "fail" },
  uiMetadata: {
    label: "Mesaj alındı",
    icon: "message-circle",
    color: "green",
  },
  runtimeMetadata: {
    capability: "production",
    handlerKey: "trigger.message.received",
  },
} as const;

describe("automation node contract", () => {
  it("parses and deeply freezes a complete versioned node", () => {
    const parsed = parseAutomationNodeContract(validNode);

    expect(parsed.type).toBe("message.received");
    expect(parsed.uiMetadata.label).toBe("Mesaj alındı");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.outputPorts)).toBe(true);
    expect(Object.isFrozen(parsed.config)).toBe(true);
  });

  it("rejects duplicate ports and unsupported policy values", () => {
    expect(
      automationNodeContractSchema.safeParse({
        ...validNode,
        outputPorts: [
          { id: "success", kind: "success", required: true },
          { id: "success", kind: "error", required: false },
        ],
      }).success,
    ).toBe(false);

    expect(
      automationNodeContractSchema.safeParse({
        ...validNode,
        errorPolicy: { mode: "ignore" },
      }).success,
    ).toBe(false);
  });
});

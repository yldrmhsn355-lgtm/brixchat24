import { describe, expect, it } from "vitest";
import {
  automationActionCatalog,
  automationConditionFieldCatalog,
  automationOperatorCatalog,
  automationTriggerCatalog,
  isAvailableAutomationAction,
  isKnownAutomationField,
  isKnownAutomationOperator,
  isSupportedAutomationTrigger,
} from "./catalog";

describe("automation catalog", () => {
  it("exposes the currently supported trigger and action contracts", () => {
    expect(isSupportedAutomationTrigger("message.received")).toBe(true);
    expect(isSupportedAutomationTrigger("message.delivery_failed")).toBe(true);
    expect(isSupportedAutomationTrigger("conversation.assigned")).toBe(false);
    expect(isAvailableAutomationAction("add_label")).toBe(true);
    expect(isAvailableAutomationAction("send_group_message")).toBe(true);
    expect(isAvailableAutomationAction("create_bitrix_task")).toBe(true);
    expect(isAvailableAutomationAction("update_bitrix_record")).toBe(true);
    expect(isSupportedAutomationTrigger("group.mentioned")).toBe(true);
    expect(isAvailableAutomationAction("webhook")).toBe(false);
  });

  it("keeps fields and operators centrally discoverable", () => {
    expect(isKnownAutomationField("channelId")).toBe(true);
    expect(isKnownAutomationField("errorCode")).toBe(true);
    expect(isKnownAutomationField("failureCategory")).toBe(true);
    expect(isKnownAutomationField("automationEligible")).toBe(true);
    expect(isKnownAutomationField("unknownField")).toBe(false);
    expect(isKnownAutomationOperator("not_contains")).toBe(true);
    expect(isKnownAutomationOperator("regex")).toBe(false);
    expect(automationTriggerCatalog.length).toBeGreaterThan(4);
    expect(automationConditionFieldCatalog.length).toBeGreaterThan(8);
    expect(automationOperatorCatalog.length).toBeGreaterThan(4);
    expect(automationActionCatalog.length).toBeGreaterThan(4);
  });
});

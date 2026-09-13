import { describe, expect, it } from "vitest";
import {
  automationActionConfigError,
  bitrixDeliveryFailureBlockReason,
  automationFailureDecision,
  automationRetryDelay,
  redactedAutomationError,
} from "./automation-runtime";

describe("automation runtime safety", () => {
  it("uses bounded exponential retry and dead-letters at the attempt limit", () => {
    expect(automationRetryDelay(1)).toBe(1_000);
    expect(automationRetryDelay(4)).toBe(8_000);
    expect(automationRetryDelay(20)).toBe(300_000);
    expect(automationFailureDecision(4, 5)).toEqual({
      status: "retry",
      delayMs: 8_000,
    });
    expect(automationFailureDecision(5, 5)).toEqual({
      status: "dead_letter",
      delayMs: 0,
    });
  });

  it("rejects incomplete executable action configuration", () => {
    expect(automationActionConfigError("assign_user", {})).toBe(
      "automation_user_id_missing",
    );
    expect(
      automationActionConfigError("add_label", {
        labelId: "52000000-0000-4000-8000-000000000002",
      }),
    ).toBeNull();
    expect(
      automationActionConfigError("send_whatsapp_template", {
        templateId: "52000000-0000-4000-8000-000000000002",
      }),
    ).toBe("automation_channel_id_missing");
    expect(automationActionConfigError("send_group_message", {})).toBe(
      "automation_group_message_text_invalid",
    );
    expect(
      automationActionConfigError("send_group_message", {
        text: "Mesajınız alındı.",
        mentionedJids: ["905551112233@s.whatsapp.net"],
      }),
    ).toBeNull();
    expect(
      automationActionConfigError("create_bitrix_task", {
        title: "Grup talebini incele",
        responsibleExternalUserId: "12",
      }),
    ).toBeNull();
    expect(
      automationActionConfigError("update_bitrix_record", {
        entityType: "lead",
        stageId: "IN_PROCESS",
        customFieldId: "UF_CRM_WHATSAPP_STATUS",
        customFieldValue: "unavailable",
      }),
    ).toBeNull();
    expect(
      automationActionConfigError("update_bitrix_record", {
        entityType: "contact",
        stageId: "IN_PROCESS",
      }),
    ).toBe("automation_bitrix_entity_type_invalid");
    expect(
      automationActionConfigError("update_bitrix_record", {
        entityType: "lead",
        stageId: "IN_PROCESS",
        customFieldId: "",
      }),
    ).toBeNull();
    expect(
      automationActionConfigError("update_bitrix_record", {
        entityType: "deal",
      }),
    ).toBe("automation_bitrix_update_target_missing");
  });

  it("redacts arbitrary errors into bounded machine codes", () => {
    expect(
      redactedAutomationError(new Error("Provider 500 / secret value")),
    ).toBe("provider_500_secret_value");
  });

  it("blocks Bitrix CRM mutation for non-customer delivery failures", () => {
    expect(
      bitrixDeliveryFailureBlockReason("message.delivery_failed", {
        failureCategory: "payment",
        automationEligible: false,
      }),
    ).toBe("automation_bitrix_delivery_failure_not_customer_related");
    expect(
      bitrixDeliveryFailureBlockReason("message.delivery_failed", {
        failureCategory: "recipient_unavailable",
        automationEligible: true,
      }),
    ).toBeNull();
    expect(bitrixDeliveryFailureBlockReason("message.received", {})).toBeNull();
  });
});

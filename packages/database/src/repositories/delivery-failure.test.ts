import { describe, expect, it } from "vitest";
import { classifyDeliveryFailure } from "./delivery-failure";

describe("delivery failure classification", () => {
  it.each([
    [131026, "recipient_unavailable"],
    [131050, "recipient_opted_out"],
    [130472, "provider_experiment"],
  ] as const)(
    "allows CRM automation for customer-related Meta code %s",
    (code, category) => {
      expect(
        classifyDeliveryFailure({ payload: { errors: [{ code }] } }),
      ).toMatchObject({
        errorCode: `META_${code}`,
        category,
        customerRelated: true,
        automationEligible: true,
        metaCode: code,
      });
    },
  );

  it.each([
    [131042, "payment"],
    [131047, "service_window"],
    [131053, "media"],
    [131056, "rate_limit"],
  ] as const)(
    "blocks CRM mutation for business or technical Meta code %s",
    (code, category) => {
      expect(
        classifyDeliveryFailure({ errorCode: `META_${code}` }),
      ).toMatchObject({
        category,
        customerRelated: false,
        automationEligible: false,
        metaCode: code,
      });
    },
  );

  it("recognizes permanent WhatsApp Web recipient failures", () => {
    expect(
      classifyDeliveryFailure({
        errorCode: "WHATSAPP_WEB_RECIPIENT_INVALID",
      }),
    ).toMatchObject({
      category: "recipient_unavailable",
      customerRelated: true,
      automationEligible: true,
    });
  });

  it("defaults unknown and channel failures to CRM-safe blocking", () => {
    expect(
      classifyDeliveryFailure({ errorCode: "CHANNEL_PERMISSION_DENIED" }),
    ).toMatchObject({
      category: "channel_configuration",
      automationEligible: false,
    });
    expect(
      classifyDeliveryFailure({ errorCode: "PROVIDER_UNKNOWN" }),
    ).toMatchObject({ category: "technical", automationEligible: false });
  });
});

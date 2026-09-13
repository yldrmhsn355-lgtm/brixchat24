import { describe, expect, it } from "vitest";
import { resolveOpenChannelsAutoCrmSettings } from "./auto-crm";

const channel = {
  mode: "lead" as const,
  sourceId: "WEB",
  responsibleExternalUserId: "7",
  pipelineId: "3",
  stageId: "NEW",
};

describe("resolveOpenChannelsAutoCrmSettings", () => {
  it("preserves the channel policy for inbound messages", () => {
    expect(
      resolveOpenChannelsAutoCrmSettings({
        direction: "inbound",
        channel,
        userPolicy: { mode: "disabled", sourceId: "CALL" },
        mappedExternalUserId: "42",
      }),
    ).toBe(channel);
  });

  it("uses the mapped operator policy for outbound messages", () => {
    expect(
      resolveOpenChannelsAutoCrmSettings({
        direction: "outbound",
        channel,
        userPolicy: { mode: "contact_and_deal", sourceId: "CALL" },
        mappedExternalUserId: "42",
      }),
    ).toEqual({
      mode: "contact_and_deal",
      sourceId: "CALL",
      responsibleExternalUserId: "42",
      pipelineId: "3",
      stageId: "NEW",
    });
  });

  it("falls back to the channel policy when the user inherits", () => {
    expect(
      resolveOpenChannelsAutoCrmSettings({
        direction: "outbound",
        channel,
        userPolicy: { mode: "inherit" },
        mappedExternalUserId: "42",
      }),
    ).toBe(channel);
  });
});

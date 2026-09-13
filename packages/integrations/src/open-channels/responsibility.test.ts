import { describe, expect, it } from "vitest";
import {
  resolveLineQueueResponsibleExternalUserId,
  resolveOpenChannelsLeadResponsibleOverride,
} from "./responsibility";

describe("Open Channels responsibility policy", () => {
  it("uses the only Bitrix line queue operator instead of a stale request", () => {
    expect(resolveLineQueueResponsibleExternalUserId(["28"], "32")).toBe("28");
  });

  it("accepts an explicit operator only when a line has multiple queue members", () => {
    expect(resolveLineQueueResponsibleExternalUserId(["28", "32"], "32")).toBe(
      "32",
    );
    expect(
      resolveLineQueueResponsibleExternalUserId(["28", "32"], "99"),
    ).toBeNull();
  });

  it("does not override responsibility for a Bitrix-managed session Lead", () => {
    expect(
      resolveOpenChannelsLeadResponsibleOverride({
        ownership: "bitrix_open_channel",
        configuredExternalUserId: "32",
      }),
    ).toBeNull();
  });

  it("does not turn a line queue operator into the direct CRM fallback owner", () => {
    expect(
      resolveOpenChannelsLeadResponsibleOverride({
        ownership: "direct_crm",
        configuredExternalUserId: "28",
      }),
    ).toBeNull();
  });
});

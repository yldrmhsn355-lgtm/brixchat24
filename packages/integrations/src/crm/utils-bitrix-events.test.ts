import { describe, expect, it } from "vitest";
import { bitrixAuthPayload, bitrixEventEntityReference } from "./utils";

describe("Bitrix event payload helpers", () => {
  it("normalizes form-encoded install auth fields", () => {
    expect(
      bitrixAuthPayload({
        "auth[access_token]": "access",
        "auth[refresh_token]": "refresh",
        "auth[application_token]": "application",
        "auth[domain]": "portal.bitrix24.com.tr",
        "auth[member_id]": "member",
      }),
    ).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      applicationToken: "application",
      domain: "portal.bitrix24.com.tr",
      memberId: "member",
    });
  });

  it("extracts the CRM entity from nested and form-encoded update events", () => {
    expect(
      bitrixEventEntityReference("ONCRMDEALUPDATE", {
        data: { FIELDS: { ID: "42" } },
      }),
    ).toEqual({ entityType: "deal", externalId: "42" });
    expect(
      bitrixEventEntityReference("ONCRMCONTACTUPDATE", {
        "data[FIELDS][ID]": "7",
      }),
    ).toEqual({ entityType: "contact", externalId: "7" });
  });
});

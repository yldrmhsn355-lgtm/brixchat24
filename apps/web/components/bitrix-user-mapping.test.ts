import { describe, expect, it } from "vitest";
import {
  bitrixUserDisplayName,
  bitrixUserEmail,
  bitrixUserCrmPolicy,
  buildBitrixUserMappingPayload,
} from "./bitrix-user-mapping";

describe("Bitrix user mapping presentation", () => {
  const rows = [
    {
      external_user_id: "42",
      external_snapshot: { name: "Bitrix Agent", email: "agent@example.test" },
      local_user_id: null,
      active: true,
    },
  ];

  it("reads the external identity from the synchronized snapshot", () => {
    expect(bitrixUserDisplayName(rows[0]!)).toBe("Bitrix Agent");
    expect(bitrixUserEmail(rows[0]!)).toBe("agent@example.test");
    expect(bitrixUserCrmPolicy(rows[0]!)).toEqual({
      mode: "inherit",
      sourceId: "",
    });
  });

  it("builds a nullable local-user mapping payload", () => {
    expect(
      buildBitrixUserMappingPayload(rows, { "42": "local-user-id" }),
    ).toEqual({
      mappings: [
        {
          externalUserId: "42",
          localUserId: "local-user-id",
          externalSnapshot: {
            name: "Bitrix Agent",
            email: "agent@example.test",
          },
          active: true,
          crmPolicy: { mode: "inherit" },
        },
      ],
    });
    expect(
      buildBitrixUserMappingPayload(rows, { "42": "" }).mappings[0]
        ?.localUserId,
    ).toBeNull();
  });

  it("normalizes an operator CRM policy", () => {
    expect(
      buildBitrixUserMappingPayload(
        rows,
        { "42": "local-user-id" },
        { "42": { mode: "lead", sourceId: "  CALL " } },
      ).mappings[0]?.crmPolicy,
    ).toEqual({ mode: "lead", sourceId: "CALL" });
  });
});

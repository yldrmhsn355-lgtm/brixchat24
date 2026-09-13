import { describe, expect, it } from "vitest";
import { CrmRepository } from "./crm";

interface QueryCall {
  text: string;
  values: unknown[];
}

type StubSql = ((first: unknown, ...values: unknown[]) => unknown) & {
  begin: (
    callback: (transaction: StubSql) => Promise<unknown>,
  ) => Promise<unknown>;
  json: (value: unknown) => unknown;
};

function createSqlStub(responses: unknown[][]) {
  const calls: QueryCall[] = [];
  const sql = ((first: unknown, ...values: unknown[]) => {
    if (
      Array.isArray(first) &&
      Object.prototype.hasOwnProperty.call(first, "raw")
    ) {
      calls.push({ text: (first as string[]).join("?"), values });
      return Promise.resolve(responses.shift() ?? []);
    }
    return { values: first };
  }) as StubSql;
  sql.begin = async (callback) => callback(sql);
  sql.json = (value) => value;
  return { sql, calls };
}

describe("CrmRepository.replaceUserMappings", () => {
  it("validates tenant membership and clears submitted assignments before swapping", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const connectionId = "00000000-0000-4000-8000-000000000002";
    const firstUserId = "00000000-0000-4000-8000-000000000003";
    const secondUserId = "00000000-0000-4000-8000-000000000004";
    const { sql, calls } = createSqlStub([
      [{ id: connectionId }],
      [{ count: 2 }],
      [],
      [],
      [],
    ]);

    const updated = await new CrmRepository(sql as never).replaceUserMappings(
      organizationId,
      connectionId,
      [
        {
          externalUserId: "41",
          localUserId: secondUserId,
          externalSnapshot: { name: "First" },
          active: true,
          crmPolicy: { mode: "lead", sourceId: "CALL" },
        },
        {
          externalUserId: "42",
          localUserId: firstUserId,
          externalSnapshot: { name: "Second" },
          active: true,
          crmPolicy: { mode: "inherit" },
        },
      ],
    );

    expect(updated).toBe(2);
    expect(calls[0]?.text).toContain("provider='bitrix24'");
    expect(calls[1]?.text).toContain("organization_members");
    expect(calls[2]?.text).toContain("SET local_user_id=NULL");
    expect(calls[3]?.text).toContain("INSERT INTO crm_user_mappings");
    expect(calls[3]?.text).toContain("crm_policy");
    expect(calls[4]?.text).toContain("INSERT INTO crm_user_mappings");
    expect(calls.every((call) => call.values.includes(organizationId))).toBe(
      true,
    );
  });

  it("rejects a local user outside the active organization membership", async () => {
    const { sql } = createSqlStub([[{ id: "connection" }], [{ count: 0 }]]);
    await expect(
      new CrmRepository(sql as never).replaceUserMappings("org", "connection", [
        {
          externalUserId: "42",
          localUserId: "00000000-0000-4000-8000-000000000004",
          externalSnapshot: {},
          active: true,
          crmPolicy: { mode: "inherit" },
        },
      ]),
    ).rejects.toThrow("mapping_local_user_invalid");
  });
});

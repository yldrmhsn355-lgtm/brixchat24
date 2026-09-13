export type BitrixUserMappingRow = Record<string, unknown>;
export type BitrixUserCrmPolicy = {
  mode: "inherit" | "disabled" | "lead" | "contact_and_deal";
  sourceId: string;
};

export function bitrixUserDisplayName(row: BitrixUserMappingRow): string {
  const snapshot = isRecord(row.external_snapshot) ? row.external_snapshot : {};
  return String(snapshot.name ?? row.external_user_id ?? "Bitrix kullanıcısı");
}

export function bitrixUserEmail(row: BitrixUserMappingRow): string {
  const snapshot = isRecord(row.external_snapshot) ? row.external_snapshot : {};
  return String(snapshot.email ?? "");
}

export function bitrixUserCrmPolicy(
  row: BitrixUserMappingRow,
): BitrixUserCrmPolicy {
  const policy = isRecord(row.crm_policy) ? row.crm_policy : {};
  const mode = ["disabled", "lead", "contact_and_deal"].includes(
    String(policy.mode),
  )
    ? (String(policy.mode) as BitrixUserCrmPolicy["mode"])
    : "inherit";
  return { mode, sourceId: String(policy.sourceId ?? "") };
}

export function buildBitrixUserMappingPayload(
  rows: BitrixUserMappingRow[],
  selections: Record<string, string>,
  policies: Record<string, BitrixUserCrmPolicy> = {},
) {
  return {
    mappings: rows.map((row) => {
      const externalUserId = String(row.external_user_id ?? "");
      return {
        externalUserId,
        localUserId: selections[externalUserId] || null,
        externalSnapshot: isRecord(row.external_snapshot)
          ? row.external_snapshot
          : {},
        active: row.active !== false,
        crmPolicy: {
          mode: policies[externalUserId]?.mode ?? "inherit",
          ...(policies[externalUserId]?.sourceId.trim()
            ? { sourceId: policies[externalUserId].sourceId.trim() }
            : {}),
        },
      };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const LABEL_MANAGER_ROLES = new Set(["owner", "admin", "team_lead"]);
const LABEL_WORKSPACE_CREATOR_ROLES = new Set(["owner", "admin"]);

export function canManageLabels(role: string | null | undefined): boolean {
  return Boolean(role && LABEL_MANAGER_ROLES.has(role));
}

export function canCreateWorkspaceLabels(
  role: string | null | undefined,
): boolean {
  return Boolean(role && LABEL_WORKSPACE_CREATOR_ROLES.has(role));
}

export function labelTextColor(background: string): "#111827" | "#ffffff" {
  const value = background.replace("#", "");
  if (!/^[\da-f]{6}$/i.test(value)) return "#111827";
  const channels = [0, 2, 4].map((index) => {
    const channel = Number.parseInt(value.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  const darkContrast = (luminance + 0.05) / 0.05;
  const lightContrast = 1.05 / (luminance + 0.05);
  return darkContrast >= lightContrast ? "#111827" : "#ffffff";
}

export function normalizeLabelName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("tr-TR");
}

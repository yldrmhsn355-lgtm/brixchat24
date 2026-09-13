export function normalizeTemplateName(value: string) {
  return value
    .trim()
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function variablePositions(body: string) {
  return [
    ...new Set(
      [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1])),
    ),
  ].sort((left, right) => left - right);
}

export function readableLanguage(code: string) {
  try {
    return new Intl.DisplayNames(["tr"], { type: "language" }).of(
      code.replace("_", "-"),
    ) ?? code;
  } catch {
    return code;
  }
}

export const statusLabels: Record<string, string> = {
  approved: "Onaylandı",
  pending: "İncelemede",
  in_review: "İncelemede",
  rejected: "Reddedildi",
  paused: "Duraklatıldı",
  disabled: "Devre dışı",
  draft: "Taslak",
  archived: "Arşivlendi",
};

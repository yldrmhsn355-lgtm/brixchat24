export type AiStateRow = {
  status: "active" | "paused" | "disabled" | null;
  human_takeover_at: string | null;
  /**
   * Null when the channel has no assigned agent; a null STATUS however only
   * means no ai_conversation_settings row exists yet, which is the default
   * "active" state for an assigned agent.
   */
  agent_id?: string | null;
};

export type AiStateKind = "active" | "paused" | "takeover";

const TAKEOVER_WINDOW_MS = 24 * 60 * 60 * 1000;

export const AI_STATE_LABELS: Record<AiStateKind, string> = {
  active: "AI Aktif",
  paused: "AI Duraklatıldı",
  takeover: "İnsan Devraldı",
};

export function aiStateKind(
  state: AiStateRow | null,
  now = new Date(),
): AiStateKind | null {
  if (!state) return null;
  if (state.agent_id === null) return null;
  if (state.status === "active") return "active";
  const takeoverAt = state.human_takeover_at
    ? new Date(state.human_takeover_at).getTime()
    : null;
  if (takeoverAt !== null && now.getTime() - takeoverAt <= TAKEOVER_WINDOW_MS)
    return "takeover";
  if (state.status === "paused") return "paused";
  if (state.status === null) return "active";
  return null;
}

export function aiStateLabel(
  state: AiStateRow | null,
  now = new Date(),
): string | null {
  const kind = aiStateKind(state, now);
  return kind ? AI_STATE_LABELS[kind] : null;
}

const AI_ERROR_MESSAGES: Record<string, string> = {
  ai_disabled: "Bu konuşma için AI yanıtları devre dışı.",
  ai_agent_not_assigned: "Bu kanala atanmış yayınlanmış bir AI ajanı yok.",
  no_customer_message: "Yanıtlanacak bir müşteri mesajı bulunamadı.",
  ai_generation_failed: "AI yanıtı oluşturulamadı. Lütfen tekrar deneyin.",
  ai_message_window_closed:
    "24 saatlik mesaj penceresi kapandığı için taslak gönderilemedi.",
  ai_run_already_sent: "Bu AI taslağı zaten gönderilmiş.",
};

export function mapAiErrorMessage(code: string | null | undefined): string {
  return (
    (code ? AI_ERROR_MESSAGES[code] : undefined) ??
    "AI isteği başarısız oldu. Lütfen tekrar deneyin."
  );
}

export function shouldEmitEditedFeedback(
  original: string,
  sent: string,
): boolean {
  return original.trim() !== sent.trim();
}

export function formatConfidence(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  return `%${Math.round(value * 100)}`;
}

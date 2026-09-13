import { describe, expect, it } from "vitest";
import {
  aiStateKind,
  aiStateLabel,
  formatConfidence,
  mapAiErrorMessage,
  shouldEmitEditedFeedback,
} from "./ai-reply";

const now = new Date("2026-07-25T12:00:00+03:00");

describe("ai reply helpers", () => {
  it("labels the assigned agent state in Turkish", () => {
    expect(
      aiStateLabel({ status: "active", human_takeover_at: null }, now),
    ).toBe("AI Aktif");
    expect(
      aiStateLabel({ status: "paused", human_takeover_at: null }, now),
    ).toBe("AI Duraklatıldı");
    expect(aiStateLabel(null, now)).toBeNull();
    expect(
      aiStateLabel({ status: "disabled", human_takeover_at: null }, now),
    ).toBeNull();
  });

  it("treats a missing settings row as active when an agent is assigned", () => {
    // No ai_conversation_settings row yet: status null is the default state
    // of a freshly assigned agent — the chip must show, not hide.
    expect(
      aiStateLabel(
        { status: null, human_takeover_at: null, agent_id: "agent-1" },
        now,
      ),
    ).toBe("AI Aktif");
    expect(
      aiStateKind({ status: null, human_takeover_at: null }, now),
    ).toBe("active");
    // Explicitly no agent on the channel: nothing to show.
    expect(
      aiStateKind(
        { status: null, human_takeover_at: null, agent_id: null },
        now,
      ),
    ).toBeNull();
  });

  it("marks a recent human takeover but keeps active agents active", () => {
    expect(
      aiStateKind(
        { status: "paused", human_takeover_at: "2026-07-25T10:00:00+03:00" },
        now,
      ),
    ).toBe("takeover");
    expect(
      aiStateKind(
        { status: null, human_takeover_at: "2026-07-25T10:00:00+03:00" },
        now,
      ),
    ).toBe("takeover");
    expect(
      aiStateKind(
        { status: "paused", human_takeover_at: "2026-07-20T10:00:00+03:00" },
        now,
      ),
    ).toBe("paused");
    expect(
      aiStateKind(
        { status: "active", human_takeover_at: "2026-07-25T10:00:00+03:00" },
        now,
      ),
    ).toBe("active");
  });

  it("maps known AI error codes to Turkish messages with a fallback", () => {
    expect(mapAiErrorMessage("ai_agent_not_assigned")).toBe(
      "Bu kanala atanmış yayınlanmış bir AI ajanı yok.",
    );
    expect(mapAiErrorMessage("ai_message_window_closed")).toContain(
      "24 saatlik",
    );
    expect(mapAiErrorMessage("unknown_code")).toBe(
      "AI isteği başarısız oldu. Lütfen tekrar deneyin.",
    );
    expect(mapAiErrorMessage(null)).toBe(
      "AI isteği başarısız oldu. Lütfen tekrar deneyin.",
    );
  });

  it("emits edited feedback only when the sent text differs after trimming", () => {
    expect(shouldEmitEditedFeedback("Merhaba!", "Merhaba!")).toBe(false);
    expect(shouldEmitEditedFeedback("Merhaba!", "  Merhaba!  \n")).toBe(false);
    expect(shouldEmitEditedFeedback("Merhaba!", "Merhaba, nasılsınız?")).toBe(
      true,
    );
  });

  it("formats confidence ratios as percentages", () => {
    expect(formatConfidence(0.87)).toBe("%87");
    expect(formatConfidence(0.999)).toBe("%100");
    expect(formatConfidence(0)).toBe("%0");
    expect(formatConfidence(null)).toBe("");
    expect(formatConfidence(undefined)).toBe("");
  });
});

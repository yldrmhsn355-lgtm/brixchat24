import { describe, expect, it } from "vitest";
import {
  formatAttachmentSize,
  formatAudioTime,
  nextAudioPlaybackRate,
  shouldSubmitComposer,
} from "./message-presentation";

describe("message presentation helpers", () => {
  it("formats voice durations consistently", () => {
    expect(formatAudioTime(0)).toBe("0:00");
    expect(formatAudioTime(65.9)).toBe("1:05");
    expect(formatAudioTime(Number.NaN)).toBe("0:00");
  });

  it("uses Enter to send and Shift+Enter for a new line", () => {
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: false })).toBe(true);
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: true })).toBe(false);
    expect(
      shouldSubmitComposer({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
      }),
    ).toBe(false);
  });

  it("formats attachment sizes for compact metadata", () => {
    expect(formatAttachmentSize(0)).toBe("");
    expect(formatAttachmentSize(2048)).toBe("2 KB");
    expect(formatAttachmentSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("cycles through professional voice playback speeds", () => {
    expect(nextAudioPlaybackRate(1)).toBe(1.5);
    expect(nextAudioPlaybackRate(1.5)).toBe(2);
    expect(nextAudioPlaybackRate(2)).toBe(1);
  });
});

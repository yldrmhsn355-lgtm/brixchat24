import { describe, expect, it } from "vitest";
import { isAttachmentDownloadable } from "./attachment-safety";

describe("inbox attachment safety", () => {
  it("enables attachment actions only for stored and clean media", () => {
    expect(
      isAttachmentDownloadable({ status: "stored", scanStatus: "clean" }),
    ).toBe(true);
    expect(
      isAttachmentDownloadable({ status: "stored", scanStatus: "failed" }),
    ).toBe(false);
    expect(
      isAttachmentDownloadable({ status: "stored", scanStatus: "infected" }),
    ).toBe(false);
    expect(
      isAttachmentDownloadable({ status: "pending", scanStatus: "clean" }),
    ).toBe(false);
  });
});

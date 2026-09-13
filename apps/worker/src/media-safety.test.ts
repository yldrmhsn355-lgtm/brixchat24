import { describe, expect, it } from "vitest";
import { MediaScanError } from "@brixchat/integrations";
import {
  mediaCleanupRequired,
  mediaObjectCleanupFailureDisposition,
  mediaProcessingFailureDisposition,
  mediaStoredClean,
  outboundMediaNeedsCleanAttachment,
} from "./media-safety";

describe("worker media safety", () => {
  it("cleans persisted orphan keys even after a manual retry changes status", () => {
    expect(
      mediaCleanupRequired({
        storageKey: null,
        lastErrorCode: "MEDIA_OBJECT_CLEANUP_FAILED",
        cleanupKeys: ["org/orphan", "org/orphan.thumbnail.webp"],
      }),
    ).toBe(true);
    expect(
      mediaCleanupRequired({
        storageKey: "org/clean",
        lastErrorCode: "MEDIA_PUBLISH_FAILED",
      }),
    ).toBe(false);
  });

  it("resumes a stored clean attachment without replacing its object", () => {
    expect(
      mediaStoredClean({
        storageKey: "org/clean",
        processingStatus: "stored",
        scanStatus: "clean",
      }),
    ).toBe(true);
    expect(
      mediaStoredClean({
        storageKey: "org/not-clean",
        processingStatus: "stored",
        scanStatus: "failed",
      }),
    ).toBe(false);
  });

  it("waits instead of sending an attachment message as filename text", () => {
    expect(
      outboundMediaNeedsCleanAttachment({
        metadata: { attachment: true },
        attachment: null,
      }),
    ).toBe(true);
    expect(
      outboundMediaNeedsCleanAttachment({
        metadata: { attachment: true },
        attachment: { storageKey: "clean-object" },
      }),
    ).toBe(false);
  });

  it("retries failed scans with MEDIA_SCAN_FAILED", () => {
    expect(
      mediaProcessingFailureDisposition(
        new Error("MEDIA_SCAN_FAILED"),
        1,
        5,
      ),
    ).toEqual({
      code: "MEDIA_SCAN_FAILED",
      dead: false,
      scanStatus: "failed",
      cleanupKey: null,
    });
  });

  it("dead-letters infected scans immediately", () => {
    expect(
      mediaProcessingFailureDisposition(new Error("MEDIA_INFECTED"), 1, 5),
    ).toEqual({
      code: "MEDIA_INFECTED",
      dead: true,
      scanStatus: "infected",
      cleanupKey: null,
    });
  });

  it("retries infected media until its rejected object is cleaned up", () => {
    expect(
      mediaProcessingFailureDisposition(
        new MediaScanError("infected", true, "org/orphan"),
        1,
        5,
      ),
    ).toEqual({
      code: "MEDIA_SCAN_CLEANUP_FAILED",
      dead: false,
      scanStatus: "infected",
      cleanupKey: "org/orphan",
    });
  });

  it("keeps a post-scan object traceable when cleanup fails", () => {
    const failure = mediaProcessingFailureDisposition(
      new Error("MEDIA_DATABASE_UPDATE_FAILED"),
      1,
      5,
    );

    expect(
      mediaObjectCleanupFailureDisposition(failure, "org/orphan", 1, 5),
    ).toEqual({
      code: "MEDIA_OBJECT_CLEANUP_FAILED",
      dead: false,
      scanStatus: null,
      cleanupKey: "org/orphan",
    });
  });
});

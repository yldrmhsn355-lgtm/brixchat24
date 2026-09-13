import { describe, expect, it } from "vitest";
import { bitrixTimelineFilename } from "./bitrix-timeline-attachment";

describe("bitrixTimelineFilename", () => {
  it("adds a jpg extension to extensionless WhatsApp JPEG filenames", () => {
    expect(
      bitrixTimelineFilename(
        "image-195613e0-9960-4f27-86b3-b650a2ad5316",
        "image/jpeg",
      ),
    ).toBe("image-195613e0-9960-4f27-86b3-b650a2ad5316.jpg");
  });

  it("preserves an existing extension", () => {
    expect(bitrixTimelineFilename("photo.jpeg", "image/jpeg")).toBe(
      "photo.jpeg",
    );
  });

  it("uses a safe fallback for unknown MIME types", () => {
    expect(bitrixTimelineFilename("attachment", "application/x-custom")).toBe(
      "attachment.bin",
    );
  });
});

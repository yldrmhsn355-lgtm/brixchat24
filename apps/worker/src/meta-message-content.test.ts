import { describe, expect, it } from "vitest";
import { metaMessageContent } from "./meta-message-content";

describe("metaMessageContent", () => {
  it("preserves text and media captions for inbox previews", () => {
    expect(
      metaMessageContent({ type: "text", text: { body: "  Merhaba  " } }),
    ).toBe("Merhaba");
    expect(
      metaMessageContent({
        type: "image",
        image: { caption: "Tedavi planı" },
      }),
    ).toBe("Tedavi planı");
    expect(
      metaMessageContent({
        type: "document",
        document: { filename: "plan.pdf" },
      }),
    ).toBe("plan.pdf");
  });

  it("normalizes structured Meta replies into useful inbox text", () => {
    expect(
      metaMessageContent({
        type: "interactive",
        interactive: { button_reply: { title: "Randevu al" } },
      }),
    ).toBe("Randevu al");
    expect(
      metaMessageContent({
        type: "contacts",
        contacts: [{ name: { formatted_name: "Ayşe Yılmaz" } }],
      }),
    ).toBe("Ayşe Yılmaz");
    expect(
      metaMessageContent({
        type: "location",
        location: { name: "Brix Dental Group" },
      }),
    ).toBe("Brix Dental Group");
  });

  it("keeps explicit placeholders when Meta supplies no display text", () => {
    expect(
      metaMessageContent({ type: "video", video: { id: "media-1" } }),
    ).toBe("[video]");
    expect(metaMessageContent({ type: "reaction", reaction: {} })).toBe(
      "[reaction]",
    );
  });
});

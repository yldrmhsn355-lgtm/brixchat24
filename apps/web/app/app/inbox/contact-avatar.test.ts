import { describe, expect, it } from "vitest";
import { contactAvatarStyle } from "./contact-avatar";

describe("contact profile picture", () => {
  it("uses a safe stored WhatsApp profile picture", () => {
    const style = contactAvatarStyle("https://cdn.example.test/contact.jpg");

    expect(style.backgroundImage).toContain(
      "https://cdn.example.test/contact.jpg",
    );
  });

  it("does not manufacture an image when no profile picture exists", () => {
    expect(contactAvatarStyle(null)).toEqual({});
  });

  it("rejects unsafe picture protocols", () => {
    expect(contactAvatarStyle("javascript:alert(1)")).toEqual({});
  });
});

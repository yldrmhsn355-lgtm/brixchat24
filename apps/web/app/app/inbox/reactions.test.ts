import { describe, expect, it } from "vitest";
import { REACTION_EMOJIS } from "./reactions";

describe("message reactions", () => {
  it("keeps the WhatsApp reaction choices as valid Unicode", () => {
    expect(REACTION_EMOJIS).toEqual([
      "\u{1F44D}",
      "\u2764\uFE0F",
      "\u{1F602}",
      "\u{1F62E}",
      "\u{1F622}",
      "\u{1F64F}",
    ]);
    expect(REACTION_EMOJIS.join("")).not.toContain("\uFFFD");
  });
});

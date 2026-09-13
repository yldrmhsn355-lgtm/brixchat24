import { describe, expect, it } from "vitest";
import {
  insertQuickReplyAtCursor,
  normalizeShortcut,
  parseCsvRecords,
  unresolvedVariables,
} from "./quick-reply-utils";

describe("quick reply composer utilities", () => {
  it("normalizes slash shortcuts and Turkish characters", () => {
    expect(normalizeShortcut("/Fotoğraf İsteği")).toBe("fotograf_istegi");
  });

  it("replaces only the active slash token and preserves the draft", () => {
    expect(
      insertQuickReplyAtCursor(
        "Ön bilgi /wel sonra",
        "Merhaba",
        13,
        13,
      ),
    ).toEqual({ value: "Ön bilgi Merhaba sonra", cursor: 16 });
  });

  it("finds unresolved variables without duplicates", () => {
    expect(
      unresolvedVariables(
        "Merhaba {{contact.first_name}} {{ contact.first_name }}",
      ),
    ).toEqual(["contact.first_name"]);
  });

  it("parses quoted CSV fields containing commas and newlines", () => {
    expect(
      parseCsvRecords(
        'title,shortcut,content\r\n"Karşılama","/merhaba","Merhaba,\\nsize nasıl yardımcı olabilirim?"',
      ),
    ).toEqual([
      {
        title: "Karşılama",
        shortcut: "/merhaba",
        content: "Merhaba,\\nsize nasıl yardımcı olabilirim?",
      },
    ]);
  });
});

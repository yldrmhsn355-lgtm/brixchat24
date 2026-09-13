import { describe, expect, it } from "vitest";
import { evaluateCondition, normalizeAutomationText } from "./index";

describe("automation condition text normalization", () => {
  it("matches Turkish dotted-I, Unicode and repeated whitespace deterministically", () => {
    expect(normalizeAutomationText("  İMPLANT   FİYATI ")).toBe("implant fiyatı");
    expect(
      evaluateCondition(
        { field: "text", operator: "contains", value: "implant fiyatı" },
        { text: "İmplant   fiyatı öğrenebilir miyim?" },
      ),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  normalizeTemplateName,
  readableLanguage,
  variablePositions,
} from "./template-center-utils";

describe("template center presentation helpers", () => {
  it("shows the exact normalized provider name", () => {
    expect(normalizeTemplateName("İlk Görüşme / Planı")).toBe(
      "ilk_gorusme_plani",
    );
  });
  it("extracts ordered unique variables", () => {
    expect(variablePositions("{{2}} {{1}} {{2}}")).toEqual([1, 2]);
  });
  it("returns a language label without throwing on provider codes", () => {
    expect(readableLanguage("tr")).toBeTruthy();
    expect(readableLanguage("en_US")).toBeTruthy();
  });
});

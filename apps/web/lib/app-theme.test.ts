import { describe, expect, it } from "vitest";
import { isAppTheme, oppositeAppTheme, resolveAppTheme } from "./app-theme";

describe("authenticated app theme", () => {
  it("prefers a valid saved choice over the operating system", () => {
    expect(resolveAppTheme("light", true)).toBe("light");
    expect(resolveAppTheme("dark", false)).toBe("dark");
  });

  it("uses the operating-system preference without a saved choice", () => {
    expect(resolveAppTheme(null, true)).toBe("dark");
    expect(resolveAppTheme(null, false)).toBe("light");
    expect(resolveAppTheme("unsupported", false)).toBe("light");
  });

  it("recognizes and toggles only supported themes", () => {
    expect(isAppTheme("light")).toBe(true);
    expect(isAppTheme("dark")).toBe(true);
    expect(isAppTheme("system")).toBe(false);
    expect(oppositeAppTheme("dark")).toBe("light");
    expect(oppositeAppTheme("light")).toBe("dark");
  });
});

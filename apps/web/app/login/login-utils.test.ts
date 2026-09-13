import { describe, expect, it } from "vitest";
import { loginErrorMessage, validateLoginFields } from "./login-utils";

describe("login form helpers", () => {
  it("validates required fields and email format", () => {
    expect(validateLoginFields("", "")).toEqual({
      email: "E-posta adresinizi girin.",
      password: "Parolanızı girin.",
    });
    expect(validateLoginFields("not-an-email", "secret")).toEqual({
      email: "Geçerli bir e-posta adresi girin.",
    });
    expect(validateLoginFields("user@example.com", "secret")).toEqual({});
  });

  it("maps authentication failures without exposing server details", () => {
    expect(loginErrorMessage(401, "invalid_credentials")).toContain("hatalı");
    expect(loginErrorMessage(429)).toContain("Çok fazla");
    expect(loginErrorMessage(503, "database_secret")).not.toContain(
      "database_secret",
    );
  });
});

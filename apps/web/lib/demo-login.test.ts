import { describe, expect, it } from "vitest";
import { resolveDemoLogin } from "./demo-login";

describe("development demo login", () => {
  it("does not expose configured demo credentials in production", () => {
    expect(
      resolveDemoLogin("production", "owner@example.test", "not-for-prod"),
    ).toBeNull();
  });

  it("requires both values to be explicitly configured", () => {
    expect(resolveDemoLogin("development", undefined, undefined)).toBeNull();
    expect(
      resolveDemoLogin("development", "owner@example.test", undefined),
    ).toBeNull();
  });

  it("returns explicitly configured local development credentials", () => {
    expect(
      resolveDemoLogin(
        "development",
        " owner@example.test ",
        "local-password",
      ),
    ).toEqual({
      email: "owner@example.test",
      password: "local-password",
    });
  });
});

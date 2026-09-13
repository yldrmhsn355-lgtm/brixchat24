import { describe, expect, it } from "vitest";
import {
  assertOrganization,
  can,
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  refreshReuseAction,
  verifyPassword,
} from "./index";
describe("tenant authorization", () => {
  it("keeps viewers read only", () =>
    expect(can("viewer", "message:send")).toBe(false));
  it("separates template management capabilities by role", () => {
    expect(can("viewer", "templates:read")).toBe(true);
    expect(can("viewer", "templates:create")).toBe(false);
    expect(can("agent", "templates:read")).toBe(true);
    expect(can("agent", "templates:test")).toBe(false);
    expect(can("team_lead", "templates:update")).toBe(true);
    expect(can("team_lead", "templates:submit")).toBe(false);
    expect(can("admin", "templates:submit")).toBe(true);
    expect(can("owner", "templates:delete")).toBe(true);
  });
  it("keeps destructive file and connection operations privileged", () => {
    expect(can("viewer", "files:view")).toBe(true);
    expect(can("viewer", "files:download")).toBe(false);
    expect(can("agent", "files:send")).toBe(true);
    expect(can("agent", "files:delete")).toBe(false);
    expect(can("team_lead", "files:archive")).toBe(true);
    expect(can("team_lead", "files:share")).toBe(false);
    expect(can("admin", "files:manage_connections")).toBe(true);
    expect(can("owner", "files:delete")).toBe(true);
  });
  it("rejects a different organization", () =>
    expect(() =>
      assertOrganization(
        { sub: "u", organizationId: "a", role: "owner", email: "a@b.co" },
        "b",
      ),
    ).toThrow("organization_scope_mismatch"));
});

describe("production authentication primitives", () => {
  it("hashes and verifies passwords with Argon2id", async () => {
    const hash = await hashPassword("ValidPassword!2026");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "ValidPassword!2026")).toBe(true);
    expect(await verifyPassword(hash, "incorrect-password")).toBe(false);
  });

  it("creates opaque tokens while persisting only deterministic hashes", () => {
    const token = createOpaqueToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(hashOpaqueToken(token)).toHaveLength(64);
    expect(hashOpaqueToken(token)).toBe(hashOpaqueToken(token));
    expect(hashOpaqueToken(createOpaqueToken())).not.toBe(
      hashOpaqueToken(token),
    );
  });

  it("revokes a token family when a replaced refresh token is reused", () => {
    expect(refreshReuseAction({ revokedAt: null, replacedById: null })).toBe(
      "rotate",
    );
    expect(refreshReuseAction({ revokedAt: null, replacedById: "next" })).toBe(
      "revoke_family",
    );
    expect(
      refreshReuseAction({ revokedAt: new Date(), replacedById: null }),
    ).toBe("reject");
  });
});

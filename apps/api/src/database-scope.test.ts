import { describe, expect, it } from "vitest";
import { databaseRouteScope, organizationAccessError } from "./database-scope";

describe("database route protection", () => {
  it("keeps platform routes outside tenant RLS", () => {
    expect(databaseRouteScope("/api/v1/platform-admin/overview")).toBe(
      "platform",
    );
    expect(databaseRouteScope("/api/v1/conversations")).toBe("tenant");
  });

  it("returns stable activation gate codes", () => {
    expect(organizationAccessError("active")).toBeNull();
    expect(organizationAccessError("pending_review")).toBe(
      "organization_pending_approval",
    );
    expect(organizationAccessError("rejected")).toBe("organization_rejected");
    expect(organizationAccessError("disabled")).toBe("organization_disabled");
  });
});

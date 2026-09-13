import { describe, expect, it } from "vitest";
import {
  driveConnectionError,
  driveConnectionStatus,
} from "./files-connection-presentation";

describe("Google Drive connection presentation", () => {
  it("does not present an unchecked authorization as healthy", () => {
    expect(
      driveConnectionStatus({
        status: "connected",
        last_health_check_at: null,
        last_error_code: null,
      }),
    ).toEqual({ className: "pending", label: "Bağlı · test edilmedi" });
  });

  it("marks only a checked connection as healthy", () => {
    expect(
      driveConnectionStatus({
        status: "connected",
        last_health_check_at: "2026-08-01T10:00:00.000Z",
        last_error_code: null,
      }),
    ).toEqual({ className: "connected", label: "Sağlıklı" });
  });

  it("turns revoked-token errors into a reconnect action", () => {
    expect(
      driveConnectionStatus({
        status: "error",
        last_health_check_at: "2026-08-01T10:00:00.000Z",
        last_error_code: "GOOGLE_TOKEN_REVOKED",
      }).label,
    ).toBe("Yeniden bağlanmalı");
    expect(driveConnectionError("GOOGLE_TOKEN_REVOKED")).toBe(
      "Google hesabını yeniden bağlayın.",
    );
  });

  it("explains how to recover from a missing Drive grant", () => {
    expect(driveConnectionError("DRIVE_SCOPE_MISSING")).toContain(
      "Drive erişim kutusunu işaretleyin",
    );
  });
});

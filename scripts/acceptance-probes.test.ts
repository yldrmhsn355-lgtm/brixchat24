import { describe, expect, it } from "vitest";
import {
  AcceptanceConfirmationRequiredError,
  MissingAcceptanceConfigurationError,
  runAcceptanceProbe,
  selectObservedMetaStatus,
  selectAcceptanceRow,
} from "./acceptance-probes";

describe("external acceptance probe safety", () => {
  it("blocks Meta verification before making a call when credentials are absent", async () => {
    await expect(
      runAcceptanceProbe({
        service: "meta",
        scenario: "verify",
        env: {},
      }),
    ).rejects.toBeInstanceOf(MissingAcceptanceConfigurationError);
  });

  it("requires explicit confirmation before an S3 round-trip", async () => {
    await expect(
      runAcceptanceProbe({
        service: "storage",
        scenario: "all",
        env: {},
      }),
    ).rejects.toBeInstanceOf(AcceptanceConfirmationRequiredError);
  });

  it("requires explicit confirmation before an SMTP test message", async () => {
    await expect(
      runAcceptanceProbe({
        service: "smtp",
        scenario: "all",
        env: {
          SMTP_HOST: "smtp.example.test",
          EMAIL_FROM: "acceptance@example.test",
          SMTP_ACCEPTANCE_RECIPIENT: "recipient@example.test",
        },
      }),
    ).rejects.toBeInstanceOf(AcceptanceConfirmationRequiredError);
  });

  it("selects the only connected provider record without exposing credentials", () => {
    expect(
      selectAcceptanceRow(
        [{ public_id: "channel-1", credentials_encrypted: "ciphertext" }],
        undefined,
        "META_ACCEPTANCE_CHANNEL_PUBLIC_ID",
      ).public_id,
    ).toBe("channel-1");
  });

  it("requires an explicit selector when multiple provider records exist", () => {
    expect(() =>
      selectAcceptanceRow(
        [{ public_id: "channel-1" }, { public_id: "channel-2" }],
        undefined,
        "META_ACCEPTANCE_CHANNEL_PUBLIC_ID",
      ),
    ).toThrow(MissingAcceptanceConfigurationError);
    expect(
      selectAcceptanceRow(
        [{ public_id: "channel-1" }, { public_id: "channel-2" }],
        "channel-2",
        "META_ACCEPTANCE_CHANNEL_PUBLIC_ID",
      ).public_id,
    ).toBe("channel-2");
  });

  it("does not regress a delivered Meta status when sent is processed later", () => {
    expect(selectObservedMetaStatus(["delivered", "sent"])).toBe("delivered");
    expect(selectObservedMetaStatus(["read", "delivered", "sent"])).toBe(
      "read",
    );
  });

  it("keeps a Meta failure authoritative over delivery states", () => {
    expect(selectObservedMetaStatus(["delivered", "failed", "sent"])).toBe(
      "failed",
    );
  });
});

import { describe, expect, it } from "vitest";
import { DisabledEmailProvider } from "./email";
describe("disabled email", () => {
  it("never pretends verification or recovery mail was sent", async () => {
    const email = new DisabledEmailProvider();
    await expect(
      email.sendVerificationEmail({
        to: "user@example.com",
        verificationUrl: "https://example.com",
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: "EMAIL_NOT_CONFIGURED" });
    await expect(
      email.sendPasswordResetEmail({
        to: "user@example.com",
        resetUrl: "https://example.com",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(
      email.sendOrganizationInvitation({
        to: "user@example.com",
        invitationUrl: "https://example.com",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

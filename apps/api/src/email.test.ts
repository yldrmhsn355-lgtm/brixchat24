import { afterEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { ConsoleEmailProvider, SmtpEmailProvider } from "./email";

describe("ConsoleEmailProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records delivery metadata without leaking tokenized links", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const provider = new ConsoleEmailProvider(true);

    await provider.sendPasswordResetEmail({
      to: "person@example.test",
      resetUrl: "http://localhost/reset-password?token=top-secret-token",
    });

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain("password_reset");
    expect(output).toContain("person@example.test");
    expect(output).not.toContain("top-secret-token");
    expect(output).not.toContain("reset-password");
  });

  it("verifies the SMTP connection without sending a message", async () => {
    const verify = vi.fn(async () => true);
    const sendMail = vi.fn();
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({
      verify,
      sendMail,
    } as never);
    const provider = new SmtpEmailProvider("sender@example.test", {
      host: "smtp.example.test",
      port: 587,
      secure: false,
    });

    await provider.verifyConnection();

    expect(verify).toHaveBeenCalledOnce();
    expect(sendMail).not.toHaveBeenCalled();
  });
});

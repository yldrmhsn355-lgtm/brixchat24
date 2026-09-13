import nodemailer from "nodemailer";

export interface VerificationEmailInput {
  to: string;
  verificationUrl: string;
}

export interface PasswordResetEmailInput {
  to: string;
  resetUrl: string;
}

export interface OrganizationInvitationEmailInput {
  to: string;
  invitationUrl: string;
}

export interface EmailProvider {
  sendVerificationEmail(input: VerificationEmailInput): Promise<void>;
  sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void>;
  sendOrganizationInvitation(
    input: OrganizationInvitationEmailInput,
  ): Promise<void>;
}

export class DisabledEmailProvider implements EmailProvider {
  private unavailable(): never {
    throw Object.assign(new Error("E-posta bağlantısı henüz kurulmadı."), {
      statusCode: 503,
      code: "EMAIL_NOT_CONFIGURED",
    });
  }
  async sendVerificationEmail(_input: VerificationEmailInput): Promise<void> {
    this.unavailable();
  }
  async sendPasswordResetEmail(_input: PasswordResetEmailInput): Promise<void> {
    this.unavailable();
  }
  async sendOrganizationInvitation(
    _input: OrganizationInvitationEmailInput,
  ): Promise<void> {
    this.unavailable();
  }
}

export class ConsoleEmailProvider implements EmailProvider {
  constructor(private readonly enabled = true) {}

  private record(type: string, to: string): void {
    if (!this.enabled) return;
    process.stdout.write(
      `${JSON.stringify({ level: "info", event: "email.console", type, to })}\n`,
    );
  }

  async sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
    this.record("verification", input.to);
  }

  async sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
    this.record("password_reset", input.to);
  }

  async sendOrganizationInvitation(
    input: OrganizationInvitationEmailInput,
  ): Promise<void> {
    this.record("organization_invitation", input.to);
  }
}

export class SmtpEmailProvider implements EmailProvider {
  private readonly transporter;

  constructor(
    private readonly from: string,
    options: {
      host: string;
      port: number;
      secure: boolean;
      username?: string;
      password?: string;
    },
  ) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      ...(options.username && options.password
        ? { auth: { user: options.username, pass: options.password } }
        : {}),
    });
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to, subject, text });
  }

  async verifyConnection(): Promise<void> {
    await this.transporter.verify();
  }

  async sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
    await this.send(
      input.to,
      "Brixchat24 e-posta doğrulama",
      `E-posta adresinizi doğrulayın: ${input.verificationUrl}`,
    );
  }

  async sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
    await this.send(
      input.to,
      "Brixchat24 parola sıfırlama",
      `Parolanızı sıfırlayın: ${input.resetUrl}`,
    );
  }

  async sendOrganizationInvitation(
    input: OrganizationInvitationEmailInput,
  ): Promise<void> {
    await this.send(
      input.to,
      "Brixchat24 workspace daveti",
      `Davetinizi kabul edin: ${input.invitationUrl}`,
    );
  }
}

export function createEmailProviderFromEnv(): EmailProvider {
  const provider = (
    process.env.EMAIL_PROVIDER ??
    (process.env.NODE_ENV === "production" ? "disabled" : "console")
  ).toLowerCase();
  if (provider === "disabled") return new DisabledEmailProvider();
  if (provider === "smtp") {
    const host = process.env.SMTP_HOST;
    const from = process.env.EMAIL_FROM;
    if (!host || !from)
      throw new Error("SMTP_HOST and EMAIL_FROM are required for SMTP email");
    const port = Number(process.env.SMTP_PORT ?? 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("SMTP_PORT must be a valid TCP port");
    return new SmtpEmailProvider(from, {
      host,
      port,
      secure: process.env.SMTP_SECURE === "true" || port === 465,
      ...(process.env.SMTP_USERNAME
        ? { username: process.env.SMTP_USERNAME }
        : {}),
      ...(process.env.SMTP_PASSWORD
        ? { password: process.env.SMTP_PASSWORD }
        : {}),
    });
  }
  if (provider !== "console")
    throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
  if (process.env.NODE_ENV === "production")
    throw new Error("Console email provider is disabled in production");
  return new ConsoleEmailProvider(true);
}

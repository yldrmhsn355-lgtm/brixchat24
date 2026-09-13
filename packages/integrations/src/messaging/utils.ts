import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
export function normalizePhone(value: string): string {
  const rawDigits = value.replace(/\D/g, "");
  const digits = rawDigits.startsWith("00") ? rawDigits.slice(2) : rawDigits;
  if (digits.length < 8 || digits.length > 15) throw new Error("INVALID_PHONE");
  return `+${digits}`;
}
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function verifyMetaSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return safeEqual(expected, signature);
}
export function deterministicEventKey(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
export function retryDelay(attempt: number): number | null {
  return [5000, 30000, 120000, 600000][attempt - 1] ?? null;
}
const priority = { pending: 0, sent: 1, delivered: 2, read: 3 } as const;
export type DeliveryState = keyof typeof priority | "failed";
export function nextMessageStatus(
  current: DeliveryState,
  incoming: DeliveryState,
): DeliveryState {
  if (current === "failed") return "failed";
  if (incoming === "failed")
    return current === "delivered" || current === "read" ? current : "failed";
  return priority[incoming] >= priority[current] ? incoming : current;
}
export function isWindowOpen(
  expiresAt: Date | null,
  now = new Date(),
): boolean {
  return expiresAt !== null && expiresAt.getTime() > now.getTime();
}
export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32)
    throw new Error("APP_ENCRYPTION_KEY must decode to 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}
export function decryptSecret(envelope: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32)
    throw new Error("APP_ENCRYPTION_KEY must decode to 32 bytes");
  const [version, iv, tag, data] = envelope.split(".");
  if (version !== "v1" || !iv || !tag || !data)
    throw new Error("INVALID_ENVELOPE");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
export function normalizeProviderError(status: number): {
  code: string;
  retryable: boolean;
} {
  if (status === 429 || status >= 500)
    return { code: "PROVIDER_TEMPORARY_ERROR", retryable: true };
  if (status === 401 || status === 403)
    return { code: "PROVIDER_UNAUTHORIZED", retryable: false };
  return { code: "PROVIDER_REJECTED", retryable: false };
}

export type ChannelCredentials = { accessToken?: string; appSecret?: string };
export function mergeChannelCredentials(
  current: ChannelCredentials,
  incoming: ChannelCredentials,
): ChannelCredentials {
  return {
    ...(incoming.accessToken?.trim()
      ? { accessToken: incoming.accessToken.trim() }
      : current.accessToken
        ? { accessToken: current.accessToken }
        : {}),
    ...(incoming.appSecret?.trim()
      ? { appSecret: incoming.appSecret.trim() }
      : current.appSecret
        ? { appSecret: current.appSecret }
        : {}),
  };
}
export function validateTemplateVariables(
  expected: string[],
  provided: Record<string, string>,
): string[] {
  const expectedSet = new Set(expected);
  return [
    ...expected
      .filter((key) => !provided[key]?.trim())
      .map((key) => `missing:${key}`),
    ...Object.keys(provided)
      .filter((key) => !expectedSet.has(key))
      .map((key) => `unknown:${key}`),
  ];
}
const quickReplyVariables = new Set([
  "contact.first_name",
  "contact.last_name",
  "contact.full_name",
  "contact.phone",
  "contact.country",
  "contact.city",
  "contact.language",
  "agent.first_name",
  "agent.full_name",
  "assigned_user.name",
  "assigned_user.first_name",
  "organization.name",
  "workspace.name",
  "team.name",
  "channel.name",
  "channel.phone_number",
  "conversation.id",
  "conversation.last_message_at",
  "appointment.date",
  "appointment.time",
  "current_date",
  "current_time",
]);
export function renderQuickReply(
  template: string,
  values: Record<string, string>,
): { content: string; missingVariables: string[]; unknownVariables: string[] } {
  const missing = new Set<string>(),
    unknown = new Set<string>();
  const content = template.replace(
    /\{\{\s*([^{}]+?)\s*\}\}/g,
    (token, key: string) => {
      if (
        !quickReplyVariables.has(key) &&
        !/^bitrix\.(contact|deal|task)\.[a-zA-Z0-9_.-]+$/.test(key)
      ) {
        unknown.add(key);
        return token;
      }
      const value = values[key];
      if (!value) {
        missing.add(key);
        return token;
      }
      return value;
    },
  );
  return {
    content,
    missingVariables: [...missing],
    unknownVariables: [...unknown],
  };
}

import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeMessagingProvider } from "../fake/provider";
import {
  decryptSecret,
  deterministicEventKey,
  encryptSecret,
  hashSecret,
  isWindowOpen,
  nextMessageStatus,
  normalizePhone,
  normalizeProviderError,
  mergeChannelCredentials,
  renderQuickReply,
  validateTemplateVariables,
  retryDelay,
  safeEqual,
  verifyMetaSignature,
} from "./utils";

const sendInput = {
  channelId: "channel",
  phoneNumberId: "phone",
  recipient: "+447700900123",
  text: "hello",
  idempotencyKey: "idempotent-key",
};

describe("messaging utilities", () => {
  it("normalizes E.164 and international dial prefixes", () => {
    expect(normalizePhone("+44 (7700) 900123")).toBe("+447700900123");
    expect(normalizePhone("00905 321 112 233")).toBe("+905321112233");
    expect(normalizePhone("905321112233")).toBe("+905321112233");
  });
  it("verifies HMAC and timing-safe values", () => {
    const raw = '{"ok":true}';
    const secret = "secret";
    const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    expect(verifyMetaSignature(raw, signature, secret)).toBe(true);
    expect(safeEqual("same", "same")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
  });
  it("creates deterministic keys and secret hashes", () => {
    expect(deterministicEventKey({ a: 1 })).toBe(
      deterministicEventKey({ a: 1 }),
    );
    expect(hashSecret("token")).toHaveLength(64);
  });
  it("keeps status monotonic", () => {
    expect(nextMessageStatus("read", "delivered")).toBe("read");
    expect(nextMessageStatus("sent", "read")).toBe("read");
    expect(nextMessageStatus("sent", "failed")).toBe("failed");
    expect(nextMessageStatus("delivered", "failed")).toBe("delivered");
    expect(nextMessageStatus("read", "failed")).toBe("read");
    expect(nextMessageStatus("failed", "read")).toBe("failed");
  });
  it("calculates retry policy", () => {
    expect([1, 2, 3, 4, 5].map(retryDelay)).toEqual([
      5000,
      30000,
      120000,
      600000,
      null,
    ]);
  });
  it("normalizes provider errors", () => {
    expect(normalizeProviderError(429)).toEqual({
      code: "PROVIDER_TEMPORARY_ERROR",
      retryable: true,
    });
    expect(normalizeProviderError(503)).toEqual({
      code: "PROVIDER_TEMPORARY_ERROR",
      retryable: true,
    });
    expect(normalizeProviderError(401)).toEqual({
      code: "PROVIDER_UNAUTHORIZED",
      retryable: false,
    });
    expect(normalizeProviderError(400)).toEqual({
      code: "PROVIDER_REJECTED",
      retryable: false,
    });
  });
  it("round trips AES-GCM", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptSecret("top-secret", key);
    expect(encrypted).not.toContain("top-secret");
    expect(decryptSecret(encrypted, key)).toBe("top-secret");
  });
  it("checks messaging window", () => {
    expect(isWindowOpen(new Date(Date.now() + 1000))).toBe(true);
    expect(isWindowOpen(new Date(Date.now() - 1000))).toBe(false);
  });
  it("preserves stored channel secrets when blank values are submitted", () => {
    expect(
      mergeChannelCredentials(
        { accessToken: "old", appSecret: "secret" },
        { accessToken: "", appSecret: "new" },
      ),
    ).toEqual({ accessToken: "old", appSecret: "new" });
  });
  it("validates exact template component positions", () => {
    expect(
      validateTemplateVariables(["body.1", "body.2"], {
        "body.1": "Elena",
        "body.2": "July 24",
      }),
    ).toEqual([]);
    expect(
      validateTemplateVariables(["body.1"], { "body.2": "extra" }),
    ).toEqual(["missing:body.1", "unknown:body.2"]);
  });
  it("renders only allow-listed quick reply variables", () => {
    expect(
      renderQuickReply("Hi {{contact.first_name}} from {{organization.name}}", {
        "contact.first_name": "Elena",
        "organization.name": "Brix",
      }),
    ).toEqual({
      content: "Hi Elena from Brix",
      missingVariables: [],
      unknownVariables: [],
    });
    expect(
      renderQuickReply("{{contact.first_name}} {{unsafe.secret}}", {}),
    ).toEqual({
      content: "{{contact.first_name}} {{unsafe.secret}}",
      missingVariables: ["contact.first_name"],
      unknownVariables: ["unsafe.secret"],
    });
    expect(
      renderQuickReply("Deal: {{bitrix.deal.TITLE}}", {
        "bitrix.deal.TITLE": "Implant treatment",
      }),
    ).toEqual({
      content: "Deal: Implant treatment",
      missingVariables: [],
      unknownVariables: [],
    });
  });
  it("fake provider supports success, temporary and permanent outcomes", async () => {
    await expect(
      new FakeMessagingProvider("success", 0).sendMessage(sendInput),
    ).resolves.toMatchObject({
      providerMessageId: expect.stringMatching(/^fake_/),
    });
    await expect(
      new FakeMessagingProvider("temporary_error", 0).sendMessage(sendInput),
    ).rejects.toMatchObject({
      code: "FAKE_TEMPORARY",
      retryable: true,
    });
    await expect(
      new FakeMessagingProvider("permanent_error", 0).sendMessage(sendInput),
    ).rejects.toMatchObject({
      code: "FAKE_PERMANENT",
      retryable: false,
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  BitrixError,
  FakeBitrix24Provider,
  crmRetryDelay,
  normalizeBitrixError,
  normalizeCrmPhone,
  pickUnambiguousMatch,
} from "../index";

describe("CRM integration contract", () => {
  it("normalizes phone values for Bitrix matching", () => {
    expect(normalizeCrmPhone("+90 (532) 111 22 33")).toBe("+905321112233");
    expect(normalizeCrmPhone("00905 321 112 233")).toBe("+905321112233");
    expect(normalizeCrmPhone("invalid")).toBeNull();
  });

  it("only auto-selects a unique high-confidence match", () => {
    const unique = [
      {
        entityType: "contact" as const,
        externalId: "7",
        displayName: "Ada",
        confidence: 1,
        source: "phone" as const,
      },
    ];
    expect(pickUnambiguousMatch(unique)?.externalId).toBe("7");
    expect(
      pickUnambiguousMatch([...unique, { ...unique[0]!, externalId: "8" }]),
    ).toBeNull();
    expect(
      pickUnambiguousMatch([{ ...unique[0]!, confidence: 0.7 }]),
    ).toBeNull();
  });

  it("normalizes authentication, rate limit, timeout and provider errors", () => {
    expect(normalizeBitrixError({ status: 401 }).code).toBe("AUTH");
    expect(normalizeBitrixError({ status: 429 }).code).toBe("RATE_LIMIT");
    expect(normalizeBitrixError({ name: "AbortError" }).code).toBe("TIMEOUT");
    expect(normalizeBitrixError({ status: 503 }).retryable).toBe(true);
    expect(normalizeBitrixError({ status: 400 }).retryable).toBe(false);
    expect(
      normalizeBitrixError({
        status: 400,
        bitrixCode: "ERROR_USER_NOT_OPERATOR",
        message: "provider detail must remain redacted",
      }),
    ).toMatchObject({
      code: "VALIDATION",
      retryable: false,
      message: "Bitrix rejected the request",
      providerCode: "ERROR_USER_NOT_OPERATOR",
    });
  });

  it("uses capped CRM retry delays", () => {
    expect([1, 2, 3, 4, 5].map(crmRetryDelay)).toEqual([
      2_000,
      10_000,
      60_000,
      300_000,
      null,
    ]);
  });

  it("fake provider returns paginated users and pipelines", async () => {
    const provider = new FakeBitrix24Provider("success");
    await expect(provider.listUsers()).resolves.toMatchObject({
      data: expect.any(Array),
    });
    await expect(provider.listPipelines()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Satış" })]),
    );
  });

  it("fake provider exposes deterministic ambiguous matches", async () => {
    const provider = new FakeBitrix24Provider("ambiguous_contact");
    const matches = await provider.findEntities({ phone: "+905321112233" });
    expect(matches).toHaveLength(2);
    expect(pickUnambiguousMatch(matches)).toBeNull();
  });

  it("fake provider creates entities idempotently", async () => {
    const provider = new FakeBitrix24Provider("success");
    const input = {
      entityType: "deal" as const,
      idempotencyKey: "conversation-1",
      fields: { TITLE: "New deal" },
    };
    const first = await provider.createEntity(input);
    const second = await provider.createEntity(input);
    expect(second).toEqual(first);
  });

  it("fake timeline writes are idempotent", async () => {
    const provider = new FakeBitrix24Provider("success");
    const input = {
      entityType: "contact" as const,
      externalId: "1",
      text: "WhatsApp received",
      idempotencyKey: "message-1",
    };
    expect(await provider.addTimelineComment(input)).toEqual(
      await provider.addTimelineComment(input),
    );
  });

  it("fake provider distinguishes retryable from permanent failures", async () => {
    await expect(
      new FakeBitrix24Provider("temporary_error").health(),
    ).rejects.toBeInstanceOf(BitrixError);
    await expect(
      new FakeBitrix24Provider("permission_denied").health(),
    ).rejects.toMatchObject({ code: "PERMISSION", retryable: false });
  });

  it("fake provider returns an explicit empty state", async () => {
    const provider = new FakeBitrix24Provider("empty");
    await expect(
      provider.findEntities({ phone: "+905321112233" }),
    ).resolves.toEqual([]);
    await expect(provider.listUsers()).resolves.toEqual({
      data: [],
      nextCursor: null,
    });
  });
});

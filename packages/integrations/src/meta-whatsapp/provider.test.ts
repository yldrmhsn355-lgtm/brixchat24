import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MetaWhatsAppCloudProvider,
  subscribeMetaAppToWaba,
  unsubscribeMetaAppFromWaba,
} from "./provider";

describe("subscribeMetaAppToWaba", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("subscribes the app with a bearer token", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            init?.method === "POST"
              ? { success: true }
              : {
                  data: [
                    {
                      override_callback_uri:
                        "https://api.example.test/webhook",
                    },
                  ],
                },
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await subscribeMetaAppToWaba({
      businessAccountId: "test-waba",
      accessToken: "test-token",
      apiVersion: "v25.0",
      overrideCallbackUri: "https://api.example.test/webhook",
      verifyToken: "test-verify-token",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v25.0/test-waba/subscribed_apps",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("pins the WABA subscription to the channel callback", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            init?.method === "POST"
              ? { success: true }
              : {
                  data: [
                    {
                      override_callback_uri:
                        "https://api.example.test/webhooks/meta/whatsapp/channel-public-id",
                    },
                  ],
                },
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await subscribeMetaAppToWaba({
      businessAccountId: "test-waba",
      accessToken: "test-token",
      apiVersion: "v25.0",
      overrideCallbackUri:
        "https://api.example.test/webhooks/meta/whatsapp/channel-public-id",
      verifyToken: "test-verify-token",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v25.0/test-waba/subscribed_apps",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          override_callback_uri:
            "https://api.example.test/webhooks/meta/whatsapp/channel-public-id",
          verify_token: "test-verify-token",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects a WABA subscription that does not confirm the callback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          new Response(
            JSON.stringify(
              init?.method === "POST"
                ? { success: true }
                : { data: [{ override_callback_uri: "https://old.test" }] },
            ),
            { status: 200 },
          ),
      ),
    );

    await expect(
      subscribeMetaAppToWaba({
        businessAccountId: "test-waba",
        accessToken: "test-token",
        overrideCallbackUri: "https://api.example.test/webhook",
        verifyToken: "test-verify-token",
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "PROVIDER_INVALID_RESPONSE",
      retryable: true,
    });
  });

  it("rejects an incomplete callback override before calling Meta", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      subscribeMetaAppToWaba({
        businessAccountId: "test-waba",
        accessToken: "test-token",
        overrideCallbackUri: "https://api.example.test/webhook",
      } as Parameters<typeof subscribeMetaAppToWaba>[0]),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "PROVIDER_INVALID_CONFIGURATION",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes permission failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("forbidden", { status: 403 })),
    );

    await expect(
      subscribeMetaAppToWaba({
        businessAccountId: "test-waba",
        accessToken: "test-token",
        overrideCallbackUri: "https://api.example.test/webhook",
        verifyToken: "test-verify-token",
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "CHANNEL_PERMISSION_DENIED",
      retryable: false,
    });
  });

  it("aborts a stalled subscription request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          }),
      ),
    );

    await expect(
      subscribeMetaAppToWaba({
        businessAccountId: "test-waba",
        accessToken: "test-token",
        timeoutMs: 1,
        overrideCallbackUri: "https://api.example.test/webhook",
        verifyToken: "test-verify-token",
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "PROVIDER_TIMEOUT",
      retryable: true,
    });
  });
});

describe("unsubscribeMetaAppFromWaba", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("removes the app subscription before a Meta channel is archived", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await unsubscribeMetaAppFromWaba({
      businessAccountId: "test-waba",
      accessToken: "test-token",
      apiVersion: "v25.0",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v25.0/test-waba/subscribed_apps",
      expect.objectContaining({
        method: "DELETE",
        headers: { authorization: "Bearer test-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

describe("MetaWhatsAppCloudProvider.healthCheck", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports phone registration and a phone-level webhook override without exposing its verify token", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const isWebhookQuery = String(url).includes("webhook_configuration");
      return new Response(
        JSON.stringify(
          isWebhookQuery
            ? {
                webhook_configuration: {
                  phone_number: "https://api.example.test/webhook",
                  application: "https://app.example.test/webhook",
                  verify_token: "must-not-leak",
                },
              }
            : {
                display_phone_number: "+90 530 000 00 00",
                verified_name: "Example Business",
                quality_rating: "GREEN",
                code_verification_status: "VERIFIED",
                platform_type: "CLOUD_API",
              },
        ),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new MetaWhatsAppCloudProvider("v25.0").healthCheck({
      phoneNumberId: "test-phone-number-id",
      accessToken: "test-token",
      expectedWebhookCallbackUri: "https://api.example.test/webhook",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v25.0/test-phone-number-id?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type",
      expect.objectContaining({
        headers: { authorization: "Bearer test-token" },
      }),
    );
    expect(result).toMatchObject({
      healthy: true,
      status: "healthy",
      profile: {
        codeVerificationStatus: "VERIFIED",
        platformType: "CLOUD_API",
        webhookRouteSource: "phone_number",
        webhookRouteMatches: "true",
      },
    });
    expect(result.profile).not.toHaveProperty("verifyToken");
  });

  it("flags a stale phone route even when the app route is correct", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).includes("webhook_configuration")
              ? {
                  webhook_configuration: {
                    phone_number: "https://old.example.test/webhook",
                    whatsapp_business_account:
                      "https://api.example.test/webhook",
                    application: "https://api.example.test/webhook",
                  },
                }
              : {},
          ),
          { status: 200 },
        ),
      ),
    );

    const result = await new MetaWhatsAppCloudProvider("v25.0").healthCheck({
      phoneNumberId: "test-phone-number-id",
      accessToken: "test-token",
      expectedWebhookCallbackUri: "https://api.example.test/webhook",
    });

    expect(result).toMatchObject({
      healthy: false,
      status: "unhealthy",
      code: "CHANNEL_WEBHOOK_ROUTE_MISMATCH",
      profile: {
        webhookRouteSource: "phone_number",
        webhookRouteMatches: "false",
      },
    });
  });

  it("keeps the base channel health available when route inspection is unsupported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        String(url).includes("webhook_configuration")
          ? new Response("unsupported", { status: 400 })
          : new Response(JSON.stringify({ quality_rating: "GREEN" }), {
              status: 200,
            }),
      ),
    );

    const result = await new MetaWhatsAppCloudProvider("v25.0").healthCheck({
      phoneNumberId: "test-phone-number-id",
      accessToken: "test-token",
      expectedWebhookCallbackUri: "https://api.example.test/webhook",
    });

    expect(result).toMatchObject({
      healthy: true,
      status: "warning",
      code: "CHANNEL_WEBHOOK_ROUTE_UNVERIFIED",
    });
  });
});

describe("MetaWhatsAppCloudProvider template management", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a template through the configured Graph version", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "provider-template-1", status: "PENDING" }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await new MetaWhatsAppCloudProvider(
      "v25.0",
    ).createTemplate({
      businessAccountId: "waba-1",
      accessToken: "token",
      name: "appointment_ready",
      language: "tr",
      category: "UTILITY",
      components: [{ type: "BODY", text: "Merhaba {{1}}" }],
    });
    expect(result).toMatchObject({
      providerTemplateId: "provider-template-1",
      status: "pending",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v25.0/waba-1/message_templates",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "appointment_ready",
          language: "tr",
          category: "UTILITY",
          components: [{ type: "BODY", text: "Merhaba {{1}}" }],
        }),
      }),
    );
  });

  it("deletes by lossless provider template id", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await new MetaWhatsAppCloudProvider("v25.0").deleteTemplate({
      businessAccountId: "waba-1",
      providerTemplateId: "12345678901234567890",
      accessToken: "token",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v25.0/waba-1/message_templates?hsm_id=12345678901234567890",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("falls back to the template name when Meta rejects hsm_id deletion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 100 } }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await new MetaWhatsAppCloudProvider(
      "v25.0",
    ).deleteTemplate({
      businessAccountId: "waba-1",
      providerTemplateId: "12345678901234567890",
      name: "appointment_ready",
      accessToken: "token",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://graph.facebook.com/v25.0/waba-1/message_templates?name=appointment_ready",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(result).toMatchObject({
      providerTemplateId: "12345678901234567890",
      status: "deleted",
    });
  });

  it("does not issue an empty provider update", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new MetaWhatsAppCloudProvider("v25.0").updateTemplate({
        providerTemplateId: "template-1",
        accessToken: "token",
      }),
    ).rejects.toMatchObject({
      code: "TEMPLATE_UPDATE_EMPTY",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { BitrixRestClient } from "./bitrix-client";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("BitrixRestClient OAuth refresh", () => {
  it("encodes Bitrix REST parameters as direct and nested form fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ result: true }));
    const client = new BitrixRestClient({
      portalUrl: "https://portal.bitrix24.com.tr",
      accessToken: "access-token",
      fetcher,
    });

    await client.call("event.bind", {
      event: "ONCRMDEALUPDATE",
      handler: "https://api.example.test/webhooks/bitrix24/connection",
      options: { sendAuth: true },
    });

    const body = fetcher.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("event")).toBe("ONCRMDEALUPDATE");
    expect(body.get("handler")).toBe(
      "https://api.example.test/webhooks/bitrix24/connection",
    );
    expect(body.get("options[sendAuth]")).toBe("true");
    expect(body.has("params")).toBe(false);
  });

  it("refreshes an expiring token, rotates the refresh token, and persists it", async () => {
    const onTokenRefresh = vi.fn(async () => undefined);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-next",
          refresh_token: "refresh-next",
          expires_in: 3600,
          client_endpoint: "https://portal.bitrix24.com.tr/rest/",
          server_endpoint: "https://oauth.bitrix.info/rest/",
          member_id: "member-1",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ result: { ID: "1" } }));
    const client = new BitrixRestClient({
      portalUrl: "https://portal.bitrix24.com.tr",
      accessToken: "access-old",
      refreshToken: "refresh-old",
      accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      clientId: "client-id",
      clientSecret: "client-secret",
      fetcher,
      onTokenRefresh,
    });

    await expect(client.call("profile")).resolves.toMatchObject({
      result: { ID: "1" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "https://oauth.bitrix.info/oauth/token/",
    );
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      "https://portal.bitrix24.com.tr/rest/profile.json",
    );
    expect(
      (fetcher.mock.calls[1]![1]!.body as URLSearchParams).get("auth"),
    ).toBe("access-next");
    expect(onTokenRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "access-next",
        refreshToken: "refresh-next",
        memberId: "member-1",
      }),
    );
  });

  it("refreshes once after an expired_token response", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "expired_token", error_description: "expired" },
          401,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-next",
          refresh_token: "refresh-next",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ result: true }));
    const client = new BitrixRestClient({
      portalUrl: "https://portal.bitrix24.com.tr",
      accessToken: "access-old",
      refreshToken: "refresh-old",
      clientId: "client-id",
      clientSecret: "client-secret",
      fetcher,
    });

    await expect(client.call("profile")).resolves.toMatchObject({
      result: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("normalizes Bitrix missing-entity errors as NOT_FOUND", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ error: "", error_description: "Not found" }, 400),
      );
    const client = new BitrixRestClient({
      portalUrl: "https://portal.bitrix24.com.tr",
      accessToken: "access-token",
      fetcher,
    });

    await expect(
      client.call("crm.lead.get", { id: "139636" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      retryable: false,
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("apiFetch", () => {
  it("shares one refresh request between concurrent 401 responses", async () => {
    const storage = memoryStorage();
    storage.setItem("brixchat_access_token", "expired-token");
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      location: { pathname: "/app/inbox", assign: vi.fn() },
    });

    let protectedCalls = 0;
    let refreshCalls = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/auth/refresh")) {
          refreshCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return Response.json({ data: { accessToken: "fresh-token" } });
        }

        protectedCalls += 1;
        return protectedCalls <= 2
          ? new Response(null, { status: 401 })
          : Response.json({ ok: true });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const responses = await Promise.all([
      apiFetch("/api/v1/first"),
      apiFetch("/api/v1/second"),
    ]);

    expect(responses.every((response) => response.ok)).toBe(true);
    expect(refreshCalls).toBe(1);
    expect(storage.getItem("brixchat_access_token")).toBe("fresh-token");

    const retryCalls = fetchMock.mock.calls.slice(-2);
    for (const [, init] of retryCalls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fresh-token",
      );
    }
  });
});

// Empty means same-origin in production; set NEXT_PUBLIC_API_URL for local
// split-port development or a separately hosted API.
const API = process.env.NEXT_PUBLIC_API_URL ?? "";
export const ACCESS_TOKEN_CHANGED_EVENT = "brixchat:access-token-changed";
export function accessToken() {
  return typeof window === "undefined"
    ? null
    : localStorage.getItem("brixchat_access_token");
}
export function setAccessToken(token: string) {
  localStorage.setItem("brixchat_access_token", token);
  window.dispatchEvent(new Event(ACCESS_TOKEN_CHANGED_EVENT));
}

let refreshRequest: Promise<string | null> | null = null;

function refreshAccessToken(): Promise<string | null> {
  if (refreshRequest) return refreshRequest;

  refreshRequest = fetch(`${API}/api/v1/auth/refresh`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const body = (await response.json()) as { data: { accessToken: string } };
      setAccessToken(body.data.accessToken);
      return body.data.accessToken;
    })
    .finally(() => {
      refreshRequest = null;
    });

  return refreshRequest;
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<Response> {
  const token = accessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  if (response.status === 401 && retry) {
    const refreshedToken = await refreshAccessToken();
    if (refreshedToken) {
      return apiFetch(path, init, false);
    }
    // A 401 that cannot be refreshed means the browser session is no longer
    // valid. Clear the stale bearer token and let the app shell return to the
    // login screen instead of rendering a raw "unauthorized" API error.
    localStorage.removeItem("brixchat_access_token");
    window.dispatchEvent(new Event(ACCESS_TOKEN_CHANGED_EVENT));
    if (window.location.pathname.startsWith("/app")) {
      window.location.assign("/login");
    }
  }
  return response;
}
export async function apiJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await apiFetch(path, init);
  const body = (await response.json()) as T & {
    error?: { message?: string } | string;
    message?: string;
  };
  if (!response.ok) {
    const nested =
      typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(
      nested ?? body.message ?? `İstek başarısız oldu (${response.status}).`,
    );
  }
  return body;
}
export async function logout() {
  await apiFetch("/api/v1/auth/logout", { method: "POST" }, false);
  localStorage.removeItem("brixchat_access_token");
  window.dispatchEvent(new Event(ACCESS_TOKEN_CHANGED_EVENT));
  window.location.href = "/login";
}

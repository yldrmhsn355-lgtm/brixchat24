import { BitrixError, crmRetryDelay, normalizeBitrixError } from "./utils";

export interface StoredBitrixTokens {
  accessToken?: string | null;
  refreshToken?: string | null;
  accessTokenExpiresAt?: string | null;
}
export interface BitrixClientOptions {
  webhookUrl?: string;
  portalUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  onTokenRefresh?: (tokens: BitrixOAuthTokenUpdate) => Promise<void>;
  /**
   * Serializes the refresh across processes (API + worker). The
   * implementation must hold an exclusive per-connection lock while running
   * the callback and pass in the freshest persisted tokens so a refresh
   * already performed elsewhere is adopted instead of burning the rotated
   * refresh token a second time.
   */
  withRefreshLock?: <T>(
    fn: (freshest: StoredBitrixTokens | null) => Promise<T>,
  ) => Promise<T>;
  timeoutMs?: number;
  maxAttempts?: number;
  fetcher?: typeof fetch;
}
export interface BitrixOAuthTokenUpdate {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string;
  clientEndpoint: string | null;
  serverEndpoint: string | null;
  memberId: string | null;
}
type BitrixEnvelope<T> = {
  result?: T;
  next?: number;
  error?: string;
  error_description?: string;
};

function appendBitrixFormValue(
  body: URLSearchParams,
  key: string,
  value: unknown,
) {
  if (value === undefined) return;
  if (value === null) {
    body.set(key, "");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      appendBitrixFormValue(body, `${key}[${index}]`, item),
    );
    return;
  }
  if (typeof value === "object") {
    for (const [nestedKey, nestedValue] of Object.entries(
      value as Record<string, unknown>,
    ))
      appendBitrixFormValue(body, `${key}[${nestedKey}]`, nestedValue);
    return;
  }
  body.set(key, String(value));
}

export class BitrixRestClient {
  private readonly fetcher: typeof fetch;
  private accessToken: string | undefined;
  private refreshToken: string | undefined;
  private accessTokenExpiresAt: number | null;
  private portalUrl: string | undefined;
  private refreshInFlight: Promise<string> | null = null;
  constructor(private readonly options: BitrixClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.portalUrl = options.portalUrl;
    this.accessTokenExpiresAt = options.accessTokenExpiresAt
      ? Date.parse(options.accessTokenExpiresAt)
      : null;
  }
  private canRefresh() {
    return Boolean(
      this.refreshToken && this.options.clientId && this.options.clientSecret,
    );
  }
  private shouldRefresh() {
    return Boolean(
      this.canRefresh() &&
      this.accessTokenExpiresAt !== null &&
      Number.isFinite(this.accessTokenExpiresAt) &&
      this.accessTokenExpiresAt <= Date.now() + 60_000,
    );
  }
  private async refreshAccessToken(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!this.canRefresh())
      throw new BitrixError(
        "AUTH",
        false,
        "Bitrix refresh credentials are not configured",
      );
    const runLocked =
      this.options.withRefreshLock ??
      (<T>(fn: (freshest: StoredBitrixTokens | null) => Promise<T>) =>
        fn(null));
    this.refreshInFlight = runLocked(async (freshest) => {
      // Another process may have rotated the tokens while we waited for the
      // lock; adopting its result avoids burning the one-shot refresh token.
      if (freshest?.accessToken && freshest.accessTokenExpiresAt) {
        const freshestExpiry = Date.parse(freshest.accessTokenExpiresAt);
        if (
          Number.isFinite(freshestExpiry) &&
          freshestExpiry > Date.now() + 120_000 &&
          freshest.accessToken !== this.accessToken
        ) {
          this.accessToken = freshest.accessToken;
          if (freshest.refreshToken) this.refreshToken = freshest.refreshToken;
          this.accessTokenExpiresAt = freshestExpiry;
          return this.accessToken;
        }
        if (freshest.refreshToken) this.refreshToken = freshest.refreshToken;
      }
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? 15_000,
      );
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await this.fetcher(
          this.options.tokenEndpoint ??
            "https://oauth.bitrix.info/oauth/token/",
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: this.options.clientId!,
              client_secret: this.options.clientSecret!,
              refresh_token: this.refreshToken!,
            }),
            signal: controller.signal,
          },
        );
      } finally {
        clearTimeout(timer);
      }
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok || typeof payload.access_token !== "string")
        throw new BitrixError(
          "AUTH",
          false,
          String(
            payload.error_description ??
              payload.error ??
              "Bitrix token refresh failed",
          ),
        );
      const expiresIn = Number(payload.expires_in ?? payload.expires ?? 3600);
      const accessTokenExpiresAt = new Date(
        Date.now() +
          (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) *
            1000,
      ).toISOString();
      this.accessToken = payload.access_token;
      this.refreshToken =
        typeof payload.refresh_token === "string"
          ? payload.refresh_token
          : this.refreshToken;
      this.accessTokenExpiresAt = Date.parse(accessTokenExpiresAt);
      if (typeof payload.client_endpoint === "string")
        this.portalUrl = payload.client_endpoint.replace(/\/rest\/?$/, "");
      await this.options.onTokenRefresh?.({
        accessToken: this.accessToken,
        refreshToken: this.refreshToken ?? null,
        accessTokenExpiresAt,
        clientEndpoint:
          typeof payload.client_endpoint === "string"
            ? payload.client_endpoint
            : null,
        serverEndpoint:
          typeof payload.server_endpoint === "string"
            ? payload.server_endpoint
            : null,
        memberId:
          typeof payload.member_id === "string" ? payload.member_id : null,
      });
      return this.accessToken;
    }).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<BitrixEnvelope<T>> {
    const maxAttempts = this.options.maxAttempts ?? 5;
    let authRefreshAttempted = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? 12_000,
      );
      try {
        if (!this.options.webhookUrl && this.shouldRefresh())
          await this.refreshAccessToken();
        const base =
          this.options.webhookUrl?.replace(/\/$/, "") ??
          `${this.portalUrl?.replace(/\/$/, "")}/rest`;
        const url = `${base}/${method}.json`;
        const body = new URLSearchParams();
        for (const [key, value] of Object.entries(params))
          appendBitrixFormValue(body, key, value);
        if (!this.options.webhookUrl && this.accessToken)
          body.set("auth", this.accessToken);
        const response = await this.fetcher(url, {
          method: "POST",
          body,
          signal: controller.signal,
        });
        const payload = (await response
          .json()
          .catch(() => ({}))) as BitrixEnvelope<T>;
        if (
          !this.options.webhookUrl &&
          !authRefreshAttempted &&
          this.canRefresh() &&
          (response.status === 401 || payload.error === "expired_token")
        ) {
          authRefreshAttempted = true;
          await this.refreshAccessToken();
          continue;
        }
        if (!response.ok || payload.error)
          throw Object.assign(
            new Error(
              payload.error_description ?? payload.error ?? "bitrix_error",
            ),
            { status: response.status, bitrixCode: payload.error },
          );
        return payload;
      } catch (error) {
        const normalized = normalizeBitrixError(error);
        const delay = crmRetryDelay(attempt);
        if (!normalized.retryable || delay === null || attempt === maxAttempts)
          throw normalized;
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new BitrixError("TEMPORARY", true, "Bitrix retry limit reached");
  }
  async paginate<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    const data: T[] = [];
    let start = 0;
    do {
      const page = await this.call<T[]>(method, { ...params, start });
      data.push(...(Array.isArray(page.result) ? page.result : []));
      start = typeof page.next === "number" ? page.next : -1;
    } while (start >= 0);
    return data;
  }
  batch(commands: Record<string, string>) {
    return this.call<Record<string, unknown>>("batch", {
      halt: 0,
      cmd: commands,
    });
  }
}

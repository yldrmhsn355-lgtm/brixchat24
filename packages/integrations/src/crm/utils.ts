import type { CrmErrorCode, CrmMatch } from "./types";

export class BitrixError extends Error {
  constructor(
    public readonly code: CrmErrorCode,
    public readonly retryable: boolean,
    message: string,
    public readonly retryAfterMs: number | null = null,
    public readonly providerCode: string | null = null,
  ) {
    super(message);
    this.name = "BitrixError";
  }
}

export function normalizeCrmPhone(value: string): string | null {
  const rawDigits = value.replace(/\D/g, "");
  const digits = rawDigits.startsWith("00") ? rawDigits.slice(2) : rawDigits;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

export function pickUnambiguousMatch(
  matches: readonly CrmMatch[],
): CrmMatch | null {
  const eligible = matches.filter((match) => match.confidence >= 0.95);
  return eligible.length === 1 ? eligible[0]! : null;
}

export function normalizeBitrixError(error: unknown): BitrixError {
  if (error instanceof BitrixError) return error;
  const item =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const status = typeof item.status === "number" ? item.status : 0;
  const bitrixCode = String(item.bitrixCode ?? "");
  const providerCode = bitrixCode || null;
  const message = String(item.message ?? "").trim();
  if (item.name === "AbortError")
    return new BitrixError(
      "TIMEOUT",
      true,
      "Bitrix request timed out",
      null,
      providerCode,
    );
  if (
    /NOT_FOUND|NOT_EXIST/i.test(bitrixCode) ||
    (status === 400 && /^not found$/i.test(message))
  )
    return new BitrixError(
      "NOT_FOUND",
      false,
      "Bitrix entity not found",
      null,
      providerCode,
    );
  // Bitrix reports throttling and server-side overload with HTTP 200 plus an
  // error code in the payload; these must retry instead of dead-lettering.
  if (
    /OPERATION_TIME_LIMIT|QUERY_LIMIT_EXCEEDED|TOO_MANY_REQUESTS|OVERLOAD_LIMIT|ERROR_UNEXPECTED_ANSWER|INTERNAL_SERVER_ERROR/i.test(
      bitrixCode,
    )
  )
    return new BitrixError(
      "RATE_LIMIT",
      true,
      "Bitrix throttled the request",
      null,
      providerCode,
    );
  if (status === 401)
    return new BitrixError(
      "AUTH",
      false,
      "Bitrix authentication failed",
      null,
      providerCode,
    );
  if (status === 403)
    return new BitrixError(
      "PERMISSION",
      false,
      "Bitrix permission denied",
      null,
      providerCode,
    );
  if (status === 404)
    return new BitrixError(
      "NOT_FOUND",
      false,
      "Bitrix entity not found",
      null,
      providerCode,
    );
  if (status === 429)
    return new BitrixError(
      "RATE_LIMIT",
      true,
      "Bitrix rate limit reached",
      null,
      providerCode,
    );
  if (status >= 500 || status === 0)
    return new BitrixError(
      "TEMPORARY",
      true,
      "Bitrix is temporarily unavailable",
      null,
      providerCode,
    );
  if (status >= 400)
    return new BitrixError(
      "VALIDATION",
      false,
      "Bitrix rejected the request",
      null,
      providerCode,
    );
  return new BitrixError(
    "PERMANENT",
    false,
    "Bitrix request failed",
    null,
    providerCode,
  );
}

export interface BitrixEventEntityReference {
  entityType: "contact" | "lead" | "deal" | "company";
  externalId: string;
}

function nestedRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "object" && nested !== null
    ? (nested as Record<string, unknown>)
    : null;
}

export function bitrixAuthPayload(payload: Record<string, unknown>) {
  const auth = nestedRecord(payload, "auth");
  const read = (key: string) =>
    auth?.[key] ?? payload[`auth[${key}]`] ?? payload[key];
  return {
    accessToken: String(read("access_token") ?? "").trim(),
    refreshToken: String(read("refresh_token") ?? "").trim(),
    applicationToken: String(read("application_token") ?? "").trim(),
    domain: String(read("domain") ?? "").trim(),
    memberId: String(read("member_id") ?? "").trim(),
    clientEndpoint: String(read("client_endpoint") ?? "").trim(),
    serverEndpoint: String(read("server_endpoint") ?? "").trim(),
    expiresIn: Number(read("expires_in") ?? 3600),
  };
}

export function bitrixEventEntityReference(
  eventType: string,
  payload: Record<string, unknown>,
): BitrixEventEntityReference | null {
  const normalized = eventType.toUpperCase();
  const entityType = (
    [
      ["CONTACT", "contact"],
      ["LEAD", "lead"],
      ["DEAL", "deal"],
      ["COMPANY", "company"],
    ] as const
  ).find(([marker]) => normalized.includes(marker))?.[1];
  if (!entityType) return null;
  const data = nestedRecord(payload, "data");
  const fields = data ? nestedRecord(data, "FIELDS") : null;
  const externalId = String(
    fields?.ID ??
      data?.ID ??
      payload["data[FIELDS][ID]"] ??
      payload["data[ID]"] ??
      "",
  ).trim();
  return externalId ? { entityType, externalId } : null;
}

export function crmRetryDelay(attempt: number): number | null {
  return [2_000, 10_000, 60_000, 300_000][attempt - 1] ?? null;
}

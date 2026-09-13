export type AutomationFailureDecision = {
  status: "retry" | "dead_letter";
  delayMs: number;
};

export function automationRetryDelay(attempt: number) {
  const normalizedAttempt = Math.max(1, Math.trunc(attempt));
  return Math.min(300_000, 1_000 * 2 ** (normalizedAttempt - 1));
}

export function automationFailureDecision(
  attempt: number,
  maxAttempts: number,
): AutomationFailureDecision {
  return attempt >= maxAttempts
    ? { status: "dead_letter", delayMs: 0 }
    : { status: "retry", delayMs: automationRetryDelay(attempt) };
}

export function redactedAutomationError(error: unknown) {
  const message = error instanceof Error ? error.message : "automation_error";
  const normalized = message
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || "automation_error";
}

export function bitrixDeliveryFailureBlockReason(
  eventType: unknown,
  payload: unknown,
) {
  if (eventType !== "message.delivery_failed") return null;
  const eventPayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return eventPayload.automationEligible === true
    ? null
    : "automation_bitrix_delivery_failure_not_customer_related";
}

export { automationActionConfigError } from "@brixchat/integrations";

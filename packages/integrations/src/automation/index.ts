import { isIP } from "node:net";
export type Condition = { field: string; operator: string; value: unknown };

export function normalizeAutomationText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("tr-TR")
    .replace(/\s+/g, " ")
    .trim();
}

// Operators whose comparison value must be non-empty: with an empty value,
// contains/starts_with degenerate to always-true ("x".includes("") === true)
// and not_contains to always-false. Fail closed instead of matching noise.
export const valueRequiredOperators = new Set([
  "contains",
  "not_contains",
  "starts_with",
]);

export function evaluateCondition(c: Condition, x: Record<string, unknown>) {
  const a = Object.prototype.hasOwnProperty.call(x, c.field)
    ? x[c.field]
    : undefined;
  if (
    valueRequiredOperators.has(c.operator) &&
    normalizeAutomationText(c.value) === ""
  )
    return false;
  if (c.operator === "equals") return a === c.value;
  if (c.operator === "contains")
    return normalizeAutomationText(a).includes(
      normalizeAutomationText(c.value),
    );
  if (c.operator === "in") return Array.isArray(c.value) && c.value.includes(a);
  if (c.operator === "exists") return a !== undefined && a !== null;
  if (c.operator === "not_equals") return a !== c.value;
  if (c.operator === "not_contains")
    return !normalizeAutomationText(a).includes(
      normalizeAutomationText(c.value),
    );
  if (c.operator === "starts_with")
    return normalizeAutomationText(a).startsWith(
      normalizeAutomationText(c.value),
    );
  if (c.operator === "is_empty")
    return (
      a === undefined ||
      a === null ||
      a === "" ||
      (Array.isArray(a) && a.length === 0)
    );
  if (c.operator === "is_not_empty")
    return !(
      a === undefined ||
      a === null ||
      a === "" ||
      (Array.isArray(a) && a.length === 0)
    );
  return false;
}
export const loopAllowed = (i: {
  depth: number;
  maxDepth: number;
  correlationId: string;
  seen: Set<string>;
}) => i.depth < i.maxDepth && !i.seen.has(i.correlationId);
export function safeWebhookTarget(value: string, allowedHosts: string[]) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (!allowedHosts.includes(h) || h === "localhost") return false;
  if (
    isIP(h) &&
    (h.startsWith("10.") ||
      h.startsWith("127.") ||
      h.startsWith("192.168.") ||
      h.startsWith("169.254.") ||
      h === "::1")
  )
    return false;
  return true;
}
export function withinWorkingHours(
  now: Date,
  timeZone: string,
  start: number,
  end: number,
) {
  const h = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone,
    }).format(now),
  );
  return h >= start && h < end;
}

export * from "./catalog";
export * from "./compiler";
export * from "./contracts";
export * from "./graph";
export * from "./registry";
export * from "./action-config";

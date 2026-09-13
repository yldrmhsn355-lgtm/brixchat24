export interface LogContext {
  requestId?: string;
  organizationId?: string;
  userId?: string;
  traceId?: string;
}
export const redact = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const safe = (key: string, item: unknown): unknown => {
    if (
      /token|secret|password|authorization|cookie|signed.?url|credential/i.test(
        key,
      )
    )
      return "[REDACTED]";
    if (Array.isArray(item)) return item.map((x) => safe(key, x));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([k, v]) => [
          k,
          safe(k, v),
        ]),
      );
    if (typeof item === "string") {
      const oneLine = item.replace(/[\r\n]+/g, " ");
      if (/phone|recipient|wa_id/i.test(key))
        return oneLine.length > 4
          ? `${"*".repeat(Math.min(8, oneLine.length - 4))}${oneLine.slice(-4)}`
          : "****";
      return oneLine;
    }
    return item;
  };
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, safe(key, item)]),
  );
};

export interface ErrorReporter {
  capture(error: Error, context: LogContext): Promise<string>;
}
export class StructuredLogErrorReporter implements ErrorReporter {
  async capture(error: Error, context: LogContext) {
    const eventId = crypto.randomUUID();
    process.stderr.write(
      JSON.stringify(
        redact({
          level: "error",
          event: "application.error",
          eventId,
          errorName: error.name,
          errorMessage: error.message,
          ...context,
        }),
      ) + "\n",
    );
    return eventId;
  }
}

const prometheusLabel = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

export class HttpRequestMetrics {
  private readonly requests = new Map<string, number>();
  private readonly durationMs = new Map<string, number>();

  record(input: {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
  }): void {
    const method = input.method.toUpperCase().slice(0, 12);
    const route = input.route.slice(0, 200);
    const statusClass = `${Math.floor(input.statusCode / 100)}xx`;
    const key = JSON.stringify([method, route, statusClass]);
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    this.durationMs.set(
      key,
      (this.durationMs.get(key) ?? 0) + Math.max(0, input.durationMs),
    );
  }

  renderPrometheus(): string {
    const lines = [
      "# HELP brixchat_http_requests_total HTTP requests by route template and status class.",
      "# TYPE brixchat_http_requests_total counter",
      "# HELP brixchat_http_request_duration_ms_sum Total HTTP request duration in milliseconds.",
      "# TYPE brixchat_http_request_duration_ms_sum counter",
    ];
    for (const [key, count] of [...this.requests.entries()].sort()) {
      const [method, route, statusClass] = JSON.parse(key) as string[];
      const labels = `method="${prometheusLabel(method!)}",route="${prometheusLabel(route!)}",status_class="${prometheusLabel(statusClass!)}"`;
      lines.push(`brixchat_http_requests_total{${labels}} ${count}`);
      lines.push(
        `brixchat_http_request_duration_ms_sum{${labels}} ${(this.durationMs.get(key) ?? 0).toFixed(3)}`,
      );
    }
    return lines.join("\n") + "\n";
  }
}

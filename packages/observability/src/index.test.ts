import { describe, expect, it } from "vitest";
import { HttpRequestMetrics, redact } from "./index";

describe("production log redaction", () => {
  it("redacts nested secrets, masks phones and prevents log injection", () => {
    const value = redact({
      authorization: "Bearer secret",
      phone: "+905551234567",
      note: "first\r\nsecond",
      nested: { refreshToken: "token-value" },
    });
    expect(value.authorization).toBe("[REDACTED]");
    expect(value.phone).toBe("********4567");
    expect(value.note).toBe("first second");
    expect(value.nested).toEqual({ refreshToken: "[REDACTED]" });
  });
});

describe("HTTP metrics", () => {
  it("uses bounded route templates and status classes without PII labels", () => {
    const metrics = new HttpRequestMetrics();
    metrics.record({
      method: "get",
      route: "/api/v1/conversations/:id",
      statusCode: 200,
      durationMs: 12.5,
    });
    metrics.record({
      method: "GET",
      route: "/api/v1/conversations/:id",
      statusCode: 204,
      durationMs: 7.5,
    });

    const output = metrics.renderPrometheus();
    expect(output).toContain('method="GET"');
    expect(output).toContain('route="/api/v1/conversations/:id"');
    expect(output).toContain('status_class="2xx"} 2');
    expect(output).toContain("} 20.000");
    expect(output).not.toContain("customer@example.com");
  });
});

import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

const jwtSecret = "test-secret-with-more-than-thirty-two-chars";

async function reportedIp(trustProxy?: false | number | string[]) {
  const app = buildApp({
    jwtSecret,
    webUrl: "http://localhost:3000",
    ...(trustProxy === undefined ? {} : { trustProxy }),
  });
  app.get("/_test/client-ip", async (request) => ({ ip: request.ip }));
  const response = await app.inject({
    method: "GET",
    url: "/_test/client-ip",
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-for": "203.0.113.42" },
  });
  await app.close();
  return response.json<{ ip: string }>().ip;
}

describe("Fastify trustProxy", () => {
  it("ignores a spoofed X-Forwarded-For header by default", async () => {
    await expect(reportedIp()).resolves.toBe("127.0.0.1");
  });

  it("uses forwarded client IP only after the proxy is explicitly trusted", async () => {
    await expect(reportedIp(["127.0.0.1"])).resolves.toBe("203.0.113.42");
  });
});

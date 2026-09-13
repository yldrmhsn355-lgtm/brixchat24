import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { resolveClientIp } from "./client-ip";

async function reportedIp(
  headers: Record<string, string>,
  trustProxyHeaders = true,
) {
  const app = Fastify({ trustProxy: trustProxyHeaders ? 2 : false });
  app.get("/", async (request) => ({
    ip: resolveClientIp(request, trustProxyHeaders),
  }));
  const response = await app.inject({
    method: "GET",
    url: "/",
    remoteAddress: "127.0.0.1",
    headers,
  });
  await app.close();
  return response.json<{ ip: string }>().ip;
}

describe("resolveClientIp", () => {
  it("uses the Cloudflare visitor IP behind a published edge", async () => {
    await expect(
      reportedIp({
        "x-real-ip": "162.158.129.196",
        "cf-connecting-ip": "203.0.113.42",
      }),
    ).resolves.toBe("203.0.113.42");
  });

  it("supports Cloudflare IPv6 edges", async () => {
    await expect(
      reportedIp({
        "x-real-ip": "2606:4700::1111",
        "cf-connecting-ip": "2001:db8::42",
      }),
    ).resolves.toBe("2001:db8::42");
  });

  it("uses Railway X-Real-IP for direct requests", async () => {
    await expect(reportedIp({ "x-real-ip": "198.51.100.17" })).resolves.toBe(
      "198.51.100.17",
    );
  });

  it("rejects a spoofed Cloudflare header on direct Railway traffic", async () => {
    await expect(
      reportedIp({
        "x-real-ip": "198.51.100.17",
        "cf-connecting-ip": "203.0.113.42",
      }),
    ).resolves.toBe("198.51.100.17");
  });

  it("rejects comma-separated visitor header values", async () => {
    await expect(
      reportedIp({
        "x-real-ip": "162.158.129.196",
        "cf-connecting-ip": "203.0.113.42, 198.51.100.17",
      }),
    ).resolves.toBe("162.158.129.196");
  });

  it("ignores X-Real-IP entirely when no proxy is trusted", async () => {
    await expect(
      reportedIp({ "x-real-ip": "198.51.100.17" }, false),
    ).resolves.toBe("127.0.0.1");
  });

  it("ignores Cloudflare headers when no proxy is trusted", async () => {
    await expect(
      reportedIp(
        {
          "x-real-ip": "162.158.129.196",
          "cf-connecting-ip": "203.0.113.42",
        },
        false,
      ),
    ).resolves.toBe("127.0.0.1");
  });
});

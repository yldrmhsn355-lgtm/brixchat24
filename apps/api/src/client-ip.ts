import type { FastifyRequest } from "fastify";
import { BlockList, isIP } from "node:net";

// Published by Cloudflare at https://www.cloudflare.com/ips-v4 and /ips-v6.
const cloudflareCidrs = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

const cloudflareProxies = new BlockList();
for (const cidr of cloudflareCidrs) {
  const [network, prefixText] = cidr.split("/");
  const family = isIP(network!) === 6 ? "ipv6" : "ipv4";
  cloudflareProxies.addSubnet(network!, Number(prefixText), family);
}

function headerIp(value: string | string[] | undefined): string | null {
  if (Array.isArray(value) || !value) return null;
  const normalized = value.trim();
  if (!normalized || normalized.includes(",")) return null;
  if (normalized.startsWith("::ffff:")) {
    const ipv4 = normalized.slice(7);
    return isIP(ipv4) === 4 ? ipv4 : null;
  }
  return isIP(normalized) ? normalized : null;
}

function isCloudflareProxy(ip: string): boolean {
  const family = isIP(ip) === 6 ? "ipv6" : "ipv4";
  return cloudflareProxies.check(ip, family);
}

/**
 * Railway owns X-Real-IP. When that peer is a published Cloudflare edge,
 * Cloudflare's single-value CF-Connecting-IP is the original visitor address.
 * Direct Railway traffic cannot spoof it because X-Real-IP will not be a
 * Cloudflare network address.
 *
 * Both headers are client-controlled when the app is reached directly, so
 * they are only honored when the deployment declares a trusted proxy in
 * front of it (TRUST_PROXY); otherwise the socket address wins.
 */
export function resolveClientIp(
  request: FastifyRequest,
  trustProxyHeaders = false,
): string {
  if (!trustProxyHeaders) return request.ip;
  const railwayIp = headerIp(request.headers["x-real-ip"]);
  const cloudflareIp = headerIp(request.headers["cf-connecting-ip"]);
  const upstreamIp = railwayIp ?? request.ip;

  if (cloudflareIp && isIP(upstreamIp) && isCloudflareProxy(upstreamIp))
    return cloudflareIp;
  return railwayIp ?? request.ip;
}

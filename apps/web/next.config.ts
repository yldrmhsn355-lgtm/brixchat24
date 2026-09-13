import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function publicConnectionSources(
  name: string,
  value: string | undefined,
): string[] {
  const configured = value?.trim();
  if (!configured || configured.startsWith("/")) return [];

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(
      `${name} must be an absolute HTTP(S) URL or a root-relative path.`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }

  const websocketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  return [url.origin, `${websocketProtocol}//${url.host}`];
}

const connectSources = new Set([
  "'self'",
  ...publicConnectionSources(
    "NEXT_PUBLIC_API_URL",
    process.env.NEXT_PUBLIC_API_URL,
  ),
  ...publicConnectionSources(
    "NEXT_PUBLIC_REALTIME_URL",
    process.env.NEXT_PUBLIC_REALTIME_URL,
  ),
]);
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  `connect-src ${Array.from(connectSources).join(" ")}`,
].join("; ");

const securityHeaders = [
  ...(process.env.NODE_ENV === "production"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains; preload",
        },
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
      ]
    : []),
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), payment=(), microphone=(self)",
  },
];

const config: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@brixchat/shared", "@brixchat/ui"],
  turbopack: { root },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};
export default config;

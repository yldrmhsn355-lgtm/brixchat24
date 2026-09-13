import { describe, expect, it } from "vitest";
import { resolveServiceDatabaseUrl } from "./index";

describe("resolveServiceDatabaseUrl", () => {
  it("prefers the API-specific credential", () => {
    expect(
      resolveServiceDatabaseUrl(
        {
          API_DATABASE_URL: "postgresql://api@db/app",
          DATABASE_URL: "postgresql://owner@db/app",
        },
        "api",
      ),
    ).toEqual({
      url: "postgresql://api@db/app",
      source: "API_DATABASE_URL",
    });
  });

  it("prefers the worker-specific credential", () => {
    expect(
      resolveServiceDatabaseUrl(
        {
          WORKER_DATABASE_URL: "postgresql://worker@db/app",
          DATABASE_URL: "postgresql://owner@db/app",
        },
        "worker",
      ),
    ).toEqual({
      url: "postgresql://worker@db/app",
      source: "WORKER_DATABASE_URL",
    });
  });

  it("keeps DATABASE_URL as a compatibility fallback", () => {
    expect(
      resolveServiceDatabaseUrl(
        { DATABASE_URL: "postgresql://local@db/app" },
        "api",
      ),
    ).toEqual({
      url: "postgresql://local@db/app",
      source: "DATABASE_URL",
    });
  });
});

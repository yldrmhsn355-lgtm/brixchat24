import { describe, expect, it } from "vitest";
import { deploymentMetadata } from "./deployment-metadata";

describe("deployment metadata", () => {
  it("prefers Railway-provided Git and deployment identity", () => {
    expect(
      deploymentMetadata(
        {
          APP_VERSION: "1.2.3",
          GIT_COMMIT_SHA: "stale-manual-sha",
          RAILWAY_GIT_COMMIT_SHA:
            "380f352d8a7c131c3f756e56f5ee275ccf20c999",
          RAILWAY_GIT_BRANCH: "codex/production-release-20260718",
          RAILWAY_DEPLOYMENT_ID: "deployment-123",
          BUILD_TIME: "2026-07-19T12:00:00.000Z",
        },
        "2026-07-25T16:00:00.000Z",
      ),
    ).toEqual({
      version: "1.2.3",
      commitSha: "380f352d8a7c131c3f756e56f5ee275ccf20c999",
      buildTime: "2026-07-25T16:00:00.000Z",
      deploymentId: "deployment-123",
      sourceBranch: "codex/production-release-20260718",
    });
  });

  it("keeps one runtime timestamp when Railway has a stale BUILD_TIME", () => {
    const env = {
      RAILWAY_DEPLOYMENT_ID: "deployment-456",
      BUILD_TIME: "replace-at-build",
    };
    const first = deploymentMetadata(env, "2026-07-25T16:01:00.000Z");
    const second = deploymentMetadata(env, "2026-07-25T16:01:00.000Z");
    expect(first.buildTime).toBe("2026-07-25T16:01:00.000Z");
    expect(second.buildTime).toBe(first.buildTime);
  });

  it("keeps legacy metadata as a local fallback", () => {
    expect(
      deploymentMetadata({ GIT_COMMIT_SHA: "legacy-sha", BUILD_TIME: "local" }),
    ).toMatchObject({
      commitSha: "legacy-sha",
      buildTime: "local",
      deploymentId: "development",
      sourceBranch: "development",
    });
  });
});

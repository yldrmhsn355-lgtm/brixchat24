import { describe, expect, it } from "vitest";
import {
  parseConfig,
  parseTrustProxy,
  resolveAutomationRuntimeConfig,
  resolveWorkerHealthPort,
} from "./index";

const requiredConfig = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/brixchat",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "test-secret-with-more-than-thirty-two-chars",
};

describe("parseTrustProxy", () => {
  it("does not trust forwarded headers without explicit configuration", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
  });

  it("accepts a verified hop count or explicit proxy allow-list", () => {
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("loopback, 10.0.0.0/8")).toEqual([
      "loopback",
      "10.0.0.0/8",
    ]);
  });

  it("rejects blanket proxy trust", () => {
    expect(() => parseTrustProxy("true")).toThrow(/positive hop count/);
    expect(() => parseTrustProxy("*")).toThrow(/positive hop count/);
  });

  it("is enforced by the environment schema", () => {
    expect(
      parseConfig({ ...requiredConfig, TRUST_PROXY: "2" }).TRUST_PROXY,
    ).toBe(2);
    expect(() =>
      parseConfig({ ...requiredConfig, TRUST_PROXY: "true" }),
    ).toThrow(/positive hop count/);
  });
});

describe("resolveWorkerHealthPort", () => {
  it("prefers Railway PORT when it is present", () => {
    expect(
      resolveWorkerHealthPort({ PORT: "9876", WORKER_HEALTH_PORT: "4100" }),
    ).toBe(9876);
  });

  it("preserves the worker-specific and local fallbacks", () => {
    expect(resolveWorkerHealthPort({ WORKER_HEALTH_PORT: "4200" })).toBe(4200);
    expect(resolveWorkerHealthPort({})).toBe(4100);
  });

  it("rejects invalid ports", () => {
    expect(() => resolveWorkerHealthPort({ PORT: "70000" })).toThrow(
      /valid TCP port/,
    );
  });
});

describe("resolveAutomationRuntimeConfig", () => {
  it("provides bounded production-safe defaults", () => {
    expect(resolveAutomationRuntimeConfig({})).toEqual({
      workerConcurrency: 2,
      maxSteps: 100,
      maxLoopIterations: 20,
      maxExecutionDurationMs: 3_600_000,
      maxSubflowDepth: 5,
      defaultRetryLimit: 5,
      staleExecutionMinutes: 5,
      staleLockSeconds: 120,
      eventRetentionDays: 90,
      logRetentionDays: 30,
      webhookTimeoutMs: 10_000,
      maxActionsPerRun: 20,
    });
  });

  it("parses explicit values and rejects unsafe limits", () => {
    expect(
      resolveAutomationRuntimeConfig({
        AUTOMATION_MAX_STEPS: "250",
        AUTOMATION_MAX_SUBFLOW_DEPTH: "8",
        AUTOMATION_WEBHOOK_TIMEOUT_MS: "30000",
      }),
    ).toMatchObject({
      maxSteps: 250,
      maxSubflowDepth: 8,
      webhookTimeoutMs: 30_000,
    });

    expect(() =>
      resolveAutomationRuntimeConfig({ AUTOMATION_MAX_STEPS: "1001" }),
    ).toThrow(/AUTOMATION_MAX_STEPS/);
  });
});

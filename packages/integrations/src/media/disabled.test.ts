import { describe, it, expect } from "vitest";
import {
  createObjectStorageProvider,
  createMalwareScanner,
  assertProductionMediaAdapters,
} from "./index";

describe("unconfigured external media services", () => {
  const env = {
    NODE_ENV: "production",
    OBJECT_STORAGE_PROVIDER: "disabled",
    MALWARE_SCANNER_PROVIDER: "disabled",
  };
  it("starts but never stores or declares an unscanned file clean", async () => {
    expect(() => assertProductionMediaAdapters(env)).not.toThrow();
    const storage = createObjectStorageProvider(env);
    await expect(
      storage.putObject({
        key: "test",
        contentType: "text/plain",
        body: new ReadableStream(),
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_NOT_CONFIGURED",
      statusCode: 503,
    });
    await expect(storage.getObject({ key: "test" })).rejects.toMatchObject({
      code: "STORAGE_NOT_CONFIGURED",
    });
    await expect(storage.healthCheck()).resolves.toMatchObject({
      healthy: false,
    });
    const scanner = createMalwareScanner(env);
    await expect(
      scanner.scan({ stream: new ReadableStream() }),
    ).resolves.toMatchObject({ status: "failed" });
  });
});

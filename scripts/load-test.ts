import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
async function main() {
const profile = process.argv[2] === "standard" ? "standard" : "smoke",
  base = process.env.LOAD_TEST_BASE_URL ?? "http://localhost:4400",
  count = profile === "standard" ? 250 : 25,
  concurrency = profile === "standard" ? 25 : 5,
  latencies: number[] = [],
  failures: string[] = [];
for (let offset = 0; offset < count; offset += concurrency)
  await Promise.all(
    Array.from({ length: Math.min(concurrency, count - offset) }, async () => {
      const start = performance.now();
      try {
        const response = await fetch(`${base}/health/live`);
        if (!response.ok) failures.push(String(response.status));
      } catch (error) {
        failures.push(
          error instanceof Error ? error.message : "request_failed",
        );
      } finally {
        latencies.push(performance.now() - start);
      }
    }),
  );
latencies.sort((a, b) => a - b);
const p95 = latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? 0,
  errorRate = failures.length / count,
  passed = p95 < 500 && errorRate < 0.01;
await mkdir(joinPath("artifacts", "performance"), { recursive: true });
const markdown = `# Load test report\n\nProfile: ${profile}\n\nRequests: ${count}\n\nConcurrency: ${concurrency}\n\np95: ${p95.toFixed(2)} ms\n\nError rate: ${(errorRate * 100).toFixed(2)}%\n\nResult: **${passed ? "PASS" : "FAIL"}**\n\nThis credential-free profile validates local HTTP acceptance. Full k6 scenario targets remain staging acceptance.\n`;
await writeFile(
  joinPath("artifacts", "performance", "load-test-report.md"),
  markdown,
);
if (!passed) process.exitCode = 1;
function joinPath(...parts: string[]) {
  return parts.join("/");
}
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const targetArg =
      process.argv.find((x) => x.startsWith("--target="))?.split("=")[1] ??
      "local",
    base =
      targetArg === "local"
        ? "http://localhost:4400"
        : process.env[`${targetArg.toUpperCase()}_API_URL`];
  if (!base) throw new Error(`Missing ${targetArg} API URL`);
  const checks = [
    "/health/live",
    "/health/ready",
    "/health/configuration",
    "/version",
  ];
  let failed = false;
  for (const path of checks) {
    const response = await fetch(`${base}${path}`);
    const body = await response.json().catch(() => ({}));
    process.stdout.write(
      JSON.stringify({
        target: targetArg,
        path,
        status: response.status,
        body,
      }) + "\n",
    );
    if (!response.ok) failed = true;
  }
  if (failed) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

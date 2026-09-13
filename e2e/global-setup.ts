import { execFileSync } from "node:child_process";
import {
  localApiUrl,
  localComposeEnvironment,
  localWebUrl,
} from "./local-environment";

function isLoopback(url: string) {
  const hostname = new URL(url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export default function globalSetup() {
  const webUrl = localWebUrl;
  const apiUrl = localApiUrl;
  const localEnvironment = isLoopback(webUrl) && isLoopback(apiUrl);

  if (!localEnvironment) {
    if (process.env.ALLOW_REMOTE_E2E !== "true") {
      throw new Error(
        "REMOTE_E2E_DISABLED: set ALLOW_REMOTE_E2E=true only for an explicitly approved non-production test environment",
      );
    }
    return;
  }

  // Recreate dependants as well as PostgreSQL/Redis. Otherwise a port-driven
  // worktree reconfiguration can leave an apparently healthy worker attached
  // to the previous Compose network.
  execFileSync(
    "docker",
    ["compose", "up", "-d", "--force-recreate", "--wait"],
    {
      stdio: "inherit",
      env: localComposeEnvironment,
    },
  );
  execFileSync(
    "docker",
    [
      "compose",
      "run",
      "--rm",
      "migrate",
      "node",
      "node_modules/tsx/dist/cli.mjs",
      "packages/database/src/seed.ts",
    ],
    {
      stdio: "inherit",
      env: localComposeEnvironment,
    },
  );
}

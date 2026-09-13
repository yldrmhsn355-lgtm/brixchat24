import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { can, roles } from "../packages/auth/src/index";

const mode = process.argv[2];
async function main() {
await mkdir("artifacts/security", { recursive: true });
if (mode === "rbac") {
  const matrix = Object.fromEntries(
    roles.map((role) => [
      role,
      {
        privacyRead: can(role, "privacy:read"),
        privacyManage: can(role, "privacy:manage"),
        usageRead: can(role, "usage:read"),
      },
    ]),
  );
  const pass =
    matrix.owner.privacyManage &&
    matrix.admin.privacyManage &&
    !matrix.agent.privacyManage &&
    !matrix.viewer.privacyManage;
  await writeFile(
    "artifacts/security/rbac-matrix.json",
    JSON.stringify({ pass, matrix }, null, 2),
  );
  if (!pass) process.exitCode = 1;
} else if (mode === "tenant-isolation") {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli)
    throw new Error("pnpm_cli_not_available_for_security_verification");
  const appVerification = spawnSync(
    process.execPath,
    [
      pnpmCli,
      "--filter",
      "@brixchat/api",
      "exec",
      "vitest",
      "run",
      "src/app.test.ts",
      "-t",
      "isolates tenants and agent assignments",
    ],
    { stdio: "inherit", shell: false },
  );
  const rlsVerification = spawnSync(
    process.execPath,
    [
      pnpmCli,
      "--filter",
      "@brixchat/api",
      "exec",
      "vitest",
      "run",
      "src/tenant-isolation-rls.test.ts",
    ],
    { stdio: "inherit", shell: false },
  );
  const pass =
    appVerification.status === 0 && rlsVerification.status === 0;
  await writeFile(
    "artifacts/security/tenant-isolation.json",
    JSON.stringify(
      {
        pass,
        status: pass
          ? "verified_by_api_integration_test"
          : "api_integration_test_failed",
        commands: [
          "pnpm --filter @brixchat/api exec vitest run src/app.test.ts -t \"isolates tenants and agent assignments\"",
          "pnpm --filter @brixchat/api exec vitest run src/tenant-isolation-rls.test.ts",
        ],
        controls: [
          "organization_id derived from authenticated session",
          "repository queries scoped by organization_id",
          "cross-tenant API test executed by this verification command",
          "RLS (migration 0040) blocks unfiltered/mismatched-org queries at the database level for the brixchat_app_scoped role",
        ],
      },
      null,
      2,
    ),
  );
  if (!pass)
    process.exitCode = appVerification.status || rlsVerification.status || 1;
} else throw new Error("Use rbac or tenant-isolation");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

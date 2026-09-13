# Phase 0 Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current `master` release path fail safely, build the three production images deterministically, start read-only API/worker containers without filesystem errors, and remove currently reported high-severity runtime dependency advisories.

**Architecture:** Keep the existing pnpm/Turborepo and Railway/Docker topology. Add a source-level regression test around the release configuration, make the shell entrypoint initialize media storage only for the local-storage adapter, and make the production Compose manifest both buildable and health-checkable. Dependency remediation stays limited to packages named by the current audit and is accepted only after targeted tests, builds, and a fresh audit.

**Tech Stack:** Node.js 22, pnpm 11, TypeScript 5.9, Vitest 3, Docker Compose, GitHub Actions, Next.js 16, Fastify 5, Sharp.

## Global Constraints

- Work only in `.worktrees/phase0-production-hardening` on `codex/phase0-production-hardening`.
- Do not connect to or mutate production PostgreSQL, Redis, Railway, Meta, Bitrix24, Google Drive, R2, or ClamAV.
- Do not merge, push, deploy, rotate credentials, or alter live webhooks.
- Keep PostgreSQL and object storage authoritative; this phase does not change runtime message behavior.
- Preserve existing developer Compose behavior with local media at `/data/media`.
- Stage only files named by this plan.

---

### Task 1: Release and container configuration regression shield

**Files:**
- Create: `scripts/production-release-config.test.ts`
- Modify: `package.json`
- Test: `scripts/production-release-config.test.ts`

**Interfaces:**
- Consumes: repository-root configuration files as UTF-8 text.
- Produces: a Vitest gate that asserts the CI branch, production image build definitions, service healthchecks, and local-storage-only entrypoint initialization.

- [x] **Step 1: Write the failing configuration test**

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFile(path, "utf8");

describe("production release configuration", () => {
  it("runs CI for the repository default branch", async () => {
    expect(await source(".github/workflows/ci.yml")).toMatch(
      /branches:\s*\[(?:[^\]]*\bmaster\b[^\]]*)\]/,
    );
  });

  it("builds and health-checks every application service", async () => {
    const compose = await source("docker-compose.production.yml");
    for (const dockerfile of [
      "apps/api/Dockerfile",
      "apps/worker/Dockerfile",
      "apps/web/Dockerfile",
    ]) expect(compose).toContain(`dockerfile: ${dockerfile}`);
    expect(compose.match(/healthcheck:/g)).toHaveLength(3);
  });

  it("does not write a local media directory for remote storage", async () => {
    const entrypoint = await source("docker-entrypoint.sh");
    expect(entrypoint).toContain('${OBJECT_STORAGE_PROVIDER:-local}');
    expect(entrypoint).toContain('${OBJECT_STORAGE_LOCAL_PATH:-/data/media}');
  });
});
```

- [x] **Step 2: Add the test to the release-tooling test script**

Change `test:release-tooling` to include `scripts/production-release-config.test.ts`.

- [x] **Step 3: Run the test and verify it fails**

Run: `pnpm vitest run scripts/production-release-config.test.ts`

Expected: failures for missing `master`, missing production build blocks/healthchecks, and unconditional media initialization.

- [x] **Step 4: Commit the red test with the implementation task or retain it unstaged until green**

No production configuration may be changed before the failure is observed.

### Task 2: Repair CI, production image build, healthchecks, and entrypoint

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `docker-compose.production.yml`
- Modify: `docker-entrypoint.sh`
- Test: `scripts/production-release-config.test.ts`

**Interfaces:**
- Consumes: existing app Dockerfiles and environment contracts.
- Produces: CI on `master`, buildable image definitions, three healthchecks, and an entrypoint compatible with `read_only: true` when storage is S3/R2.

- [x] **Step 1: Correct the default branch trigger**

Use `branches: [master]` for push events; pull requests remain enabled for every branch.

- [x] **Step 2: Make media initialization adapter-aware**

Implement this exact shell behavior before `exec`:

```sh
if [ "${OBJECT_STORAGE_PROVIDER:-local}" = "local" ]; then
  media_path="${OBJECT_STORAGE_LOCAL_PATH:-/data/media}"
  mkdir -p "$media_path"
  chown -R node:node "$media_path"
fi
```

- [x] **Step 3: Add build definitions and runtime healthchecks**

For `api`, `worker`, and `web`, add `build.context: .` with their existing Dockerfile. Add Node-fetch healthchecks for API `/health/ready`, worker `/`, and web `/login`. Keep secrets, read-only filesystems, networks, and restart policies unchanged.

- [x] **Step 4: Make the release workflow provide non-secret configuration placeholders**

At job scope define placeholder `ACME_EMAIL` and local candidate image tags so `docker compose config` can render without production credentials. Build only `api worker web`; do not start services or push images.

- [x] **Step 5: Run the targeted test**

Run: `pnpm vitest run scripts/production-release-config.test.ts`

Expected: PASS, 3 tests.

- [x] **Step 6: Render the production Compose manifest**

Run in PowerShell:

```powershell
$env:ACME_EMAIL='ci@example.invalid'
$env:BRIXCHAT_API_IMAGE='brixchat24-api:phase0'
$env:BRIXCHAT_WORKER_IMAGE='brixchat24-worker:phase0'
$env:BRIXCHAT_WEB_IMAGE='brixchat24-web:phase0'
$env:BRIXCHAT_API_ENV_FILE='.env.production.example'
$env:BRIXCHAT_WORKER_ENV_FILE='.env.production.example'
docker compose -f docker-compose.production.yml config --quiet
```

Expected: exit code 0.

### Task 3: Remediate high-severity runtime dependency advisories

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/api/package.json` only if Fastify requires a direct update
- Modify: `apps/worker/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: current `pnpm audit --json` advisory set.
- Produces: patched Next.js, Sharp, Fastify routing/URI dependencies, PostCSS, and compatible transitive packages without changing application APIs.

- [x] **Step 1: Record the failing audit baseline**

Run: `pnpm audit --audit-level=high`

Expected baseline: non-zero with 18 high advisories, including Next.js, Sharp, `fast-uri`, `find-my-way`, PostCSS, and Nano ID paths.

- [x] **Step 2: Apply the minimum compatible direct updates**

Run:

```powershell
pnpm --filter @brixchat/web update next@16.2.11
pnpm --filter @brixchat/worker update sharp@0.35.0
pnpm --filter @brixchat/api update fastify@latest
pnpm update -r
```

Do not accept a major-version change outside the packages named above. If a high advisory remains only because a transitive range cannot resolve a patched version, add the narrowest root `pnpm.overrides` entry and document the dependency path in the commit message.

- [x] **Step 3: Re-run the security audit**

Run: `pnpm audit --audit-level=high`

Expected: no high or critical runtime advisories. Dev-only advisories must be reported separately if the package manager still classifies them as high.

- [x] **Step 4: Run package verification**

Run:

```powershell
pnpm --filter @brixchat/web test
pnpm --filter @brixchat/api typecheck
pnpm --filter @brixchat/worker typecheck
pnpm --filter @brixchat/web build
```

Expected: every command exits 0.

### Task 4: Final Phase 0 gates and handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-08-16-phase0-production-hardening.md` checkbox state only

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: a reviewable branch with explicit evidence and no production mutation.

- [x] **Step 1: Run the repository gates**

Run:

```powershell
pnpm test:release-tooling
pnpm architecture:check
pnpm typecheck
```

Expected: all pass. If the pre-existing database-boundary gate still fails, record the exact unchanged baseline failure and do not hide it by raising the ceiling.

- [x] **Step 2: Inspect the diff and worktree**

Run: `git status --short` and `git diff --check`.

Expected: only planned files, no whitespace errors.

- [x] **Step 3: Update Graphify after code/config modifications**

Run: `graphify update . --force` from the worktree. If Graphify is unavailable, report the gap and do not fabricate freshness.

Verification note (2026-08-16): Graphify updated successfully. The initial full
`pnpm test` run used a ten-day-old local `brixchat24-api:latest` image containing
only migrations 0000-0031. Rebuilding the image exposed migrations 0032-0038;
the database then recorded all 39 journal entries, created
`users.is_platform_admin`, and seeded successfully. A fresh-database run leaves
three API integration failures; the same three failures reproduce on unchanged
`master` with its original dependency set, so they are pre-existing baseline
failures rather than Phase 0 regressions. Separately, the pre-existing
database-boundary gate reports 208 direct SQL awaits.

- [x] **Step 4: Commit only after all non-pre-existing gates pass**

```powershell
git add .github/workflows/ci.yml .github/workflows/release.yml docker-compose.production.yml docker-entrypoint.sh package.json apps/web/package.json apps/api/package.json apps/worker/package.json pnpm-lock.yaml scripts/production-release-config.test.ts docs/superpowers/plans/2026-08-16-phase0-production-hardening.md
git commit -m "fix(release): harden production build and startup gates"
```

Do not push or merge without a separate user instruction.

## Follow-on plans

1. Tenant RLS and scoped non-owner database role rollout.
2. API repository extraction and database-boundary baseline reduction.
3. Worker role separation and queue isolation.
4. OpenAPI contract generation, distributed rate limiting, and observability wiring.

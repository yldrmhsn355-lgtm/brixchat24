import { defineConfig } from "vitest/config";

// The root `test:release-tooling` run passes bare file names as filters, which
// also match copies under .worktrees/ and .backups/. Only this repo's own
// scripts/ directory is in scope here.
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/.worktrees/**",
      "**/.backups/**",
      "**/dist/**",
    ],
  },
});

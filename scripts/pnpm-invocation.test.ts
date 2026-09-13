import assert from "node:assert/strict";
import test from "node:test";
import { getPnpmInvocation } from "./pnpm-invocation";

test("uses the Windows command shell for pnpm command shims", () => {
  assert.deepEqual(
    getPnpmInvocation(["db:migrate"], "win32", "C:\\Windows\\System32\\cmd.exe"),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm", "db:migrate"],
    },
  );
});

test("falls back to cmd.exe when ComSpec is unavailable", () => {
  assert.equal(getPnpmInvocation([], "win32", "").command, "cmd.exe");
});

test("executes pnpm directly on non-Windows platforms", () => {
  assert.deepEqual(getPnpmInvocation(["db:migrate"], "linux"), {
    command: "pnpm",
    args: ["db:migrate"],
  });
});

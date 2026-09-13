export type PnpmInvocation = {
  command: string;
  args: string[];
};

export function getPnpmInvocation(
  args: string[],
  platform: NodeJS.Platform = process.platform,
  commandShell: string | undefined = process.env.ComSpec,
): PnpmInvocation {
  if (platform === "win32") {
    return {
      command: commandShell || "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm", ...args],
    };
  }

  return { command: "pnpm", args: [...args] };
}

import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { ShellSandboxMode } from "./types";

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  shell: boolean;
}

export function buildShellSpawn(command: string, cwd: string, sandbox: ShellSandboxMode = "off"): SpawnSpec {
  const root = path.resolve(cwd);
  if (sandbox === "off") return { file: command, args: [], cwd: root, shell: true };

  return {
    file: "bwrap",
    args: [
      "--unshare-all",
      "--share-net",
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      root,
      root,
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--chdir",
      root,
      "/bin/sh",
      "-lc",
      command,
    ],
    cwd: root,
    shell: false,
  };
}

export function validateShellSandbox(sandbox: ShellSandboxMode = "off"): string | null {
  if (sandbox === "off") return null;
  if (process.platform !== "linux") return "AGENT_SHELL_SANDBOX=readonly-root 只能在 Linux 上使用";
  if (!findOnPath("bwrap")) return "AGENT_SHELL_SANDBOX=readonly-root 需要先安装 bubblewrap(bwrap)";
  return null;
}

function findOnPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

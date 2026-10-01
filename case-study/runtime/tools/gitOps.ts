import { z } from "zod";
import type { Tool } from "./types";
import { runCommand } from "./exec";

// ┌─ 为什么把 git status / git diff 单独做成工具？─────────────────────────────┐
// 能力上它们 = runShell("git status") / runShell("git diff")，模型完全能用 shell 代替。
// 但仍值得单列，凭两条：
//   1) 高频：coding loop 里几乎每改一步都要看「现在什么状态 / 改了什么」。做成一等工具，
//      模型能可靠地、语义清晰地用对它们（transcript 里直接是 gitDiff，而不是淹没在一堆 runShell 里）。
//   2) 只读、天然安全：它们不改任何东西，第 2 周的权限层可直接判 safe、放行；
//      这样需要严格盯防的「危险面」就收缩到只剩 runShell。
// 反例对照：editFile 单列是靠 reliability（str_replace 的安全）；这俩靠的是「高频 + 只读安全」。

export const gitStatus: Tool<Record<string, never>> = {
  name: "gitStatus",
  description: "查看工作区 git 状态（哪些文件被改/新增/删除）。只读、安全。",
  schema: z.object({}),
  async run(_input, ctx) {
    const r = await runCommand("git status --short", ctx.workingDir);
    if (r.exitCode !== 0) return `error: ${r.stderr.trim() || "git status 失败"}`;
    return r.stdout.trim() || "(工作区干净)"; // 空输出兜成清晰提示，别给模型空字符串
  },
};

export const gitDiff: Tool<{ path?: string }> = {
  name: "gitDiff",
  description: "查看尚未提交的改动内容（unified diff）。只读、安全。可选 path 限定范围。",
  schema: z.object({ path: z.string().optional().describe("限定某个文件/目录，不填看全部") }),
  async run({ path: p }, ctx) {
    // 用 `--` 把 path 当作 pathspec（而非选项），并加引号防空格；只读工具，风险低
    const cmd = p ? `git diff -- ${JSON.stringify(p)}` : "git diff";
    const r = await runCommand(cmd, ctx.workingDir);
    if (r.exitCode !== 0) return `error: ${r.stderr.trim() || "git diff 失败"}`;
    return r.stdout.trim() || "(无改动)";
  },
};

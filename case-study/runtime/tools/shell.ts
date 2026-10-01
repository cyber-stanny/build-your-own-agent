import { z } from "zod";
import type { Tool } from "./types";
import { runCommand } from "./exec";

// runShell：agent 真正的「手」。能跑命令是 coding agent 的核心，但也最危险。
// 第 2 周会加权限层：runShell 是唯一需要严格盯防的「危险面」，
// 而 readFile/gitDiff/gitStatus 等只读工具可被判 safe、放行（见 gitOps.ts 的说明）。
export const runShell: Tool<{ command: string }> = {
  name: "runShell",
  description:
    "在工作目录下执行一条会自然结束的 shell 命令，返回 exit_code / stdout / stderr。不要用它启动 dev server、watch、http server 等长期进程；这类命令请用 startProcess。",
  schema: z.object({ command: z.string() }),
  async run({ command }, ctx) {
    const longRunning = looksLikeLongRunningCommand(command);
    if (longRunning) {
      return [
        "exit_code: -1",
        "stderr:",
        `这个命令看起来是长期进程（${longRunning.reason}），不适合用 runShell 执行。`,
        "请改用 startProcess 启动，用 readProcessLog 查看日志，用 stopProcess 停止。",
      ].join("\n");
    }

    const r = await runCommand(command, ctx.workingDir, 30_000, { shellSandbox: ctx.shellSandbox, signal: ctx.signal });
    return [
      `exit_code: ${r.exitCode}`,
      r.stdout && `stdout:\n${r.stdout}`,
      r.stderr && `stderr:\n${r.stderr}`,
    ]
      .filter(Boolean)
      .join("\n");
  },
};

const LONG_RUNNING_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /^(npm|pnpm|yarn|bun)\s+(run\s+)?dev(\s|$)/i, reason: "前端开发服务器" },
  { re: /^(npx\s+)?vite(\s+dev)?(\s|$)/i, reason: "Vite 开发服务器" },
  { re: /^(npx\s+)?next\s+dev(\s|$)/i, reason: "Next.js 开发服务器" },
  { re: /^(npx\s+)?astro\s+dev(\s|$)/i, reason: "Astro 开发服务器" },
  { re: /^(npx\s+)?nuxt\s+dev(\s|$)/i, reason: "Nuxt 开发服务器" },
  { re: /^(python3?|py)\s+-m\s+http\.server(\s|$)/i, reason: "Python 静态 HTTP 服务" },
  { re: /^(npx\s+)?serve(\s|$)/i, reason: "静态文件服务" },
];

export function looksLikeLongRunningCommand(command: string): { reason: string } | null {
  const segments = command
    .split(/&&|;|\n/)
    .map((segment) => normalizeShellSegment(segment))
    .filter(Boolean);
  const candidates = [...segments, ...segments.flatMap(extractWrappedCommands)];

  for (const segment of candidates) {
    if (/\s(--help|-h)(\s|$)/i.test(` ${segment} `)) continue;
    for (const { re, reason } of LONG_RUNNING_PATTERNS) {
      if (re.test(segment) && !/\b(build|lint|test|typecheck)\b/i.test(segment)) return { reason };
    }
  }

  return null;
}

function normalizeShellSegment(segment: string): string {
  return segment
    .replace(/^nohup\s+/i, "")
    .replace(/\s+\d?>&\d/g, "")
    .replace(/\s+>\s*\S+/g, "")
    .replace(/\s+&$/g, "")
    .trim();
}

function extractWrappedCommands(segment: string): string[] {
  const commands: string[] = [];
  const shellMatch = segment.match(/\b(?:bash|sh|zsh)\s+-c\s+(['"])([\s\S]+)\1/i);
  if (shellMatch?.[2]) commands.push(...shellMatch[2].split(/&&|;|\n/).map(normalizeShellSegment));

  const screenMatch = segment.match(/\bscreen\s+[\s\S]*?\s(?:bash|sh|zsh)\s+-c\s+(['"])([\s\S]+)\1/i);
  if (screenMatch?.[2]) commands.push(...screenMatch[2].split(/&&|;|\n/).map(normalizeShellSegment));

  const tmuxMatch = segment.match(/\btmux\s+[\s\S]*?\s(?:bash|sh|zsh)\s+-c\s+(['"])([\s\S]+)\1/i);
  if (tmuxMatch?.[2]) commands.push(...tmuxMatch[2].split(/&&|;|\n/).map(normalizeShellSegment));

  return commands.filter(Boolean);
}

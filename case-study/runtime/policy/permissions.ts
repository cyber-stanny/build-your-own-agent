// ┌─ harness 级的安全层：在工具执行「之前」决定 allow / deny / require_approval ─┐
// 为什么必须在这：拦截危险动作没法用一条 shell 命令实现——它要在 loop 真正 run 工具之前拦下。
// 设计（呼应 tools/gitOps.ts 的说明）：只读工具直接放行，危险面集中在 runShell，重点检查它的命令。

export type Decision = "allow" | "deny" | "require_approval";

export interface PolicyResult {
  decision: Decision;
  reason?: string;
}

// 只读、天然安全的工具：直接放行（把需要盯防的面收缩到 runShell）
const SAFE_TOOLS = new Set(["readFile", "listDir", "gitStatus", "gitDiff"]);

// 危险命令模式（最小黑名单；命中即 deny）。目标是「拦住明显危险」，不求穷尽。
// ⚠️ 黑名单在结构上就会漏：破坏方式是开放集合（unlink / find -delete / >file 截断 /
//    node -e fs.rmSync / git clean -fdx …），枚举不完。真安全靠沙箱(confinement) + approval，
//    不是更长的黑名单。这里只当「速度带」。详见 learning-records/0011。
const DANGEROUS_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\brm\s+/i, why: "删除文件" }, // 放宽到任何 `rm <args>`（不止 -rf）；coding agent 极少需要 rm，真要删就该走 approval
  { re: /\bfind\b[\s\S]*\s-delete\b/i, why: "批量删除文件" },
  { re: /\bgit\s+clean\b/i, why: "清除未跟踪文件" },
  { re: /\bgh\s+pr\s+(merge|close)\b/i, why: "合并或关闭远端 PR" },
  { re: /\bpm2\s+(reload|restart|stop|delete)\b/i, why: "变更生产进程状态" },
  { re: /\bdeploy-server\.sh\b/i, why: "执行生产部署脚本" },
  { re: /\b(npm|yarn|pnpm)\s+publish\b/i, why: "发布包" },
  { re: /\bsudo\b/i, why: "提权" },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i, why: "下载脚本后直接管道执行" },
  { re: /\bchmod\s+-R\s+777\b/i, why: "过宽的递归权限" },
  { re: /\bmkfs(\.\w+)?\b/i, why: "格式化磁盘" },
  { re: />\s*\/dev\/(sd|nvme|disk)/i, why: "写裸设备" },
  { re: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, why: "fork bomb" },
];

export function checkToolCall(toolName: string, input: unknown): PolicyResult {
  if (SAFE_TOOLS.has(toolName)) return { decision: "allow" };

  if (toolName === "deployMain") {
    const mode = String((input as { mode?: unknown } | null)?.mode ?? "");
    if (mode === "reload-only") return { decision: "require_approval", reason: "确认执行 PM2 reload" };
    return { decision: "allow" };
  }

  // 危险面集中在 runShell：逐条比对命令
  if (toolName === "runShell") {
    const command = String((input as { command?: unknown } | null)?.command ?? "");
    for (const { re, why } of DANGEROUS_PATTERNS) {
      if (re.test(command)) {
        // 危险命令 → 要人批准（不再一刀 deny）。
        // 有审批通道（web 弹窗）就让人决定；没有（如纯 CLI）会被 executeTool 兜底成 deny。
        return { decision: "require_approval", reason: `命中危险模式（${why}）：${command}` };
      }
    }
    return { decision: "allow" };
  }

  // writeFile / editFile 等写操作：先放行（已被 workingDir 限制兜底）。
  // 以后可升级为 require_approval（写文件/跑命令前让人确认），等第 3 周有了 web 终端再接 human-in-the-loop。
  return { decision: "allow" };
}

import { spawn } from "node:child_process";
import type { ShellSandboxMode } from "./types";
import { buildShellSpawn, validateShellSandbox } from "./sandbox";

// 命令执行的原始结果（不带任何给模型看的格式化——那是各工具自己的事）
export interface CmdResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  shellSandbox?: ShellSandboxMode;
  signal?: AbortSignal; // 外部中止信号；触发时 kill 子进程组
}

// 在指定目录下跑一条命令，「永不抛」：非 0 退出 / 超时 / spawn 失败，统一映射成 CmdResult。
// 这是个**普通的共享函数（消重复）**，不是可替换的执行环境抽象——
// shell / gitDiff / gitStatus 都要「在 workingDir 跑命令、拿 exit/stdout/stderr」，抽出来避免三处复制。
export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 30_000,
  options: RunCommandOptions = {},
): Promise<CmdResult> {
  return new Promise((resolve) => {
    const sandboxError = validateShellSandbox(options.shellSandbox);
    if (sandboxError) {
      resolve({ exitCode: -1, stdout: "", stderr: sandboxError });
      return;
    }

    const spec = buildShellSpawn(command, cwd, options.shellSandbox);
    const child = spawn(spec.file, spec.args, {
      shell: spec.shell,
      cwd: spec.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let externallyAborted = false;
    let resolved = false;
    let closeResult: CmdResult | null = null; // aborted 时暂存 close 结果，等 escalation 完成再 resolve

    const finish = (result: CmdResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      // 非 abort 路径：正常清理所有 timer。
      // abort 路径：forceKill 已在 handleAbort 中清除；abortEscalation 在其回调中置 undefined。
      //   finish 通常在 escalation 回调中（close 先到时被暂存）或 escalation 已触发后（close 后到）调用。
      if (!externallyAborted) {
        clearTimeout(forceKill);
        if (abortEscalation) clearTimeout(abortEscalation);
      }
      // 命令结束后清理外部 signal listener，避免泄漏
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
        abortHandler = undefined;
      }
      resolve(result);
    };

    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // 进程可能已经结束，close 事件会负责收尾。
      }
    };

    const forceKill = setTimeout(() => {
      if (timedOut || externallyAborted) killProcessGroup("SIGKILL");
    }, timeoutMs + 2_000);

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup("SIGTERM");
    }, timeoutMs);

    // 外部中止信号：立即 SIGTERM + 3 秒后 SIGKILL 兜底（应对忽略 SIGTERM 的进程）
    let abortHandler: (() => void) | undefined;
    let abortEscalation: ReturnType<typeof setTimeout> | undefined;
    const handleAbort = () => {
      externallyAborted = true;
      clearTimeout(forceKill); // abortEscalation 接管 SIGKILL，不需要 timeout+2s 的冗余兜底
      clearTimeout(timeout);   // 不再关心超时，由 abort 路径接管
      killProcessGroup("SIGTERM");
      // 如果 SIGTERM 被忽略，3 秒后强制 SIGKILL
      abortEscalation = setTimeout(() => {
        killProcessGroup("SIGKILL");
        abortEscalation = undefined;
        // 若 close 已到（leader 被 SIGTERM 杀死），用暂存结果 resolve
        // 短宽限期让 SIGKILL 传播到进程树
        if (closeResult) setTimeout(() => finish(closeResult!), 100);
        // 否则 close 尚未到：SIGKILL 不可忽略，close 很快会自然触发，
        // 此时 abortEscalation 已置 undefined，close 回调正常走 finish
      }, 3_000);
    };
    if (options.signal) {
      if (options.signal.aborted) {
        handleAbort();
      } else {
        abortHandler = handleAbort;
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (err) => {
      finish({ exitCode: -1, stdout: "", stderr: err.message });
    });

    child.on("close", (code, signal) => {
      const stderrText = Buffer.concat(stderr).toString();
      const result: CmdResult = {
        exitCode: timedOut ? -1 : (code ?? -1),
        stdout: Buffer.concat(stdout).toString(),
        stderr: timedOut ? `${stderrText}\nCommand timed out after ${timeoutMs}ms${signal ? ` (${signal})` : ""}`.trim() : stderrText,
      };
      // 外部 abort 时：leader 进程可能先 close 但 descendant 仍在运行。
      // 如果 abortEscalation 尚未触发，暂存 result，等 escalation 完成后再 resolve。
      if (externallyAborted && abortEscalation) {
        closeResult = result;
        return;
      }
      finish(result);
    });
  });
}

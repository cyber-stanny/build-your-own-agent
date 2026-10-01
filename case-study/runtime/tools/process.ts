import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "./types";

type ProcessStatus = "running" | "exited" | "stopped" | "error";

export interface ManagedProcess {
  id: string;
  name?: string;
  command: string;
  cwd: string;
  pid?: number;
  status: ProcessStatus;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  logs: string;
  child?: ChildProcess;
}

const MAX_LOG_CHARS = 40_000;

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private nextId = 1;

  start(input: { command: string; cwd?: string; name?: string }, ctx: ToolContext): ManagedProcess {
    const cwd = resolveInside(ctx, input.cwd ?? ".");
    const id = `proc_${String(this.nextId++).padStart(4, "0")}`;
    const child = spawn(input.command, {
      shell: true,
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const proc: ManagedProcess = {
      id,
      name: input.name,
      command: input.command,
      cwd,
      pid: child.pid,
      status: "running",
      startedAt: new Date().toISOString(),
      logs: "",
      child,
    };
    this.processes.set(id, proc);

    child.stdout?.on("data", (chunk: Buffer) => this.appendLog(proc, chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => this.appendLog(proc, chunk.toString()));
    child.on("error", (err) => {
      proc.status = "error";
      proc.error = err.message;
      proc.exitedAt = new Date().toISOString();
      this.appendLog(proc, err.message);
    });
    child.on("close", (code, signal) => {
      if (proc.status === "stopped") return;
      proc.status = "exited";
      proc.exitCode = code;
      proc.signal = signal;
      proc.exitedAt = new Date().toISOString();
    });

    return proc;
  }

  list(): ManagedProcess[] {
    return [...this.processes.values()];
  }

  get(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  stop(id: string): ManagedProcess | undefined {
    const proc = this.processes.get(id);
    if (!proc) return undefined;
    if (proc.status !== "running") return proc;

    proc.status = "stopped";
    proc.exitedAt = new Date().toISOString();
    if (proc.pid) {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        try {
          process.kill(proc.pid, "SIGTERM");
        } catch {
          // The process may already be gone; status has still moved out of running.
        }
      }
    }
    return proc;
  }

  private appendLog(proc: ManagedProcess, text: string): void {
    proc.logs = (proc.logs + text).slice(-MAX_LOG_CHARS);
  }
}

const startProcessSchema = z.object({
  command: z.string().describe("要启动的长期命令，比如 npm run dev 或 npx vite --host 0.0.0.0"),
  cwd: z.string().optional().describe("相对工作目录的启动目录，默认当前 workingDir"),
  name: z.string().optional().describe("方便识别的进程名，比如 test-web"),
});

const idSchema = z.object({ id: z.string().describe("startProcess 返回的进程 id") });

export function createProcessTools(manager = new ProcessManager()): Tool[] {
  const startProcess: Tool<z.infer<typeof startProcessSchema>> = {
    name: "startProcess",
    description:
      "启动长期运行的进程并立即返回，比如 dev server、watch、http server。不要用 runShell 启动这类命令；用 readProcessLog 看日志，用 stopProcess 停止。",
    schema: startProcessSchema,
    async run(input, ctx) {
      const proc = manager.start(input, ctx);
      await delay(300);
      return formatProcess(proc);
    },
  };

  const listProcesses: Tool<Record<string, never>> = {
    name: "listProcesses",
    description: "列出当前 runtime 启动并管理的长期进程。",
    schema: z.object({}),
    async run() {
      const items = manager.list();
      if (items.length === 0) return "(no managed processes)";
      return items.map(formatProcessSummary).join("\n");
    },
  };

  const readProcessLog: Tool<{ id: string; maxChars?: number }> = {
    name: "readProcessLog",
    description: "读取 startProcess 启动的长期进程日志，常用于确认 dev server 是否启动成功以及提取访问地址。",
    // `.positive()` 在 OpenAPI 目标下会被 zod-to-json-schema 转成
    // `exclusiveMinimum: true`，DeepSeek 要求该字段必须是数字，因此显式使用 min(1)。
    schema: z.object({ id: z.string(), maxChars: z.number().int().min(1).optional() }),
    async run({ id, maxChars = 4_000 }) {
      const proc = manager.get(id);
      if (!proc) return `error: unknown process id ${id}`;
      const logs = proc.logs.slice(-maxChars);
      return [
        formatProcess(proc),
        "logs:",
        logs || "(no logs yet)",
      ].join("\n");
    },
  };

  const stopProcess: Tool<{ id: string }> = {
    name: "stopProcess",
    description: "停止 startProcess 启动的长期进程。",
    schema: idSchema,
    async run({ id }) {
      const proc = manager.stop(id);
      if (!proc) return `error: unknown process id ${id}`;
      return formatProcess(proc);
    },
  };

  return [startProcess, listProcesses, readProcessLog, stopProcess];
}

function resolveInside(ctx: ToolContext, p: string): string {
  const root = path.resolve(ctx.workingDir);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes workingDir: ${p}`);
  }
  return abs;
}

function formatProcess(proc: ManagedProcess): string {
  return [
    `id: ${proc.id}`,
    proc.name && `name: ${proc.name}`,
    `status: ${proc.status}`,
    proc.pid && `pid: ${proc.pid}`,
    `cwd: ${proc.cwd}`,
    `command: ${proc.command}`,
    proc.exitCode !== undefined && `exit_code: ${proc.exitCode}`,
    proc.signal && `signal: ${proc.signal}`,
    proc.error && `error: ${proc.error}`,
    detectedUrls(proc.logs).length > 0 && `urls:\n${detectedUrls(proc.logs).map((url) => `- ${url}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatProcessSummary(proc: ManagedProcess): string {
  return `${proc.id} · ${proc.status} · pid=${proc.pid ?? "-"} · ${proc.name ?? proc.command}`;
}

function detectedUrls(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s)]+/g) ?? [])];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

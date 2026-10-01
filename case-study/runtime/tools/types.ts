import type { z } from "zod";

// ┌─ harness 第 2 层：工具（agent 的「手」）─────────────────────────────┐
// 每个工具 = 名字 + 给模型看的说明 + 入参 schema(zod) + 真正干活的 run()。

export interface ToolContext {
  // 工具在哪个目录下执行。
  // 第 1 周：本地目录；第 2 周会把它换成「云服务器上的目录」，工具代码却几乎不用改——
  // 这正是后面要讲的「runtime 边界」。
  workingDir: string;
  // shell 写入边界：off=普通本地执行；readonly-root=根文件系统只读，仅 workingDir 可写。
  shellSandbox?: ShellSandboxMode;
  // 外部中止信号。长时间运行的工具应当定期检查并在 signal 触发时尽早返回。
  signal?: AbortSignal;
}

export type ShellSandboxMode = "off" | "readonly-root";

export interface Tool<I = any> {
  name: string;
  description: string; // 这段话会进「工具说明书」给模型，写清楚「什么时候用、参数啥意思」很重要
  schema: z.ZodType<I>; // 用 zod 在运行时校验模型给的入参（模型可能给错）
  run(input: I, ctx: ToolContext): Promise<string>; // 返回「观察结果」(observation)，会塞回历史给模型
}

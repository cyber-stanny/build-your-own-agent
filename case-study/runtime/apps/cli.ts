import { mkdirSync } from "node:fs";
import { Command } from "commander";
import { ToolRegistry } from "../tools/registry";
import { readFile, writeFile, editFile, listDir } from "../tools/fileOps";
import { runShell } from "../tools/shell";
import { createProcessTools } from "../tools/process";
import { gitStatus, gitDiff } from "../tools/gitOps";
import { createRememberTool } from "../tools/memory";
import { createDeployMainTool } from "../tools/deploy";
import { createInterface } from "node:readline/promises";
import { EventBus, ConsoleSink, JsonlSink } from "../core/events";
import { runTurn, type RunDeps } from "../core/loop";
import { createSession } from "../sessions/session";
import { MockModelClient } from "../model/mock";
import { DeepseekModelClient } from "../model/deepseek";
import type { ModelClient } from "../model/types";
import { MemoryStore } from "../memory/store";
import { appConfig } from "../config";

// ┌─ 入口：把上面各层「装配」起来，跑一次 agent ──────────────────────────┐
// 读这个文件能看清「一个 agent run 需要哪些零件、怎么拼」。

const program = new Command();
program
  .argument("[task...]", "要 agent 完成的任务")
  .option("--mock", "用假模型(不需要 API key)，按剧本演示 loop")
  .option("--max-turns <n>", "最多循环轮数", String(appConfig.agent.maxTurns))
  .option("--cwd <dir>", "工具执行目录", appConfig.agent.workingDir)
  .option("--shell-sandbox <mode>", "shell 沙箱模式：off / readonly-root", appConfig.agent.shellSandbox)
  .option("--context-strategy <mode>", "context：cache-first / legacy-window", appConfig.agent.contextStrategy)
  .option(
    "--context-prune-batch-user-turns <n>",
    "cache-first：超预算时每批移除的完整 user turn 数",
    String(appConfig.agent.contextPruneBatchUserTurns),
  )
  .option("--recent-turns <n>", "legacy-window：保留最近 N 轮", String(appConfig.agent.recentTurns))
  .option("--max-context-tokens <n>", "context：粗估 token 预算", String(appConfig.agent.maxContextTokens))
  .option("--max-tool-chars <n>", "context：单条工具结果超长截断阈值", String(appConfig.agent.maxToolResultChars))
  .option("--memory-file <path>", "持久状态文件", appConfig.agent.memoryFile)
  .option("--debug-context", "打印每轮 context 的裁剪决策")
  .option("--repl", "多轮交互模式：持续对话，历史累积在同一 session")
  .parse();

const opts = program.opts();
const task = (program.args.join(" ") || "建一个 hello.js 并运行它").trim();

// 选模型：带 --mock 或没有 DEEPSEEK_API_KEY → 用假模型；否则用真 Deepseek。
const useMock = opts.mock || !appConfig.model.deepseekApiKey;
const model: ModelClient = useMock
  ? new MockModelClient()
  : new DeepseekModelClient(appConfig.model.deepseekApiKey!, appConfig.model.deepseekModel);

const memory = new MemoryStore(opts.memoryFile);
const processTools = createProcessTools();

// 注册工具（这一步决定了「这个 agent 有哪些手」）
const registry = new ToolRegistry()
  .register(readFile)
  .register(writeFile)
  .register(editFile)
  .register(listDir)
  .register(runShell)
  .register(processTools[0])
  .register(processTools[1])
  .register(processTools[2])
  .register(processTools[3])
  .register(gitStatus)
  .register(gitDiff)
  .register(createRememberTool(memory))
  .register(createDeployMainTool());

// 准备工作目录 + 本次 run 的事件日志文件
mkdirSync(opts.cwd, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const events = new EventBus()
  .use(new ConsoleSink()) // 终端可视化
  .use(new JsonlSink(`runs/${runId}.jsonl`)); // 持久化/replay

console.log(`\n模型: ${model.name}  ·  目录: ${opts.cwd}  ·  日志: runs/${runId}.jsonl\n`);

// session 持有 transcript；system 在建会话时放一次；deps 是每个 run 共用的零件
const session = createSession(runId, appConfig.agent.systemPrompt);
const deps: RunDeps = {
  model,
  registry,
  events,
  config: {
    maxTurns: Number(opts.maxTurns),
    workingDir: opts.cwd,
    shellSandbox: opts.shellSandbox,
    context: {
      strategy: opts.contextStrategy,
      recentTurns: Number(opts.recentTurns),
      pruneBatchUserTurns: Number(opts.contextPruneBatchUserTurns),
      maxContextTokens: Number(opts.maxContextTokens),
      maxToolResultChars: Number(opts.maxToolChars),
    },
    memoryContext: () => memory.formatForContext(),
    debugContext: Boolean(opts.debugContext),
  },
};

if (opts.repl) {
  // 多轮：反复读一行 → runTurn（历史累积在同一 session）→ 直到 exit
  console.log("多轮模式：直接输入消息；输入 exit / quit 退出。\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    const line = (await rl.question("你> ")).trim();
    if (!line) continue;
    if (["exit", "quit", ":q"].includes(line)) break;
    const final = await runTurn(session, line, deps);
    console.log(`\n${final}\n`);
  }
  rl.close();
} else {
  // 单次：也走 session+runTurn（只是只跑一个 run）
  const final = await runTurn(session, task, deps);
  console.log(`\n———\n最终答复: ${final}\n`);
}

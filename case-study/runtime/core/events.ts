import type { ModelUsage } from "../model/types";
import type { ContextStrategy } from "../context/builder";
import type { PromptCacheObservation } from "../context/cache-observability";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// ┌─ harness：可观察 + 可回放（升级成「事件总线 + 可插拔 sink」）──────────────┐
// agent run 每一步都 emit 一个事件。EventBus 把每个事件 fan-out 给所有 sink。
// 现有 sink：console（终端可视化）、jsonl（持久化/replay）。
// 加 streaming = 再插一个 ws sink（推给浏览器），loop 一行不用动 —— 这就是「现成的流」。

export type AgentEvent =
  | { type: "user_message"; content: string }
  | { type: "model_request"; turn: number; messageCount: number }
  | { type: "model_usage"; turn: number; estimate: number; prompt: PromptCacheObservation; usage: ModelUsage }
  | { type: "model_response"; turn: number; text: string; toolCalls: { name: string }[] }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string }
  | {
      type: "context_built";
      turn: number;
      messageCount: number;
      builtMessageCount: number;
      tokenEstimate: number;
      strategy: ContextStrategy;
      prompt: PromptCacheObservation;
      included: string[];
      omitted: string[];
    }
  | { type: "approval_request"; id: string; tool: string; input: unknown; reason?: string }
  | { type: "approval_resolved"; id: string; decision: "allow" | "deny" }
  | { type: "run_interrupted"; content: string }
  | { type: "command_result"; command: string; content: string }
  | { type: "error"; content: string }
  | { type: "final_answer"; content: string };

export type TimestampedEvent = AgentEvent & {
  ts: string;
  seq?: number;
  sessionId?: string;
  runId?: string;
};

// 一个 sink = 处理每个事件的消费者（一个「出口」）
export interface EventSink {
  handle(ev: TimestampedEvent): void;
  close?(): void; // 可选收尾（关文件/连接等）
}

// 事件总线：把每个事件分发给所有注册的 sink
export class EventBus {
  private sinks: EventSink[] = [];

  use(sink: EventSink): this {
    this.sinks.push(sink);
    return this;
  }

  // loop 仍然只调这一个方法（接口没变）；背后从「写死 2 个出口」变成「fan-out 给 N 个 sink」
  log(ev: AgentEvent): void {
    const stamped: TimestampedEvent = { ts: new Date().toISOString(), ...ev };
    for (const s of this.sinks) s.handle(stamped);
  }

  close(): void {
    for (const s of this.sinks) s.close?.();
  }
}

// ── 内置 sink ──────────────────────────────────────────────

// 终端可视化
export class ConsoleSink implements EventSink {
  handle(ev: TimestampedEvent): void {
    printEvent(ev);
  }
}

// 持久化成 JSONL（replay 用）
export class JsonlSink implements EventSink {
  constructor(private filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }
  handle(ev: TimestampedEvent): void {
    appendFileSync(this.filePath, JSON.stringify(ev) + "\n");
  }
}

// 把一个事件打印成人能读的样子。replay 也复用它，所以「实时看」和「回放看」长得一样。
export function printEvent(ev: AgentEvent): void {
  switch (ev.type) {
    case "user_message":
      return line("👤 user", ev.content);
    case "model_request":
      return line("⟳ model", `turn ${ev.turn} · 携带 ${ev.messageCount} 条历史 →`);
    case "model_response": {
      const tools = ev.toolCalls.map((t) => t.name).join(", ");
      return line("🤖 model", ev.text + (tools ? `   [想调用: ${tools}]` : ""));
    }
    case "model_usage":
      return line("◷ usage", formatUsage(ev.estimate, ev.usage));
    case "tool_call":
      return line("🔧 call", `${ev.name}(${JSON.stringify(ev.input)})`);
    case "tool_result":
      return line("📥 result", truncate(ev.content));
    case "context_built":
      return; // 不打印到控制台（web 面板 / jsonl 消费它；CLI 想看详情用 --debug-context 的框）
    case "approval_request":
      return line("⏸ approval", `需要批准：${ev.tool} —— ${ev.reason ?? ""}`);
    case "approval_resolved":
      return line("▶ approval", `${ev.decision === "allow" ? "已批准" : "已拒绝"}：${ev.id}`);
    case "run_interrupted":
      return line("■ interrupted", ev.content);
    case "command_result":
      return line("⌘ command", `${ev.command} · ${ev.content}`);
    case "final_answer":
      return line("✅ final", ev.content);
    case "error":
      return line("❌ error", ev.content);
  }
}

function line(tag: string, msg: string): void {
  console.log(`${tag.padEnd(10)} ${msg}`);
}
function formatUsage(estimate: number, usage: ModelUsage): string {
  const actual = usage.totalTokens ?? sumKnown(usage.inputTokens, usage.outputTokens);
  const delta = typeof actual === "number" ? ` · 估算偏差 ${actual - estimate >= 0 ? "+" : ""}${actual - estimate}` : "";
  const cache = formatCacheUsage(usage);
  const request = usage.requestId ? ` · request ${usage.requestId}` : "";
  return `估算 ~${estimate} · 实际 ${actual ?? "?"} tokens · input ${usage.inputTokens ?? "?"} · output ${usage.outputTokens ?? "?"}${usage.reasoningTokens ? ` · reasoning ${usage.reasoningTokens}` : ""}${cache}${request}${delta}`;
}
function formatCacheUsage(usage: ModelUsage): string {
  if (usage.cachedInputTokens === undefined && usage.cacheMissInputTokens === undefined) return "";
  const hit = usage.cachedInputTokens ?? 0;
  const miss = usage.cacheMissInputTokens ?? Math.max(0, (usage.inputTokens ?? hit) - hit);
  const cacheInput = hit + miss;
  const ratio = cacheInput > 0 ? ((hit / cacheInput) * 100).toFixed(1) : "0.0";
  return ` · cache hit ${hit}/${cacheInput} (${ratio}%) · miss ${miss}`;
}
function sumKnown(a?: number, b?: number): number | undefined {
  return typeof a === "number" && typeof b === "number" ? a + b : undefined;
}
function truncate(s: string, n = 300): string {
  return s.length > n ? s.slice(0, n) + " …" : s;
}

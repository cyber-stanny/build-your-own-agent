import type { ModelClient } from "../model/types";
import type { ToolRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import type { EventBus } from "./events";
import type { Session } from "../sessions/session";
import { checkToolCall } from "../policy/permissions";
import { buildContext, estimateTokens, type ContextConfig } from "../context/builder";
import { formatContextDebug } from "../context/debugger";
import {
  countSharedPrefixMessages,
  fingerprintPrompt,
  type PromptCacheObservation,
} from "../context/cache-observability";

export interface LoopConfig {
  maxTurns: number; // 防止无限循环：最多走几轮
  workingDir: string; // 工具执行目录
  shellSandbox?: ToolContext["shellSandbox"]; // runShell 的写入隔离模式
  allowedTools?: string[]; // 只允许这些工具（不填 = 全允许）
  context: ContextConfig; // 每轮如何把 transcript 压成 context
  debugContext?: boolean; // 打印 context 决策
  memoryContext?: () => string; // 持久状态注入：每轮调模型前读取最新记忆
  signal?: AbortSignal; // 外部可通过此信号中止当前 runTurn（如用户点停止）
  // 注意：systemPrompt 不在这里了——它属于 session（建会话时放一次），不属于单次 run
}

// 危险动作要人批准时，loop 通过这个回调去「问人」——具体怎么问由调用方提供：
// web 端发 approval_request 事件 + 等 ws 回传；纯 CLI 不提供 → 一律拒绝（安全兜底）。
export interface ApprovalRequest {
  tool: string;
  input: unknown;
  reason?: string;
}
export type ApproveFn = (req: ApprovalRequest) => Promise<boolean>;

export interface RunDeps {
  model: ModelClient;
  registry: ToolRegistry;
  events: EventBus;
  config: LoopConfig;
  approve?: ApproveFn; // 不提供则 require_approval 一律拒绝
  checkpoint?: (session: Session) => void; // transcript 每次变化后持久化；CLI 可不提供
}

const previousPromptBySession = new WeakMap<
  Session,
  { messages: Session["messages"]; toolsHash: string }
>();

// ── 辅助：用 AbortSignal 做 Promise.race，让 await 在 signal 触发时立即 reject ──
function signalRace<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
    } else {
      onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  // 主 Promise 先 settle → 移除 listener（避免累积）
  const cleanup = () => {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
      onAbort = undefined;
    }
  };

  return Promise.race([promise.finally(cleanup), abortPromise]);
}

// ── 辅助：写入终止消息并发出 final_answer 事件，不再返回 ──
function terminateRun(session: Session, deps: RunDeps, content: string): never {
  session.messages.push({ role: "assistant", content, toolCalls: [] });
  deps.checkpoint?.(session);
  deps.events.log({ type: "final_answer", content });
  throw new AbortError(content);
}

class AbortError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AbortError";
  }
}

// ── 辅助：当工具循环中发现中止时，补齐所有未完成的 tool result 再终止 ──
// 参数 currentCallAlreadyEmitted：当前 tool call 的 tool_call 事件是否已发出。
//   场景 A（循环开头检查 signal）：未 emit → false，abortToolLoop 负责补 tool_call
//   场景 B（executeTool 被 signalRace reject）：已 emit → true，跳过 tool_call
//   场景 C（executeTool 返回后检查 signal）：已 emit + 有 currentResult → 自动跳过
async function abortToolLoop(
  session: Session,
  deps: RunDeps,
  res: { toolCalls: { id: string; name: string; input: unknown }[] },
  completedIndex: number,
  currentResult?: { observation: string },
  currentCallAlreadyEmitted?: boolean,
): Promise<never> {
  const { events } = deps;

  // 1) 当前 call 的 tool_result 处理
  const currentCall = res.toolCalls[completedIndex];
  if (currentResult) {
    // 场景 C：executeTool 返回后检查 signal → tool 已完成，有真实 observation
    events.log({ type: "tool_result", id: currentCall.id, content: currentResult.observation });
    session.messages.push({ role: "tool", toolCallId: currentCall.id, content: currentResult.observation });
  } else if (currentCallAlreadyEmitted) {
    // 场景 B：executeTool 被 signalRace reject → tool_call 已 emit 但无 result，
    // 补一个 cancelled tool_result 保证配对完整
    const cancelled = "cancelled: 任务已终止，该工具未被调用。";
    events.log({ type: "tool_result", id: currentCall.id, content: cancelled });
    session.messages.push({ role: "tool", toolCallId: currentCall.id, content: cancelled });
  }
  // 场景 A：循环开头检查 signal → 当前 call 未 emit 任何东西，由下面 for 循环处理

  // 2) 尚未执行的后继 toolCalls 逐一补 cancelled result（保证每个 toolCall 都有配对）
  const startFrom = (currentResult || currentCallAlreadyEmitted)
    ? completedIndex + 1 // 当前 call 已处理完毕，从下一个开始
    : completedIndex; // 场景 A：当前 call 未 emit 任何东西，需要补
  for (let i = startFrom; i < res.toolCalls.length; i++) {
    const call = res.toolCalls[i];
    const cancelled = "cancelled: 任务已终止，该工具未被调用。";
    events.log({ type: "tool_call", id: call.id, name: call.name, input: call.input });
    events.log({ type: "tool_result", id: call.id, content: cancelled });
    session.messages.push({ role: "tool", toolCallId: call.id, content: cancelled });
  }
  deps.checkpoint?.(session);

  // 3) 最后推一条干净的终止 assistant 消息（无 toolCalls）
  const content = "任务已被用户手动终止。";
  session.messages.push({ role: "assistant", content, toolCalls: [] });
  deps.checkpoint?.(session);
  events.log({ type: "final_answer", content });
  throw new AbortError(content);
}

// ══════════════════════════════════════════════════════════════════════
//  runTurn = 一个「run」：把用户这一句**追加到 session 的 transcript**，然后跑 agent loop
//  （问模型 → 给答案 or 调工具 → 调完塞回去再问），直到给出最终答案或到 maxTurns。
//  关键：transcript 现在归 session 持有、跨 run 累积 —— 这就是「多轮」：
//  第二次调 runTurn 时，session.messages 里还留着上一次的全部历史。
// ══════════════════════════════════════════════════════════════════════
export async function runTurn(session: Session, userInput: string, deps: RunDeps): Promise<string> {
  const { model, registry, events, config, approve } = deps;
  // 捕获 signal 快照：整个 runTurn 只读这份引用，防止外部在旧 run 未 settle 时替换 config.signal
  const signal = config.signal;
  const ctx: ToolContext = { workingDir: config.workingDir, shellSandbox: config.shellSandbox, signal };

  const repaired = repairInterruptedToolCalls(session.messages);
  if (repaired.length > 0) {
    deps.checkpoint?.(session);
    for (const item of repaired) events.log({ type: "tool_result", id: item.toolCallId, content: item.content });
    events.log({
      type: "error",
      content: `检测到上次运行中断，已补齐 ${repaired.length} 个未完成工具结果，当前对话可以继续。`,
    });
  }

  // 1) 把用户这一句追加到 session 的持久 transcript（多轮的核心动作）
  session.messages.push({ role: "user", content: userInput });
  deps.checkpoint?.(session);
  events.log({ type: "user_message", content: userInput });

  // 2) 主循环（读写的都是 session.messages）
  for (let turn = 1; turn <= config.maxTurns; turn++) {
    // 检查外部中止信号（用户点停止/终止）
    if (signal?.aborted) {
      terminateRun(session, deps, "任务已被用户手动终止。");
    }

    events.log({ type: "model_request", turn, messageCount: session.messages.length });

    // 2a) transcript（可能很长）先经 buildContext 压成这轮发出去的 context
    const memoryText = config.memoryContext?.();
    const built = buildContext(withMemoryContext(session.messages, memoryText), config.context);
    const toolSchemas = registry.toSchemas();
    const fingerprint = fingerprintPrompt(built.messages, toolSchemas, memoryText);
    const previousPrompt = previousPromptBySession.get(session);
    const prompt: PromptCacheObservation = { ...fingerprint };
    if (previousPrompt?.toolsHash === fingerprint.toolsHash) {
      const sharedPrefixMessages = countSharedPrefixMessages(previousPrompt.messages, built.messages);
      prompt.sharedPrefixMessages = sharedPrefixMessages;
      prompt.sharedPrefixTokenEstimate = estimateTokens(built.messages.slice(0, sharedPrefixMessages));
    }
    // 把 context 决策作为事件发出 → web 面板 / jsonl 都能看到（CLI 想看详情仍可用 --debug-context）
    events.log({
      type: "context_built",
      turn,
      messageCount: session.messages.length,
      builtMessageCount: built.messages.length,
      tokenEstimate: built.tokenEstimate,
      strategy: config.context.strategy ?? "cache-first",
      prompt,
      included: built.included,
      omitted: built.omitted,
    });
    if (config.debugContext) console.log(formatContextDebug(built));

    // model.complete 传 signal → OpenAI SDK 底层 fetch 可被取消
    let res: import("../model/types").ModelResponse;
    try {
      res = await signalRace(model.complete(built.messages, toolSchemas, signal), signal);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // signalRace 在 model.complete 等待时 reject → 走终止路径
        terminateRun(session, deps, "任务已被用户手动终止。");
      }
      throw err;
    }
    // model.complete 可能耗时长（网络 I/O），返回后立即检查是否已被终止
    if (signal?.aborted) {
      terminateRun(session, deps, "任务已被用户手动终止。");
    }
    previousPromptBySession.set(session, { messages: [...built.messages], toolsHash: fingerprint.toolsHash });
    if (res.usage) {
      events.log({ type: "model_usage", turn, estimate: built.tokenEstimate, prompt, usage: res.usage });
    }

    // 2b) 模型发言记进 transcript（无论最终与否都要记）
    session.messages.push({
      role: "assistant",
      content: res.text,
      reasoningContent: res.reasoningContent,
      toolCalls: res.toolCalls,
    });
    deps.checkpoint?.(session);

    // 2c) 没有要调工具 = 本 run 完成：只发 final_answer
    //     （不再发 model_response——最后一轮的「模型发言」就是最终答案，两者会重复同一段文字）
    if (res.toolCalls.length === 0) {
      events.log({ type: "final_answer", content: res.text });
      return res.text;
    }

    // 2d) 还要继续：这一轮的 model_response = 中间发言 + 它要调的工具
    events.log({ type: "model_response", turn, text: res.text, toolCalls: res.toolCalls });
    for (let i = 0; i < res.toolCalls.length; i++) {
      const call = res.toolCalls[i];
      // 每次调工具前也检查中止信号（避免在耗时工具执行中被卡住等太久）
      if (signal?.aborted) {
        await abortToolLoop(session, deps, res, i);
      }

      events.log({ type: "tool_call", id: call.id, name: call.name, input: call.input });
      // 用 signalRace 包装 executeTool：signal 触发时立即 reject，不等到 tool 自然完成
      let result: { observation: string; stopRun?: boolean };
      // 先把 executeTool 的 promise 存下来；如果 signal 触发但工具不响应 signal，
      // 我们仍需要等它实际完成拿真实 result，而不是凭空写 cancelled。
      const toolPromise = executeTool(registry, ctx, call, config.allowedTools, approve);
      try {
        result = await signalRace(toolPromise, signal);
      } catch (err) {
        if ((err as Error).name === "AbortError" && signal?.aborted) {
          // signal 触发时 executeTool 仍在跑。大部分工具不检查 ctx.signal，
          // 意味着它们可能已经执行了（如 startProcess 已启动服务器、file tools 已写文件）。
          // 给工具一个宽限期（5 秒）等真实结果；超时则用 cancelled result，
          // 避免非协作式工具（如 analyzeImage 的 SDK 调用不转发 signal）无限等待。
          let actualResult: { observation: string };
          try {
            actualResult = await Promise.race([
              toolPromise,
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ABORT_TOOL_TIMEOUT")), 5_000)),
            ]);
          } catch {
            actualResult = { observation: "cancelled: 任务已终止，该工具调用被中断。" };
          }
          await abortToolLoop(session, deps, res, i, { observation: actualResult.observation });
        }
        throw err;
      }
      // executeTool 返回后检查是否已被终止（可能在 tool 执行期间 signal 触发）
      if (signal?.aborted) {
        // executeTool 已返回，它的 observation 有效，先推进 transcript 再补齐后继 calls
        await abortToolLoop(session, deps, res, i, { observation: result.observation });
      }
      events.log({ type: "tool_result", id: call.id, content: result.observation });
      session.messages.push({ role: "tool", toolCallId: call.id, content: result.observation });
      deps.checkpoint?.(session);
      if (result.stopRun) {
        // 操作未获批准，也需要补齐所有未执行的 tool calls
        // 注意：只有当前调用被拒绝，后面的调用没执行；需要一个干净终止
        for (let j = i + 1; j < res.toolCalls.length; j++) {
          const rem = res.toolCalls[j];
          const cancelled = "cancelled: 前置操作未获批准，该工具未被调用。";
          events.log({ type: "tool_call", id: rem.id, name: rem.name, input: rem.input });
          events.log({ type: "tool_result", id: rem.id, content: cancelled });
          session.messages.push({ role: "tool", toolCallId: rem.id, content: cancelled });
        }
        deps.checkpoint?.(session);
        const content = "操作未获批准，已停止当前任务。";
        session.messages.push({ role: "assistant", content, toolCalls: [] });
        deps.checkpoint?.(session);
        events.log({ type: "final_answer", content });
        return content;
      }
    }
  }

  events.log({ type: "error", content: `reached maxTurns (${config.maxTurns})` });
  return "(stopped: reached maxTurns)";
}

export type RepairedToolResult = {
  toolCallId: string;
  content: string;
};

export function repairInterruptedToolCalls(messages: Session["messages"]): RepairedToolResult[] {
  const repaired: RepairedToolResult[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.toolCalls?.length) continue;

    const expected = msg.toolCalls.map((call) => call.id);
    const present = new Set<string>();
    let insertAt = i + 1;

    while (insertAt < messages.length && messages[insertAt].role === "tool") {
      const toolMsg = messages[insertAt];
      if (toolMsg.role === "tool" && expected.includes(toolMsg.toolCallId)) present.add(toolMsg.toolCallId);
      insertAt++;
    }

    const missing = msg.toolCalls.filter((call) => !present.has(call.id));
    if (missing.length === 0) continue;

    const repairedMessages = missing.map((call) => ({
      role: "tool" as const,
      toolCallId: call.id,
      content: `error: 上次运行在工具 ${call.name} 执行期间中断，未能记录工具结果。请根据当前状态重新确认下一步。`,
    }));

    messages.splice(insertAt, 0, ...repairedMessages);
    repaired.push(...repairedMessages.map(({ toolCallId, content }) => ({ toolCallId, content })));
    i = insertAt + missing.length - 1;
  }

  return repaired;
}

function withMemoryContext(
  messages: Session["messages"],
  memoryText?: string,
): Session["messages"] {
  if (!memoryText?.trim()) return messages;
  const memoryMessage = { role: "system" as const, content: memoryText.trim() };
  const firstNonSystem = messages.findIndex((m) => m.role !== "system");
  if (firstNonSystem < 0) return [...messages, memoryMessage];
  return [...messages.slice(0, firstNonSystem), memoryMessage, ...messages.slice(firstNonSystem)];
}

// 执行单个工具调用：权限检查 → 找工具 → 校验入参 → 运行。
// 关键设计：工具出错**不抛异常中断 loop**，而是把错误当作「观察结果」还给模型，
// 让模型自己看到错误、自己决定下一步（这正是 agent 比死板脚本强的地方）。
type ToolExecutionResult = {
  observation: string;
  stopRun?: boolean;
};

async function executeTool(
  registry: ToolRegistry,
  ctx: ToolContext,
  call: { name: string; input: unknown },
  allowedTools?: string[],
  approve?: ApproveFn,
): Promise<ToolExecutionResult> {
  if (allowedTools && !allowedTools.includes(call.name)) {
    return { observation: `error: tool "${call.name}" is not allowed` };
  }
  const tool = registry.get(call.name);
  if (!tool) return { observation: `error: unknown tool "${call.name}"` };

  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) return { observation: `error: invalid input for ${call.name}: ${parsed.error.message}` };

  // 安全策略：在真正执行前拦截。deny / 拒绝批准 都只是返回 error 观察结果，模型看到会避开。
  const verdict = checkToolCall(call.name, parsed.data);
  if (verdict.decision === "deny") {
    return { observation: `error: 被安全策略拒绝 —— ${verdict.reason}`, stopRun: true };
  }
  if (verdict.decision === "require_approval") {
    // 问人。没有审批通道（如纯 CLI）→ 默认拒绝（安全兜底）。
    const ok = approve ? await approve({ tool: call.name, input: parsed.data, reason: verdict.reason }) : false;
    if (!ok) return { observation: `error: 操作未获批准 —— ${verdict.reason ?? call.name}`, stopRun: true };
  }

  try {
    return { observation: await tool.run(parsed.data, ctx) };
  } catch (err) {
    return { observation: `error: ${(err as Error).message}` };
  }
}

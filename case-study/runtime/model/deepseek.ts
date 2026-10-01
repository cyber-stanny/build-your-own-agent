import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { ModelClient, ModelResponse, Message, ToolSchema, ToolCall, ModelUsage } from "./types";
import { appConfig } from "../config";

// DeepSeek provider。DeepSeek 的 chat-completions 接口兼容 OpenAI 格式，
// 本类负责把内部中立类型转换为 DeepSeek/OpenAI 的请求/响应格式。
export class DeepseekModelClient implements ModelClient {
  name: string;
  private client: OpenAI;
  private debugLogPath?: string;

  constructor(apiKey: string, private model = appConfig.model.deepseekModel) {
    this.name = model;
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.deepseek.com",
    });
    if (appConfig.model.deepseekDebugLog) {
      const dir = appConfig.model.deepseekDebugLogDir;
      mkdirSync(dir, { recursive: true });
      this.debugLogPath = path.join(dir, `deepseek-${Date.now()}.jsonl`);
    }
  }

  async complete(messages: Message[], tools: ToolSchema[], signal?: AbortSignal): Promise<ModelResponse> {
    // 标准字段先用 satisfies 做完整类型校验（reasoning_effort 是标准 OpenAI 字段，类型里有）。
    const params = {
      model: this.model,
      messages: toDeepseekMessages(messages),
      tools: tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema as Record<string, unknown>,
        },
      })),
      tool_choice: "auto" as const,
      stream: false as const,
      max_tokens: appConfig.agent.maxOutputTokens,
      reasoning_effort: "high" as const,
    } satisfies OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

    // DeepSeek 思考模式：thinking 是 DeepSeek 专属扩展字段，OpenAI 类型未覆盖，
    // 用 OpenAI SDK 时放进 body 即可。单独加 + 整体 cast，避免污染上面的标准字段校验。
    // 官方文档（兼容 OpenAI / Anthropic 两种格式）：https://api-docs.deepseek.com/guides/thinking_mode
    let res: OpenAI.Chat.Completions.ChatCompletion;
    try {
      res = await this.client.chat.completions.create(
        {
          ...params,
          thinking: { type: "enabled" },
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        { signal }, // 第二个参数传 AbortSignal → OpenAI SDK 底层 fetch 可被取消
      );
      this.logDebugResponse(messages, tools, res);
    } catch (err) {
      if (signal?.aborted) {
        // 用户主动停止导致的 abort，不走 debug log 也不抛错
        return { text: "", toolCalls: [] };
      }
      this.logDebugError(messages, tools, err);
      throw err;
    }

    const msg = res.choices?.[0]?.message;
    if (!msg) {
      return { text: "", toolCalls: [], usage: toDeepseekModelUsage(res.usage, res) };
    }

    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    }

    const toolCalls: ToolCall[] = [];
    for (const c of msg.tool_calls ?? []) {
      const fnArgs = typeof c.function?.arguments === "string" ? c.function.arguments : "";
      const functionName = c.function?.name ?? "unknown";
      let input: Record<string, unknown> = {};
      try {
        if (fnArgs && fnArgs.trim()) input = JSON.parse(fnArgs) as Record<string, unknown>;
      } catch {
        input = {};
      }

      if (c.id) {
        toolCalls.push({ id: c.id, name: functionName, input: input as Record<string, unknown> });
      }
    }

    const rawReasoningContent = (msg as unknown as { reasoning_content?: unknown }).reasoning_content;
    const reasoningContent = typeof rawReasoningContent === "string" ? rawReasoningContent : undefined;

    if (!text.trim() && toolCalls.length === 0 && res.choices?.[0]?.finish_reason === "stop") {
      if (reasoningContent?.trim()) {
        text = reasoningContent;
      }
    }

    return {
      text,
      reasoningContent: toolCalls.length > 0 ? reasoningContent : undefined,
      toolCalls,
      usage: toDeepseekModelUsage(res.usage, res),
    };
  }

  private logDebugResponse(
    messages: Message[],
    tools: ToolSchema[],
    res: OpenAI.Chat.Completions.ChatCompletion,
  ): void {
    if (!this.debugLogPath) return;

    const choice = res.choices?.[0];
    const msg = choice?.message as unknown;
    this.appendDebugLog({
      ts: new Date().toISOString(),
      request: this.summarizeRequest(messages, tools),
      response: {
        id: res.id,
        model: res.model,
        usage: res.usage,
        finishReason: choice?.finish_reason,
        message: msg,
      },
    });
  }

  private logDebugError(messages: Message[], tools: ToolSchema[], err: unknown): void {
    if (!this.debugLogPath) return;
    const error = err as { name?: string; message?: string; status?: number; code?: string; type?: string };
    this.appendDebugLog({
      ts: new Date().toISOString(),
      request: this.summarizeRequest(messages, tools),
      error: {
        name: error?.name ?? "Error",
        message: error?.message ?? String(err),
        status: error?.status,
        code: error?.code,
        type: error?.type,
      },
    });
  }

  private summarizeRequest(messages: Message[], tools: ToolSchema[]): Record<string, unknown> {
    return {
      model: this.model,
      messageCount: messages.length,
      messages: messages.map(summarizeMessage),
      tools,
    };
  }

  private appendDebugLog(entry: Record<string, unknown>): void {
    if (!this.debugLogPath) return;
    appendFileSync(this.debugLogPath, JSON.stringify(entry) + "\n");
  }
}

export function toDeepseekModelUsage(
  usage: OpenAI.Chat.Completions.ChatCompletion["usage"],
  response?: Pick<OpenAI.Chat.Completions.ChatCompletion, "id" | "model" | "system_fingerprint">,
): ModelUsage | undefined {
  if (!usage) return undefined;
  const promptDetails = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
  const completionDetails = usage.completion_tokens_details as { reasoning_tokens?: number } | undefined;
  const extra = usage as {
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
  return {
    requestId: response?.id,
    model: response?.model,
    systemFingerprint: response?.system_fingerprint ?? undefined,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens: extra.prompt_cache_hit_tokens ?? promptDetails?.cached_tokens,
    cacheMissInputTokens: extra.prompt_cache_miss_tokens,
    reasoningTokens: completionDetails?.reasoning_tokens,
    raw: usage,
  };
}

function summarizeMessage(m: Message): Record<string, unknown> {
  const base = {
    role: m.role,
    contentLength: m.content.length,
    contentPreview: m.content.slice(0, 500),
  };
  if (m.role === "assistant") {
    return { ...base, reasoningContentLength: m.reasoningContent?.length ?? 0, toolCalls: m.toolCalls };
  }
  if (m.role === "tool") {
    return { ...base, toolCallId: m.toolCallId };
  }
  return base;
}

export function toDeepseekMessages(messages: Message[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "system") {
      return { role: "system", content: m.content };
    }

    if (m.role === "user") {
      return { role: "user", content: m.content };
    }

    if (m.role === "assistant") {
      const out: any = { role: "assistant", content: m.content || "" };
      if (m.reasoningContent !== undefined) out.reasoning_content = m.reasoningContent;
      // 只有真有工具调用时才带 tool_calls；空数组会被 API 拒（规范要求出现即非空）。
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: {
            name: c.name,
            arguments: JSON.stringify(c.input),
          },
        }));
      }
      return out as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    }

    return {
      role: "tool",
      tool_call_id: m.toolCallId,
      content: m.content,
    } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
  });
}

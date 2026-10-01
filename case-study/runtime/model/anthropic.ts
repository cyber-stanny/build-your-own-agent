import Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelResponse, Message, ToolSchema, ToolCall, ModelUsage } from "./types";
import { appConfig } from "../config";

// 真模型 provider。它的唯一职责：在「我们的中立类型」和「Anthropic API 格式」之间来回翻译。
// 这就是 harness 的「模型适配层」——把它换成 OpenAI 版，loop / tools 全都不用改。
export class AnthropicModelClient implements ModelClient {
  name = "anthropic";
  private client: Anthropic;
  constructor(apiKey: string, private model = "claude-sonnet-4-6") {
    this.client = new Anthropic({ apiKey });
  }

  async complete(messages: Message[], tools: ToolSchema[]): Promise<ModelResponse> {
    const system = messages.find((m) => m.role === "system")?.content;

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: appConfig.agent.maxOutputTokens,
      system,
      messages: toAnthropic(messages),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as any, // JSON Schema 直接交给 API
      })),
    });

    // 把返回的内容块拆成 text + toolCalls，统一成我们的 ModelResponse
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use")
        toolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
    }
    return { text, toolCalls, usage: toModelUsage(res.usage) };
  }
}

function toModelUsage(usage: Anthropic.Message["usage"]): ModelUsage | undefined {
  if (!usage) return undefined;
  const details = usage as {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  const cachedInputTokens = (details.cache_read_input_tokens ?? 0) + (details.cache_creation_input_tokens ?? 0);
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
    cachedInputTokens: cachedInputTokens || undefined,
    raw: usage,
  };
}

// 把中立历史翻成 Anthropic 的 messages。三个要点（也是 tool-calling 协议的关键）：
//   - system 不进 messages（它是顶层参数）
//   - assistant 的 tool_use 必须带 id
//   - 工具结果用 user 角色的 tool_result 块发回，按 id 对应；连续的工具结果合并到同一条 user 消息
function toAnthropic(messages: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? [])
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      out.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        (prev.content as any[]).push(block); // 合并连续 tool_result
      } else {
        out.push({ role: "user", content: [block] as any });
      }
    }
  }
  return out;
}

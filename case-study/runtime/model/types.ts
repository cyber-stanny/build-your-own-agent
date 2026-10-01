// ┌─ harness 第 1 层：与模型对话的「中立数据结构」 ─────────────────────────┐
// 整个 agent 的历史、工具调用、工具结果都用这里的类型表达。
// 关键设计：我们定义一套**与具体厂商无关**的类型；具体 provider（mock / anthropic）
// 负责把它翻译成各家 API 的格式。loop 只认这套类型，不关心背后是谁。
// 这就是 harness 里「模型适配层」的雏形。

// 模型这一轮想调用的某个工具
export interface ToolCall {
  id: string; // 这次调用的唯一 id，用来把对应的 tool_result 对回去
  name: string; // 要调用的工具名
  input: Record<string, unknown>; // 工具入参（此时还没校验）
}

// 对话历史里的一条消息。四种角色：
export type Message =
  | { role: "system"; content: string } // 系统提示（agent 的身份/规则）
  | { role: "user"; content: string } // 用户输入
  | { role: "assistant"; content: string; reasoningContent?: string; toolCalls?: ToolCall[] } // 模型发言（可能附带思考内容和工具调用）
  | { role: "tool"; toolCallId: string; content: string }; // 某次工具调用的结果（observation）

// 给模型看的「工具说明书」
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema，描述这个工具的参数长什么样
}

// 模型厂商返回的真实 token 用量。字段保持中立命名，provider 负责从各家 usage 映射过来。
export interface ModelUsage {
  requestId?: string;
  model?: string;
  systemFingerprint?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheMissInputTokens?: number;
  reasoningTokens?: number;
  raw?: unknown;
}

// 模型一轮的输出，被 provider 统一成这个形状
export interface ModelResponse {
  text: string; // 模型这一轮说的话（只调工具时可能为空）
  reasoningContent?: string; // provider 要求后续回传的思考内容（DeepSeek V4 工具轮次）
  toolCalls: ToolCall[]; // 想调用的工具；空数组 = 不再调工具 = 给出最终答案
  usage?: ModelUsage; // API 返回的真实 token 用量；mock 或不支持的 provider 可以没有
}

// 所有 provider 都实现这一个接口。换模型 = 换一个实现，loop 一行都不用动。
export interface ModelClient {
  name: string;
  complete(messages: Message[], tools: ToolSchema[], signal?: AbortSignal): Promise<ModelResponse>;
}

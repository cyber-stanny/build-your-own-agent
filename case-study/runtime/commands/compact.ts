import type { ModelClient, Message } from "../model/types";
import { estimateTokens } from "../context/builder";

export type CompactResult = {
  summary: string;
  beforeMessages: number;
  afterMessages: number;
  beforeTokens: number;
  afterTokens: number;
};

const COMPACT_PROMPT = `你要把一个 coding agent 的完整历史压缩成“继续工作摘要”。

要求：
- 只保留后续继续执行任务真正需要的信息。
- 不要编造，不确定就写“不确定”。
- 尽量保留具体文件名、命令、错误、已做决定、未完成事项。
- 输出中文 Markdown，结构必须包含：
  目标
  当前进度
  关键文件/命令
  已确认的决定
  失败过的尝试
  未完成事项
  下一步建议`;

export async function compactMessages(
  messages: Message[],
  model: ModelClient,
  options: { keepRecentUserTurns: number },
): Promise<CompactResult> {
  const beforeMessages = messages.length;
  const beforeTokens = estimateTokens(messages);
  const split = splitForCompact(messages, options.keepRecentUserTurns);
  const summary = split.old.length > 0 ? await summarize(split.old, model) : emptySummary();
  const compacted = replaceOldHistoryWithSummary(split, summary);

  messages.splice(0, messages.length, ...compacted);

  return {
    summary,
    beforeMessages,
    afterMessages: messages.length,
    beforeTokens,
    afterTokens: estimateTokens(messages),
  };
}

async function summarize(messages: Message[], model: ModelClient): Promise<string> {
  if (model.name === "mock") {
    return fallbackSummary(messages);
  }

  const res = await model.complete(
    [
      { role: "system", content: COMPACT_PROMPT },
      { role: "user", content: formatTranscript(messages) },
    ],
    [],
  );
  return res.text.trim() || fallbackSummary(messages);
}

type CompactSplit = {
  system?: Message;
  old: Message[];
  tail: Message[];
};

function replaceOldHistoryWithSummary(split: CompactSplit, summary: string): Message[] {
  const out: Message[] = [];

  if (split.system) out.push(split.system);
  out.push({ role: "system", content: `以下是此前对话的压缩摘要，用于继续执行当前任务：\n\n${summary}` });
  out.push(...split.tail);

  return out;
}

function splitForCompact(messages: Message[], keepRecentUserTurns: number): CompactSplit {
  const systemIndex = messages.findIndex((m) => m.role === "system");
  const system = systemIndex >= 0 ? messages[systemIndex] : undefined;
  const body = messages.filter((_, index) => index !== systemIndex);
  const tailStart = findRecentUserTurnStart(body, keepRecentUserTurns);

  return {
    system,
    old: body.slice(0, tailStart),
    tail: body.slice(tailStart),
  };
}

function findRecentUserTurnStart(messages: Message[], keepRecentUserTurns: number): number {
  const keep = Math.max(1, keepRecentUserTurns);
  let seen = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue;
    seen++;
    if (seen === keep) return i;
  }

  return 0;
}

function formatTranscript(messages: Message[]): string {
  return messages.map(formatMessage).join("\n\n---\n\n");
}

function formatMessage(m: Message): string {
  if (m.role === "assistant") {
    const tools = m.toolCalls?.length ? `\n工具调用：${JSON.stringify(m.toolCalls)}` : "";
    return `assistant:\n${m.content}${tools}`;
  }
  if (m.role === "tool") return `tool(${m.toolCallId}):\n${m.content}`;
  return `${m.role}:\n${m.content}`;
}

function fallbackSummary(messages: Message[]): string {
  const users = messages.filter((m) => m.role === "user").map((m) => `- ${m.content}`);
  const recent = messages.slice(-8).map(formatMessage).join("\n\n");
  return [
    "## 目标",
    users.at(-1) ?? "- 不确定",
    "## 当前进度",
    "已根据当前 transcript 生成压缩摘要；mock 模型下使用规则摘要。",
    "## 关键文件/命令",
    "不确定",
    "## 已确认的决定",
    "保留全部用户输入作为任务锚点，并保留最近若干轮原始细节。",
    "## 失败过的尝试",
    "不确定",
    "## 未完成事项",
    "继续根据用户最新任务推进。",
    "## 下一步建议",
    "读取最近上下文，确认任务状态后继续执行。",
    "## 最近片段",
    recent,
  ].join("\n\n");
}

function emptySummary(): string {
  return [
    "## 目标",
    "- 不确定",
    "## 当前进度",
    "没有可压缩的旧历史；已保留最近用户对话原文。",
    "## 关键文件/命令",
    "不确定",
    "## 已确认的决定",
    "不确定",
    "## 失败过的尝试",
    "无",
    "## 未完成事项",
    "继续根据用户最新任务推进。",
    "## 下一步建议",
    "读取最近上下文，确认任务状态后继续执行。",
  ].join("\n\n");
}

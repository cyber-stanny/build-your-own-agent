import type { Message } from "../model/types";

// ┌─ context 工程的核心：把「完整 transcript」压成「这轮真正发给模型的 context」─┐
// transcript（全部历史，只增不减）→ buildContext（按规则裁剪/截断）→ 发出去的 messages
// 默认 cache-first：预算内保留完整 transcript，只在越过预算时成批移除最旧的完整 user turn。
// legacy-window 保留旧行为，便于 A/B 和紧急回退。

export type ContextStrategy = "cache-first" | "legacy-window";

export interface ContextConfig {
  strategy?: ContextStrategy;
  recentTurns: number; // legacy-window：保留最近 N 个 assistant/tool 轮次
  pruneBatchUserTurns?: number; // cache-first：超预算时每批移除多少个完整 user turn
  maxToolResultChars: number; // 单条工具结果超过此长度就截断（截断 ≠ 丢弃）
  maxContextTokens?: number; // 粗估 context token 预算；超过时按所选策略裁剪
}

export interface BuiltContext {
  messages: Message[]; // 这轮真正发给模型的内容
  included: string[]; // 放了哪些（给 debugger 看）
  omitted: string[]; // 省了/截断了哪些 + 原因
  tokenEstimate: number; // 粗估 token（英文≈chars/4；中文偏低，先够用）
}

type TaggedMessage = {
  m: Message;
  turn: number;
};

export function buildContext(transcript: Message[], config: ContextConfig): BuiltContext {
  if ((config.strategy ?? "cache-first") === "cache-first") {
    return buildCacheFirstContext(transcript, config);
  }

  return buildLegacyWindowContext(transcript, config);
}

function buildCacheFirstContext(transcript: Message[], config: ContextConfig): BuiltContext {
  const full = buildCacheFirstCandidate(transcript, config, 0);
  if (!config.maxContextTokens || full.tokenEstimate <= config.maxContextTokens) return full;

  const body = transcript.filter((m) => m.role !== "system");
  const userTurns = countUserMessages(body);
  const maxDroppable = Math.max(0, userTurns - 1);
  const batch = Math.max(1, config.pruneBatchUserTurns ?? 8);

  for (let dropped = Math.min(batch, maxDroppable); dropped <= maxDroppable && dropped > 0; ) {
    const candidate = buildCacheFirstCandidate(transcript, config, dropped);
    if (candidate.tokenEstimate <= config.maxContextTokens || dropped === maxDroppable) {
      candidate.omitted.unshift(
        candidate.tokenEstimate > config.maxContextTokens
          ? `context 仍超过预算：粗估 ${candidate.tokenEstimate} / ${config.maxContextTokens} tokens`
          : `context 超过预算后按批裁剪：每批 ${batch} 个完整 user turn`,
      );
      return candidate;
    }

    dropped = Math.min(dropped + batch, maxDroppable);
  }

  full.omitted.unshift(
    `context 仍超过预算：粗估 ${full.tokenEstimate} / ${config.maxContextTokens} tokens（没有可移除的完整旧 user turn）`,
  );
  return full;
}

function buildCacheFirstCandidate(
  transcript: Message[],
  config: ContextConfig,
  droppedUserTurns: number,
): BuiltContext {
  const systemMessages = transcript.filter((m) => m.role === "system");
  const body = transcript.filter((m) => m.role !== "system");
  const userStarts = findUserTurnStarts(body);
  const keepFrom = droppedUserTurns > 0 ? (userStarts[droppedUserTurns] ?? body.length) : 0;
  const out: Message[] = [];
  const omitted: string[] = [];

  for (const message of [...systemMessages, ...body.slice(keepFrom)]) {
    const compacted = compactToolResult(message, config.maxToolResultChars);
    out.push(compacted.message);
    if (compacted.omitted) omitted.push(compacted.omitted);
  }

  if (droppedUserTurns > 0) {
    omitted.unshift(`省略最旧的 ${droppedUserTurns} 个完整 user turn（${keepFrom} 条消息）`);
  }

  return {
    messages: out,
    included:
      droppedUserTurns === 0
        ? ["system（含 memory/summary system）", "预算内完整 transcript（append-only）"]
        : [
            "system（含 memory/summary system）",
            `最近 ${Math.max(1, userStarts.length - droppedUserTurns)} 个完整 user turn`,
          ],
    omitted,
    tokenEstimate: estimateTokens(out),
  };
}

function buildLegacyWindowContext(transcript: Message[], config: ContextConfig): BuiltContext {
  const maxRecentTurns = Math.max(1, config.recentTurns);
  let built = buildLegacyWithRecentTurns(transcript, config, maxRecentTurns);
  if (!config.maxContextTokens || built.tokenEstimate <= config.maxContextTokens) return built;

  for (let recentTurns = maxRecentTurns - 1; recentTurns >= 1; recentTurns--) {
    const candidate = buildLegacyWithRecentTurns(transcript, config, recentTurns);
    if (candidate.tokenEstimate <= config.maxContextTokens || recentTurns === 1) {
      built = candidate;
      break;
    }
  }

  built.omitted.unshift(
    built.tokenEstimate > config.maxContextTokens
      ? `context 仍超过预算：粗估 ${built.tokenEstimate} / ${config.maxContextTokens} tokens（system/user 锚点会保留）`
      : `为适配 context 预算，最近轮数从 ${maxRecentTurns} 降到 ${extractEffectiveRecentTurns(built.included)} 轮`,
  );
  return built;
}

function buildLegacyWithRecentTurns(transcript: Message[], config: ContextConfig, recentTurns: number): BuiltContext {
  const { maxToolResultChars } = config;
  const tagged = tagTurns(transcript);
  const lastTurn = getLastTurn(tagged);
  const keepFrom = lastTurn - recentTurns + 1; // 保留 turn >= keepFrom 的（锚点除外，恒留）

  const out: Message[] = [];
  const omitted: string[] = [];
  let omittedMsgs = 0;

  for (const item of tagged) {
    if (isOldHistory(item, keepFrom)) {
      omittedMsgs++; // 太旧，省略（一整轮一起省，不会把 assistant 和它的 tool 拆开）
      continue;
    }

    const compacted = compactToolResult(item.m, maxToolResultChars);
    out.push(compacted.message);
    if (compacted.omitted) omitted.push(compacted.omitted);
  }

  if (omittedMsgs > 0) {
    omitted.unshift(`省略旧历史 ${omittedMsgs} 条消息（早于最近 ${recentTurns} 轮）`);
  }

  return {
    messages: out,
    included: describeIncluded(recentTurns, lastTurn),
    omitted,
    tokenEstimate: estimateTokens(out),
  };
}

function findUserTurnStarts(messages: Message[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") starts.push(i);
  }
  return starts;
}

function countUserMessages(messages: Message[]): number {
  return messages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0);
}

function extractEffectiveRecentTurns(included: string[]): number {
  const item = included.find((line) => line.startsWith("最近 "));
  const match = item?.match(/最近 (\d+) 轮/);
  return match ? Number(match[1]) : 1;
}

// 标 turn 号：每遇到一个 assistant 就开一轮；assistant 与它后面的 tool 同属一轮。
// system / user 是锚点（turn = -1），永远保留。
function tagTurns(transcript: Message[]): TaggedMessage[] {
  let turn = 0;
  return transcript.map((m) => {
    if (m.role === "assistant") turn++;
    return { m, turn: isAnchorMessage(m) ? -1 : turn };
  });
}

function isAnchorMessage(m: Message): boolean {
  return m.role === "system" || m.role === "user";
}

function getLastTurn(tagged: TaggedMessage[]): number {
  return Math.max(0, ...tagged.map((item) => item.turn));
}

function isOldHistory(item: TaggedMessage, keepFrom: number): boolean {
  return item.turn !== -1 && item.turn < keepFrom;
}

function compactToolResult(m: Message, maxToolResultChars: number): { message: Message; omitted?: string } {
  // 截断超长的工具结果（最大的 token 吞金兽）
  if (m.role !== "tool" || m.content.length <= maxToolResultChars) {
    return { message: m };
  }

  const truncated = truncateMiddle(m.content, maxToolResultChars);
  return {
    message: { ...m, content: truncated },
    omitted: `tool_result 截断 ${m.content.length}→${truncated.length} 字符`,
  };
}

function describeIncluded(recentTurns: number, lastTurn: number): string[] {
  return [
    "system + 全部 user（任务锚点，恒留）",
    `最近 ${Math.min(recentTurns, lastTurn)} 轮对话`,
  ];
}

// 粗估 token：累加 content 长度（+ assistant 的 toolCalls 序列化长度）/ 4。
// 不是精确分词，只为给 debugger 一个量级感；要精确得接真 tokenizer。
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.role === "assistant") {
      if (m.reasoningContent) chars += m.reasoningContent.length;
      if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
    }
  }
  return Math.ceil(chars / 4);
}

// 截断保留头+尾，中间标注省了多少（关键信息常在两端）
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.max(20, Math.floor((max - 40) / 2));
  return `${s.slice(0, keep)}\n…[截断 ${s.length - keep * 2} 字符]…\n${s.slice(-keep)}`;
}

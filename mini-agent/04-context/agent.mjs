// 04-context —— 加入 Context 管理。
// 问题：历史无限增长 → token 无限烧钱 → 注意力被稀释。
// 解法（对照原项目 context/builder.ts）：
//   1. 估算 token（chars/4）
//   2. 超长工具结果截断（保留头尾）
//   3. 超预算时成批丢弃最旧的完整 user 轮（保留 system）
// 关键认知：transcript（全量）≠ context（本轮发出）。两者分离。

// ── Context 管理（对照 runtime/context/builder.ts）──
const MAX_CONTEXT_TOKENS = 100; // 演示用小预算；原项目默认 500_000（config.defaults.ts:19）
const MAX_TOOL_RESULT_CHARS = 120; // 原项目默认 12_000

// 粗估 token：chars/4（原项目 estimateTokens：context/builder.ts:219）
function estimateTokens(messages) {
  return Math.ceil(messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) / 4);
}

// 超长工具结果截断：保留头尾，中间标注省略（原项目 truncateMiddle：builder.ts:232）
function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const keep = Math.max(20, Math.floor((max - 40) / 2));
  return `${s.slice(0, keep)}\n…[截断 ${s.length - keep * 2} 字符]…\n${s.slice(-keep)}`;
}

// cache-first 风格裁剪（简化版，对照原项目 buildCacheFirstContext：builder.ts:38-65）：
//   超预算时从最旧的完整 user 轮开始丢弃，但至少保留最后一轮；system 永远保留。
// 「完整 user 轮」= 一条 user 消息 + 它引发的所有后续消息，绝不在轮中间拆开——
// 否则会出现「assistant 的 tool_calls 没有对应结果」的非法历史。
function buildContext(transcript, maxTokens) {
  const system = transcript.filter((m) => m.role === "system");
  const body = transcript.filter((m) => m.role !== "system");

  // 第一步：截断每条超长工具结果
  let kept = body.map((m) => (m.role === "tool" ? { ...m, content: truncateMiddle(m.content, MAX_TOOL_RESULT_CHARS) } : m));

  const omitted = [];
  // 第二步：超预算时，从最旧的 user 轮开始整轮丢弃
  if (estimateTokens([...system, ...kept]) > maxTokens) {
    const userIdx = kept.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
    const droppable = userIdx.length - 1; // 至少保留最后一轮
    if (droppable > 0) {
      kept = kept.slice(userIdx[droppable]); // 从最后一个 user 开始保留（演示：一次丢一批）
      omitted.push(`丢弃最旧 ${droppable} 个完整 user turn（剩 ${kept.length} 条消息）`);
    }
    omitted.push(`裁剪后粗估 ${estimateTokens([...system, ...kept])} / 预算 ${maxTokens} tokens`);
  }

  return { messages: [...system, ...kept], omitted };
}

// ── 演示 ──
// 构造一段有 5 个 user 轮、每轮带一条 500 字符工具输出的 transcript
const transcript = [{ role: "system", content: "你是演示助手。" }];
for (let i = 1; i <= 5; i++) {
  transcript.push({ role: "user", content: `任务${i}：处理一批数据` });
  transcript.push({ role: "assistant", content: `第 ${i} 步开始`, tool_calls: [{ id: `c${i}` }] });
  transcript.push({ role: "tool", toolCallId: `c${i}`, content: `日志${i}: ${"x".repeat(500)} 结束标记${i}` });
}

console.log(`transcript: ${transcript.length} 条消息，粗估 ${estimateTokens(transcript)} tokens（全量保存，不动）\n`);

// 单独演示工具结果截断（发生在每轮构建时，与裁剪无关）
const one = transcript.find((m) => m.role === "tool");
console.log("── 截断演示（单条工具结果）──");
console.log(truncateMiddle(one.content, MAX_TOOL_RESULT_CHARS));

// 整体演示 buildContext
const { messages, omitted } = buildContext(transcript, MAX_CONTEXT_TOKENS);
console.log(`\n── 裁剪演示（预算 ${MAX_CONTEXT_TOKENS} tokens）──`);
console.log(`context: ${messages.length} 条消息，粗估 ${estimateTokens(messages)} tokens`);
console.log(`roles: ${messages.map((m) => m.role).join(", ")}`);
if (omitted.length) console.log(`决策记录:\n  - ${omitted.join("\n  - ")}`);

// 对照源码：
//   estimateTokens        ↔ runtime/context/builder.ts:219
//   truncateMiddle        ↔ builder.ts:232（保留头尾：关键信息常在两端）
//   整轮丢弃 + 至少留一轮 ↔ builder.ts:38-65 buildCacheFirstContext（原版逐批尝试）
//   transcript/context 分离 ↔ builder.ts:3-5 注释；session 存全量（sessions/session.ts）

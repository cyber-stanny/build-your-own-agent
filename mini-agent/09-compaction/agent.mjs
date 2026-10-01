// 09-compaction —— 加入 Context Compaction：把 transcript 本身压小。
// 与 04 阶段的裁剪不同：裁剪是「每轮临时少发一点」（transcript 不变），
// compaction 是「旧历史 → 摘要，写回 transcript」（永久变小，保留任务语义）。
// 对照原项目 commands/compact.ts：保留 system + 最近 N 个 user 轮，中间换成一条摘要 system 消息。
//
// 运行：node agent.mjs    （内置演示：8 轮历史 → /compact → 观察前后形状）

function createLLM() {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      name: "mock",
      // mock 的 summarize：直接数要点（对照原项目对 mock 走规则摘要 fallbackSummary）
      async chat(messages) {
        const transcript = messages.at(-1).content;
        const users = [...transcript.matchAll(/^user:\n(.+)$/gm)].map((m) => m[1]);
        return [
          "## 目标",
          users.at(-1) ?? "不确定",
          "## 当前进度",
          `旧历史中共 ${users.length} 条用户输入（mock 规则摘要只提炼最后一条作为目标锚点，细节以保留的最近原文为准）`,
        ].join("\n");
      },
    };
  }
  const baseUrl = process.env.MINI_AGENT_BASE_URL ?? "https://api.deepseek.com";
  const model = process.env.MINI_AGENT_MODEL ?? "deepseek-chat";
  return {
    name: model,
    async chat(messages) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
      return (await res.json()).choices[0].message.content;
    },
  };
}

// ── Compaction（对照 runtime/commands/compact.ts:27 的 compactMessages）──
const KEEP_RECENT_USER_TURNS = 2; // 原项目默认 2（config.defaults.ts:22）
const COMPACT_PROMPT =
  "把这段 agent 对话历史压缩成「继续工作摘要」。保留：目标、当前进度、关键文件/命令、已确认的决定、未完成事项。不要编造。";

function estimateTokens(messages) {
  return Math.ceil(messages.reduce((s, m) => s + (m.content?.length ?? 0), 0) / 4);
}

function splitForCompact(messages, keepRecent) {
  const system = messages[0]?.role === "system" ? messages[0] : undefined;
  const body = messages.filter((m) => m !== system);
  // 从后往前数第 keepRecent 个 user 消息的位置（对照 compact.ts:93 findRecentUserTurnStart）
  let seen = 0, tailStart = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].role === "user" && ++seen === keepRecent) { tailStart = i; break; }
  }
  return { system, old: body.slice(0, tailStart), tail: body.slice(tailStart) };
}

async function compactMessages(messages, llm) {
  const before = { n: messages.length, tokens: estimateTokens(messages) };
  const { system, old, tail } = splitForCompact(messages, KEEP_RECENT_USER_TURNS);

  let summary = "(没有可压缩的旧历史)";
  if (old.length > 0) {
    const transcript = old.map((m) => `${m.role}:\n${m.content}`).join("\n\n---\n\n");
    summary = (await llm.chat([{ role: "system", content: COMPACT_PROMPT }, { role: "user", content: transcript }])).trim();
  }

  // 替换形状：[身份 system] + [摘要 system] + [最近轮]（对照 compact.ts:70 replaceOldHistoryWithSummary）
  const compacted = [
    ...(system ? [system] : []),
    { role: "system", content: `以下是此前对话的压缩摘要，用于继续执行当前任务：\n\n${summary}` },
    ...tail,
  ];
  return { compacted, before, after: { n: compacted.length, tokens: estimateTokens(compacted) }, summary };
}

// ── 演示 ──
const llm = createLLM();
// 构造一段很长的历史（模拟真实任务：大量工具输出会撑爆 context）
const messages = [
  { role: "system", content: "你是项目助手。" },
  { role: "user", content: "任务：给我的网站做暗色模式" },
  { role: "assistant", content: "好，我先读样式文件。", tool_calls: [{ id: "c1" }] },
  { role: "tool", toolCallId: "c1", content: `styles.css:\n${"color: #333; margin: 0; padding: 0;\n".repeat(30)}...(共 3000 字符)` },
  { role: "assistant", content: "方案：新增 theme.css 变量 + body[data-theme=dark] 覆盖。" },
  { role: "user", content: "顺便把字体换成思源黑体" },
  { role: "assistant", content: "已改用思源黑体，字体栈写进了 variables.css。", tool_calls: [{ id: "c2" }] },
  { role: "tool", toolCallId: "c2", content: `variables.css:\n${"font-family: 'Source Han Sans'; --gap: 8px;\n".repeat(30)}` },
  { role: "user", content: "加一个设置页，能切换亮暗主题" },
  { role: "assistant", content: "设置页完成，localStorage 记住选择。" },
  { role: "user", content: "把用户的主题偏好同步到服务端" },
  { role: "assistant", content: "方案：登录后 PUT /api/preferences。" },
];

console.log(`压缩前: ${messages.length} 条消息，粗估 ${estimateTokens(messages)} tokens`);
console.log("角色序列:", messages.map((m) => m.role).join(","));

const { compacted, before, after } = await compactMessages(messages, llm);
console.log(`\n压缩后: ${after.n} 条消息，粗估 ${after.tokens} tokens`);
console.log("角色序列:", compacted.map((m) => m.role).join(","));
console.log(`\n摘要 system 消息内容:\n${compacted[1].content}`);
console.log(`\n保留的最近轮原文:`);
for (const m of compacted.slice(2)) console.log(`  [${m.role}] ${m.content}`);

// 对照源码：
//   splitForCompact        ↔ runtime/commands/compact.ts:80（system + old + tail 三段）
//   COMPACT_PROMPT         ↔ compact.ts:12（原版要求七段结构：目标/进度/关键文件/决定/失败尝试/未完成/下一步）
//   摘要放 system          ↔ compact.ts:74（system 是裁剪锚点，永不被丢，见 context/builder.ts:185）
//   mock 规则摘要          ↔ compact.ts:49 summarize 里 model.name === "mock" 走 fallbackSummary
//   /compact 作为 run      ↔ sessions/runtime-store.ts:184 startCompact（可停止、有状态、与任务互斥）

// 06-memory —— 加入简单 Memory：跨会话的持久事实。
// 分工（对照原项目 memory/store.ts + tools/memory.ts）：
//   读 = 隐式：每轮调模型前，把记忆渲染成一条 system 消息注入
//   写 = 显式：模型通过 remember 工具主动记录
// 每轮「重新读取」是关键：run 中途刚写的记忆，下一圈就生效。
//
// 运行：node agent.mjs demo

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const MEMORY_FILE = path.join(import.meta.dirname, "memory.json");

// ── MemoryStore（对照 runtime/memory/store.ts:17）──
function loadMemory() {
  if (!existsSync(MEMORY_FILE)) return [];
  try {
    return JSON.parse(readFileSync(MEMORY_FILE, "utf8")).entries ?? [];
  } catch {
    return [];
  }
}

function remember(key, value) {
  const entries = loadMemory();
  const entry = { key, value, updatedAt: new Date().toISOString() };
  const existing = entries.findIndex((e) => e.key === key);
  if (existing >= 0) entries[existing] = entry; // 同 key 覆盖
  else entries.push(entry);
  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  writeFileSync(MEMORY_FILE, JSON.stringify({ entries: entries.slice(0, 50) }, null, 2)); // 上限 50 条
  return entry;
}

// 渲染成注入文本（对照 memory/store.ts:50 的 formatForContext）
function formatForContext(entries) {
  if (entries.length === 0) return "";
  return [
    "以下是已持久记住的事实（如已过时请用 remember 更新）：",
    ...entries.map((e) => `- ${e.key}: ${e.value}`),
  ].join("\n");
}

// ── 工具：remember（对照 runtime/tools/memory.ts:7 的 createRememberTool）──
const rememberTool = {
  name: "remember",
  description: "把对后续对话有复用价值的事实写入持久记忆。同一 key 会覆盖旧值。",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "简短稳定的记忆名，如 user.favoriteColor" },
      value: { type: "string", description: "要记住的具体事实" },
    },
    required: ["key", "value"],
  },
  async run({ key, value }) {
    const entry = remember(key, value);
    return `已记住: ${entry.key} = ${entry.value}`;
  },
};

function createLLM() {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      name: "mock",
      turn: 0,
      async chat(messages) {
        this.turn++;
        if (this.turn === 1)
          return {
            text: "好的，我记下来。",
            tool_calls: [{ id: "c1", function: { name: "remember", arguments: JSON.stringify({ key: "user.name", value: "小王" }) } }],
          };
        // 第 2 轮：证明记忆注入了 system —— 引用最后一条 system 消息的内容
        const memorySystem = messages.find((m) => m.role === "system" && m.content.startsWith("以下是已持久记住"));
        return { text: memorySystem ? `(mock) 从记忆注入中看到：${memorySystem.content.split("\n")[1]}` : "(mock) 没找到记忆", tool_calls: [] };
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
        body: JSON.stringify({
          model,
          messages,
          tools: [{ type: "function", function: { name: rememberTool.name, description: rememberTool.description, parameters: rememberTool.parameters } }],
        }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
      const msg = (await res.json()).choices[0].message;
      return { text: msg.content ?? "", tool_calls: msg.tool_calls ?? [] };
    },
  };
}

async function executeTool(call) {
  if (call.function.name !== "remember") return `error: unknown tool`;
  const input = JSON.parse(call.function.arguments || "{}");
  return rememberTool.run(input);
}

// ── 带「记忆注入」的 loop（对照 core/loop.ts:178-179 的 memoryContext + withMemoryContext:346）──
async function runTurn(llm, userMessage) {
  const messages = [
    { role: "system", content: "你是助手。用户告知的重要事实用 remember 记住。" },
    { role: "user", content: userMessage },
  ];

  for (let turn = 1; turn <= 5; turn++) {
    // 每圈【重新读取】最新记忆，插成一条 system 消息（在身份 system 之后）
    const memoryText = formatForContext(loadMemory());
    const outgoing = memoryText
      ? [messages[0], { role: "system", content: memoryText }, ...messages.slice(1)]
      : messages;

    const { text, tool_calls } = await llm.chat(outgoing);
    if (tool_calls.length === 0) return text;

    messages.push({ role: "assistant", content: text, tool_calls });
    for (const call of tool_calls) {
      const observation = await executeTool(call);
      console.log(`  [工具] ${observation}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: observation });
    }
  }
  return "(stopped: reached maxTurns)";
}

// ── 演示：记住 → 新 run 里用上 ──
console.log("── run 1：告诉它一件事实 ──");
const llm = createLLM();
console.log(`用户: 我叫小王\n助手: ${await runTurn(llm, "我叫小王")}`);
console.log(`\nmemory.json: ${readFileSync(MEMORY_FILE, "utf8").trim()}`);
console.log("\n── run 2：全新的 run（历史为空），但记忆还在 ──");
console.log(`用户: 我叫什么？\n助手: ${await runTurn(llm, "我叫什么？")}`);

// 对照源码：
//   loadMemory/remember    ↔ runtime/memory/store.ts:27（同 key 覆盖、上限 50、按时间排序）
//   formatForContext       ↔ memory/store.ts:50
//   每圈注入最新记忆       ↔ core/loop.ts:178 config.memoryContext?.() + withMemoryContext :346
//   remember 工具          ↔ tools/memory.ts:7（工厂函数注入 MemoryStore）

// 重新开始记忆：删除 memory.json 即可

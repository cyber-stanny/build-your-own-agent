// 01-basic-chat —— 最简单的 LLM 对话。
// 没有循环、没有工具、没有记忆：一组 messages，一次调用，一个回答。
//
// 运行：
//   node agent.mjs "什么是 Agent Loop？"
//   MINI_AGENT_API_KEY=sk-xxx node agent.mjs "你好"   # 有 key 时调真实模型

import { readFileSync } from "node:fs";

// ── LLM 封装：有 key 走真实 API（OpenAI 兼容），没 key 用 Mock ──
// 这就是 runtime/model/types.ts 里 ModelClient 接口的最小雏形：
// 调用方只认「传 messages，回一段文本」，不关心背后是谁。
function createLLM() {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      name: "mock",
      // Mock：不调网络，按输入拼一个确定的回复（可重复、可离线）
      async chat(messages) {
        const last = messages[messages.length - 1].content;
        return `(mock 回复) 你说：「${last}」。配置 MINI_AGENT_API_KEY 可切换真实模型。`;
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
      const data = await res.json();
      return data.choices[0].message.content;
    },
  };
}

// ── 主程序 ──
const userMessage = process.argv.slice(2).join(" ") || "用一句话解释什么是 AI Agent";

const messages = [
  { role: "system", content: "你是一个简洁的教学助手，用中文回答。" },
  { role: "user", content: userMessage },
];

const llm = createLLM();
console.log(`模型: ${llm.name}`);
const answer = await llm.chat(messages);
console.log(`助手: ${answer}`);

// 对照源码：这个 30 行文件对应 my-agent-runtime 的这些部分 ——
//   messages 结构      → runtime/model/types.ts:15 (Message)
//   createLLM 封装     → runtime/model/types.ts:51 (ModelClient 接口)
//   真实模型调用       → runtime/model/deepseek.ts:27 (DeepseekModelClient.complete)
//   mock 模型          → runtime/model/mock.ts:8 (MockModelClient)

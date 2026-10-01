// 03-tools —— 加入 Tool Calling：agent 的「手」。
// 模型不再用文本标记表达意图，而是返回结构化的 tool_calls；
// 我们执行后把结果作为 role:"tool" 消息塞回历史，下一轮模型就能「看到」结果。
//
// 运行：node agent.mjs "帮我看看 notes.txt 里写了什么"

import { readFileSync, existsSync } from "node:fs";

// ── 工具定义：name + description(给模型看) + parameters(JSON Schema) + run(真正干活) ──
// 对照原项目 tools/types.ts:19 的 Tool 接口（那边用 zod，这里手写 JSON Schema）
const readFileTool = {
  name: "read_file",
  description: "读取当前目录下某个文本文件的内容。当用户问文件内容时使用。",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "文件名，如 notes.txt" } },
    required: ["path"],
  },
  // run 拿到已校验的入参；返回字符串会原样进入模型历史
  async run({ path }) {
    if (!existsSync(path)) return `error: 文件 ${path} 不存在`;
    const content = readFileSync(path, "utf8");
    return content.slice(0, 2000); // 简化版截断：原项目是保留头尾的 truncateMiddle
  },
};

const listDirTool = {
  name: "list_dir",
  description: "列出当前目录下的文件名。当用户想看看有什么文件时使用。",
  parameters: { type: "object", properties: {} },
  async run() {
    return (await import("node:fs")).readdirSync(".").filter((f) => !f.startsWith(".")).join("\n") || "(空)";
  },
};

const TOOLS = [readFileTool, listDirTool];

function createLLM() {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      name: "mock",
      // Mock 剧本：先看目录 → 读文件 → 收尾（对照原项目 model/mock.ts 的三步剧本）
      turn: 0,
      async chat(messages) {
        this.turn++;
        if (this.turn === 1)
          return { text: "我先看看目录里有什么。", tool_calls: [{ id: "call_1", function: { name: "list_dir", arguments: "{}" } }] };
        if (this.turn === 2)
          return { text: "找到了，读取内容。", tool_calls: [{ id: "call_2", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) } }] };
        const last = messages.filter((m) => m.role === "tool").at(-1)?.content ?? "";
        return { text: `notes.txt 的内容是：${last}`, tool_calls: [] };
      },
    };
  }
  const baseUrl = process.env.MINI_AGENT_BASE_URL ?? "https://api.deepseek.com";
  const model = process.env.MINI_AGENT_MODEL ?? "deepseek-chat";
  return {
    name: model,
    // 真实 API：messages + tools(声明) 一起发；tool_calls 是模型主动要求的
    async chat(messages) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          tools: TOOLS.map(({ name, description, parameters }) => ({
            type: "function",
            function: { name, description, parameters },
          })),
        }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
      const msg = (await res.json()).choices[0].message;
      return { text: msg.content ?? "", tool_calls: msg.tool_calls ?? [] };
    },
  };
}

// ── 执行一个工具调用（对照原项目 core/loop.ts:365 的 executeTool，这里是极简版）──
async function executeTool(call) {
  const tool = TOOLS.find((t) => t.name === call.function.name);
  if (!tool) return `error: unknown tool "${call.function.name}"`; // 找不到→错误当结果，不抛异常
  let input = {};
  try {
    input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return "error: 参数不是合法 JSON"; // 模型给错参数同样当观察结果
  }
  try {
    return await tool.run(input);
  } catch (err) {
    return `error: ${err.message}`; // 工具报错→给模型看，让它自己决定下一步
  }
}

// ── 带 Agent Loop：有 tool_calls 就执行并回填，没有就是最终答案 ──
async function runTurn(llm, userMessage) {
  const messages = [
    { role: "system", content: "你是文件助手。需要信息时调用工具，拿到结果后再回答。" },
    { role: "user", content: userMessage },
  ];

  for (let turn = 1; turn <= 8; turn++) {
    const { text, tool_calls } = await llm.chat(messages);
    console.log(`[turn ${turn}] 模型: ${text || "(思考中，直接调工具)"}`);

    if (tool_calls.length === 0) return text; // 停止条件：不再调工具 = 最终答案

    messages.push({ role: "assistant", content: text, tool_calls }); // 声明也要进历史
    for (const call of tool_calls) {
      console.log(`[turn ${turn}]   调用 ${call.function.name}(${call.function.arguments})`);
      const observation = await executeTool(call);
      console.log(`[turn ${turn}]   结果: ${observation.slice(0, 80)}${observation.length > 80 ? "…" : ""}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: observation }); // 结果回填
    }
  }
  return "(stopped: reached maxTurns)";
}

const answer = await runTurn(createLLM(), process.argv.slice(2).join(" ") || "帮我看看 notes.txt 里写了什么");
console.log(`\n最终答复: ${answer}`);

// 对照源码：
//   TOOLS 声明          ↔ runtime/tools/types.ts:19 (Tool 接口)
//   executeTool         ↔ runtime/core/loop.ts:365（原版多了白名单/zod 校验/安全策略三关）
//   结果回填            ↔ core/loop.ts:281（push role:"tool" 消息）
//   mock 三步剧本       ↔ runtime/model/mock.ts:12-42

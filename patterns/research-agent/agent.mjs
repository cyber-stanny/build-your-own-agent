// 资料研究 Agent —— 知识点：多步信息收集（search → read → 综合）+ 带出处引用
// 运行：node agent.mjs "什么是 RAG？和微调有什么区别？"
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const CORPUS_DIR = path.join(ROOT, "corpus");

// ── LLM 封装（每个 Demo 重复这 25 行，方便单独阅读）──
function createLLM(mockScript) {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return { name: "mock", async chat(messages, tools) { return mockScript(messages, tools); } };
  const baseUrl = process.env.MINI_AGENT_BASE_URL ?? "https://api.deepseek.com";
  const model = process.env.MINI_AGENT_MODEL ?? "deepseek-chat";
  return {
    name: model,
    async chat(messages, tools) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, messages,
          ...(tools?.length && { tools: tools.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } })) }),
        }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
      const msg = (await res.json()).choices[0].message;
      return { text: msg.content ?? "", tool_calls: msg.tool_calls ?? [] };
    },
  };
}

// ── 工具：search_docs（按关键词找文件和行）+ read_doc（读全文）──
const TOOLS = [
  {
    name: "search_docs",
    description: "在资料库中搜索关键词，返回命中的文档名和匹配行。研究的第一步。",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run({ query }) {
      const hits = [];
      for (const f of readdirSync(CORPUS_DIR)) {
        const lines = readFileSync(path.join(CORPUS_DIR, f), "utf8").split("\n");
        lines.forEach((line, i) => {
          if (line.toLowerCase().includes(query.toLowerCase())) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
      }
      return hits.slice(0, 20).join("\n") || `(没有关于 "${query}" 的资料)`;
    },
  },
  {
    name: "read_doc",
    description: "读取资料库中某篇文档的完整内容。",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async run({ name }) {
      const abs = path.join(CORPUS_DIR, name);
      if (!abs.startsWith(CORPUS_DIR + path.sep)) return "error: 非法路径";
      try { return readFileSync(abs, "utf8"); } catch { return `error: 找不到文档 ${name}`; }
    },
  },
];

// ── Mock 剧本：按问题关键词检索 → 读命中最多的文档 → 带引用作答 ──
// 真实模型靠语义决定检索词与读哪篇；mock 用关键词 + 命中计数近似，保证课堂输入都能走通。
function createMockScript() {
  let phase = 0;
  let docName = "";
  let query = "";
  return function (messages) {
    const last = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
    phase++;
    if (phase === 1) {
      const question = messages.at(-1).content;
      query = /微调|fine-?tuning/i.test(question) ? "微调" : /tool calling|工具调用/i.test(question) ? "tool calling" : "RAG";
      return { text: `我先在资料库里搜「${query}」。`, tool_calls: [{ id: "c1", function: { name: "search_docs", arguments: JSON.stringify({ query }) } }] };
    }
    if (phase === 2) {
      // 选命中最多的文档，而不是第一行命中的（更接近相关性排序）
      const counts = {};
      for (const line of last.split("\n")) {
        const doc = line.split(":")[0];
        if (doc) counts[doc] = (counts[doc] ?? 0) + 1;
      }
      docName = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      if (!docName) return { text: `资料库里没有关于「${query}」的内容，如实告知用户。`, tool_calls: [] };
      return { text: `命中了 ${docName}（${counts[docName]} 处），读全文。`, tool_calls: [{ id: "c2", function: { name: "read_doc", arguments: JSON.stringify({ name: docName }) } }] };
    }
    const excerpt = last.split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 2).join("；");
    const compare = /RAG|微调/.test(query)
      ? "\n\n综合资料：RAG 是检索外部知识注入上下文，改的是「模型能查到什么」；微调（fine-tuning）改的是「模型参数本身」。前者成本低、可随时更新知识库，适合知识频繁变化的场景；后者把知识烧进权重，适合固定风格与格式。"
      : "\n\n以上要点均出自该文档原文，未添加资料之外的内容。";
    return { text: `根据资料《${docName}》：${excerpt}${compare}`, tool_calls: [] };
  };
}

// ── Agent Loop ──
async function runTurn(llm, userMessage) {
  const messages = [
    { role: "system", content: "你是研究助手。回答前先用 search_docs 搜资料、read_doc 读原文；回答时必须标注信息来自哪篇文档（格式：[文档名]）。资料里没有的就明说没有。" },
    { role: "user", content: userMessage },
  ];
  for (let turn = 1; turn <= 8; turn++) {
    const { text, tool_calls } = await llm.chat(messages, TOOLS);
    if (tool_calls.length === 0) return text;
    messages.push({ role: "assistant", content: text, tool_calls });
    for (const call of tool_calls) {
      let input = {};
      try { input = JSON.parse(call.function.arguments || "{}"); } catch { /* ignore */ }
      const tool = TOOLS.find((t) => t.name === call.function.name);
      const observation = tool ? await tool.run(input).catch((e) => `error: ${e.message}`) : `error: unknown tool`;
      console.log(`  🔧 ${call.function.name}(${JSON.stringify(input).slice(0, 50)})`);
      console.log(`     → ${observation.split("\n")[0].slice(0, 70)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: observation });
    }
  }
  return "(stopped: reached maxTurns)";
}

const question = process.argv.slice(2).join(" ") || "什么是 RAG？和微调有什么区别？";
const llm = createLLM(createMockScript());
console.log(`模型: ${llm.name}\n问题: ${question}\n`);
console.log(`最终答复:\n${await runTurn(llm, question)}`);

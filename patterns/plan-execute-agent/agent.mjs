// Plan & Execute Agent —— 知识点：先规划后执行（Planner / Executor 分离）+ 计划失败重规划
// Planner：把任务拆成带顺序的 JSON 步骤清单（一次调用）。
// Executor：逐步执行（带工具的 agent loop），每步的结果记录到计划状态里。
// 某步失败 → 回到 Planner 重规划（插入补救步骤），而不是硬着头皮继续——这是与纯 loop 的最大区别。
// 运行：node agent.mjs
import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const WORK_DIR = path.join(ROOT, "workspace");
mkdirSync(WORK_DIR, { recursive: true });
// 每次运行前复位两个演示产物，保证「初始计划漏一步 → 验证失败 → 重规划」每次都能看到。
// 安全纪律与 file-organizer 一致：只删「内容与本次演示生成的完全一致」的文件；
// 你自己改过的文件会保留（此时验证步骤可能直接通过，本次就看不到重规划路径）。
const DEMO_FILES = {
  "index.html": "<html><body><h1>欢迎</h1></body></html>",
  "style.css": "body { font-family: sans-serif; }",
};
for (const [name, demoContent] of Object.entries(DEMO_FILES)) {
  const p = path.join(WORK_DIR, name);
  if (!existsSync(p)) continue;
  let current = "";
  try { current = readFileSync(p, "utf8"); } catch { continue; }
  if (current === demoContent) unlinkSync(p);
  else console.log(`(检测到修改过的 ${name}，跳过重置；本次可能不会演示重规划路径)`);
}

function createLLM() {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  const BASE_URL = process.env.MINI_AGENT_BASE_URL ?? "https://api.deepseek.com";
  const MODEL = process.env.MINI_AGENT_MODEL ?? "deepseek-chat";
  if (!apiKey) return { name: "mock" };
  return {
    name: MODEL,
    async chat(messages, tools) {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL, messages,
          ...(tools?.length && { tools: tools.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } })) }),
        }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
      const msg = (await res.json()).choices[0].message;
      return { text: msg.content ?? "", tool_calls: msg.tool_calls ?? [] };
    },
  };
}

// ── Executor 的工具（与 coding-agent 相同的思路）──
const TOOLS = [
  {
    name: "write_file",
    description: "在工作目录写入文件。",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async run({ path: p, content }) {
      const abs = path.resolve(WORK_DIR, p);
      if (!abs.startsWith(WORK_DIR + path.sep)) return "error: 路径越界";
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      return `wrote ${p}`;
    },
  },
  {
    name: "list_files",
    description: "列出工作目录文件，用于验证。",
    parameters: { type: "object", properties: {} },
    async run() { return readdirSync(WORK_DIR).join("\n") || "(empty)"; },
  },
];

async function executeStep(llm, step) {
  console.log(`  ▶ 执行步骤 ${step.id}: ${step.detail}`);
  const messages = [
    { role: "system", content: "你是执行者。只完成给定的单个步骤，用工具完成它，完成后直接回复「步骤完成」。" },
    { role: "user", content: `当前步骤：${step.detail}` },
  ];
  for (let turn = 1; turn <= 5; turn++) {
    const { text, tool_calls } = await executorTurn(llm, messages, step);
    if (tool_calls.length === 0) return { status: text.includes("失败") ? "failed" : "done", note: text };
    messages.push({ role: "assistant", content: text, tool_calls });
    for (const call of tool_calls) {
      let input = {};
      try { input = JSON.parse(call.function.arguments || "{}"); } catch { /* ignore */ }
      const tool = TOOLS.find((t) => t.name === call.function.name);
      const observation = tool ? await tool.run(input).catch((e) => `error: ${e.message}`) : `error: unknown tool`;
      console.log(`      🔧 ${call.function.name} → ${observation.split("\n")[0].slice(0, 50)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: observation });
    }
  }
  return { status: "failed", note: "执行轮数耗尽" };
}

// Executor 的模型调用（mock 按步骤 id 决定行为；真实模型看 step.detail 即兴执行）
async function executorTurn(llm, messages, step) {
  if (llm.name !== "mock") return llm.chat(messages, TOOLS);
  // mock 剧本。hasToolResult：本步骤内已经执行过一次工具 → 本轮收尾（防止无限重复调用）
  const hasToolResult = messages.some((m) => m.role === "tool");

  // 验证类步骤：第一轮发起 list_files，第二轮基于真实目录内容下结论
  if (String(step.detail).startsWith("验证") || String(step.detail).startsWith("再次验证")) {
    if (!hasToolResult) return { text: "检查文件是否齐全。", tool_calls: [{ id: "ev", function: { name: "list_files", arguments: "{}" } }] };
    const listing = messages.filter((m) => m.role === "tool").at(-1).content;
    if (!listing.includes("style.css")) return { text: "验证失败：style.css 缺失", tool_calls: [] };
    return { text: `验证通过：${listing.split("\n").join("、")} 都在。步骤完成`, tool_calls: [] };
  }

  if (hasToolResult) return { text: "步骤完成", tool_calls: [] };

  if (String(step.detail).includes("style.css") || step.id === "2b") {
    return {
      text: "写入样式表。",
      tool_calls: [{ id: "ecss", function: { name: "write_file", arguments: JSON.stringify({ path: "style.css", content: "body { font-family: sans-serif; }" }) } }],
    };
  }
  return {
    text: "写入首页。",
    tool_calls: [{ id: "ehtml", function: { name: "write_file", arguments: JSON.stringify({ path: "index.html", content: "<html><body><h1>欢迎</h1></body></html>" }) } }],
  };
}

// ── Planner：任务 → JSON 步骤清单；失败时带着「哪步为什么失败」重新规划 ──
async function plan(llm, task, failureNote) {
  if (llm.name !== "mock") {
    const res = await llm.chat([
      { role: "system", content: '你是规划师。把任务拆成 2-4 个可执行步骤，只输出 JSON：{"steps":[{"id":1,"detail":"..."}]}' },
      { role: "user", content: failureNote ? `任务：${task}\n上次执行在「${failureNote}」失败，重新规划。` : `任务：${task}` },
    ]);
    return JSON.parse(res.text.replace(/^```(?:json)?\n?|```$/g, "").trim());
  }
  // mock 剧本：规划器第一次漏掉了 style.css（真实场景很常见——计划不完整），
  // 执行阶段的验证步骤暴露缺口 → 重规划补插补救步骤。
  if (!failureNote)
    return { steps: [{ id: 1, detail: "编写 index.html 欢迎页" }, { id: 2, detail: "验证 index.html 和 style.css 都存在" }] };
  return { steps: [{ id: "2b", detail: "补写 style.css（上次执行发现缺失）" }, { id: 2, detail: "再次验证 index.html 和 style.css 都存在" }] };
}

const llm = createLLM();
const TASK = "做一个最简单的欢迎页：index.html + style.css，并确认两个文件都在 workspace 里";
console.log(`模型: ${llm.name}\n任务: ${TASK}\n`);

let planData = await plan(llm, TASK);
console.log("—— 初始计划 ——");
for (const s of planData.steps) console.log(`  ${s.id}. ${s.detail}`);

let replans = 0;
while (replans <= 2) {
  let failedNote = null;
  for (const step of planData.steps) {
    const result = await executeStep(llm, step);
    if (result.status === "failed") {
      failedNote = `步骤 ${step.id}（${step.detail}）`;
      console.log(`  ✗ ${failedNote} 失败 → 触发重规划\n`);
      break;
    }
  }
  if (!failedNote) {
    console.log("\n✅ 计划全部完成");
    break;
  }
  replans++;
  planData = await plan(llm, TASK, failedNote);
  console.log(`—— 重规划 #${replans} ——`);
  for (const s of planData.steps) console.log(`  ${s.id}. ${s.detail}`);
}
if (replans > 2) console.log("\n❌ 重规划超过 2 次，停止（有界重试）");

console.log(`\n最终 workspace 内容: ${readdirSync(WORK_DIR).join("、") || "(空)"}`);

// 对照源码：
//   计划是显式 JSON 状态    ↔ followups/types.ts 的 PrReviewFollowupTask（状态机字段显式持久化）
//   步骤失败 → 重规划       ↔ followups/service.ts:71-77（repairing 状态不盲目继续，重新检查）
//   重规划次数上限          ↔ followups/types.ts:78 maxRepairAttempts（3/5 轮封顶）
//   Executor 是标准 loop    ↔ core/loop.ts:147 runTurn

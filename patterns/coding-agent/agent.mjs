// 简化版 Coding Agent —— 知识点：测试失败作为观察结果 → 模型自我修复；命令白名单
// 任务：写出 add.js 通过 test_add.js。Mock 故意先写错一版，展示完整的「失败→修复」循环。
// 运行：node agent.mjs
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";

const ROOT = import.meta.dirname;
const WORK_DIR = path.join(ROOT, "workspace");

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

// ── 工具 ──
const TOOLS = [
  {
    name: "write_file",
    description: "在工作目录写入文件（覆盖写）。",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async run({ path: p, content }) {
      const abs = path.resolve(WORK_DIR, p);
      if (!abs.startsWith(WORK_DIR + path.sep)) return "error: 路径越界";
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      return `wrote ${content.length} chars to ${p}`;
    },
  },
  {
    name: "read_file",
    description: "读取工作目录下的文件。",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async run({ path: p }) {
      const abs = path.resolve(WORK_DIR, p);
      if (!abs.startsWith(WORK_DIR + path.sep)) return "error: 路径越界";
      try { return (await import("node:fs")).readFileSync(abs, "utf8"); } catch { return `error: ${p} 不存在`; }
    },
  },
  {
    name: "run_command",
    description: "运行测试。只允许执行 node <file.js> 形式的命令。",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    async run({ command }) {
      // ⭐ 命令白名单：只放行 node <file>.js（对照 followups/agent.ts:132 的「唯一命令」审批白名单）
      if (!/^node\s+[\w./-]+\.js$/.test(command)) return `error: 只允许 "node <file>.js"，拒绝: ${command}`;
      return await new Promise((resolve) => {
        execFile("node", [command.slice(5).trim()], { cwd: WORK_DIR, timeout: 10_000 }, (err, stdout, stderr) => {
          // ⭐ 永不抛：失败信息原样给模型看（对照 runtime/tools/exec.ts:20 的 runCommand「永不抛」）
          resolve([`exit_code: ${err ? err.code ?? 1 : 0}`, stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join("\n"));
        });
      });
    },
  },
];

// ── Mock 剧本：写一版「故意错的」→ 测试失败 → 读报错 → 修复 → 通过 → 汇报 ──
function createMockScript() {
  let phase = 0;
  return function (messages) {
    const last = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
    phase++;
    if (phase === 1)
      return {
        text: "我来实现 add 函数。",
        tool_calls: [{ id: "c1", function: { name: "write_file", arguments: JSON.stringify({ path: "add.js", content: "module.exports = (a, b) => a - b; // 第一版：故意写错（减号）\n" }) } }],
      };
    if (phase === 2) return { text: "跑一下测试验证。", tool_calls: [{ id: "c2", function: { name: "run_command", arguments: JSON.stringify({ command: "node test_add.js" }) } }] };
    if (phase === 3) {
      // 此时 last 里是失败输出——模型「读到报错」后修复
      return {
        text: `测试失败了（${last.split("\n")[0]}）。报错显示期望相加但实际是相减，修复它。`,
        tool_calls: [{ id: "c3", function: { name: "write_file", arguments: JSON.stringify({ path: "add.js", content: "module.exports = (a, b) => a + b;\n" }) } }],
      };
    }
    if (phase === 4) return { text: "再跑一遍测试确认。", tool_calls: [{ id: "c4", function: { name: "run_command", arguments: JSON.stringify({ command: "node test_add.js" }) } }] };
    return { text: "测试全部通过：add(a,b) 已实现并通过 test_add.js 的 3 个断言。任务完成。", tool_calls: [] };
  };
}

// ── Agent Loop ──
async function runTurn(llm, userMessage) {
  const messages = [
    { role: "system", content: "你是 coding agent。实现代码后必须运行测试验证；测试失败时读报错、修改代码、重跑，直到通过或确认无解。" },
    { role: "user", content: userMessage },
  ];
  for (let turn = 1; turn <= 10; turn++) {
    const { text, tool_calls } = await llm.chat(messages, TOOLS);
    if (tool_calls.length === 0) return text;
    messages.push({ role: "assistant", content: text, tool_calls });
    for (const call of tool_calls) {
      let input = {};
      try { input = JSON.parse(call.function.arguments || "{}"); } catch { /* ignore */ }
      const tool = TOOLS.find((t) => t.name === call.function.name);
      const observation = tool ? await tool.run(input).catch((e) => `error: ${e.message}`) : `error: unknown tool`;
      console.log(`  🔧 ${call.function.name}(${JSON.stringify(input).slice(0, 60)})`);
      console.log(`     → ${observation.split("\n").slice(0, 2).join(" | ").slice(0, 90)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: observation });
    }
  }
  return "(stopped: reached maxTurns)";
}

// ── 测试文件（教学固定提供，agent 只实现被测函数）──
mkdirSync(WORK_DIR, { recursive: true });
if (!existsSync(path.join(WORK_DIR, "test_add.js"))) {
  writeFileSync(
    path.join(WORK_DIR, "test_add.js"),
    [
      "const add = require('./add.js');",
      "const assert = require('node:assert');",
      "assert.strictEqual(add(1, 2), 3);",
      "assert.strictEqual(add(-1, 1), 0);",
      "assert.strictEqual(add(0, 0), 0);",
      "console.log('ALL TESTS PASSED');",
    ].join("\n"),
  );
}

const llm = createLLM(createMockScript());
console.log(`模型: ${llm.name}\n任务: 实现 add.js，让 node test_add.js 输出 ALL TESTS PASSED\n`);
console.log(`最终答复: ${await runTurn(llm, "实现 add.js（导出一个加法函数），让它通过 test_add.js")}`);

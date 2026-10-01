// 数据分析 Agent —— 知识点：「代码即工具」（模型写代码→runtime 执行→结果回填）+ 沙箱意识
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

const ANALYSIS_CODE = `// 模型生成的分析代码：按地区汇总销售额
const fs = require('fs');
const rows = fs.readFileSync('data.csv', 'utf8').trim().split('\\n').slice(1)
  .map(line => { const [date, region, amount] = line.split(','); return { region, amount: Number(amount) }; });
const byRegion = {};
for (const r of rows) byRegion[r.region] = (byRegion[r.region] ?? 0) + r.amount;
const total = Object.values(byRegion).reduce((a, b) => a + b, 0);
for (const [region, sum] of Object.entries(byRegion).sort((a, b) => b[1] - a[1]))
  console.log(\`\${region}: \${sum} 元 (\${(sum / total * 100).toFixed(1)}%)\`);
console.log('TOTAL:', total);`;

// ── Mock 剧本：预览 → 执行分析代码 → 【从工具真实输出生成报告】→ 汇报 ──
// 报告里的每个数字都解析自 run_js 的 stdout 和 preview_csv 的行数——
// 换一份 CSV，报告就跟着变。这才能教「禁止编造数字，一切以代码输出为准」。
function createMockScript() {
  let phase = 0;
  let previewObs = "";
  let analysisObs = "";
  return function (messages) {
    const last = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
    phase++;
    if (phase === 1) return { text: "先看数据长什么样。", tool_calls: [{ id: "c1", function: { name: "preview_csv", arguments: JSON.stringify({ file: "data.csv", n: 4 }) } }] };
    if (phase === 2) {
      previewObs = last;
      return { text: "数据是 date,region,amount 结构。我写段代码按地区汇总。", tool_calls: [{ id: "c2", function: { name: "run_js", arguments: JSON.stringify({ code: ANALYSIS_CODE }) } }] };
    }
    if (phase === 3) {
      analysisObs = last;
      // 解析 run_js 输出中的汇总行（如 "华东: 4930 元 (51.7%)"）与 preview 中的记录数
      const rows = [...analysisObs.matchAll(/^(.+): (\d+) 元 \(([\d.]+)%\)$/gm)].map((m) => ({ region: m[1], amount: m[2], pct: m[3] }));
      const recordCount = Math.max(0, (Number(previewObs.match(/总行数: (\d+)/)?.[1] ?? 1) - 1));
      const bullets = rows.length
        ? rows.map((r) => `- ${r.region}：${r.amount} 元，占 ${r.pct}%`).join("\n")
        : "- 工具输出中没有可解析的汇总行，如实告知用户而非编造";
      const report = [
        "# 销售数据分析报告",
        "",
        "## 结论（每个数字都取自 run_js 的真实输出）",
        bullets,
        `- 数据共 ${recordCount} 条销售记录`,
        "",
        "## 方法",
        "agent 先 preview_csv 查看数据结构，再生成 JavaScript 汇总代码由 run_js 执行，最后把真实输出整理成本报告。",
      ].join("\n");
      return { text: "分析完成，把结论写成报告。", tool_calls: [{ id: "c3", function: { name: "write_file", arguments: JSON.stringify({ path: "report.md", content: report }) } }] };
    }
    const top = analysisObs.split("\n").find((l) => l.includes(" 元")) ?? "没有有效汇总行";
    return { text: `分析完成：${top}（排名第一）。报告已写入 workspace/report.md，数字均来自工具输出。`, tool_calls: [] };
  };
}

// ── 工具 ──
const TOOLS = [
  {
    name: "preview_csv",
    description: "预览 CSV 的前 n 行和总行数，用于了解数据结构。",
    parameters: { type: "object", properties: { file: { type: "string" }, n: { type: "number" } }, required: ["file"] },
    async run({ file, n = 5 }) {
      const abs = path.resolve(WORK_DIR, file);
      if (!abs.startsWith(WORK_DIR + path.sep)) return "error: 路径越界";
      try {
        const lines = (await import("node:fs")).readFileSync(abs, "utf8").trim().split("\n");
        return [`总行数: ${lines.length}`, ...lines.slice(0, n)].join("\n");
      } catch { return `error: ${file} 不存在`; }
    },
  },
  {
    name: "run_js",
    description: "在 workspace 目录执行一段 Node.js 分析代码（可用 require，读得到 data.csv），返回 console 输出。只做数据分析，禁止联网和删文件。",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    async run({ code }) {
      // ⭐ 「代码即工具」：执行的是模型生成的代码。
      // 教学版直接跑；生产做法是沙箱（对照 runtime/tools/sandbox.ts 的 bubblewrap 只读根 + 白名单 workingDir）
      return await new Promise((resolve) => {
        execFile("node", ["-e", code], { cwd: WORK_DIR, timeout: 10_000 }, (err, stdout, stderr) => {
          resolve([`exit_code: ${err ? err.code ?? 1 : 0}`, stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join("\n"));
        });
      });
    },
  },
  {
    name: "write_file",
    description: "把分析报告写入工作目录。",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async run({ path: p, content }) {
      const abs = path.resolve(WORK_DIR, p);
      if (!abs.startsWith(WORK_DIR + path.sep)) return "error: 路径越界";
      writeFileSync(abs, content, "utf8");
      return `wrote report to ${p}`;
    },
  },
];

// ── Agent Loop ──
async function runTurn(llm, userMessage) {
  const messages = [
    { role: "system", content: "你是数据分析 agent。流程：先预览数据结构 → 生成分析代码并用 run_js 执行 → 根据真实输出写结论。禁止编造数字，一切以代码输出为准。" },
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
      console.log(`  🔧 ${call.function.name}(${Object.keys(input).length ? "…" : "{}"})`);
      console.log(`     → ${observation.split("\n").slice(0, 3).join(" | ").slice(0, 100)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: observation });
    }
  }
  return "(stopped: reached maxTurns)";
}

// ── 演示数据：12 条模拟销售记录 ──
mkdirSync(WORK_DIR, { recursive: true });
if (!existsSync(path.join(WORK_DIR, "data.csv"))) {
  const rows = ["date,region,amount"];
  const data = [
    ["2026-01", "华东", 1200], ["2026-01", "华南", 900], ["2026-01", "华北", 400],
    ["2026-02", "华东", 1350], ["2026-02", "华南", 950], ["2026-02", "西南", 300],
    ["2026-03", "华东", 1100], ["2026-03", "华南", 800], ["2026-03", "华北", 450],
    ["2026-04", "华东", 1280], ["2026-04", "西南", 380], ["2026-04", "华北", 420],
  ];
  for (const [d, r, a] of data) rows.push(`${d},${r},${a}`);
  writeFileSync(path.join(WORK_DIR, "data.csv"), rows.join("\n"));
}

const llm = createLLM(createMockScript());
console.log(`模型: ${llm.name}\n任务: 分析 workspace/data.csv 的销售数据并生成报告\n`);
console.log(`最终答复: ${await runTurn(llm, "分析 data.csv，告诉我哪个地区卖得最好，并生成 report.md")}`);
console.log(`\n生成的报告:\n${(await import("node:fs")).readFileSync(path.join(WORK_DIR, "report.md"), "utf8")}`);

// 文件整理 Agent —— 知识点：Tool Calling + workingDir 安全边界
// 运行：node agent.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const WORK_DIR = path.join(ROOT, "messy-files"); // 所有操作锁在这个目录（对照 runtime/tools/fileOps.ts:8）

// ── LLM 封装：无 key 用按剧本演的 Mock，有 key 走 OpenAI 兼容 API ──
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

// ── 工具定义：move 把文件移入「分类文件夹」（文件夹由模型决定）──
const TOOLS = [
  {
    name: "list_files",
    description: "列出待整理目录下的所有文件名。",
    parameters: { type: "object", properties: {} },
    async run() { return readdirSync(WORK_DIR, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(空)"; },
  },
  {
    name: "peek_file",
    description: "看某个文件的前 200 字符，用于判断它属于什么类别。",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async run({ name }) {
      const abs = path.join(WORK_DIR, name);
      if (!abs.startsWith(WORK_DIR)) return "error: 非法路径";
      if (!existsSync(abs) || !abs.startsWith(WORK_DIR + path.sep)) return `error: ${name} 不存在`;
      return readFileSync(abs, "utf8").slice(0, 200);
    },
  },
  {
    name: "move_file",
    description: "把文件移入「类别/」子文件夹（类别由你决定，会自动创建）。目标已有同名文件时拒绝移动，不会覆盖。",
    parameters: { type: "object", properties: { name: { type: "string" }, folder: { type: "string" } }, required: ["name", "folder"] },
    async run({ name, folder }) {
      const src = path.join(WORK_DIR, name);
      if (!src.startsWith(WORK_DIR + path.sep) || !existsSync(src)) return `error: ${name} 不存在`;
      const dstDir = path.join(WORK_DIR, folder);
      if (!dstDir.startsWith(WORK_DIR + path.sep)) return "error: 非法类别目录";
      const dst = path.join(dstDir, name);
      if (existsSync(dst)) return `error: ${folder}/${name} 已存在同名文件，为避免覆盖数据已取消移动。请换一个分类或先重命名`;
      mkdirSync(dstDir, { recursive: true });
      renameSync(src, dst);
      return `moved ${name} → ${folder}/`;
    },
  },
];

// ── Mock 剧本：看目录 → 按「扩展名 + 内容」分类并批量移动 → 复查 → 汇报 ──
// 剧本是「有状态」的：每一轮只看最新一条观察结果来决定下一步（模拟真实模型的行为）。
function createMockScript() {
  let phase = 0;
  return function mockScript(messages) {
    const lastObservation = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
    phase++;
    if (phase === 1) return { text: "我先看看目录里有什么文件。", tool_calls: [{ id: "c1", function: { name: "list_files", arguments: "{}" } }] };

    if (phase === 2) {
      // 从目录观察结果里解析出待整理的顶层文件（带扩展名的行）
      const files = lastObservation.split("\n").filter((f) => f && !f.endsWith("/") && f.includes("."));
      const classify = (f) =>
        (/\.(docx?|pdf|md|txt)$/.test(f) && "文档") ||
        (/\.(jpe?g|png|gif)$/.test(f) && "图片") ||
        (/\.(xlsx?|csv)$/.test(f) && "表格数据") ||
        "其他";
      return {
        text: `发现 ${files.length} 个文件，按扩展名分类移动。`,
        tool_calls: files.map((f, i) => ({ id: `m${i}`, function: { name: "move_file", arguments: JSON.stringify({ name: f, folder: classify(f) }) } })),
      };
    }
    if (phase === 3) return { text: "再检查一遍整理结果。", tool_calls: [{ id: "v1", function: { name: "list_files", arguments: "{}" } }] };
    // 收尾如实汇报：有同名冲突被拒绝时，不宣称"全部归类完成"
    const conflicts = messages.filter((m) => m.role === "tool" && m.content.startsWith("error:")).length;
    const note = conflicts > 0
      ? `另有 ${conflicts} 个移动因同名冲突被工具拒绝，相关文件保留在原地（未覆盖任何内容）。`
      : "所有文件已按「文档 / 图片 / 表格数据 / 其他」归类。";
    return { text: `整理完成！当前目录结构：\n${lastObservation}\n${note}`, tool_calls: [] };
  };
}

// ── Agent Loop（对照 runtime/core/loop.ts:147 runTurn）──
async function runTurn(llm, userMessage) {
  const messages = [
    { role: "system", content: "你是文件整理助手。先查看目录，再分类移动文件，最后向用户汇报结构。文件名保持不变。" },
    { role: "user", content: userMessage },
  ];
  for (let turn = 1; turn <= 8; turn++) {
    const { text, tool_calls } = await llm.chat(messages, TOOLS);
    if (tool_calls.length === 0) return text;
    messages.push({ role: "assistant", content: text, tool_calls });
    for (const call of tool_calls) {
      let input = {};
      try { input = JSON.parse(call.function.arguments || "{}"); } catch { /* 保持空对象 */ }
      const tool = TOOLS.find((t) => t.name === call.function.name);
      const observation = tool ? await tool.run(input).catch((e) => `error: ${e.message}`) : `error: unknown tool ${call.function.name}`;
      console.log(`  🔧 ${call.function.name}(${JSON.stringify(input)}) → ${observation.split("\n")[0].slice(0, 60)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: observation });
    }
  }
  return "(stopped: reached maxTurns)";
}

// ── 演示数据（首次运行自动生成）──
const samples = {
  "论文初稿.docx": "基于大语言模型的智能体研究……（模拟 docx 文本内容）",
  "听课照片.jpg": "\uFFFD\uFFFD\uFFFD（模拟图片二进制）",
  "课程成绩.xlsx": "学号,课程,成绩\n2024001,Agent开发,95\n（模拟 xlsx 文本）",
  "买菜清单.txt": "西红柿、鸡蛋、面条",
  "实验数据.csv": "trial,score\n1,0.82\n2,0.87\n",
};
mkdirSync(WORK_DIR, { recursive: true });
// 先收集「任意层级已存在的文件名」：样例只在任何层级都不存在时才创建——
// 否则重跑时会在顶层重新生成一份，与分类目录里的旧副本成对冲突。
const existing = new Set();
for (const e of readdirSync(WORK_DIR, { withFileTypes: true })) {
  if (e.isFile()) existing.add(e.name);
  else if (e.isDirectory()) for (const f of readdirSync(path.join(WORK_DIR, e.name))) existing.add(f);
}
for (const [name, content] of Object.entries(samples)) {
  if (!existing.has(name)) writeFileSync(path.join(WORK_DIR, name), content);
}
// 演示前复位：把上一次分类进子目录的【演示样例】搬回顶层，保证可重复运行。
// 安全纪律——用「内容比对」区分我们的产物和用户的数据：
//   1) 顶层无同名 → 直接搬回；
//   2) 顶层同名且内容 === 样例模板 → 是我们自己上次留下的副本，删顶层副本后搬回（去重）；
//   3) 顶层同名但内容不同（用户的新文件）→ 保留用户文件；
//      若子目录副本仍是样例模板（已被用户文件取代），清掉我们的旧副本以免每次都冲突；
//      若子目录副本也被改过（内容 ≠ 模板），那是用户数据，绝不动，交给冲突提示。
const sampleNames = new Set(Object.keys(samples));
for (const d of readdirSync(WORK_DIR, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const f of readdirSync(path.join(WORK_DIR, d.name))) {
    if (!sampleNames.has(f)) continue; // 复位只认演示样例
    const src = path.join(WORK_DIR, d.name, f);
    const dst = path.join(WORK_DIR, f);
    if (!existsSync(dst)) { renameSync(src, dst); continue; } // ① 直接搬回
    const sameAsTemplate = (p) => { try { return readFileSync(p, "utf8") === samples[f]; } catch { return false; } };
    if (sameAsTemplate(dst)) { unlinkSync(dst); renameSync(src, dst); continue; } // ② 顶层是旧副本 → 去重搬回
    if (sameAsTemplate(src)) unlinkSync(src); // ③ 用户文件取代了我们的旧样例 → 清掉旧样例
    // ③' 子目录副本内容也和模板不同 → 用户数据，保持原样
  }
}

const llm = createLLM(createMockScript());
console.log(`模型: ${llm.name}\n任务: 整理 messy-files/ 目录\n`);
const answer = await runTurn(llm, "帮我把 messy-files 目录里的文件分类整理好");
console.log(`\n最终答复: ${answer}`);

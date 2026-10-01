// 07-skills —— 加入 Skill 机制：按需加载的「操作手册」。
// 问题：所有知识都塞 system prompt 会撑爆上下文。
// 解法：skill = 一个带 frontmatter 的 markdown 文件（name/description + 正文）。
//   第 1 级：system 只注入 skill 的「名字 + 一句话描述」（便宜）
//   第 2 级：模型需要时调 load_skill 工具，才把全文读进上下文（按需）
// 这就是 Claude Code 等 coding agent 的 skill 渐进式披露（progressive disclosure）模式。
//
// 运行：node agent.mjs demo

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const SKILLS_DIR = path.join(import.meta.dirname, "skills");

// ── Skill 发现：扫描目录，解析 frontmatter（对照 Claude Code 的 SKILL.md 结构）──
function discoverSkills() {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = readFileSync(path.join(SKILLS_DIR, f), "utf8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!m) return null;
      const meta = Object.fromEntries(m[1].split("\n").map((line) => line.split(/:\s*/)).map(([k, ...v]) => [k.trim(), v.join(":").trim()]));
      return { name: meta.name, description: meta.description, body: m[2].trim() };
    })
    .filter(Boolean);
}

// ── 工具 1：load_skill —— 把某个 skill 全文读进上下文 ──
const loadSkillTool = {
  name: "load_skill",
  description: "加载某个技能的完整操作手册。当任务匹配某个技能时先调用它。",
  parameters: { type: "object", properties: { name: { type: "string", description: "技能名" } }, required: ["name"] },
  async run({ name }) {
    const skill = discoverSkills().find((s) => s.name === name);
    if (!skill) return `error: 未找到技能 "${name}"。可用: ${discoverSkills().map((s) => s.name).join(", ")}`;
    return skill.body;
  },
};

function createLLM() {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      name: "mock",
      turn: 0,
      chosen: "",
      async chat(messages) {
        this.turn++;
        const last = messages[messages.length - 1].content;
        if (this.turn === 1) {
          // 按任务关键词选技能（真实模型靠语义匹配 description，mock 用关键词近似）
          const question = messages.at(-1).content;
          this.chosen = /考试|复习|备考|期末/.test(question) ? "exam-prep" : "git-help";
          return { text: `这个任务匹配 ${this.chosen} 技能，我先加载手册。`, tool_calls: [{ id: "c1", function: { name: "load_skill", arguments: JSON.stringify({ name: this.chosen }) } }] };
        }
        const points = last.split("\n").filter((l) => l.trim()).slice(0, 3).join("；");
        return { text: `(mock) 已按《${this.chosen}》手册回答。要点：${points}`, tool_calls: [] };
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
          tools: [{ type: "function", function: { name: loadSkillTool.name, description: loadSkillTool.description, parameters: loadSkillTool.parameters } }],
        }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
      const msg = (await res.json()).choices[0].message;
      return { text: msg.content ?? "", tool_calls: msg.tool_calls ?? [] };
    },
  };
}

async function runTurn(llm, userMessage) {
  // 第 1 级注入：只在 system 里放「目录」（名字 + 描述），不放全文
  const catalog = discoverSkills().map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const messages = [
    {
      role: "system",
      content: `你是助手。系统装有以下技能手册，任务匹配时先用 load_skill 加载再行动：\n${catalog || "(无技能)"}`,
    },
    { role: "user", content: userMessage },
  ];

  for (let turn = 1; turn <= 5; turn++) {
    const { text, tool_calls } = await llm.chat(messages);
    if (tool_calls.length === 0) return text;
    messages.push({ role: "assistant", content: text, tool_calls });
    for (const call of tool_calls) {
      const input = JSON.parse(call.function.arguments || "{}");
      const observation = call.function.name === "load_skill" ? await loadSkillTool.run(input) : `error: unknown tool`;
      console.log(`  [工具] load_skill("${input.name}") → 注入 ${observation.length} 字符手册`);
      messages.push({ role: "tool", tool_call_id: call.id, content: observation });
    }
  }
  return "(stopped: reached maxTurns)";
}

console.log("已发现的技能:");
for (const s of discoverSkills()) console.log(`  - ${s.name}（手册 ${s.body.length} 字符，但 system 里只放了一句话）`);
console.log("\n── 运行 ──");
const answer = await runTurn(createLLM(), process.argv.slice(2).join(" ") || "我想撤销最近一次 git commit");
console.log(`助手: ${answer}`);

// 对照/参考：
//   skill 文件结构        ↔ Claude Code 的 SKILL.md（frontmatter name+description + 正文）
//   第 1 级目录注入       ↔ 渐进式披露：description 常驻，正文按需
//   load_skill 工具       ↔ 模型主动触发的知识加载；原项目规划为 v0.2 方向，尚未实现

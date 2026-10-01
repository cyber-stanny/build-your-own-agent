// 简历分析 Agent —— 知识点：结构化输出（JSON）+ Schema 校验 + 校验失败自动重试
// 没有工具、没有 loop 的「单次调用」型 agent：重点全在「怎么让模型稳定输出机器可读的 JSON」。
// 运行：node agent.mjs    （读取 resume.txt，输出结构化分析）
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const RESUME = readFileSync(path.join(ROOT, "resume.txt"), "utf8");

// ── 期望的输出 Schema（校验器，纯手写 30 行，不引第三方库）──
const SCHEMA = {
  name: "string", grade: "string", skills: "string[]",
  experiences: "string[]", matchScore: "number(0-100)", suggestions: "string[]",
};

function validate(data) {
  const errors = [];
  if (typeof data?.name !== "string") errors.push("name 必须是字符串");
  if (typeof data?.grade !== "string") errors.push("grade 必须是字符串");
  // 三个数组字段都检查【元素类型】——只查 Array.isArray 会放过 [1, 2] 这类值
  if (!Array.isArray(data?.skills) || data.skills.some((s) => typeof s !== "string")) errors.push("skills 必须是字符串数组");
  if (!Array.isArray(data?.experiences) || data.experiences.some((s) => typeof s !== "string")) errors.push("experiences 必须是字符串数组");
  if (typeof data?.matchScore !== "number" || data.matchScore < 0 || data.matchScore > 100) errors.push("matchScore 必须是 0-100 的数字");
  if (!Array.isArray(data?.suggestions) || data.suggestions.some((s) => typeof s !== "string")) errors.push("suggestions 必须是字符串数组");
  return errors;
}

function createLLM(mockScript) {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return { name: "mock", async chat(messages) { return mockScript(messages); } };
  const baseUrl = process.env.MINI_AGENT_BASE_URL ?? "https://api.deepseek.com";
  const model = process.env.MINI_AGENT_MODEL ?? "deepseek-chat";
  return {
    name: model,
    async chat(messages) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, response_format: { type: "json_object" } }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
      return (await res.json()).choices[0].message.content ?? "";
    },
  };
}

// ── Mock 剧本：三次尝试分别演示三类真实故障，让校验-重试循环完整可见 ──
//   第 1 次：Markdown 围栏 + 尾逗号     → JSON.parse 失败
//   第 2 次：合法 JSON，但 experiences 混入数字 → Schema 校验失败（元素类型）
//   第 3 次：完全干净的结果             → 通过
function createMockScript() {
  let call = 0;
  return function () {
    call++;
    if (call === 1)
      return '```json\n{\n  "name": "王小明",\n  "grade": "大三",\n  "skills": ["JavaScript", "Python", "SQL"],\n  "experiences": ["校科技协会技术部干事", "某公司前端实习 3 个月"],\n  "matchScore": 72,\n  "suggestions": ["补充一个完整项目经历", "量化实习成果（如性能提升 X%）",],\n}\n```';
    if (call === 2)
      return JSON.stringify({
        name: "王小明", grade: "大三",
        skills: ["JavaScript", "Python", "SQL"],
        experiences: ["校科技协会技术部干事", 42],
        matchScore: 72,
        suggestions: ["补充一个完整项目经历", "量化实习成果（如性能提升 X%）"],
      });
    return JSON.stringify({
      name: "王小明", grade: "大三",
      skills: ["JavaScript", "Python", "SQL"],
      experiences: ["校科技协会技术部干事", "某公司前端实习 3 个月"],
      matchScore: 72,
      suggestions: ["补充一个完整项目经历", "量化实习成果（如性能提升 X%）"],
    });
  };
}

// ── 校验-重试循环：核心就这 15 行 ──
async function analyzeResume(llm, resume) {
  const baseMessages = [
    { role: "system", content: `你是简历分析引擎。只输出一个 JSON 对象，字段必须严格符合：${JSON.stringify(SCHEMA)}。不要输出任何其他文字或 Markdown 围栏。` },
    { role: "user", content: `分析这份简历：\n${resume}` },
  ];
  const messages = [...baseMessages];

  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await llm.chat(messages);
    console.log(`第 ${attempt} 次尝试：收到 ${raw.length} 字符`);
    try {
      // 常见病先温和处理：剥 Markdown 围栏
      const cleaned = raw.replace(/^```(?:json)?\n?|```$/g, "").trim();
      const data = JSON.parse(cleaned);
      const errors = validate(data);
      if (errors.length === 0) return { data, attempts: attempt };
      console.log(`  ⚠️ Schema 校验失败: ${errors.join("; ")}`);
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: `你的输出有这些问题: ${errors.join("; ")}。请重新输出完整 JSON，不要有其他文字。` });
    } catch {
      console.log("  ⚠️ 不是合法 JSON");
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: "你的输出不是合法 JSON（注意：不要 Markdown 围栏、不要尾逗号）。请重新输出完整 JSON。" });
    }
  }
  return { data: null, attempts: 3 };
}

const llm = createLLM(createMockScript());
console.log(`模型: ${llm.name}\n`);
const { data, attempts } = await analyzeResume(llm, RESUME);
if (data) {
  console.log(`\n✅ 第 ${attempts} 次尝试后拿到合法结构化结果:\n`);
  console.log(JSON.stringify(data, null, 2));
} else {
  console.log("\n❌ 3 次尝试均失败（真实系统会降级为人工处理）");
}

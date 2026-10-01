// Reflection Agent —— 知识点：反思循环（生成 → 自我批评 → 修订）
// 在普通生成之后加一道「模型评审自己的产出」：批评要结构化（分数 + 问题清单），
// 分数不达标就带着问题清单重写，最多 N 轮。这是提升单模型产出质量最便宜的架构。
// 运行：node agent.mjs "主题：我为什么想学 AI Agent 开发"
function createLLM() {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    let call = 0;
    return {
      name: "mock",
      async chat(messages) {
        call++;
        const isCritique = messages[0].content.includes("严格的编辑");
        if (!isCritique && call === 1) {
          // 第 1 版：平庸的初稿（没有细节、没有例子）
          return "我想学 AI Agent 开发，因为 AI 很火，我觉得这个方向很有前途，学了应该能找到好工作。";
        }
        if (isCritique) {
          const draft = messages.at(-1).content;
          if (draft.includes("有前途")) {
            return JSON.stringify({ score: 5, issues: ["全是空话，没有任何具体事实", "没有例子支撑动机", "结尾没有行动项"] });
          }
          return JSON.stringify({ score: 9, issues: [] });
        }
        // 修订版：有细节、有例子、有行动项
        return "我为什么想学 AI Agent 开发？大三上学期我用大模型 API 写过一个自动整理课程资料的脚本，那一刻我意识到：会调 API 只是起点，能「让它自己完成一串工作」才是质变。Agent 开发正是这个质变的方向。我的行动项：这学期读完 my-agent-runtime 的 loop 源码，并在课程项目里实现一个带工具调用的最小 agent。";
      },
    };
  }
  const BASE_URL = process.env.MINI_AGENT_BASE_URL ?? "https://api.deepseek.com";
  const MODEL = process.env.MINI_AGENT_MODEL ?? "deepseek-chat";
  return {
    name: MODEL,
    async chat(messages) {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: MODEL, messages }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
      return (await res.json()).choices[0].message.content ?? "";
    },
  };
}

const PASS_SCORE = 8;
const MAX_ITERATIONS = 3;

async function writeWithReflection(llm, topic) {
  // ① 初稿
  let draft = await llm.chat([
    { role: "system", content: "你是学生，写一段 150 字以内的短文，真诚具体，不要空话。" },
    { role: "user", content: `主题：${topic}` },
  ]);
  console.log(`—— 初稿（未经反思）——\n${draft}\n`);

  // ② 反思循环：批评是结构化的（score + issues），不达标就带着问题重写
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const critiqueRaw = await llm.chat([
      { role: "system", content: "你是严格的编辑。评审给定的短文，只输出 JSON：{\"score\":1-10, \"issues\":[\"问题1\", ...]}。score<8 必须给出具体可改进的问题。" },
      { role: "user", content: draft },
    ]);
    const critique = JSON.parse(critiqueRaw.replace(/^```(?:json)?\n?|```$/g, "").trim());
    console.log(`—— 第 ${i} 轮评审：${critique.score} 分 ——`);
    for (const issue of critique.issues) console.log(`   · ${issue}`);

    if (critique.score >= PASS_SCORE) {
      console.log(`   ✅ 达到 ${PASS_SCORE} 分及格线，结束`);
      return draft;
    }

    draft = await llm.chat([
      { role: "system", content: "根据编辑指出的问题重写短文，150 字以内。保留原有正确的部分，只修复指出的问题。" },
      { role: "user", content: `原文：\n${draft}\n\n编辑的问题：\n${critique.issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}` },
    ]);
    console.log(`—— 重写完成 ——\n${draft.slice(0, 80)}…\n`);
  }
  return draft;
}

const topic = (process.argv.slice(2).join(" ") || "主题：我为什么想学 AI Agent 开发").replace(/^主题：/, "");
const llm = createLLM();
console.log(`模型: ${llm.name}\n主题: ${topic}\n`);
const final = await writeWithReflection(llm, topic);
console.log(`\n═══ 最终定稿 ═══\n${final}`);

// 对照：
//   批评结构化（JSON score+issues）  ↔ patterns/resume-agent 的 Schema 校验思想
//   问题清单喂回重写                 ↔ core/loop.ts 的「错误当观察结果」——反思循环就是一层「自我 loop」
//   及格线 + 最大轮数               ↔ followups/service.ts 的修复轮数上限思想（有界重试）

// 内容创作 Agent —— 知识点：Prompt Chaining（提示词流水线）
// 对比 Agent Loop：流水线是「人把流程写死，每步调一次模型」；loop 是「模型自己决定下一步」。
// 什么时候用哪种：步骤固定 → 流水线（便宜可控）；步骤不确定 → loop（灵活但贵）。
// 运行：node agent.mjs "主题：大学生第一门编程语言怎么选" [audience: 大一新生]
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
        body: JSON.stringify({ model, messages }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
      return (await res.json()).choices[0].message.content ?? "";
    },
  };
}

// ── Mock：三个阶段各回一段，内容相互衔接（outline → draft → polish）──
function createMockScript() {
  let call = 0;
  return function (messages) {
    call++;
    if (call === 1) return "1. 为什么「选语言」是个伪问题\n2. 三个候选：Python / JavaScript / C\n3. 判断标准：目标方向 > 生态 > 上手难度\n4. 我的建议与学习路径";
    if (call === 2)
      return [
        "# 大学生第一门编程语言怎么选",
        "## 1. 为什么「选语言」是个伪问题",
        "编程思维是通用的，语言只是载体。但第一门语言影响你能否坚持下去。",
        "## 2. 三个候选",
        "Python 语法最接近自然语言；JavaScript 写网页立刻有可视化反馈；C 让你直面内存与指针。",
        "## 3. 判断标准",
        "目标方向 > 生态 > 上手难度：想做数据/AI 选 Python，想做网页选 JavaScript，想打底子选 C。",
        "## 4. 我的建议与学习路径",
        "先 Python 入门建立信心，再用 JavaScript 做个项目，C 留给数据结构课。",
      ].join("\n");
    return [
      "# 大学生第一门编程语言怎么选",
      "别纠结太久：编程思维是通用的，但第一门语言决定了你能不能坚持下去。",
      "**想搞数据和 AI，选 Python**：语法最接近自然语言，装好就能写爬虫、画图表。",
      "**想做网页，选 JavaScript**：浏览器就是现成的运行环境，代码保存即见效果。",
      "C 语言值得学，但建议放在数据结构课里，配合指针和内存一起理解。",
      "路径建议：Python 建立信心 → JavaScript 做出第一个作品 → C 补底层。",
    ].join("\n");
  };
}

// ── Prompt Chaining：三步流水线，每步一个专职 prompt，前一步输出是下一步输入 ──
async function pipeline(llm, topic, audience) {
  // 第 1 步：大纲师
  const outline = await llm.chat([
    { role: "system", content: "你是内容大纲师。为指定主题和受众输出 4 条以内的要点大纲，每条一行，不要展开。" },
    { role: "user", content: `主题：${topic}\n受众：${audience}` },
  ]);
  console.log("── 第 1 步：大纲 ──\n" + outline + "\n");

  // 第 2 步：写手（拿到大纲）
  const draft = await llm.chat([
    { role: "system", content: "你是写手。根据给定的要点大纲写一篇 300 字以内的初稿，Markdown 格式。" },
    { role: "user", content: `大纲：\n${outline}\n受众：${audience}` },
  ]);
  console.log("── 第 2 步：初稿 ──\n" + draft.slice(0, 200) + "…\n");

  // 第 3 步：编辑（拿到初稿，只做打磨）
  const polished = await llm.chat([
    { role: "system", content: "你是编辑。在不改变事实和结构的前提下把初稿改得更口语、更有冲击力，开头一句话必须能让人想读完。" },
    { role: "user", content: draft },
  ]);
  return polished;
}

const args = process.argv.slice(2);
const topic = (args[0] ?? "").replace(/^主题：/, "") || "大学生第一门编程语言怎么选";
const audience = (args[1] ?? "").replace(/^audience:/, "") || "大一新生";
const llm = createLLM(createMockScript());
console.log(`模型: ${llm.name}\n主题: ${topic} · 受众: ${audience}\n`);
console.log("── 第 3 步：终稿 ──\n");
console.log(await pipeline(llm, topic, audience));

// 对照：流水线（本 Demo）vs Agent Loop（patterns/coding-agent）
//   流水线：步骤写死在代码里，模型只负责每步的内容
//   Loop：runtime 只提供「调工具」的能力，步骤顺序由模型现场决定
//   原项目里的流水线例子：commands/compact.ts 的 summarize（一次专门调用，不进主 loop）

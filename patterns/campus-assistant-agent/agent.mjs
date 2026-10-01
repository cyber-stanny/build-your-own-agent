// 校园助手 Agent —— 知识点：工具选择（意图路由）+ 工具 description 的引导作用
// 一个工具 = 一项校园服务；模型根据用户问题「选对工具」。观察 mock 如何靠关键词路由（真实模型靠语义）。
// 运行：
//   node agent.mjs "明天有什么课？"
//   node agent.mjs "今天食堂吃什么？"
//   node agent.mjs "图书馆几点开门？"
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

// ── 校园数据（真实项目里这些是查询教务/后勤系统）──
const SCHEDULE = {
  周一: "1-2节 高数(教三201)  3-4节 大学英语(文B302)",
  周二: "1-2节 数据结构(计301)  6-7节 体育(田径场)",
  周三: "3-4节 线性代数(教三105)  6-7节 智能体导论(计501)",
  周四: "1-2节 数据结构(计301)",
  周五: "3-4节 概率论(文B202)",
  周六: "无课", 周日: "无课",
};
const MENU = { 一食堂: "红烧肉套餐 / 麻辣香锅 / 兰州拉面", 二食堂: "黄焖鸡 / 石锅拌饭 / 螺蛳粉" };
const LIBRARY = "开放时间 07:30-22:30（周五 07:30-18:00）；四楼自习室需预约";

// ── 工具：description 写得越清楚，模型路由越准 ──
const TOOLS = [
  {
    name: "query_schedule",
    description: "查询某天的课程表。用户问「课」「上课」「schedule」时用。",
    parameters: { type: "object", properties: { day: { type: "string", description: "星期几，如 周一" } }, required: ["day"] },
    async run({ day }) { return SCHEDULE[day] ?? `没有「${day}」的课表数据`; },
  },
  {
    name: "canteen_menu",
    description: "查询今天各食堂的菜单。用户问「吃」「食堂」「菜单」时用。",
    parameters: { type: "object", properties: { canteen: { type: "string", description: "食堂名，不填返回全部" } }, required: [] },
    async run({ canteen }) {
      if (!canteen) return Object.entries(MENU).map(([k, v]) => `${k}: ${v}`).join("\n");
      return MENU[canteen] ?? `没有「${canteen}」的数据`;
    },
  },
  {
    name: "library_hours",
    description: "查询图书馆开放时间与自习室预约规则。",
    parameters: { type: "object", properties: {} },
    async run() { return LIBRARY; },
  },
];

// ── Mock「路由」：关键词匹配（真实模型做的是同样的事，只是用语义而不是字符串）──
function createMockScript() {
  let phase = 0;
  let question = "";
  return function (messages) {
    const last = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
    phase++;
    if (phase === 1) {
      question = messages.at(-1).content;
      const call = (name, args) => ({ id: "c1", function: { name, arguments: JSON.stringify(args) } });
      if (/课|上课|schedule/.test(question)) return { text: "查一下课表。", tool_calls: [call("query_schedule", { day: pickDay(question) })] };
      if (/吃|食堂|菜单/.test(question)) return { text: "看看今天吃什么。", tool_calls: [call("canteen_menu", {})] };
      if (/图书馆|自习/.test(question)) return { text: "查图书馆开放时间。", tool_calls: [call("library_hours", {})] };
      return { text: "我可以帮你查课程表、食堂菜单、图书馆开放时间。试试问「明天有什么课？」", tool_calls: [] };
    }
    return { text: `根据查询结果回答：${last}`, tool_calls: [] };
  };
}
function pickDay(q) {
  const days = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  if (/明天/.test(q)) return "周三"; // 演示固定为周三（真实实现应取当前日期推算）
  return days.find((d) => q.includes(d)) ?? "周一";
}

// ── Agent Loop ──
async function runTurn(llm, userMessage) {
  const messages = [
    { role: "system", content: "你是校园助手小智，亲切简洁。只回答校园相关问题；需要事实信息时调用工具查询，不要凭记忆编造课表或菜单。" },
    { role: "user", content: userMessage },
  ];
  for (let turn = 1; turn <= 5; turn++) {
    const { text, tool_calls } = await llm.chat(messages, TOOLS);
    if (tool_calls.length === 0) return text;
    messages.push({ role: "assistant", content: text, tool_calls });
    for (const call of tool_calls) {
      let input = {};
      try { input = JSON.parse(call.function.arguments || "{}"); } catch { /* ignore */ }
      const tool = TOOLS.find((t) => t.name === call.function.name);
      const observation = tool ? await tool.run(input).catch((e) => `error: ${e.message}`) : `error: unknown tool`;
      console.log(`  🔧 ${call.function.name}(${JSON.stringify(input)})`);
      messages.push({ role: "tool", tool_call_id: call.id, content: observation });
    }
  }
  return "(stopped: reached maxTurns)";
}

const question = process.argv.slice(2).join(" ") || "明天有什么课？";
const llm = createLLM(createMockScript());
console.log(`模型: ${llm.name}\n学生: ${question}\n`);
console.log(`小智: ${await runTurn(llm, question)}`);

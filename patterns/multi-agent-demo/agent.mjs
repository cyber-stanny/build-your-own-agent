// 多 Agent 协作 Demo —— 知识点：协调者模式（Orchestrator-Workers）+ 角色化 worker + 消息传递
// 架构：协调者（有派活工具）→ 两个专职 worker（调研员 / 写手，各自独立调用）→ 汇总产出。
// 每个角色 = 一套独立 system prompt；worker 之间不直接对话，一切经过协调者。
// 运行：node agent.mjs "主题：AI 会不会取代程序员"
const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
const BASE_URL = process.env.MINI_AGENT_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.MINI_AGENT_MODEL ?? "deepseek-chat";

// ── 真实 API 调用（协调者带工具，worker 不带）──
async function realChat(messages, tools) {
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
}

// ── 两个专职 worker：角色 = system prompt，仅此而已 ──
const ROLES = {
  researcher: {
    label: "调研员",
    system: "你是调研员。针对给定议题列出 3 个支持观点和 3 个反对观点，每条一句话，客观中立，不要结论。",
    mock: "支持方：1) AI 提效让程序员做更多事；2) 新岗位（提示工程/Agent 开发）在增加；3) 软件需求总量在膨胀。\n反对方：1) 初级重复性编码岗位在缩减；2) AI 已能独立完成小型需求；3) 企业倾向用更少的人做同样的事。",
  },
  writer: {
    label: "写手",
    system: "你是专栏写手。基于给定的调研要点写一段 150 字以内的评论文章，观点鲜明，口语化，直接输出正文。",
    mock: "AI 不会简单地取代程序员，但会重新定义这份工作：重复编码被自动化，需求定义、架构判断和责任承担依然属于人。会用 AI 的程序员将获得杠杆，拒绝使用的人才会被淘汰。",
  },
};

async function runWorker(role, task) {
  console.log(`  🤖 [${role.label}] 收到任务: ${String(task).slice(0, 40)}…`);
  let text;
  if (!apiKey) {
    text = role.mock; // mock：按角色返回确定的产出
  } else {
    text = (await realChat([{ role: "system", content: role.system }, { role: "user", content: task }])).text;
  }
  console.log(`  🤖 [${role.label}] 完成（${text.length} 字符）`);
  return text;
}

// ── 协调者：唯一有工具的 agent，工具就是「派活」 ──
const TOOLS = [
  {
    name: "dispatch_researcher",
    description: "派调研员针对一个议题收集正反两方观点。",
    parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    async run({ topic }) { return runWorker(ROLES.researcher, `议题：${topic}`); },
  },
  {
    name: "dispatch_writer",
    description: "派写手基于调研要点写一篇短评。",
    parameters: { type: "object", properties: { brief: { type: "string", description: "调研要点全文" } }, required: ["brief"] },
    async run({ brief }) { return runWorker(ROLES.writer, brief); },
  },
];

// ── 协调者 Loop ──
async function runCoordinator(userMessage) {
  const messages = [
    { role: "system", content: "你是内容团队的协调者。你的工作不是自己写，而是拆解任务、派给合适的成员、审核汇总产出。流程：先调研后成文。" },
    { role: "user", content: userMessage },
  ];
  for (let turn = 1; turn <= 6; turn++) {
    const { text, tool_calls } = apiKey
      ? await realChat(messages, TOOLS)
      : coordinatorMock(messages);
    if (tool_calls.length === 0) return text;
    messages.push({ role: "assistant", content: text, tool_calls });
    for (const call of tool_calls) {
      let input = {};
      try { input = JSON.parse(call.function.arguments || "{}"); } catch { /* ignore */ }
      const tool = TOOLS.find((t) => t.name === call.function.name);
      const observation = tool ? await tool.run(input).catch((e) => `error: ${e.message}`) : `error: unknown tool`;
      messages.push({ role: "tool", tool_call_id: call.id, content: observation });
    }
  }
  return "(stopped: reached maxTurns)";
}

// ── Mock 协调者剧本：先派调研 → 把调研结果交给写手 → 汇总 ──
// 议题从用户消息中提取，会真实传入派活参数（worker 产出在 mock 下仍是固定剧本）。
function coordinatorMock(messages) {
  const last = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
  if (!last) {
    const topic = (messages.at(-1).content.match(/「(.+?)」/) ?? [])[1] ?? "AI 会不会取代程序员";
    return { text: `这个议题有争议，先派调研员收集正反观点。`, tool_calls: [{ id: "c1", function: { name: "dispatch_researcher", arguments: JSON.stringify({ topic }) } }] };
  }
  if (!last.includes("不会简单")) return { text: "调研完成，交给写手成文。", tool_calls: [{ id: "c2", function: { name: "dispatch_writer", arguments: JSON.stringify({ brief: last.slice(0, 120) }) } }] };
  return { text: `${last}\n\n（以上由协调者调度：调研员收集观点 → 写手成文 → 协调者审核发布）`, tool_calls: [] };
}

const topic = (process.argv.slice(2).join(" ") || "主题：AI 会不会取代程序员").replace(/^主题：/, "");
console.log(`模型: ${apiKey ? MODEL : "mock"}\n议题: ${topic}\n`);
console.log("── 协调者开始调度 ──");
console.log("\n最终产出:\n" + (await runCoordinator(`请产出关于「${topic}」的短评`)));

// 对照源码：这个「协调者→worker」模式与 runtime/followups 的关系：
//   worker = 独立 system prompt 的一次独立调用          ↔ followups/agent.ts:26（新 session + 专用守则跑完整 loop）
//   派活工具的观察结果 = worker 的最终产出              ↔ parseAgentFollowupOutcome（只回传结构化结果）
//   worker 无工具、协调者有工具                          ↔ getFollowupAllowedTools 的权限按角色分配

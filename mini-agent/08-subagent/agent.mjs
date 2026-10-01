// 08-subagent —— 加入简单 Sub-agent：让一个 agent 派活给另一个 agent。
// 父 agent：拿到任务 → 决定拆给谁 → 汇总子 agent 的结论回答用户。
// 子 agent：独立 loop + 独立 system prompt + 受限工具集，跑完只把「最终答案」交回父上下文。
// 关键认知：子 agent 的全部中间过程（几十条消息）都被压缩成一条「观察结果」，
//   这本身就是一种上下文压缩——父 agent 不需要看子 agent 的草稿。
//
// 运行：node agent.mjs "调研：Node.js 和 Python 哪个更适合大一学生入门？"

function createLLM() {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  const baseUrl = process.env.MINI_AGENT_BASE_URL ?? "https://api.deepseek.com";
  const model = process.env.MINI_AGENT_MODEL ?? "deepseek-chat";
  if (!apiKey) {
    return {
      name: "mock",
      role: "parent",
      // Mock 剧本：父 agent 第 1 轮派活给 worker；worker 只跑 1 轮就给结论
      async chat(messages) {
        const isWorker = messages[0].content.includes("调研员");
        if (!isWorker && messages.length === 2) {
          return {
            text: "这个问题需要先做调研，我派一个调研员子 agent。",
            tool_calls: [{ id: "c1", function: { name: "spawn_subagent", arguments: JSON.stringify({ task: "列出 Node.js 和 Python 各 3 个优缺点（面向大一新生视角）" }) } }],
          };
        }
        if (isWorker) {
          return { text: "调研结论：Node.js 上手快（就学 JavaScript 一门语言、npm 生态活跃）；Python 语法最接近伪代码、数据科学资源多。建议：想做网页先 Node.js，想做数据处理选 Python。" , tool_calls: [] };
        }
        const subResult = messages.filter((m) => m.role === "tool").at(-1)?.content ?? "";
        return { text: `根据子 agent 的调研：${subResult.slice(0, 120)}……综合建议：先想清楚你想做什么方向。`, tool_calls: [] };
      },
    };
  }
  return {
    name: model,
    async chat(messages, tools) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          ...(tools?.length ? { tools: tools.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } })) } : {}),
        }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
      const msg = (await res.json()).choices[0].message;
      return { text: msg.content ?? "", tool_calls: msg.tool_calls ?? [] };
    },
  };
}

// ── 子 agent：独立 loop、独立身份、受限工具（这里为了聚焦，worker 没有任何工具）──
async function runSubagent(task) {
  console.log(`    [子agent 启动] 任务: ${task}`);
  const llm = createLLM();
  const messages = [
    { role: "system", content: "你是一名调研员。只做研究和归纳，不需要调用任何工具，直接给出结论。" },
    { role: "user", content: task },
  ];
  for (let turn = 1; turn <= 4; turn++) {
    const { text, tool_calls } = await llm.chat(messages);
    if (tool_calls.length === 0) {
      console.log(`    [子agent 完成] 返回 ${text.length} 字符结论（中间过程不带回父上下文）`);
      return text;
    }
    // 教学版 worker 没有工具：模型硬要调就当作错误观察结果让它自行纠正
    messages.push({ role: "assistant", content: text, tool_calls });
    for (const call of tool_calls) {
      messages.push({ role: "tool", tool_call_id: call.id, content: "error: 调研员没有工具，请直接给出你的结论。" });
    }
  }
  return "(子agent 达到轮数上限)";
}

// ── 父 agent 工具：spawn_subagent ──
const spawnSubagentTool = {
  name: "spawn_subagent",
  description: "派一个独立的调研子 agent 去完成子任务，只返回它的最终结论。适合信息收集、独立小任务。",
  parameters: { type: "object", properties: { task: { type: "string", description: "交给子 agent 的完整任务描述" } }, required: ["task"] },
  async run({ task }) {
    return runSubagent(task);
  },
};

async function runParent(llm, userMessage) {
  const messages = [
    { role: "system", content: "你是负责人。复杂任务可以先派子 agent 做调研，再基于结论回答用户。" },
    { role: "user", content: userMessage },
  ];
  for (let turn = 1; turn <= 5; turn++) {
    const { text, tool_calls } = await llm.chat(messages, [spawnSubagentTool]);
    if (tool_calls.length === 0) return text;
    messages.push({ role: "assistant", content: text, tool_calls });
    for (const call of tool_calls) {
      const input = JSON.parse(call.function.arguments || "{}");
      const observation = call.function.name === "spawn_subagent" ? await spawnSubagentTool.run(input) : "error: unknown tool";
      messages.push({ role: "tool", tool_call_id: call.id, content: observation });
    }
  }
  return "(stopped: reached maxTurns)";
}

const question = process.argv.slice(2).join(" ") || "调研：Node.js 和 Python 哪个更适合大一学生入门？";
const answer = await runParent(createLLM(), question);
console.log(`\n最终答复: ${answer}`);

// 对照源码（原项目没有 run 中途派生的 sub-agent，但有同构的「后台 agent」）：
//   子 agent 独立 loop     ↔ followups/agent.ts:26 createExistingAgentFollowup（复用同一个 runTurn）
//   受限工具集             ↔ followups/agent.ts:90 getFollowupAllowedTools（原版禁掉 deploy 等）
//   只回传最终结论         ↔ followups/agent.ts:143 parseAgentFollowupOutcome（只解析一行 JSON 结果）
//   教学版最小 sub-agent   ↔ mini-agent/08-subagent（父派活→子跑 loop→观察结果回填）

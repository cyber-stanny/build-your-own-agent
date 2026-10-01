// 02-agent-loop —— 加入 Agent Loop 的骨架。
// Loop = while 循环：反复问模型「完成任务了吗」，模型用它自己的输出决定继续还是结束。
// 这个阶段还没有工具：模型通过输出特殊标记 <DONE> 表示「我做完了」。
//
// 运行：node agent.mjs "从 3 倒数数到 1，每数一个数停一下"

function createLLM() {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      name: "mock",
      // Mock 剧本：第 1、2 轮输出中间步骤，第 3 轮输出 <DONE>
      turns: [
        "正在处理第 1 步：3",
        "正在处理第 2 步：2",
        "最后一步：1，任务完成 <DONE>",
      ],
      i: 0,
      async chat(messages) {
        return this.turns[this.i++] ?? "任务完成 <DONE>";
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
        body: JSON.stringify({ model, messages }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
      return (await res.json()).choices[0].message.content;
    },
  };
}

// ── Agent Loop：本阶段的核心（对比原项目 core/loop.ts:147 的 runTurn）──
const MAX_TURNS = 5; // 防死循环安全阀（原项目默认 32：runtime/config.defaults.ts:14）

async function runLoop(llm, userMessage) {
  const messages = [
    {
      role: "system",
      content: "你是任务执行器。每轮推进一小步并简述进度。全部完成时，在回复末尾输出 <DONE>。",
    },
    { role: "user", content: userMessage },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    console.log(`── 第 ${turn} 轮（携带 ${messages.length} 条历史）──`);
    const text = await llm.chat(messages);
    console.log(`模型: ${text}`);

    // 停止条件 1：模型宣布完成（原项目里这个信号是「不再要求调工具」，见 core/loop.ts:234）
    if (text.includes("<DONE>")) return text.replace("<DONE>", "").trim();

    // 关键动作：模型每轮的发言要追加进 messages，
    // 否则下一轮它看不到自己说过什么，会原地打转（初学者最常犯的 bug）
    messages.push({ role: "assistant", content: text });

    // 原项目在这里还有停止条件 2：有 toolCalls 就执行工具、把结果 push 回去（第 03 阶段实现）
    messages.push({ role: "user", content: "继续。" });
  }

  // 停止条件 3：打满轮数（原项目 core/loop.ts:303 的 "(stopped: reached maxTurns)"）
  return "(stopped: reached maxTurns)";
}

const final = await runLoop(createLLM(), process.argv.slice(2).join(" ") || "从 3 倒数数到 1，每数一个数停一下");
console.log(`\n最终结果: ${final}`);

// 对照源码：runLoop 的三个停止条件 ↔ runtime/core/loop.ts:234（完成）/ :283（拒绝）/ :303（maxTurns）
// messages.push 的位置 ↔ core/loop.ts:163(user) / :224(assistant) / :281(tool)

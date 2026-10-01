// 05-session —— 加入 Session：多轮对话 + 持久化 + 恢复。
// Session = { id, messages }。历史跨 run 累积；每次变化落盘 JSON；重启后可接着聊。
// 对照原项目 sessions/session.ts（内存对象）+ sessions/store.ts（SQLite 持久化）。
//
// 运行：
//   node agent.mjs chat            # 交互多轮（exit 退出）
//   node agent.mjs demo            # 非交互演示：跑两轮 → 保存 → "重启" → 恢复验证
import { createInterface } from "node:readline/promises";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const SESSION_DIR = path.join(import.meta.dirname, "sessions");

function createLLM() {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      name: "mock",
      async chat(messages) {
        const userTurns = messages.filter((m) => m.role === "user");
        return `(mock) 这是本次对话的第 ${userTurns.length} 条用户消息，我记住了之前的全部 ${messages.length} 条历史。`;
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

// ── Session 管理（对照 sessions/session.ts:16 + sessions/store.ts:175）──
function createSession(id, systemPrompt) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt }); // system 只在建会话时放一次
  return { id, messages };
}

function saveSession(session) {
  mkdirSync(SESSION_DIR, { recursive: true });
  // 原项目这里每次 transcript 变化都 checkpoint 到 SQLite（loop 的 deps.checkpoint 回调）
  writeFileSync(path.join(SESSION_DIR, `${session.id}.json`), JSON.stringify(session, null, 2));
}

function loadSession(id) {
  const file = path.join(SESSION_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

function listSessions() {
  if (!existsSync(SESSION_DIR)) return [];
  return readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
}

// ── 一个 run：把用户输入追加进 session，然后调模型 ──
async function runTurn(session, userInput, llm) {
  session.messages.push({ role: "user", content: userInput });
  saveSession(session); // 先落盘：崩溃也不丢用户输入
  const answer = await llm.chat(session.messages);
  session.messages.push({ role: "assistant", content: answer });
  saveSession(session); // 回答也落盘
  return answer;
}

// ── 交互模式 ──
async function chat() {
  const llm = createLLM();
  const sessionId = `sess_${Date.now()}`;
  const session = createSession(sessionId, "你是记忆良好的助手，用中文简洁回答。");
  console.log(`新会话 ${sessionId}（输入 exit 退出；sessions/ 下可看到落盘文件）\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // for-await 遍历 readline：stdin EOF 时循环自然结束，不会挂起
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line === "exit") break;
    console.log(`${await runTurn(session, line, llm)}\n`);
  }
  rl.close();
  console.log(`会话已保存：sessions/${sessionId}.json（${session.messages.length} 条消息）`);
  console.log(`下次可恢复：node agent.mjs resume ${sessionId}`);
}

// ── 演示模式：跑两轮 → 保存 → 重新加载 → 证明记忆还在 ──
async function demo() {
  const llm = createLLM();
  const sessionId = `sess_${Date.now()}`;
  console.log(`── 第一次运行（会话 ${sessionId}）──`);
  const session = createSession(sessionId, "你是记忆良好的助手。");
  console.log(`用户: 我叫小王，最喜欢蓝色`);
  console.log(`助手: ${await runTurn(session, "我叫小王，最喜欢蓝色", llm)}`);
  console.log(`用户: 我喜欢什么颜色？`);
  console.log(`助手: ${await runTurn(session, "我喜欢什么颜色？", llm)}`);

  console.log(`\n── 模拟进程重启：内存清空，从磁盘恢复 ──`);
  const restored = loadSession(sessionId);
  console.log(`从 sessions/${sessionId}.json 恢复 ${restored.messages.length} 条消息`);
  console.log(`用户: （新进程）我叫什么名字？`);
  console.log(`助手: ${await runTurn(restored, "我叫什么名字？", llm)}`);

  console.log(`\n已保存的会话: ${listSessions().join(", ")}`);
}

// ── 恢复模式 ──
async function resume(id) {
  const session = loadSession(id);
  if (!session) {
    console.log(`找不到会话 ${id}。已有: ${listSessions().join(", ") || "(无)"}`);
    return;
  }
  const llm = createLLM();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`恢复会话 ${id}（历史 ${session.messages.length} 条），继续聊（exit 退出）：`);
  // for-await 遍历 readline：stdin EOF 时循环自然结束，不会挂起（与 chat() 相同的修法）
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line === "exit") break;
    console.log(`${await runTurn(session, line, llm)}\n`);
  }
  rl.close();
}

const [mode, arg] = process.argv.slice(2);
if (mode === "chat" || !mode) await chat();
else if (mode === "demo") await demo();
else if (mode === "resume") await resume(arg);
else console.log("用法: node agent.mjs [chat | demo | resume <sessionId>]");

// 对照源码：
//   createSession     ↔ runtime/sessions/session.ts:16（system 只放一次）
//   saveSession       ↔ runtime/sessions/store.ts:175 saveMessages（原项目用 SQLite）
//   runTurn 追加历史  ↔ runtime/core/loop.ts:163-166（跨 run 累积 = 多轮的本质）
//   resume            ↔ sessions/runtime-store.ts:285 getOrLoad（内存是缓存，磁盘是真相）

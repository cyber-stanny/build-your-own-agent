// 10-complete-agent —— 组合成完整 Mini Agent。
// 汇总前 9 个阶段：Loop + Tools + Context(截断+裁剪) + Session(落盘+恢复) + Memory + Skills + Sub-agent + Compaction。
// 保留极简风格：一个文件 ~350 行，每个子系统 20~40 行。
//
// 运行：
//   node agent.mjs                                   # REPL（新会话）
//   node agent.mjs "在 workspace 里建 notes.md 写一句话"  # 单任务模式
//   node agent.mjs resume sess_<id>                  # 恢复历史会话继续聊
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const WORK_DIR = path.join(ROOT, "workspace"); // 所有文件工具锁在这里（对照 tools/fileOps.ts:8 的 resolveInside）
const MEMORY_FILE = path.join(ROOT, "memory.json");
const SESSION_DIR = path.join(ROOT, "sessions");
const SKILLS_DIR = path.join(ROOT, "skills");

// ═══ 1. LLM（01 阶段）═══
// 统一契约：chat() 恒返回 { text, tool_calls }——compact 等不带工具的调用也走同一形状。
function createLLM() {
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
  const baseUrl = process.env.MINI_AGENT_BASE_URL ?? "https://api.deepseek.com";
  const model = process.env.MINI_AGENT_MODEL ?? "deepseek-chat";
  if (!apiKey) {
    // mock 规则摘要（对照 commands/compact.ts:119 fallbackSummary）：
    // 目标取最后一条 user 输入，进度数 assistant 条数——不夸称"保留了全部历史"。
    const ruleSummary = (transcript) => {
      const turns = transcript.split("\n\n");
      const users = turns.filter((t) => t.startsWith("user:")).map((t) => t.slice(5).trim());
      const assistants = turns.filter((t) => t.startsWith("assistant:")).length;
      return [
        "## 目标",
        users.at(-1) ?? "不确定",
        "## 当前进度",
        `旧历史中共 ${assistants} 条 assistant 记录（mock 规则摘要，只提炼最后一条用户目标）`,
        "## 未完成事项",
        "继续根据保留的最近原文推进",
      ].join("\n");
    };
    return {
      name: "mock",
      async chat(messages, tools) {
        const sys = messages[0]?.content ?? "";
        if (sys.startsWith("把对话历史压缩")) {
          return { text: ruleSummary(messages.at(-1).content), tool_calls: [] };
        }
        if (sys.includes("调研员")) {
          return { text: "调研结论：任务可行。建议拆成三步：准备数据 → 实现核心逻辑 → 写验证。", tool_calls: [] };
        }
        // 「最新一条消息是 user」= 这是一次新 run 的第一轮——以此判定剧本阶段，
        // 不用跨 run 的计数器：同一 REPL 里连续做多个任务，每个任务都会走完整剧本。
        if (messages.at(-1)?.role === "user") {
          const task = messages.at(-1).content;
          if (/调研|研究/.test(task)) {
            return {
              text: "这个任务我先派一个子 agent 做调研。",
              tool_calls: [{ id: `c_${Date.now() % 100000}`, function: { name: "spawn_subagent", arguments: JSON.stringify({ task: `调研：${task}` }) } }],
            };
          }
          return {
            text: "我先建一个文件记录任务。",
            tool_calls: [{ id: `c_${Date.now() % 100000}`, function: { name: "write_file", arguments: JSON.stringify({ path: "mock-output.md", content: `任务「${task}」的产物（mock）` }) } }],
          };
        }
        const lastTool = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
        return { text: `(mock) 任务完成。${lastTool ? `依据：${lastTool.split("\n")[0].slice(0, 60)}` : ""}`, tool_calls: [] };
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
          model, messages,
          tools: (tools ?? []).map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } })),
        }),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
      const msg = (await res.json()).choices[0].message;
      return { text: msg.content ?? "", tool_calls: msg.tool_calls ?? [] };
    },
  };
}

// ═══ 2. 工具（03 阶段 + 06 记忆 + 07 技能 + 08 子 agent）═══
function insideWorkDir(p) {
  const abs = path.resolve(WORK_DIR, p);
  if (abs !== WORK_DIR && !abs.startsWith(WORK_DIR + path.sep)) throw new Error(`path escapes workingDir: ${p}`);
  return abs;
}

const llmRef = { current: null }; // 子 agent 需要访问 LLM；启动时注入（工厂注入的最小形态）

const TOOLS = [
  {
    name: "read_file", description: "读取工作目录下的文本文件。",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async run({ path: p }) { return readFileSync(insideWorkDir(p), "utf8").slice(0, 4000); },
  },
  {
    name: "write_file", description: "把文本写入工作目录下的文件（覆盖写，自动建目录）。",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async run({ path: p, content }) {
      const abs = insideWorkDir(p);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      return `wrote ${content.length} chars to ${p}`;
    },
  },
  {
    name: "list_dir", description: "列出工作目录下的文件。",
    parameters: { type: "object", properties: {} },
    async run() { return readdirSync(WORK_DIR).join("\n") || "(empty)"; },
  },
  {
    name: "remember", description: "把跨对话有价值的事实写入持久记忆（同 key 覆盖）。",
    parameters: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] },
    async run({ key, value }) {
      const entries = existsSync(MEMORY_FILE) ? JSON.parse(readFileSync(MEMORY_FILE, "utf8")).entries ?? [] : [];
      const entry = { key, value, updatedAt: new Date().toISOString() };
      const i = entries.findIndex((e) => e.key === key);
      if (i >= 0) entries[i] = entry; else entries.push(entry);
      writeFileSync(MEMORY_FILE, JSON.stringify({ entries }, null, 2));
      return `remembered: ${key}`;
    },
  },
  {
    name: "load_skill", description: "加载某个技能的完整手册。任务匹配技能时先调用。",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async run({ name }) {
      const file = path.join(SKILLS_DIR, `${name}.md`);
      if (!existsSync(file)) return `error: 未找到技能 "${name}"`;
      return readFileSync(file, "utf8").replace(/^---[\s\S]*?---\n/, ""); // 去掉 frontmatter 只给正文
    },
  },
  {
    // 08 阶段的 sub-agent：独立 system prompt + 不带工具的独立调用，只把最终结论带回父上下文。
    // 对照 followups/agent.ts:90：子 agent 的工具集按角色受限（这里是"无工具"）。
    name: "spawn_subagent", description: "派一个独立调研子 agent 去完成子任务，只返回它的最终结论。适合信息收集类小任务。",
    parameters: { type: "object", properties: { task: { type: "string", description: "交给子 agent 的完整任务" } }, required: ["task"] },
    async run({ task }) {
      const result = await llmRef.current.chat([
        { role: "system", content: "你是一名调研员子 agent。只做研究和归纳，不调用工具，直接给出简短结论。" },
        { role: "user", content: task },
      ]); // 注意：不传 tools
      return result.text;
    },
  },
];

// ═══ 3. Context（04 阶段：截断 + 09 阶段外的超预算裁剪）═══
const MAX_TOOL_CHARS = 2000;
const MAX_CONTEXT_TOKENS = 1200;
function estimateTokens(messages) { return Math.ceil(messages.reduce((s, m) => s + (m.content?.length ?? 0), 0) / 4); }
function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const keep = Math.max(50, Math.floor((max - 60) / 2));
  return `${s.slice(0, keep)}\n…[截断 ${s.length - keep * 2} 字符]…\n${s.slice(-keep)}`;
}
function buildOutgoing(session, memoryText) {
  let msgs = session.messages.map((m) => (m.role === "tool" ? { ...m, content: truncateMiddle(m.content, MAX_TOOL_CHARS) } : m));
  // 注入最新记忆（在身份 system 之后，对照 core/loop.ts:346 withMemoryContext）
  if (memoryText?.trim()) {
    const i = msgs.findIndex((m) => m.role !== "system");
    msgs.splice(i < 0 ? msgs.length : i, 0, { role: "system", content: memoryText });
  }
  // 超预算裁剪（对照 context/builder.ts:38 cache-first）：从最旧的完整 user 轮开始丢，
  // 保留开头全部 system（身份+记忆）和最后一轮，绝不在轮中间拆开。
  if (estimateTokens(msgs) > MAX_CONTEXT_TOKENS) {
    const bodyStart = msgs.findIndex((m) => m.role !== "system");
    if (bodyStart > 0) {
      const body = msgs.slice(bodyStart);
      const userIdx = body.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
      const droppable = userIdx.length - 1; // 至少保留最后一轮
      if (droppable > 0) {
        const pruned = [...msgs.slice(0, bodyStart), ...body.slice(userIdx[droppable])];
        if (estimateTokens(pruned) < estimateTokens(msgs)) {
          console.log(`  ✂ context 超预算（${estimateTokens(msgs)} tokens），裁剪为 ${pruned.length} 条消息（保留最后一轮完整）`);
          msgs = pruned;
        }
      }
    }
  }
  return msgs;
}

// ═══ 4. Skill 目录（07 阶段：system 只放名字+描述）═══
function skillCatalog() {
  if (!existsSync(SKILLS_DIR)) return "";
  return readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md")).map((f) => {
    const m = readFileSync(path.join(SKILLS_DIR, f), "utf8").match(/^---\n([\s\S]*?)\n---/);
    const name = m?.[1].match(/name:\s*(.+)/)?.[1] ?? f.replace(".md", "");
    const desc = m?.[1].match(/description:\s*(.+)/)?.[1] ?? "";
    return `- ${name}: ${desc}`;
  }).join("\n");
}

// ═══ 5. Session（05 阶段：落盘 + 恢复）+ Memory 注入（06 阶段）═══
function systemPrompt() {
  return [
    "你是一个教学版 Mini Agent，可以读写 workspace 下的文件完成任务；复杂的调研类子任务可以派 spawn_subagent。",
    `可用技能手册（用 load_skill 加载）：\n${skillCatalog() || "（无）"}`,
  ].join("\n");
}
function createSession(id) {
  const session = { id, messages: [{ role: "system", content: systemPrompt() }] };
  mkdirSync(SESSION_DIR, { recursive: true });
  return session;
}
function saveSession(s) { writeFileSync(path.join(SESSION_DIR, `${s.id}.json`), JSON.stringify(s, null, 2)); }
function loadSession(id) {
  const file = path.join(SESSION_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
function listSessions() {
  if (!existsSync(SESSION_DIR)) return [];
  return readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
}
function loadMemory() {
  try { return JSON.parse(readFileSync(MEMORY_FILE, "utf8")).entries ?? []; } catch { return []; }
}
function memoryText() {
  const entries = loadMemory();
  return entries.length ? `已记住的事实：\n${entries.map((e) => `- ${e.key}: ${e.value}`).join("\n")}` : "";
}

// ═══ 6. Agent Loop（02/03 阶段）═══
const MAX_TURNS = 10;
async function executeTool(call) {
  const tool = TOOLS.find((t) => t.name === call.function.name);
  if (!tool) return `error: unknown tool "${call.function.name}"`;
  let input;
  try { input = JSON.parse(call.function.arguments || "{}"); } catch { return "error: 参数不是合法 JSON"; }
  try { return await tool.run(input); } catch (err) { return `error: ${err.message}`; } // 错误当观察结果
}

async function runTurn(session, userInput, llm) {
  session.messages.push({ role: "user", content: userInput });
  saveSession(session);

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const outgoing = buildOutgoing(session, memoryText());
    const { text, tool_calls } = await llm.chat(outgoing, TOOLS);
    session.messages.push({ role: "assistant", content: text, tool_calls });

    if (tool_calls.length === 0) { saveSession(session); return text; } // 停止条件

    for (const call of tool_calls) {
      console.log(`  🔧 ${call.function.name}(${(call.function.arguments ?? "").slice(0, 60)})`);
      const observation = await executeTool(call);
      console.log(`  📥 ${observation.slice(0, 80)}${observation.length > 80 ? "…" : ""}`);
      session.messages.push({ role: "tool", tool_call_id: call.id, content: observation });
      saveSession(session);
    }
  }
  return "(stopped: reached maxTurns)";
}

// ═══ 7. Compaction（09 阶段）═══
const KEEP_RECENT_USER_TURNS = 2;
async function compact(session, llm) {
  const [system, ...body] = session.messages;
  let seen = 0, tailStart = 0;
  for (let i = body.length - 1; i >= 0; i--) if (body[i].role === "user" && ++seen === KEEP_RECENT_USER_TURNS) { tailStart = i; break; }
  const old = body.slice(0, tailStart);
  if (old.length === 0) return console.log("没有可压缩的旧历史。");
  const transcript = old.map((m) => `${m.role}:\n${m.content}`).join("\n\n");
  // chat 恒返回 { text, tool_calls }；压缩调用不传 tools
  const summary = (await llm.chat([
    { role: "system", content: "把对话历史压缩成继续工作摘要：目标/进度/关键文件/决定/未完成事项。不要编造。" },
    { role: "user", content: transcript },
  ])).text.trim();
  const before = estimateTokens(session.messages);
  session.messages = [system, { role: "system", content: `此前对话的压缩摘要：\n${summary}` }, ...body.slice(tailStart)];
  saveSession(session);
  console.log(`压缩完成：${session.messages.length + old.length}→${session.messages.length} 条消息，粗估 ${before}→${estimateTokens(session.messages)} tokens`);
}

// ═══ 8. 入口 ══
const llm = createLLM();
llmRef.current = llm;
mkdirSync(WORK_DIR, { recursive: true });

async function repl(session) {
  console.log(`Mini Agent（${llm.name}）· /new /compact /exit 可用\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // for-await 遍历 readline：stdin EOF 时循环自然结束，不会挂起
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "/exit") break;
    if (line === "/new") { Object.assign(session, createSession(`sess_${Date.now()}`)); console.log("(新会话)"); continue; }
    if (line === "/compact") { await compact(session, llm); continue; }
    console.log(`${await runTurn(session, line, llm)}\n`);
  }
  rl.close();
  console.log(`会话已保存：sessions/${session.id}.json；恢复：node agent.mjs resume ${session.id}`);
}

const args = process.argv.slice(2);
if (args[0] === "resume") {
  const session = loadSession(args[1]);
  if (!session) {
    console.log(`找不到会话 ${args[1] ?? ""}。已有: ${listSessions().join(", ") || "(无)"}`);
    process.exit(1);
  }
  console.log(`已恢复会话 ${session.id}（${session.messages.length} 条消息）`);
  await repl(session);
} else {
  const task = args.join(" ").trim();
  if (task) {
    const session = createSession(`run_${Date.now()}`);
    console.log(`模型: ${llm.name}\n最终答复: ${await runTurn(session, task, llm)}`);
  } else {
    await repl(createSession(`sess_${Date.now()}`));
  }
}

// 各阶段对照：
//   1 LLM        → 01-basic-chat（model/types.ts 的 ModelClient 思想）
//   2 工具       → 03-tools + 06-memory + 07-skills + 08-subagent（tools/registry.ts）
//   3 Context    → 04-context 截断 + cache-first 裁剪（context/builder.ts）
//   5 Session    → 05-session 落盘与恢复（sessions/store.ts、runtime-store.ts:285 getOrLoad）
//   6 Loop       → 02-agent-loop（core/loop.ts runTurn）
//   7 Compaction → 09-compaction（commands/compact.ts）
//   刻意没有的：审批流、事件总线——见 README 扩展作业
